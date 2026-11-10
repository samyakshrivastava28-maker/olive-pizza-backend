import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { Router, Request, Response } from 'express';
import { query } from '../lib/db.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { idempotency } from '../middleware/idempotency.middleware.js';
import { adminDb } from '../config/firebase.js';
import { FirestoreListener } from '../listeners/firestore.listener.js';
import { OwnerTemplates, CustomerTemplates, RestaurantTemplates } from '../services/notification/NotificationTemplates.js';

import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { orderEventService } from '../services/order/OrderEventService.js';
import { queueEmail } from '../services/email.service.js';
import { buildOrderStatusEmail } from '../services/emailTemplates.service.js';
import { DeliveryCapacityService } from '../services/delivery/DeliveryCapacityService.js';
import { FranchiseGoogleSheetsService } from '../services/reports/FranchiseGoogleSheetsService.js';
import { CanonicalOrderService } from '../services/pos/CanonicalOrderService.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { calculateDistance } from '../lib/utils.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { AuthoritativePricingResolver } from '../services/menu/AuthoritativePricingResolver.js';
import { RiderReplacementSagaService } from '../services/delivery/RiderReplacementSagaService.js';
import { PaymentService } from '../services/payment/PaymentService.js';
import crypto from 'crypto';

// Restaurant local timezone for daily order counter reset
const RESTAURANT_TIMEZONE = process.env.RESTAURANT_TIMEZONE || 'Asia/Kolkata';

/** Returns YYYY-MM-DD in the restaurant's local timezone */
function getLocalDateString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TIMEZONE })
    .format(new Date());
}

/**
 * Atomically increments the daily order counter in Firestore and returns
 * the next sequential number for today. Resets to 1 when the date changes.
 */
async function getNextDailyOrderNumber(): Promise<{ dailyOrderNumber: number; orderDateLocal: string }> {
  const today = getLocalDateString();
  const counterRef = adminDb.collection('counters').doc('dailyOrders');

  const dailyOrderNumber = await adminDb.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const data = snap.exists ? snap.data()! : { date: today, count: 0 };
    const newCount = data.date === today ? (data.count as number) + 1 : 1;
    t.set(counterRef, { date: today, count: newCount });
    return newCount;
  });

  return { dailyOrderNumber, orderDateLocal: today };
}

const router = Router();

// 1. GET / - Get orders (Customer gets own orders, Staff gets scoped branch orders)
router.get('/', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const role = (user.role || 'customer').toLowerCase();
    const isStaff = ['restaurant_manager', 'manager', 'owner', 'developer', 'admin', 'platform_owner', 'kitchen_staff', 'cashier'].includes(role) ||
      user.email === 'olivepizzarjn@gmail.com' ||
      user.email === 'webhub2811@gmail.com';

    if (isStaff) {
      const scope = FranchiseScopeService.resolveScope(user);
      const requestedBranchId = (req.query.branchId as string) || (scope.isGlobalOwner ? 'all' : (scope.branchId || ''));
      const effectiveBranchId = FranchiseScopeService.getEffectiveBranchId(scope, requestedBranchId);

      let q: any = adminDb.collection('orders');
      if (effectiveBranchId !== 'all') {
        q = q.where('branchId', '==', effectiveBranchId);
      }

      const snapshot = await q.orderBy('createdAt', 'desc').limit(100).get().catch(async () => {
        // Fallback without index if orderBy fails
        let fallbackQ: any = adminDb.collection('orders');
        if (effectiveBranchId !== 'all') {
          fallbackQ = fallbackQ.where('branchId', '==', effectiveBranchId);
        }
        return await fallbackQ.limit(100).get();
      });

      const orders = snapshot.docs.map((doc: any) => {
        return OrderProjectionService.projectByRole({ id: doc.id, ...doc.data() }, user);
      });

      res.json(orders);
      return;
    }

    // Normal customer: fetch both active Firestore orders and archived PostgreSQL orders
    let snapshotDocs: any[] = [];
    try {
      const snap = await adminDb.collection('orders')
        .where('userId', '==', user.uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get()
        .catch(async () => {
          return await adminDb.collection('orders').where('userId', '==', user.uid).limit(50).get().catch(() => ({ docs: [] }));
        });
      snapshotDocs = snap?.docs || [];
    } catch (fsErr: any) {
      console.warn('[Orders] Firestore read notice for customer orders, falling back to PostgreSQL:', fsErr.message);
    }

    const pgHistorical = await OrderPersistenceArchiveService.getCustomerHistoricalOrders(user.uid, (user as any).phone || (user as any).phone_number).catch(() => []);
      
    const activeOrders = snapshotDocs
      .map((doc: any) => OrderProjectionService.projectForCustomer(doc.data(), user.uid, doc.id))
      .filter(Boolean);


    const activeIds = new Set(activeOrders.map((o: any) => o.id));
    const pastOrders = (pgHistorical || [])
      .filter((po: any) => !activeIds.has(po.id))
      .map((po: any) => OrderProjectionService.projectForCustomer(po, user.uid, po.id))
      .filter(Boolean);

    const combined = [...activeOrders, ...pastOrders];
    res.json(combined);
  } catch (error) {
    console.error("[Orders] Failed to fetch orders:", error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// 2. GET /live - Dedicated live orders endpoint for Restaurant Managers & KDS (Staff/Owner only)
router.get('/live', verifyToken, requireRole(['restaurant_manager', 'owner', 'kitchen_staff', 'cashier', 'manager', 'admin', 'franchise_owner', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const scope = FranchiseScopeService.resolveScope(user);
    const requestedBranchId = (req.query.branchId as string) || (scope.isGlobalOwner ? 'all' : (scope.branchId || ''));
    const effectiveBranchId = FranchiseScopeService.getEffectiveBranchId(scope, requestedBranchId);

    const activeStatuses = ['pending', 'pending_acceptance', 'accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery'];

    let q: any = adminDb.collection('orders');
    if (effectiveBranchId !== 'all') {
      q = q.where('branchId', '==', effectiveBranchId);
    }

    let activeOrders: any[] = [];
    try {
      const snapshot = await q.orderBy('createdAt', 'desc').limit(50).get().catch(async () => {
        let fallbackQ: any = adminDb.collection('orders');
        if (effectiveBranchId !== 'all') {
          fallbackQ = fallbackQ.where('branchId', '==', effectiveBranchId);
        }
        return await fallbackQ.limit(50).get().catch(() => ({ docs: [] }));
      });

      activeOrders = (snapshot?.docs || [])
        .map((doc: any) => OrderProjectionService.projectForRestaurantManager(doc.data(), doc.id))
        .filter((o: any) => activeStatuses.includes(o.status));
    } catch (fsErr: any) {
      console.warn('[Orders] Firestore read notice for /live, querying PostgreSQL:', fsErr.message);
    }

    // Authoritative fallback: Query PostgreSQL canonical_orders directly
    if (activeOrders.length === 0) {
      try {
        const { query: pgQuery } = await import('../config/postgres.js');
        const pgParams: any[] = [];
        let branchClause = '';
        if (effectiveBranchId !== 'all') {
          pgParams.push(effectiveBranchId);
          branchClause = `AND branch_id = $${pgParams.length}`;
        }
        const pgRes = await pgQuery(
          `SELECT * FROM canonical_orders 
           WHERE order_status NOT IN ('DELIVERED', 'CANCELLED') ${branchClause} 
           ORDER BY created_at DESC LIMIT 50`,
          pgParams
        );
        activeOrders = pgRes.rows.map((r: any) => ({
          id: r.id,
          orderNumber: r.daily_order_no ? `#${r.daily_order_no}` : r.id?.slice(0, 6),
          status: (r.order_status || 'pending').toLowerCase(),
          customerName: r.customer_name,
          customerPhone: r.customer_phone,
          deliveryAddress: typeof r.delivery_address === 'string' ? { addressLine: r.delivery_address } : r.delivery_address,
          totalAmount: Number(r.total_amount || 0),
          paymentMethod: r.payment_method,
          paymentStatus: r.payment_status,
          createdAt: r.created_at,
          branchId: r.branch_id
        }));
      } catch (pgErr: any) {
        console.warn('[Orders] PostgreSQL /live query notice:', pgErr.message);
      }
    }

    res.json({ success: true, count: activeOrders.length, orders: activeOrders });

  } catch (error: any) {
    console.error("[Orders] Failed to fetch live orders:", error);
    res.status(500).json({ error: error?.message || 'Failed to fetch live orders' });
  }
});

// 2a. GET /bill/:billReference - Dedicated secure customer bill page lookup
// Strict Server-Side Authorization: Caller must own the order or be authorized staff/owner.
// Returns HTTP 403 Forbidden on URL manipulation / unauthorized access.
router.get('/bill/:billReference', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { billReference } = req.params;
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      return;
    }

    // 1. Locate the canonical order by billReference or order ID in Firestore
    let orderDoc: any = null;
    let orderId: string = '';

    // Search by billReference field
    const refQuery = await adminDb.collection('orders')
      .where('billReference', '==', billReference)
      .limit(1)
      .get();

    if (!refQuery.empty) {
      orderDoc = refQuery.docs[0].data();
      orderId = refQuery.docs[0].id;
    } else {
      // Fallback: check if billReference is actually the Firestore doc ID
      const directDoc = await adminDb.collection('orders').doc(billReference).get();
      if (directDoc.exists) {
        orderDoc = directDoc.data();
        orderId = directDoc.id;
      }
    }

    // Fallback 2: Check PostgreSQL canonical tables if not found in Firestore
    if (!orderDoc) {
      const pgRes = await query(
        `SELECT co.*, cb.permanent_bill_no, cb.bill_number, cb.daily_order_no
         FROM canonical_orders co
         LEFT JOIN canonical_bills cb ON cb.order_id = co.id
         WHERE co.id = $1 OR co.bill_reference = $1 OR cb.bill_reference = $1 OR cb.permanent_bill_no::text = $1
         LIMIT 1`,
        [billReference]
      ).catch(() => ({ rows: [] }));

      if (pgRes.rows.length > 0) {
        const row = pgRes.rows[0];
        orderId = row.id;
        orderDoc = {
          id: row.id,
          userId: row.user_id,
          permanentBillNo: row.permanent_bill_no,
          billNumber: row.bill_number || `#${row.permanent_bill_no}`,
          dailyOrderNumber: row.daily_order_no,
          orderNumber: `#${row.daily_order_no}`,
          billReference: row.bill_reference || billReference,
          customerName: row.customer_name,
          contactPhone: row.customer_phone,
          deliveryAddress: row.delivery_address,
          orderType: row.order_type,
          orderSource: row.order_source,
          items: typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || []),
          subtotal: Number(row.subtotal || 0),
          discountAmount: Number(row.discount_amount || 0),
          couponCode: row.coupon_code,
          taxes: Number(row.tax_amount || 0),
          cgst: Number(row.cgst || 0),
          sgst: Number(row.sgst || 0),
          deliveryFee: Number(row.delivery_fee || 0),
          packagingCharge: Number(row.packaging_charge || 0),
          totalAmount: Number(row.total_amount || 0),
          paymentMethod: row.payment_method,
          paymentStatus: row.payment_status,
          status: row.order_status,
          createdAt: row.created_at,
          branchName: 'Olive Pizza — Rajnandgaon HQ',
          branchId: row.branch_id
        };
      }
    }

    if (!orderDoc) {
      res.status(404).json({ error: 'Bill not found' });
      return;
    }

    // 2. Authoritative Server-Side Authorization Check
    const role = (user.role || 'customer').toLowerCase();
    const isStaff = [
      'restaurant_manager', 'manager', 'owner', 'developer', 'admin',
      'platform_owner', 'kitchen_staff', 'cashier', 'franchise_manager', 'franchise_owner'
    ].includes(role) ||
      user.email === 'olivepizzarjn@gmail.com' ||
      user.email === 'webhub2811@gmail.com' ||
      user.email === 'olivepizzamaker@gmail.com';

    const orderOwnerUid = orderDoc.userId || orderDoc.user_id;

    if (!isStaff) {
      if (!orderOwnerUid || orderOwnerUid !== user.uid) {
        res.status(403).json({
          error: 'Forbidden: You do not have permission to view this bill.',
          code: 'UNAUTHORIZED_BILL_ACCESS'
        });
        return;
      }
    }

    // 3. Construct Authoritative Print-Ready Bill Payload
    const permanentBillNo = Number(orderDoc.permanentBillNo || orderDoc.permanent_bill_no || 1);
    const dailyOrderNumber = Number(orderDoc.dailyOrderNumber || orderDoc.daily_order_no || 1);
    const billNumber = orderDoc.billNumber || `#${permanentBillNo}`;
    const orderNumber = orderDoc.orderNumber || `#${dailyOrderNumber}`;

    const createdDate = orderDoc.createdAt?.toDate ? orderDoc.createdAt.toDate() : new Date(orderDoc.createdAt || Date.now());
    const orderDate = orderDoc.orderDateLocal || BillingNumberService.getLocalDateString(createdDate);
    const orderTime = BillingNumberService.getLocalTimeString(createdDate);

    const orderType = (orderDoc.fulfillmentType || orderDoc.deliveryType || orderDoc.orderType || 'delivery').toLowerCase();
    const orderTypeLabel = orderType === 'pickup' || orderType === 'takeaway' ? 'Pickup / Takeaway' : 'Home Delivery';

    const rawItems = Array.isArray(orderDoc.items) ? orderDoc.items : [];
    const formattedItems = rawItems.map((it: any) => {
      const qty = Number(it.quantity || 1);
      const unitPrice = Number(it.price || it.unitPrice || 0);
      const addons = Array.isArray(it.addons) ? it.addons : [];
      const addonPrice = addons.reduce((sum: number, a: any) => sum + Number(a.price || 0), 0);
      const itemSubtotal = (unitPrice + addonPrice) * qty;

      return {
        name: String(it.name || it.productName || 'Artisan Pizza'),
        quantity: qty,
        size: it.size || it.variant || 'Regular',
        crust: it.crust || 'Classic Hand Tossed',
        addons: addons.map((a: any) => typeof a === 'object' ? (a.name || a.title || 'Add-on') : String(a)),
        price: unitPrice,
        addonPrice,
        subtotal: itemSubtotal
      };
    });

    const subtotal = Number(orderDoc.subtotal || orderDoc.totalAmount || 0);
    const discount = Number(orderDoc.discountAmount || orderDoc.discount || 0);
    const taxes = Number(orderDoc.taxes || orderDoc.taxAmount || 0);
    const cgst = orderDoc.cgst !== undefined ? Number(orderDoc.cgst) : Number((taxes / 2).toFixed(2));
    const sgst = orderDoc.sgst !== undefined ? Number(orderDoc.sgst) : Number((taxes - cgst).toFixed(2));
    const deliveryFee = Number(orderDoc.deliveryFee || 0);
    const packagingCharge = Number(orderDoc.packagingCharge || 0);
    const grandTotal = Number(orderDoc.totalAmount || orderDoc.finalTotal || (subtotal - discount + taxes + deliveryFee + packagingCharge));

    const billPayload = {
      billReference: orderDoc.billReference || billReference,
      orderId,
      permanentBillNo,
      billNumber,
      dailyOrderNumber,
      orderNumber,
      orderDate,
      orderTime,
      orderType: orderTypeLabel,
      fulfillmentType: orderType,
      orderSource: (orderDoc.orderSource || 'ONLINE').toUpperCase(),
      status: (orderDoc.status || 'pending').toLowerCase(),
      restaurant: {
        name: 'Olive Pizza',
        branchName: orderDoc.branchName || 'Olive Pizza — Rajnandgaon HQ',
        address: 'Dongargaon Rd, near Saraswati school, Rajnandgaon, CG 491441',
        phone: '+91 91799 44445',
        gstin: '22AAAAA0000A1Z5',
        fssai: '10522016000123'
      },
      customer: {
        name: orderDoc.customerName || orderDoc.userName || 'Valued Customer',
        phone: orderDoc.contactPhone || orderDoc.phone || 'N/A',
        deliveryAddress: typeof orderDoc.deliveryAddress === 'object' 
          ? (orderDoc.deliveryAddress?.addressLine || orderDoc.deliveryAddress?.address || orderDoc.deliveryAddress?.fullAddress || 'Pickup at Counter')
          : (orderDoc.deliveryAddress || 'Pickup at Counter'),
        pickupInfo: (orderType === 'pickup' || orderType === 'takeaway') ? {
          branchName: 'Olive Pizza — Rajnandgaon HQ',
          pickupCounter: 'Olive Pizza Store Front Counter',
          address: 'Dongargaon Rd, near Saraswati school, Rajnandgaon, CG 491441',
          contactPhone: '+91 91799 44445'
        } : null
      },
      items: formattedItems,
      pricing: {
        subtotal,
        discount,
        couponCode: orderDoc.couponCode || orderDoc.appliedCouponCode || null,
        packagingCharge,
        deliveryFee,
        taxes,
        cgst,
        sgst,
        total: grandTotal
      },
      payment: {
        method: String(orderDoc.paymentMethod || 'COD').toUpperCase(),
        status: String(orderDoc.paymentStatus || (orderDoc.paymentMethod === 'COD' ? 'PENDING' : 'PAID')).toUpperCase(),
        paymentId: orderDoc.paymentId || null
      },
      timing: {
        createdAt: createdDate.toISOString(),
        acceptedAt: orderDoc.acceptedAt ? (orderDoc.acceptedAt.toDate ? orderDoc.acceptedAt.toDate().toISOString() : orderDoc.acceptedAt) : null,
        deliveredAt: orderDoc.deliveredAt ? (orderDoc.deliveredAt.toDate ? orderDoc.deliveredAt.toDate().toISOString() : orderDoc.deliveredAt) : null,
        cancelledAt: orderDoc.cancelledAt ? (orderDoc.cancelledAt.toDate ? orderDoc.cancelledAt.toDate().toISOString() : orderDoc.cancelledAt) : null,
      }
    };

    res.json({ success: true, bill: billPayload });
  } catch (err: any) {
    console.error('[Orders] Error retrieving bill:', err);
    res.status(500).json({ error: err.message || 'Failed to retrieve bill' });
  }
});

// 2b. GET /:id - Single order lookup with authorized role-based field projection
router.get('/:id', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    let data: any = null;
    try {
      const docSnap = await adminDb.collection('orders').doc(id).get();
      if (docSnap.exists) {
        data = { id: docSnap.id, ...docSnap.data() };
      }
    } catch (fsErr: any) {
      console.warn('[Orders] Firestore single order read notice, falling back to PostgreSQL:', fsErr.message);
    }

    if (!data) {
      // Fallback: check PostgreSQL canonical archive for completed/archived order
      data = await OrderPersistenceArchiveService.getHistoricalOrder(id);
    }


    if (!data) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const scope = FranchiseScopeService.resolveScope(user);
    try {
      FranchiseScopeService.assertOrderAccess(scope, data, user.uid);
    } catch (scopeErr: any) {
      res.status(scopeErr.status || 403).json({ error: scopeErr.message || 'Forbidden: Access denied' });
      return;
    }

    const projected = OrderProjectionService.projectByRole(data, user);
    res.json({ success: true, order: projected });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch order' });
  }
});

// Re-verifies customer location and delivery radius before allowing checkout to begin (Enforcement Point 3)
router.post('/validate-checkout', async (req: Request, res: Response): Promise<void> => {
  try {
    const { lat, lng, address, items, targetFranchiseId, targetBranchId } = req.body;
    const custLat = Number(lat);
    const custLng = Number(lng);

    if (isNaN(custLat) || isNaN(custLng)) {
      res.status(400).json({
        success: false,
        isServiceable: false,
        error: "We currently don't deliver to this location.",
        code: 'OUT_OF_DELIVERY_ZONE'
      });
      return;
    }

    const valResult = await CustomerOrderingContextService.validateCustomerOrderLocation({
      lat: custLat,
      lng: custLng,
      targetFranchiseId: targetFranchiseId ? String(targetFranchiseId).trim() : undefined,
      targetBranchId: targetBranchId ? String(targetBranchId).trim() : undefined,
      customerId: (req as any).user?.uid || 'guest'
    });

    if (!valResult.isValid) {
      const statusCode = valResult.code === 'FRANCHISE_MISMATCH' ? 403 : 400;
      res.status(statusCode).json({
        success: false,
        isServiceable: false,
        error: valResult.error || "We currently don't deliver to this location.",
        code: valResult.code || 'OUT_OF_DELIVERY_ZONE'
      });
      return;
    }

    res.json({
      success: true,
      isServiceable: true,
      franchiseId: valResult.resolvedFranchiseId,
      branchId: valResult.resolvedBranchId,
      distanceKm: valResult.distanceKm
    });
  } catch (error: any) {
    console.error('[Orders] Error validating checkout:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/orders/sync-offline-actions
 * Batch idempotent synchronization of offline restaurant manager actions.
 * Supports:
 * - Order status transitions (preparing, ready, delivered, cancelled)
 * - Prep time adjustments
 * Server-enforced idempotency, franchise/branch isolation, conflict resolution.
 */
router.post('/sync-offline-actions', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const role = (user.role || '').toLowerCase();
    const allowedApps = Array.isArray(user.allowedApps) ? user.allowedApps : [];
    const isStaff = ['restaurant_manager', 'kitchen_staff', 'cashier'].includes(role) ||
      allowedApps.includes('RESTAURANT_MANAGER');

    if (!isStaff) {
      res.status(403).json({ success: false, error: 'Forbidden: Restaurant manager authorization required' });
      return;
    }

    const { actions } = req.body;
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      res.status(400).json({ success: false, error: 'actions array is required' });
      return;
    }

    const userBranchId = user.branchId;
    const actionScope = FranchiseScopeService.resolveScope(user);

    const results: any[] = [];

    for (const act of actions) {
      const actionId = act.actionId || act.id || act.idempotencyKey || `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const idempotencyKey = act.idempotencyKey || act.actionId || act.id || actionId;
      const orderId = act.orderId;
      const nextStatus = act.nextStatus;
      const reason = act.reason;
      const prepMinutes = act.estimatedPreparationMinutes ?? act.prepMinutes;

      if (!orderId || !nextStatus) {
        results.push({
          idempotencyKey,
          actionId,
          orderId: orderId || null,
          status: 'FAILED',
          error: 'Missing orderId or nextStatus'
        });
        continue;
      }

      try {
        // 1. Fetch current order state from Firestore or authoritative PostgreSQL
        let currentStatus = 'pending';
        let orderBranchId = '';

        const orderDoc = await adminDb.collection('orders').doc(orderId).get();
        if (orderDoc.exists) {
          const orderData = orderDoc.data()!;
          currentStatus = orderData.status || 'pending';
          orderBranchId = orderData.branchId || '';
        } else {
          const pgOrder = await query('SELECT id, order_status, branch_id, franchise_id FROM canonical_orders WHERE id = $1 LIMIT 1', [orderId]);
          if (pgOrder.rows.length === 0) {
            results.push({
              idempotencyKey,
              actionId,
              orderId,
              status: 'FAILED',
              error: `Order ${orderId} not found in database`
            });
            continue;
          }
          currentStatus = pgOrder.rows[0].order_status || 'pending';
          orderBranchId = pgOrder.rows[0].branch_id || '';
        }

        // Branch isolation check
        if (orderBranchId && !FranchiseScopeService.isAuthorizedForBranch(actionScope, orderBranchId)) {
          results.push({
            idempotencyKey,
            actionId,
            orderId,
            status: 'FAILED',
            error: `Forbidden: Branch isolation violation for branch ${orderBranchId}`
          });
          continue;
        }

        // Idempotency: If order is already in the target status or advanced past it
        if (currentStatus === nextStatus) {
          results.push({
            idempotencyKey,
            actionId,
            orderId,
            status: 'ALREADY_SYNCED',
            currentStatus,
            duplicate: true
          });
          continue;
        }

        // Conflict check: If order was cancelled on the server while client was offline
        if (currentStatus === 'cancelled' || currentStatus === 'rejected') {
          results.push({
            idempotencyKey,
            actionId,
            orderId,
            status: 'REVIEW_REQUIRED',
            error: `Order was cancelled on server while offline. Current status: ${currentStatus}`,
            currentStatus
          });
          continue;
        }

        // Execute transition
        const transitionMetadata = typeof prepMinutes === 'number' ? { estimatedPreparationMinutes: prepMinutes } : {};
        const transRes = await OrderStateMachine.transition(
          orderId,
          nextStatus,
          { uid: user.uid, role: role || 'restaurant_manager', name: user.email?.split('@')[0] || 'Manager', branchId: userBranchId || orderBranchId },
          transitionMetadata
        );

        if (transRes.success) {
          results.push({
            idempotencyKey,
            actionId,
            orderId,
            status: 'SYNCED',
            newStatus: nextStatus,
            version: transRes.version,
            syncedAt: new Date().toISOString()
          });
        } else {
          results.push({
            idempotencyKey,
            actionId,
            orderId,
            status: 'REVIEW_REQUIRED',
            error: transRes.error || 'State machine transition rejected',
            currentStatus
          });
        }
      } catch (actErr: any) {
        console.error(`[SyncOfflineActions] Error syncing action ${actionId}:`, actErr.message);
        results.push({
            idempotencyKey,
            actionId,
          orderId,
          status: 'FAILED',
          error: actErr.message
        });
      }
    }

    const syncedCount = results.filter(r => r.status === 'SYNCED' || r.status === 'ALREADY_SYNCED').length;
    res.json({
      success: true,
      message: `Processed ${actions.length} offline actions (${syncedCount} succeeded)`,
      syncedCount,
      totalCount: actions.length,
      results
    });
  } catch (err: any) {
    console.error('[SyncOfflineActions] Global error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create a new order securely
router.post('/', verifyToken, idempotency(), async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.uid;
  const isDebug = req.headers['x-debug-mode'] === 'true';
  const startTime = Date.now();
  const trace: any = {
    route: 'POST /api/orders',
    action: 'Place Order',
    userId,
    steps: []
  };

  try {
    const { items, addressDetails, address, location } = req.body;
    trace.steps.push({ step: 'Validation', status: 'started' });
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Cart is empty' });
      return;
    }

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 0. STRICT GUARD AGAINST FAKE / SYNTHETIC / TEST ORDERS
    // Eliminates phantom orders that trigger false kitchen alarms and rider dispatches
    const incomingId = (req.body.id || req.body.orderId || '').toString().trim().toLowerCase();
    const incomingCustomerName = (req.body.customerName || req.body.name || '').toString().trim().toLowerCase();
    const incomingSource = (req.body.orderSource || '').toString().trim().toUpperCase();
    const isSyntheticPattern = 
      incomingId.startsWith('test_') ||
      incomingId.startsWith('mock_') ||
      incomingId.startsWith('synthetic_') ||
      incomingId.startsWith('dummy_') ||
      incomingId.startsWith('online_test_') ||
      incomingId.startsWith('ord_test_') ||
      /^(test|mock|synthetic|dummy|fake|archival test|idempotency test)/i.test(incomingCustomerName) ||
      ['TEST', 'MOCK', 'SYNTHETIC'].includes(incomingSource) ||
      req.body.isTest === true ||
      req.body.isMock === true ||
      req.headers['x-test-order'] === 'true';

    if (isSyntheticPattern) {
      const isProduction = process.env.NODE_ENV === 'production';
      const isAllowedMockTest = 
        !isProduction && 
        process.env.NODE_ENV === 'test' && 
        process.env.ALLOW_SYNTHETIC_ORDERS === 'true' && 
        Boolean(process.env.FIRESTORE_EMULATOR_HOST);

      if (!isAllowedMockTest) {
        console.warn(`[Orders] REJECT: Synthetic/test order blocked (ID: ${incomingId || 'none'}, Name: ${incomingCustomerName || 'none'}, Source: ${incomingSource || 'none'}).`);
        res.status(400).json({
          error: 'Synthetic, mock, or test orders are strictly prohibited in this environment.',
          code: 'SYNTHETIC_ORDER_REJECTED'
        });
        return;
      }
    }

    // 0. Enforce 1 active order per customer policy
    try {
      const existingOrdersSnap = await adminDb.collection('orders')
        .where('userId', '==', userId)
        .get();

      const activeOrderDoc = existingOrdersSnap.docs.find(doc => {
        const d = doc.data();
        const status = (d.status || '').toLowerCase();
        return !['delivered', 'cancelled', 'rejected', 'failed'].includes(status);
      });

      if (activeOrderDoc) {
        const activeData = activeOrderDoc.data();
        // Cross-verify with PostgreSQL canonical table to ensure this order wasn't already delivered
        let isActuallyDeliveredInPg = false;
        try {
          const pgCheck = await query(
            `SELECT order_status FROM canonical_orders WHERE id = $1 LIMIT 1`,
            [activeOrderDoc.id]
          );
          if (pgCheck.rows.length > 0) {
            const pgStatus = (pgCheck.rows[0].order_status || '').toUpperCase();
            if (pgStatus === 'DELIVERED' || pgStatus === 'CANCELLED') {
              isActuallyDeliveredInPg = true;
              // Clean up Firestore doc state
              await adminDb.collection('orders').doc(activeOrderDoc.id).update({
                status: pgStatus.toLowerCase(),
                order_status: pgStatus,
                live_lifecycle: 'TERMINAL'
              }).catch(() => {});
            }
          }
        } catch {}

        if (!isActuallyDeliveredInPg) {
          const orderNum = activeData.dailyOrderNumber ? `#${activeData.dailyOrderNumber}` : `#${activeOrderDoc.id.slice(0, 6)}`;
          res.status(400).json({ 
            error: `You already have an active order in progress (${orderNum}). Please wait until your current order is delivered before placing another order.`,
            code: 'ACTIVE_ORDER_EXISTS',
            activeOrderId: activeOrderDoc.id,
            activeOrderStatus: activeData.status
          });
          return;
        }
      }
    } catch (activeOrderErr: any) {
      console.warn('[Orders] Active order check notice:', activeOrderErr.message);
    }

    // 1. Fetch user data from Firestore
    let userData: any = {};
    try {
      const userDoc = await adminDb.collection('users').doc(userId).get();
      if (userDoc.exists) userData = userDoc.data()!;
    } catch (uErr) {
      console.warn('[Orders] User doc read notice:', uErr);
    }
    
    const incomingOrderSource = (req.body.orderSource || 'ONLINE').toUpperCase();
    const rawUserPhone = req.body.contactPhone || req.body.phone || userData.phone || userData.contactPhone || (req.user as any)?.phone_number || (req.user as any)?.phone;
    const cleanDigits = (rawUserPhone || '').replace(/\D/g, '');
    if (incomingOrderSource === 'ONLINE' && (!rawUserPhone || cleanDigits.length < 10 || cleanDigits === '9999999999')) {
      res.status(400).json({ error: 'A valid customer mobile number is required to place an order.', code: 'PHONE_REQUIRED' });
      return;
    }
    const userPhone = rawUserPhone || (incomingOrderSource.startsWith('POS') ? 'POS-Walkin' : 'N/A');

    const effectiveLocation = location || (typeof req.body.deliveryAddress === 'object' && req.body.deliveryAddress?.lat != null ? { lat: req.body.deliveryAddress.lat, lng: req.body.deliveryAddress.lng } : null);
    const userAddress = (typeof address === 'string' ? address : null) || 
      (typeof req.body.deliveryAddress === 'string' ? req.body.deliveryAddress : req.body.deliveryAddress?.addressLine) || 
      userData.full_address || userData.fullAddress || (req.body.deliveryType === 'pickup' ? 'Pickup at Store' : 'Rajnandgaon');

    // Auto-sync missing profile fields to Firestore user doc if provided during checkout
    if (userPhone && (!userData.phone || (!userData.fullAddress && !userData.full_address))) {
      adminDb.collection('users').doc(userId).set({
        phone: userPhone,
        phoneSetupCompleted: true,
        fullAddress: userAddress || 'Pickup',
        full_address: userAddress || 'Pickup',
        locationSetupCompleted: true,
        location: effectiveLocation || null,
      }, { merge: true }).catch(err => console.warn('[Orders] User profile sync warning:', err));
    }

    // 0.4. Dynamic Branch & Franchise Resolution
    const deliveryType = req.body.deliveryType || 'delivery';
    const callerRole = req.user?.role || 'customer';
    const isStaffMember = ['cashier', 'kitchen_staff', 'restaurant_manager', 'franchise_owner', 'admin', 'owner'].includes(callerRole);

    let resolvedBranchId = '';
    let resolvedFranchiseId = '';
    let resolvedOrgId = 'org_olive_pizza';
    let resolvedBranchName = '';

    if (isStaffMember) {
      const scope = FranchiseScopeService.resolveScope(req.user);
      resolvedBranchId = FranchiseScopeService.getEffectiveBranchId(scope, req.body.branchId || undefined);
      if (!resolvedBranchId || resolvedBranchId === 'all') {
        res.status(400).json({ error: 'Specific branch is required to create an order.', code: 'BRANCH_REQUIRED' });
        return;
      }
      resolvedFranchiseId = scope.franchiseId || req.user?.franchiseId || '';
      resolvedOrgId = scope.organizationId || 'org_olive_pizza';
    } else {
      // Customer: Enforcement Point 4 (Authoritative radius verification & single-franchise lock immediately before persisting)
      const explicitBranch = (req.body.branchId || req.headers['x-branch-id'] || req.body.session?.branchId || '').trim();
      const explicitFranchise = (req.body.franchiseId || req.body.session?.franchiseId || '').trim();

      const rawLat = req.body.lat ?? req.body.latitude ?? location?.lat ?? effectiveLocation?.lat ?? req.body.deliveryAddress?.lat ?? userData.lat ?? userData.location?.lat;
      const rawLng = req.body.lng ?? req.body.longitude ?? location?.lng ?? effectiveLocation?.lng ?? req.body.deliveryAddress?.lng ?? userData.lng ?? userData.location?.lng;
      const custLat = rawLat != null ? Number(rawLat) : NaN;
      const custLng = rawLng != null ? Number(rawLng) : NaN;

      if (deliveryType === 'delivery') {
        if (isNaN(custLat) || isNaN(custLng)) {
          res.status(400).json({
            error: "We currently don't deliver to this location.",
            code: 'OUT_OF_DELIVERY_ZONE'
          });
          return;
        }

        const valResult = await CustomerOrderingContextService.validateCustomerOrderLocation({
          lat: custLat,
          lng: custLng,
          targetFranchiseId: explicitFranchise || undefined,
          targetBranchId: explicitBranch || undefined,
          customerId: userId
        });

        if (!valResult.isValid) {
          const statusCode = valResult.code === 'FRANCHISE_MISMATCH' ? 403 : 400;
          res.status(statusCode).json({
            error: valResult.error || "We currently don't deliver to this location.",
            code: valResult.code || 'OUT_OF_DELIVERY_ZONE'
          });
          return;
        }

        resolvedBranchId = valResult.resolvedBranchId;
        resolvedFranchiseId = valResult.resolvedFranchiseId;
      } else {
        // Pickup order: resolve explicit or closest branch
        if (explicitBranch) {
          resolvedBranchId = explicitBranch;
        } else if (explicitFranchise) {
          resolvedFranchiseId = explicitFranchise;
        } else if (!isNaN(custLat) && !isNaN(custLng)) {
          const res = await CustomerOrderingContextService.resolveOrderingContext({
            customerId: userId,
            lat: custLat,
            lng: custLng
          });
          if (res.isServiceable && res.context) {
            resolvedBranchId = res.context.branchId;
            resolvedFranchiseId = res.context.franchiseId;
          }
        }

        if (!resolvedBranchId) {
          res.status(400).json({
            error: "A valid branch is required for takeaway/pickup orders.",
            code: 'BRANCH_REQUIRED'
          });
          return;
        }
      }
    }

    let branchDeliverySettings: any = null;
    let restaurantDeliverySettings: any = null;

    // Lookup resolved branch details to guarantee consistent name & IDs
    try {
      const bDoc = await adminDb.collection('franchises').doc(resolvedBranchId).get();
      if (bDoc.exists) {
        const bData = bDoc.data()!;
        resolvedBranchName = bData.name || resolvedBranchName;
        resolvedFranchiseId = bData.franchiseId || resolvedFranchiseId;
        resolvedOrgId = bData.organizationId || resolvedOrgId;
        branchDeliverySettings = bData.deliverySettings || null;

        // Check operational availability of branch
        if (bData.isActive === false || bData.isOpen === false || bData.acceptingOrders === false) {
          res.status(400).json({
            error: `${resolvedBranchName} is currently closed and not accepting orders.`,
            code: 'RESTAURANT_CLOSED',
            canAcceptOrders: false,
            isOpen: false
          });
          return;
        }
      }
    } catch (bErr) {
      console.warn('[Orders] Branch document read notice:', bErr);
    }

    // Check restaurant_settings collection for the branch
    try {
      const restDoc = await adminDb.collection('restaurant_settings').doc(resolvedBranchId).get();
      if (restDoc.exists) {
        const restData = restDoc.data() || {};
        restaurantDeliverySettings = restData.deliverySettings || restData;
        if (restData.isOpen === false || restData.acceptingOrders === false) {
          res.status(400).json({
            error: restData.closeReason || `${resolvedBranchName} is currently closed and not accepting orders.`,
            code: 'RESTAURANT_CLOSED',
            canAcceptOrders: false,
            isOpen: false
          });
          return;
        }
      }
    } catch (restErr) {
      console.warn('[Orders] Restaurant status read notice:', restErr);
    }

    // 0.5. Check Delivery Availability if delivery requested
    if (deliveryType === 'delivery') {
      const avail = await DeliveryCapacityService.getRestaurantAvailability(resolvedBranchId);
      if (!avail.canAcceptDeliveries) {
        res.status(400).json({
          error: avail.availabilityMessage,
          code: avail.availabilityStatus,
          canAcceptDeliveries: false
        });
        return;
      }
    }

    console.log("Order attempt:", { phone: userPhone, address: userAddress, itemsCount: items.length });

    // 2. Validate prices from Firestore / DB across collections (Strict Authoritative Pricing)
    let serverCalculatedTotal = 0;
    const validatedItems: any[] = [];

    for (const item of items) {
      const itemId = item.menuItemId || item.id;
      if (!itemId || typeof itemId !== 'string') {
        res.status(400).json({ error: 'Invalid or missing menu item identifier.', code: 'INVALID_MENU_ITEM' });
        return;
      }

      // Authoritative Branch Pricing Resolution
      let authoritativePrice: any = null;
      try {
        authoritativePrice = await AuthoritativePricingResolver.resolveItemPrice({
          branchId: resolvedBranchId,
          productId: itemId,
          size: item.size || item.variant,
          crust: item.crust,
          addons: item.addons
        });
      } catch (authErr: any) {
        res.status(400).json({
          error: authErr.message || `Unable to authoritatively resolve pricing for "${item.name || itemId}".`,
          code: 'INVALID_MENU_ITEM'
        });
        return;
      }

      let menuData: any = null;
      try {
        // Fetch product/combo metadata for image & category
        let docSnap = await adminDb.collection('products').doc(itemId).get();
        if (docSnap.exists) {
          menuData = docSnap.data();
        } else {
          docSnap = await adminDb.collection('combos').doc(itemId).get();
          if (docSnap.exists) {
            menuData = docSnap.data();
          }
        }
      } catch (dbReadErr) {
        console.warn('[Orders] DB lookup fallback:', dbReadErr);
      }

      if (!menuData) {
        menuData = {
          name: authoritativePrice.productName,
          productName: authoritativePrice.productName,
          price: authoritativePrice.unitPrice,
          basePrice: authoritativePrice.basePrice
        };
      }

      if (menuData.isAvailable === false || menuData.isActive === false) {
        res.status(400).json({ error: 'Item ' + (menuData.name || menuData.productName || item.name) + ' is currently unavailable' });
        return;
      }

      // Authoritative Price Determination from AuthoritativePricingResolver
      const itemPrice = authoritativePrice.unitPrice;
      if (itemPrice <= 0) {
        res.status(400).json({
          error: `Unable to verify authoritative price for item "${menuData.name || menuData.productName || item.name}".`,
          code: 'PRICE_VERIFICATION_FAILED'
        });
        return;
      }

      const itemName = menuData.productName || menuData.name || item.name || 'Artisan Pizza Item';
      const itemImage = menuData.imageUrl || menuData.image || item.image || '';

      const qty = Math.max(1, Math.min(50, Math.floor(Number(item.quantity || 1))));
      let addonsCost = 0;
      const validatedAddons: any[] = [];
      if (Array.isArray(item.addons) && item.addons.length > 0) {
        if (!Array.isArray(menuData.addons) || menuData.addons.length === 0) {
          res.status(400).json({
            error: `Addons are not supported for item "${itemName}".`,
            code: 'UNKNOWN_ADDON_ID'
          });
          return;
        }
        for (const addon of item.addons) {
          if (!addon) continue;
          const authoritativeAddon = menuData.addons.find((a: any) => (
            (addon.id && a.id === addon.id) ||
            (addon.name && a.name && a.name.toLowerCase().trim() === String(addon.name).toLowerCase().trim())
          ));
          if (!authoritativeAddon) {
            res.status(400).json({
              error: `Addon "${addon.name || addon.id}" is not available for item "${itemName}".`,
              code: 'UNKNOWN_ADDON_ID'
            });
            return;
          }
          const addonPrice = Number(authoritativeAddon.price || 0);
          addonsCost += addonPrice;
          validatedAddons.push({
            id: authoritativeAddon.id || addon.id || addon.name,
            name: authoritativeAddon.name || addon.name,
            price: addonPrice
          });
        }
      }
      // itemPrice is authoritativePrice.unitPrice, which already includes base + crust + addons
      serverCalculatedTotal += itemPrice * qty;

      validatedItems.push({
        menuItemId: itemId,
        name: itemName,
        price: itemPrice,
        quantity: qty,
        size: item.size || item.variant || 'regular',
        crust: item.crust || 'normal',
        image: itemImage,
        addons: validatedAddons
      });
    }

    // Authoritative Server-side Delivery Fee Calculation
    let deliveryFee = 0;
    if (deliveryType === 'delivery') {
      const baseFee = Number(
        branchDeliverySettings?.deliveryFee ??
        restaurantDeliverySettings?.deliveryFee ??
        restaurantDeliverySettings?.deliveryCharge ??
        30
      );
      const freeAbove = Number(
        branchDeliverySettings?.freeDeliveryThreshold ??
        restaurantDeliverySettings?.freeDeliveryAbove ??
        restaurantDeliverySettings?.freeDeliveryThreshold ??
        500
      );
      if (freeAbove > 0 && serverCalculatedTotal >= freeAbove) {
        deliveryFee = 0;
      } else {
        deliveryFee = Math.max(0, baseFee);
      }
    }
    const taxes = Math.round(serverCalculatedTotal * 0.05);

    // ── PHASE 3: SERVER-SIDE COUPON REVALIDATION & CONCURRENCY ATOMICITY ────────
    let discountAmount = 0;
    let appliedCouponCode: string | null = null;
    let couponRejectReason: string | null = null;

    const clientCouponCode: string | null = req.body.couponCode?.trim()?.toUpperCase() || null;
    if (clientCouponCode) {
      try {
        const couponSnap = await adminDb.collection('coupons')
          .where('code', '==', clientCouponCode)
          .limit(1)
          .get();

        if (!couponSnap.empty) {
          const couponDocRef = couponSnap.docs[0].ref;

          await adminDb.runTransaction(async (transaction) => {
            const freshCouponDoc = await transaction.get(couponDocRef);
            if (!freshCouponDoc.exists) {
              throw new Error('COUPON_NOT_FOUND');
            }
            const couponData = freshCouponDoc.data()!;
            const now = new Date();
            const expiresAt = couponData.expiresAt ? new Date(couponData.expiresAt) : null;
            const startsAt = couponData.startsAt ? new Date(couponData.startsAt) : null;
            const usageCount = Number(couponData.usageCount || 0);
            const usageLimit = Number(couponData.usageLimit || Infinity);
            const minOrderAmount = Number(couponData.minOrderAmount || 0);

            if (!couponData.isActive) {
              throw new Error(`Coupon ${clientCouponCode} is inactive.`);
            }
            if (expiresAt && now > expiresAt) {
              throw new Error(`Coupon ${clientCouponCode} has expired.`);
            }
            if (startsAt && now < startsAt) {
              throw new Error(`Coupon ${clientCouponCode} is not yet valid.`);
            }
            if (usageCount >= usageLimit) {
              throw new Error(`Coupon ${clientCouponCode} has reached its usage limit.`);
            }
            if (serverCalculatedTotal < minOrderAmount) {
              throw new Error(`Minimum order amount for this coupon is ₹${minOrderAmount}. Current subtotal: ₹${serverCalculatedTotal}.`);
            }

            const discountType: string = couponData.discountType || 'percentage';
            const discountValue = Number(couponData.discountValue || 0);
            const maxDiscount = Number(couponData.maxDiscount || Infinity);

            if (discountType === 'percentage') {
              discountAmount = Math.min(Math.round(serverCalculatedTotal * (discountValue / 100)), maxDiscount);
            } else if (discountType === 'flat') {
              discountAmount = Math.min(discountValue, serverCalculatedTotal);
            }

            transaction.update(couponDocRef, {
              usageCount: usageCount + 1,
              lastUsedAt: new Date().toISOString()
            });
          });

          appliedCouponCode = clientCouponCode;
        } else {
          couponRejectReason = `Coupon ${clientCouponCode} does not exist.`;
        }
      } catch (couponErr: any) {
        console.warn('[Orders] Coupon validation error:', couponErr.message);
        couponRejectReason = couponErr.message || 'Coupon validation failed. Order placed without discount.';
        discountAmount = 0;
        appliedCouponCode = null;
      }
    }

    // ── PHASE 3: SCHEDULED ORDER VALIDATION ──────────────────────────────────
    const orderTiming: string = req.body.orderTiming || 'immediate';
    const scheduledFor: string | null = req.body.scheduledFor || null; // ISO string

    if (orderTiming === 'scheduled') {
      if (!scheduledFor) {
        res.status(400).json({ error: 'scheduledFor (ISO datetime) is required for scheduled orders.' });
        return;
      }
      const scheduledDate = new Date(scheduledFor);
      if (isNaN(scheduledDate.getTime())) {
        res.status(400).json({ error: 'scheduledFor must be a valid ISO datetime string.' });
        return;
      }
      if (scheduledDate <= new Date()) {
        res.status(400).json({ error: 'scheduledFor must be a future date/time.' });
        return;
      }
      // Validate scheduled hour is within store opening hours (12:00–23:59)
      const scheduledHour = scheduledDate.getHours();
      const scheduledMinute = scheduledDate.getMinutes();
      const scheduledTotalMinutes = scheduledHour * 60 + scheduledMinute;
      const openMinutes = 12 * 60;   // 12:00 = 720
      const closeMinutes = 23 * 60 + 59; // 23:59 = 1439
      if (scheduledTotalMinutes < openMinutes || scheduledTotalMinutes > closeMinutes) {
        res.status(400).json({
          error: `Scheduled time must be between 12:00 PM and 11:59 PM (store operating hours). Requested: ${scheduledDate.toLocaleTimeString()}.`
        });
        return;
      }
    }

    // ── PHASE 3: ORDER SOURCE TAGGING ─────────────────────────────────────────
    // Distinguishes online customer orders from POS-originated orders.
    // Only authenticated staff/terminals can create POS or offline orders.
    const userRole = (req.user as any)?.role || 'customer';
    const isStaff = ['cashier', 'kitchen_staff', 'restaurant_manager', 'franchise_owner', 'admin', 'owner'].includes(userRole);
    const orderSource: string = req.body.orderSource || 'ONLINE';
    const VALID_POS_SOURCES = ['POS_DINE_IN', 'POS_TAKEAWAY', 'POS_DELIVERY', 'OFFLINE_RESTAURANT'];
    const resolvedOrderSource = (isStaff && VALID_POS_SOURCES.includes(orderSource)) ? orderSource : 'ONLINE';

    // Allow POS cashier manual discounts only when originating from authorized staff without a coupon
    if (isStaff && resolvedOrderSource !== 'ONLINE' && req.body.discountAmount && !clientCouponCode) {
      discountAmount = Math.min(Math.max(0, Number(req.body.discountAmount) || 0), serverCalculatedTotal);
    }

    // Server-Authoritative Packaging Charge (from PostgreSQL branch settings, not untrusted client body)
    let packagingCharge = 0;
    try {
      const branchRes = await query(
        'SELECT tax_settings FROM restaurant_branches WHERE id = $1 LIMIT 1',
        [resolvedBranchId]
      );
      if (branchRes.rows.length > 0 && branchRes.rows[0].tax_settings?.packagingCharge != null) {
        packagingCharge = Number(branchRes.rows[0].tax_settings.packagingCharge);
      } else {
        packagingCharge = Math.max(0, Number(req.body.packagingCharge) || 0);
      }
    } catch {
      packagingCharge = Math.max(0, Number(req.body.packagingCharge) || 0);
    }
    const finalOrderTotal = Math.max(0, serverCalculatedTotal - discountAmount) + deliveryFee + taxes + packagingCharge;

    // Authoritative Price Revalidation against Client Expected Total (Tamper & Stale Cart Protection)
    const clientExpectedTotal = req.body.clientExpectedTotal !== undefined 
      ? Number(req.body.clientExpectedTotal) 
      : (req.body.totalAmount !== undefined ? Number(req.body.totalAmount) : undefined);

    if (resolvedOrderSource === 'ONLINE' && clientExpectedTotal !== undefined && !isNaN(clientExpectedTotal)) {
      if (Math.abs(clientExpectedTotal - finalOrderTotal) > 1.0) {
        res.status(409).json({
          success: false,
          error: 'Price mismatch detected. Menu prices, discounts, or delivery fees have updated. Please review your cart.',
          code: 'PRICE_MISMATCH_RETRY',
          serverTotal: finalOrderTotal,
          clientTotal: clientExpectedTotal
        });
        return;
      }
    }


    // 2.5 Duplicate Order Prevention (Idempotency / Distributed Lock)
    const deviceId = (req.headers['x-device-id'] as string) || req.ip || 'unknown';
    
    try {
      const lockResult = await query(
        'INSERT INTO checkout_locks (user_id, device_id, expires_at) ' +
        'VALUES ($1, $2, NOW() + INTERVAL \'10 seconds\') ' +
        'ON CONFLICT (user_id) DO UPDATE ' +
        'SET device_id = EXCLUDED.device_id, locked_at = NOW(), expires_at = NOW() + INTERVAL \'10 seconds\' ' +
        'WHERE checkout_locks.expires_at < NOW() OR checkout_locks.device_id = EXCLUDED.device_id ' +
        'RETURNING user_id;',
        [userId, deviceId]
      );

      if (lockResult.rows.length === 0) {
        if (isDebug) trace.steps.push({ step: 'Idempotency Lock', status: 'failed', reason: 'Order currently placing' });
        res.status(409).json({
          success: false,
          error: 'Another checkout transaction is already in progress. Please wait a moment before trying again.',
          code: 'CHECKOUT_LOCK_HELD',
        });
        return;
      }
    } catch (lockErr: any) {
      console.error('[Orders] Critical: Checkout lock service unavailable:', lockErr?.message);
      if (isDebug) trace.steps.push({ step: 'Idempotency Lock', status: 'failed', error: lockErr?.message });
      res.status(503).json({
        success: false,
        error: 'Order checkout lock service temporarily unavailable. Please retry placing your order.',
        code: 'LOCK_SERVICE_UNAVAILABLE',
        trace: isDebug ? trace : undefined
      });
      return;
    }
    trace.steps.push({ step: 'Idempotency Lock', status: 'success' });

    // 3. Atomically allocate Permanent Bill No. and Daily Order No. & commit to PostgreSQL
    const newOrderId = crypto.randomUUID();

    const resolvedTerminalId = isStaff ? (req.user?.terminalId || null) : null;
    const resolvedCashierName = isStaff ? ((req.user as any)?.name || req.user?.email || null) : null;

    const timeoutMinutes = Number(process.env.ORDER_ACCEPT_TIMEOUT_MINUTES || 10);
    const acceptanceDeadline = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();

      // Verify captured online payment in PostgreSQL ledger before order confirmation
      let initialPaymentStatus = 'PENDING';
      const rawPaymentMethod = (req.body.paymentMethod || 'COD').toUpperCase();

      if (resolvedOrderSource !== 'ONLINE') {
        // Authoritative verification for POS payments against canonical records
        if (!isStaff) {
          res.status(403).json({
            error: 'Forbidden: Non-online order creation requires authenticated staff credentials.',
            code: 'FORBIDDEN_ORDER_SOURCE'
          });
          return;
        }
        if (rawPaymentMethod === 'COD') {
          initialPaymentStatus = 'PENDING';
        } else if (rawPaymentMethod === 'CASH') {
          const cashReceived = Number(req.body.amountReceived || req.body.paymentDetails?.amountReceived || finalOrderTotal);
          initialPaymentStatus = cashReceived >= finalOrderTotal - 0.05 ? 'PAID' : 'PENDING';
        } else {
          // Card / UPI / Split: verify settlement details
          const digitalRef = (req.body.paymentId || req.body.paymentDetails?.paymentId || req.body.paymentDetails?.providerTransactionId || '').toString().trim();
          let isVerified = false;
          if (digitalRef) {
            const bindRes = await PaymentService.verifyAndBindCapturedPayment({
              paymentRef: digitalRef,
              targetOrderId: newOrderId,
              expectedAmount: finalOrderTotal,
              expectedMethod: rawPaymentMethod,
            });
            isVerified = bindRes.verified;
            if (!bindRes.verified && bindRes.reason === 'ALREADY_CONSUMED') {
              console.warn(`[Orders] Payment ${digitalRef} already bound to another order. Non-online order settlement rejected.`);
            }
          }
          const isSettled = isVerified;
          initialPaymentStatus = isSettled ? 'PAID' : 'PENDING';
        }
      } else if (rawPaymentMethod !== 'COD') {
        const incomingPaymentId = (req.body.paymentId || req.body.paymentDetails?.paymentId || '').toString().trim();
        if (incomingPaymentId) {
          const bindRes = await PaymentService.verifyAndBindCapturedPayment({
            paymentRef: incomingPaymentId,
            targetOrderId: newOrderId,
            expectedAmount: finalOrderTotal,
            expectedMethod: rawPaymentMethod,
          });
          if (bindRes.verified) {
            initialPaymentStatus = 'PAID';
          } else {
            console.warn(`[Orders] Online payment verification failed for ${incomingPaymentId}: ${bindRes.reason}`);
          }
        }

        if (initialPaymentStatus !== 'PAID') {
          res.status(402).json({
            error: 'Online payment verification failed or payment has not been captured in PostgreSQL authority. Order cannot be placed.',
            code: 'PAYMENT_REQUIRED'
          });
          return;
        }
      }

      let permanentBillNo: number | null = null;
      let dailyOrderNumber: number | null = null;
      let orderDateLocal = BillingNumberService.getLocalDateString();

      try {
        const nums = await BillingNumberService.allocateNumbers();
        permanentBillNo = nums.permanentBillNo;
        dailyOrderNumber = nums.dailyOrderNo;
        orderDateLocal = nums.orderDate;
      } catch (numErr) {
        console.warn('[Orders] Number allocation notice during checkout:', numErr);
      }

      const orderNumber = dailyOrderNumber ? `#${dailyOrderNumber}` : `#${newOrderId.slice(0, 6).toUpperCase()}`;
      const billNumber = permanentBillNo ? `#${permanentBillNo}` : `#BILL-${newOrderId.slice(0, 6).toUpperCase()}`;
      const billReference = 'bill_' + crypto.randomBytes(12).toString('hex');

      const orderFirestoreDoc = {
        id: newOrderId,
        orderId: newOrderId,
        lifecycle: 'ACTIVE',
        postgresPersistence: 'PENDING',
        postgresSyncError: null,
        permanentBillNo,
        billNumber,
        billReference,
        dailyOrderNumber,
        orderNumber,
        orderDateLocal,
        userId,
        customerId: userId,
        items: validatedItems,
        totalAmount: finalOrderTotal,
        subtotal: serverCalculatedTotal,
        deliveryFee,
        taxes,
        packagingCharge,
        discountAmount,
        status: 'pending',
        notification_version: 1,
        acceptanceDeadline,
        acceptDeadlineAt: acceptanceDeadline,
        cancellationAcknowledged: false,
        cancellationAcknowledgedAt: null,
        deliveryAddress: { 
          addressLine: userAddress || 'Pickup', 
          lat: effectiveLocation?.lat ?? req.body.deliveryAddress?.lat ?? userData.lat ?? userData.location?.lat ?? 0, 
          lng: effectiveLocation?.lng ?? req.body.deliveryAddress?.lng ?? userData.lng ?? userData.location?.lng ?? 0,
          houseNumber: addressDetails?.houseNumber || '',
          apartment: addressDetails?.apartment || '',
          landmark: addressDetails?.landmark || '',
          instructions: addressDetails?.instructions || ''
        },
        contactPhone: userPhone,
        customerName: userData.name || (req.user as any)?.name || 'Gourmet Customer',
        // Canonical order identifiers
        daily_order_number: orderNumber,
        paymentMethod: req.body.paymentMethod || 'COD',
        paymentId: req.body.paymentId || ('pay_' + newOrderId.slice(0, 8)),
        paymentStatus: initialPaymentStatus,
        // Phase 3 canonical order fields
        source: resolvedOrderSource.startsWith('POS') ? 'POS' : 'ONLINE',
        orderSource: resolvedOrderSource,
        orderTiming,
        scheduledFor: scheduledFor || null,
        appliedCouponCode: appliedCouponCode || null,
        couponRejectReason: couponRejectReason || null,
        // POS & Multi-Tenant Terminal Metadata (Server-derived)
        tableNumber: req.body.tableNumber || null,
        cashierName: resolvedCashierName,
        terminalId: resolvedTerminalId,
        branchId: resolvedBranchId,
        branchName: resolvedBranchName,
        franchiseId: resolvedFranchiseId,
        organizationId: resolvedOrgId,
        paymentDetails: req.body.paymentDetails || null,
        fulfillmentType: deliveryType,
        deliveryType: deliveryType,
        notificationDispatched: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // STEP 3: Persist to canonical PostgreSQL relational ledger first (Authoritative ACID Transaction)
      // Durable projection obligation: Written as PROJECTION_PENDING so that any crash before/during Firestore write is captured
      (orderFirestoreDoc as any).live_lifecycle = 'PROJECTION_PENDING';
      try {
        await OrderPersistenceArchiveService.syncLiveOrderToPostgres(newOrderId, orderFirestoreDoc);
        trace.steps.push({ step: 'Canonical PostgreSQL Persistence', status: 'success', orderId: newOrderId, dailyOrderNumber, permanentBillNo });
      } catch (syncErr: any) {
        console.error(`[Orders] Canonical PostgreSQL sync failed for order ${newOrderId}:`, syncErr.message);
        trace.steps.push({ step: 'Canonical PostgreSQL Persistence', status: 'error', error: syncErr.message });
        res.status(500).json({ error: 'Failed to persist order to canonical ledger. Transaction aborted.' });
        return;
      }

      // STEP 4: Project order document to Firestore for live operational consumers
      try {
        await adminDb.collection('orders').doc(newOrderId).set(orderFirestoreDoc);

        // Mark projection resolved in PostgreSQL canonical store
        await query("UPDATE canonical_orders SET live_lifecycle = 'ACTIVE' WHERE id = $1 AND live_lifecycle = 'PROJECTION_PENDING'", [newOrderId]).catch(() => {});

        // Mark order as already processed in FirestoreListener to prevent duplicate new-order alert
        FirestoreListener.markOrderProcessed(newOrderId);

        trace.steps.push({ step: 'Firestore Projection', status: 'success', orderId: newOrderId, dailyOrderNumber, permanentBillNo, billReference });

        // Reset user's active cart upon successful order placement (prevents abandoned cart reminder)
        adminDb.collection('user_carts').doc(userId).set({
          userId,
          items: [],
          total: 0,
          itemCount: 0,
          lastOrderId: newOrderId,
          lastOrderPlacedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          abandonedCartReminderSentAt: null
        }, { merge: true }).catch(() => {});

        // Asynchronously sync online order to franchise-specific Google Spreadsheet
        FranchiseGoogleSheetsService.syncOrderToFranchise({
          id: newOrderId,
          userId,
          items: validatedItems,
          totalAmount: finalOrderTotal,
          subtotal: serverCalculatedTotal,
          deliveryFee,
          taxes,
          discountAmount,
          status: 'pending',
          contactPhone: userPhone,
          customerName: userData.name || (req.user as any)?.name || 'Gourmet Customer',
          dailyOrderNumber,
          orderSource: resolvedOrderSource,
          paymentMethod: req.body.paymentMethod || 'COD',
          paymentStatus: (req.body.paymentMethod || 'COD').toUpperCase() === 'ONLINE' ? 'PAID' : 'PENDING',
          branchId: resolvedBranchId,
          branchName: resolvedBranchName,
          franchiseId: resolvedFranchiseId,
          deliveryAddress: { addressLine: userAddress || 'Pickup' },
          createdAt: new Date()
        }).catch(e => console.warn('[OnlineOrderSheetSync] Notice:', e.message));
      } catch (err: any) {
        console.warn(`[Orders] Firestore operational projection degraded for order ${newOrderId}:`, err.message);
        trace.steps.push({ step: 'Firestore Projection', status: 'degraded', error: err.message });
        // Order is committed in PostgreSQL; flag projection for background reconciliation
        await query(
          `UPDATE canonical_orders SET live_lifecycle = 'PROJECTION_PENDING' WHERE id = $1`,
          [newOrderId]
        ).catch(() => {});
      }

    trace.processingTime = Date.now() - startTime;
    res.status(201).json({ 
      message: 'Order placed successfully', 
      orderId: newOrderId, 
      permanentBillNo,
      billNumber,
      orderNumber, 
      dailyOrderNumber: dailyOrderNumber > 0 ? dailyOrderNumber : null, 
      orderDateLocal, 
      orderSource: resolvedOrderSource,
      appliedCouponCode: appliedCouponCode || null,
      couponRejectReason: couponRejectReason || null,
      discountAmount,
      finalTotal: finalOrderTotal,
      trace: isDebug ? trace : undefined 
    });

    // Release checkout lock immediately so customer can place next order without waiting
    query('DELETE FROM checkout_locks WHERE user_id = $1', [userId]).catch(() => {});

    // 5. Asynchronous Background Dispatch (Targeted Restaurant Management Notification with Action Buttons)
    setImmediate(async () => {
      try {
        const { NotificationRouter } = await import('../services/notification/NotificationRouter.js');
        const isCod = (req.body.paymentMethod || 'COD').toUpperCase() === 'COD';
        await NotificationRouter.routeOrderEvent({
          orderId: newOrderId,
          orderNumber,
          dailyOrderNumber: orderNumber,
          permanentBillNo: permanentBillNo || undefined,
          orderType: deliveryType,
          totalAmount: finalOrderTotal,
          items: validatedItems,
          paymentMethod: req.body.paymentMethod || 'COD',
          paymentStatus: isCod ? 'PENDING' : 'PAID',
          cashToCollect: isCod ? finalOrderTotal : 0,
          deliveryAddress: userAddress || 'Pickup',
          deliveryInstructions: req.body.deliveryInstructions || req.body.instructions || '',
          customerNotes: req.body.customerNotes || req.body.notes || '',
          lat: effectiveLocation?.lat,
          lng: effectiveLocation?.lng,
          contactPhone: userPhone,
          customerName: userData.name || (req.user as any)?.name || 'Customer',
          userId,
          branchId: resolvedBranchId,
          franchiseId: resolvedFranchiseId,
          orderTime: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          financials: {
            subtotal: serverCalculatedTotal,
            discount: discountAmount,
            deliveryFee,
            taxes,
            packagingCharge: req.body.packagingCharge || 0,
            couponCode: appliedCouponCode || undefined,
            total: finalOrderTotal
          }
        }, 'RESTAURANT_NEW_ORDER_ALARM');
      } catch (notifErr: any) {
        console.error('[Orders] Async Restaurant Notification dispatch error:', notifErr.message);
      }

      // Initial Customer Order Placed Notification (pinned live card)
      try {
        const customerPlacedPayload = CustomerTemplates.orderUpdate(newOrderId, {
          orderNumber,
          status: 'pending',
          totalAmount: finalOrderTotal,
          version: 1
        });
        await notificationEngine.send(userId, customerPlacedPayload, {
          eventId: `ORDER_CREATED:customer:${newOrderId}`,
          category: 'pinned_live',
          orderId: newOrderId,
          targetApp: 'customer',
          tag: `order_${newOrderId}`
        });
      } catch (custErr: any) {
        console.warn('[Orders] Customer initial order placed push error:', custErr.message);
      }

      // Transactional order email removed in favor of real-time push / in-app notification system (Section 5)

      try {
        await orderEventService.emitNewOrder(newOrderId);
      } catch (pushErr: any) {
        console.error('[Orders] Async OrderEventService failed:', pushErr.message);
      }

      // Phase 10: Google Sheets Sync Engine (Non-blocking)
      try {
        const { SheetsSyncWorker } = await import('../services/reports/SheetsSyncWorker.js');
        await SheetsSyncWorker.queueOrder(newOrderId, {
          orderNumber,
          customerName: userData.name || 'Customer',
          customerPhone: userPhone,
          totalAmount: finalOrderTotal,
          subtotal: serverCalculatedTotal,
          discountAmount,
          taxes,
          deliveryFee,
          paymentMethod: req.body.paymentMethod || 'COD',
          orderType: deliveryType,
          orderSource: resolvedOrderSource,
          tableNumber: req.body.tableNumber || undefined,
          terminalId: req.body.session?.terminalId || req.body.terminalId || (req.headers['x-terminal-id'] as string) || undefined,
          cashierName: req.body.session?.cashierName || req.body.cashierName || undefined,
          branchName: resolvedBranchName || req.body.session?.branchName || req.body.branchName || 'Olive Pizza',
          franchiseId: resolvedFranchiseId || req.body.session?.franchiseId || req.body.franchiseId || '',
          status: 'pending',
          itemCount: validatedItems.reduce((sum: number, it: any) => sum + (it.quantity || 1), 0),
          items: validatedItems,
          couponCode: appliedCouponCode || undefined,
          createdAt: new Date().toISOString()
        });
      } catch (sheetErr: any) {
        console.warn('[Orders] SheetsSyncWorker notice:', sheetErr.message);
      }
    });


  } catch (error: any) {
    console.error('Error creating order:', error);
    trace.steps.push({ step: 'Fatal Error', status: 'failed', error: error.message });
    trace.processingTime = Date.now() - startTime;
    res.status(500).json({ error: 'Failed to create order', trace: isDebug ? trace : undefined });
  } finally {
    if (userId) {
      try {
        await query('DELETE FROM checkout_locks WHERE user_id = $1', [userId]);
      } catch(e) {
        console.error('Failed to release checkout lock:', e);
      }
    }
  }
});

// Universal Order Status Update (Strictly Operational Roles — Owner is Read-Only)
router.all(['/:id/status'], verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, cancellationReason, deliveryPartnerId, deliveryPartnerName, deliveryPartnerPhone, estimatedPreparationMinutes, prepMinutes } = req.body;
    const uid = req.user!.uid;
    const role = (req.user!.role || 'staff').toLowerCase();
    const emailLower = (req.user?.email || '').toLowerCase();
    const name = (req.user as any)?.name || (req.user as any)?.displayName || req.user?.email || 'Staff';
    const appTarget = ((req.headers['x-app-target'] || req.headers['x-app-source'] || '') as string).toUpperCase();
    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';
    const isDeliveryApp = appTarget === 'DELIVERY';

    let effectiveRole = role;
    if (role === 'owner' || role === 'admin' || isMasterAccount) {
      if (isDeliveryApp) {
        effectiveRole = 'delivery_partner';
      } else {
        effectiveRole = 'restaurant_manager';
      }
    } else if (role === 'manager' || role === 'kitchen_manager' || role === 'chef') {
      effectiveRole = 'restaurant_manager';
    } else if (role === 'rider' || role === 'delivery') {
      effectiveRole = 'delivery_partner';
    }

    const operationalRoles = ['restaurant_manager', 'kitchen_staff', 'cashier', 'delivery_partner'];
    if (!operationalRoles.includes(effectiveRole)) {
      res.status(403).json({ error: 'Forbidden: Operational role required for status mutation' });
      return;
    }

    if (!status) {
      res.status(400).json({ error: 'Status is required' });
      return;
    }

    // Pre-check order existence and branch scoping
    let orderBranchId = '';
    let orderExists = false;

    try {
      const orderDoc = await adminDb.collection('orders').doc(id).get();
      if (orderDoc.exists) {
        orderExists = true;
        orderBranchId = orderDoc.data()?.branchId || '';
      }
    } catch (fsErr: any) {
      console.warn('[Orders] Firestore read notice for /:id/status pre-check:', fsErr.message);
    }

    if (!orderExists) {
      try {
        const { query: pgQuery } = await import('../config/postgres.js');
        const pgRes = await pgQuery('SELECT branch_id FROM canonical_orders WHERE id = $1', [id]);
        if (pgRes.rows.length > 0) {
          orderExists = true;
          orderBranchId = pgRes.rows[0].branch_id || '';
        }
      } catch (pgErr: any) {
        console.warn('[Orders] PostgreSQL fallback order check notice:', pgErr.message);
      }
    }

    if (!orderExists) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const userBranchId = req.user?.branchId;
    const reqScope = FranchiseScopeService.resolveScope(req.user);
    if (orderBranchId && !FranchiseScopeService.isAuthorizedForBranch(reqScope, orderBranchId)) {
      res.status(403).json({
        error: `Forbidden: You do not have authority over orders from branch ${orderBranchId}`
      });
      return;
    }


    const metadata: Record<string, any> = {};
    if (cancellationReason) metadata.cancellationReason = cancellationReason;
    if (deliveryPartnerId) metadata.deliveryPartnerId = deliveryPartnerId;
    if (deliveryPartnerName) metadata.deliveryPartnerName = deliveryPartnerName;
    if (deliveryPartnerPhone) metadata.deliveryPartnerPhone = deliveryPartnerPhone;
    const targetPrep = Number(estimatedPreparationMinutes ?? prepMinutes);
    if (!isNaN(targetPrep) && targetPrep > 0) metadata.estimatedPreparationMinutes = targetPrep;

    const result = await OrderStateMachine.transition(id, status as any, { uid, role: effectiveRole, name, branchId: userBranchId || orderBranchId }, metadata);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.error || 'Failed to update order status' });
      return;
    }

    res.json({ success: true, orderId: id, status: result.currentStatus, version: result.version });
  } catch (error: any) {
    console.error('[Orders] Universal status update failed:', error?.message);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Restaurant Manager / Staff Accept Order Action (From App or Notification Action)
router.post('/:id/accept', verifyToken, async (req: AuthRequest, res: Response) => {
  const requestId = `req_acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { id } = req.params;
    const userRole = (req.user?.role || '').toLowerCase();
    const emailLower = (req.user?.email || '').toLowerCase();
    const uid = req.user?.uid;
    const userBranchId = req.user?.branchId;
    const name = (req.user as any)?.name || req.user?.email || 'Manager';
    const appTarget = ((req.headers['x-app-target'] || req.headers['x-app-source'] || '') as string).toUpperCase();

    // Owner Portal Read-Only Enforcement
    if (appTarget === 'OWNER') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Owner portal has read-only operational authority. Kitchen transitions must be executed by restaurant managers.',
        requestId
      });
    }

    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';
    let effectiveRole = userRole;
    if (userRole === 'owner' || userRole === 'admin' || isMasterAccount) {
      effectiveRole = 'restaurant_manager';
    } else if (userRole === 'manager' || userRole === 'kitchen_manager' || userRole === 'chef') {
      effectiveRole = 'restaurant_manager';
    }

    const isAuthorizedStaff = ['restaurant_manager', 'kitchen_staff', 'cashier'].includes(effectiveRole);
    if (!isAuthorizedStaff || !uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized: Restaurant staff authorization required', requestId });
    }

    // Pre-check order existence and branch scoping (Firestore & PostgreSQL authoritative fallback)
    let orderData: any = null;
    let orderBranchId = '';
    try {
      const orderDoc = await adminDb.collection('orders').doc(id).get();
      if (orderDoc.exists) {
        orderData = orderDoc.data()!;
        orderBranchId = orderData.branchId || '';
      }
    } catch (fsErr: any) {
      console.warn(`[Orders] Firestore read notice for /:id/accept:`, fsErr.message);
    }

    if (!orderData) {
      try {
        const { OrderPersistenceArchiveService } = await import('../services/order/OrderPersistenceArchiveService.js');
        orderData = await OrderPersistenceArchiveService.getHistoricalOrder(id);
        if (orderData) {
          orderBranchId = orderData.branchId || '';
        }
      } catch (pgErr: any) {
        console.warn(`[Orders] PostgreSQL fallback notice for /:id/accept:`, pgErr.message);
      }
    }

    if (!orderData) {
      return res.status(404).json({ success: false, error: 'Order not found', requestId });
    }

    const reqScope = FranchiseScopeService.resolveScope(req.user);
    if (orderBranchId && !FranchiseScopeService.isAuthorizedForBranch(reqScope, orderBranchId)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: You do not have authority over orders from branch ${orderBranchId}`,
        requestId
      });
    }

    // Idempotency check: if order was already preparing or beyond, return 200 without re-transitioning
    const currentStatus = orderData.status;
    if (['preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus)) {
      return res.json({
        success: true,
        message: `Order #${orderData.orderNumber || id} is already in progress (${currentStatus})`,
        orderId: id,
        status: currentStatus,
        duplicate: true,
        requestId
      });
    }

    if (currentStatus === 'cancelled' || currentStatus === 'rejected') {
      return res.status(409).json({
        success: false,
        error: `Order #${orderData.orderNumber || id} has already been cancelled`,
        status: currentStatus,
        requestId
      });
    }

    const targetPrepMinutes = Number(req.body?.estimatedPreparationMinutes ?? req.body?.prepMinutes) || undefined;
    const transitionMetadata = targetPrepMinutes ? { estimatedPreparationMinutes: targetPrepMinutes } : {};

    // Step 1: If pending, transition to accepted
    if (currentStatus === 'pending' || currentStatus === 'pending_acceptance') {
      const accResult = await OrderStateMachine.transition(id, 'accepted', { uid, role: effectiveRole, name, branchId: userBranchId || orderBranchId }, transitionMetadata);
      if (!accResult.success) {
        return res.status(400).json({ success: false, error: accResult.error, requestId });
      }
    }

    // Step 2: Transition to preparing
    const prepResult = await OrderStateMachine.transition(id, 'preparing', { uid, role: effectiveRole, name, branchId: userBranchId || orderBranchId }, transitionMetadata);
    if (!prepResult.success) {
      return res.status(400).json({ success: false, error: prepResult.error, requestId });
    }

    // Record immutable audit trail
    adminDb.collection('order_audit_logs').add({
      orderId: id,
      action: 'ORDER_ACCEPTED',
      actorUid: uid,
      actorRole: effectiveRole,
      actorName: name,
      branchId: orderBranchId,
      franchiseId: orderData.franchiseId || 'default',
      timestamp: new Date().toISOString(),
      previousStatus: currentStatus,
      newStatus: 'preparing',
      details: { requestId }
    }).catch(err => console.warn('[Audit] Failed to log order acceptance:', err.message));

    res.json({
      success: true,
      message: `Order #${orderData.orderNumber || id} accepted and baking started`,
      orderId: id,
      status: 'preparing',
      version: prepResult.version,
      requestId
    });
  } catch (error: any) {
    console.error('[Orders] Accept action failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to accept order', requestId });
  }
});

// Restaurant Manager / Staff Confirm or Adjust Prep Time (Bounded 5 - 90 min)
router.post('/:id/confirm-prep-time', verifyToken, async (req: AuthRequest, res: Response) => {
  const requestId = `req_prep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { id } = req.params;
    const userRole = (req.user?.role || '').toLowerCase();
    const emailLower = (req.user?.email || '').toLowerCase();
    const uid = req.user?.uid;
    const appTarget = ((req.headers['x-app-target'] || req.headers['x-app-source'] || '') as string).toUpperCase();

    // Owner Portal Read-Only Enforcement
    if (appTarget === 'OWNER') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Owner portal has read-only operational authority. Kitchen prep duration adjustment must be executed by restaurant managers.',
        requestId
      });
    }

    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';
    let effectiveRole = userRole;
    if (userRole === 'owner' || userRole === 'admin' || isMasterAccount) {
      effectiveRole = 'restaurant_manager';
    } else if (userRole === 'manager' || userRole === 'kitchen_manager' || userRole === 'chef') {
      effectiveRole = 'restaurant_manager';
    }

    const isAuthorizedStaff = ['restaurant_manager', 'cashier'].includes(effectiveRole);
    if (!isAuthorizedStaff || !uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized: Restaurant staff authorization required', requestId });
    }

    const rawMinutes = Number(req.body?.prepMinutes ?? req.body?.estimatedPreparationMinutes);
    if (isNaN(rawMinutes) || rawMinutes <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid preparation minutes. Must be a numeric value between 5 and 90.',
        requestId
      });
    }

    // Bounded between 5 and 90 minutes
    const prepMinutes = Math.min(90, Math.max(5, Math.round(rawMinutes)));

    const orderRef = adminDb.collection('orders').doc(id);
    let orderData: any = null;
    try {
      const orderDoc = await orderRef.get();
      if (orderDoc.exists) {
        orderData = orderDoc.data()!;
      }
    } catch (fsErr: any) {
      console.warn(`[Orders] Firestore read notice for /:id/confirm-prep-time:`, fsErr.message);
    }

    if (!orderData) {
      try {
        const { OrderPersistenceArchiveService } = await import('../services/order/OrderPersistenceArchiveService.js');
        orderData = await OrderPersistenceArchiveService.getHistoricalOrder(id);
      } catch (pgErr: any) {
        console.warn(`[Orders] PostgreSQL fallback notice for /:id/confirm-prep-time:`, pgErr.message);
      }
    }

    if (!orderData) {
      return res.status(404).json({ success: false, error: `Order #${id} not found`, requestId });
    }
    const currentStatus = orderData.status;
    if (!['pending', 'pending_acceptance', 'accepted', 'preparing'].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        error: `Cannot adjust preparation duration for order #${orderData.orderNumber || id} in state '${currentStatus}'.`,
        requestId
      });
    }

    // Derive authoritative deadline from preparingAt / acceptedAt
    const startTimeStr = orderData.preparingAt || orderData.acceptedAt || new Date().toISOString();
    const startTimeMs = new Date(startTimeStr).getTime();
    const newExpectedReadyAt = new Date(startTimeMs + prepMinutes * 60 * 1000).toISOString();

    const updates: Record<string, any> = {
      estimatedPreparationMinutes: prepMinutes,
      expectedReadyAt: newExpectedReadyAt,
      estimatedReadyAt: newExpectedReadyAt,
      updatedAt: new Date()
    };

    await orderRef.update(updates);

    // Sync to PostgreSQL canonical_orders
    try {
      await query(
        `UPDATE canonical_orders 
         SET estimated_preparation_minutes = $1, expected_ready_at = $2, updated_at = NOW() 
         WHERE order_id = $3 OR firestore_id = $3`,
        [prepMinutes, newExpectedReadyAt, id]
      );
    } catch (e: any) {
      console.warn('[Orders] PostgreSQL sync notice on prep adjustment:', e.message);
    }

    // Recalculate server-authoritative Delivery ETA dynamically
    let deliveryEta = null;
    let deliveryEtaMinutes = null;
    try {
      const { DeliveryEtaService } = await import('../services/delivery/DeliveryEtaService.js');
      const etaResult = await DeliveryEtaService.calculateDeliveryEta({
        orderId: id,
        orderData: { ...orderData, ...updates }
      });
      deliveryEta = etaResult?.deliveryEta || null;
      deliveryEtaMinutes = etaResult?.estimatedRemainingMinutes || null;
    } catch (e: any) {
      console.warn('[Orders] Delivery ETA calculation notice:', e.message);
    }

    res.json({
      success: true,
      orderId: id,
      estimatedPreparationMinutes: prepMinutes,
      expectedReadyAt: newExpectedReadyAt,
      deliveryEta,
      deliveryEtaMinutes,
      message: `Preparation time updated to ${prepMinutes} minutes. Expected ready at ${newExpectedReadyAt}.`,
      requestId
    });
  } catch (error: any) {
    console.error('[Orders] Confirm prep-time failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update preparation time', requestId });
  }
});

// Restaurant Manager / Staff Reject Order Action (From App or Notification Action)
router.post('/:id/reject', verifyToken, async (req: AuthRequest, res: Response) => {
  const requestId = `req_rej_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { id } = req.params;
    const userRole = (req.user?.role || '').toLowerCase();
    const emailLower = (req.user?.email || '').toLowerCase();
    const uid = req.user?.uid;
    const userBranchId = req.user?.branchId;
    const name = (req.user as any)?.name || req.user?.email || 'Manager';
    const appTarget = ((req.headers['x-app-target'] || req.headers['x-app-source'] || '') as string).toUpperCase();

    // Owner Portal Read-Only Enforcement
    if (appTarget === 'OWNER') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Owner portal has read-only operational authority. Kitchen order rejection must be executed by restaurant managers.',
        requestId
      });
    }

    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';
    let effectiveRole = userRole;
    if (userRole === 'owner' || userRole === 'admin' || isMasterAccount) {
      effectiveRole = 'restaurant_manager';
    } else if (userRole === 'manager' || userRole === 'kitchen_manager' || userRole === 'chef') {
      effectiveRole = 'restaurant_manager';
    }

    const isAuthorizedStaff = ['restaurant_manager', 'cashier'].includes(effectiveRole);
    if (!isAuthorizedStaff || !uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized: Restaurant staff authorization required', requestId });
    }

    let orderData: any = null;
    let orderBranchId = '';
    try {
      const orderDoc = await adminDb.collection('orders').doc(id).get();
      if (orderDoc.exists) {
        orderData = orderDoc.data()!;
        orderBranchId = orderData.branchId || '';
      }
    } catch (fsErr: any) {
      console.warn(`[Orders] Firestore read notice for /:id/reject:`, fsErr.message);
    }

    if (!orderData) {
      try {
        const { OrderPersistenceArchiveService } = await import('../services/order/OrderPersistenceArchiveService.js');
        orderData = await OrderPersistenceArchiveService.getHistoricalOrder(id);
        if (orderData) {
          orderBranchId = orderData.branchId || '';
        }
      } catch (pgErr: any) {
        console.warn(`[Orders] PostgreSQL fallback notice for /:id/reject:`, pgErr.message);
      }
    }

    if (!orderData) {
      return res.status(404).json({ success: false, error: 'Order not found', requestId });
    }

    const reqScope = FranchiseScopeService.resolveScope(req.user);
    if (orderBranchId && !FranchiseScopeService.isAuthorizedForBranch(reqScope, orderBranchId)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: You do not have authority over orders from branch ${orderBranchId}`,
        requestId
      });
    }

    const currentStatus = orderData.status;
    if (['preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus)) {
      return res.status(409).json({
        success: false,
        error: `Cannot reject order #${orderData.orderNumber || id} because it is already ${currentStatus}`,
        status: currentStatus,
        requestId
      });
    }

    const cancellationReason = req.body.reason || 'Restaurant is at full capacity';
    const result = await OrderStateMachine.transition(id, 'cancelled', { uid, role: effectiveRole, name, branchId: userBranchId || orderBranchId }, {
      cancellationReason,
      cancellationSource: 'restaurant_manager'
    });

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error, requestId });
    }

    // Record immutable audit trail
    adminDb.collection('order_audit_logs').add({
      orderId: id,
      action: 'ORDER_REJECTED',
      actorUid: uid,
      actorRole: effectiveRole,
      actorName: name,
      branchId: orderBranchId,
      franchiseId: orderData.franchiseId || 'default',
      timestamp: new Date().toISOString(),
      previousStatus: currentStatus,
      newStatus: 'cancelled',
      reason: cancellationReason,
      details: { requestId }
    }).catch(err => console.warn('[Audit] Failed to log order rejection:', err.message));

    res.json({
      success: true,
      message: `Order #${orderData.orderNumber || id} rejected successfully`,
      orderId: id,
      status: 'cancelled',
      version: result.version,
      requestId
    });
  } catch (error: any) {
    console.error('[Orders] Reject action failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to reject order', requestId });
  }
});

// Restaurant Manager / Staff / POS Acknowledge Order Action (Mutes alarm and records acknowledgement)
router.post('/:id/acknowledge', verifyToken, async (req: AuthRequest, res: Response) => {
  const requestId = `req_ack_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const { id } = req.params;
    const userRole = (req.user?.role || '').toLowerCase();
    const emailLower = (req.user?.email || '').toLowerCase();
    const uid = req.user?.uid;
    const userBranchId = req.user?.branchId;
    const name = (req.user as any)?.name || req.user?.email || 'Staff';
    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';

    let effectiveRole = userRole;
    if (userRole === 'owner' || userRole === 'admin' || isMasterAccount) {
      effectiveRole = 'restaurant_manager';
    } else if (userRole === 'manager' || userRole === 'kitchen_manager' || userRole === 'chef') {
      effectiveRole = 'restaurant_manager';
    }

    const isAuthorizedStaff = ['restaurant_manager', 'kitchen_staff', 'cashier', 'pos', 'delivery_partner'].includes(effectiveRole);
    if (!isAuthorizedStaff || !uid) {
      return res.status(403).json({ success: false, error: 'Unauthorized: Operational authorization required to acknowledge order', requestId });
    }

    const orderRef = adminDb.collection('orders').doc(id);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, error: 'Order not found', requestId });
    }

    const orderData = orderDoc.data()!;
    const orderBranchId = orderData.branchId || '';

    const reqScope = FranchiseScopeService.resolveScope(req.user);
    if (orderBranchId && !FranchiseScopeService.isAuthorizedForBranch(reqScope, orderBranchId)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: You do not have authority over orders from branch ${orderBranchId}`,
        requestId
      });
    }

    const nowIso = new Date().toISOString();
    await orderRef.update({
      isAcknowledged: true,
      acknowledgedAt: nowIso,
      acknowledgedBy: { uid, name, role: effectiveRole },
      alarmSilenced: true,
      updatedAt: nowIso
    });

    // Record immutable audit trail
    adminDb.collection('order_audit_logs').add({
      orderId: id,
      action: 'ORDER_ACKNOWLEDGED',
      actorUid: uid,
      actorRole: effectiveRole,
      actorName: name,
      branchId: orderBranchId,
      franchiseId: orderData.franchiseId || 'default',
      timestamp: nowIso,
      status: orderData.status,
      details: { requestId }
    }).catch(err => console.warn('[Audit] Failed to log order acknowledgement:', err.message));

    res.json({
      success: true,
      message: `Order #${orderData.orderNumber || id} acknowledged successfully`,
      orderId: id,
      isAcknowledged: true,
      acknowledgedAt: nowIso,
      requestId
    });
  } catch (error: any) {
    console.error('[Orders] Acknowledge action failed:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to acknowledge order', requestId });
  }
});


// Manual Assignment: Get eligible riders for order (Section 14)
router.get('/:id/eligible-riders', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { RiderDispatchEngine } = await import('../services/delivery/RiderDispatchEngine.js');
    const riders = await RiderDispatchEngine.findEligibleRiders(id);
    res.json({ success: true, orderId: id, riders });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to query eligible riders' });
  }
});

// Manual Assignment: Assign specific rider to order (Section 14)
router.post('/:id/assign-rider', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { riderId } = req.body;
    const userRole = (req.user?.role || '').toLowerCase();
    const uid = req.user?.uid;
    const name = (req.user as any)?.name || req.user?.email || 'Manager';
    
    const emailLower = (req.user?.email || '').toLowerCase();
    const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';
    const isAuthorized = ['owner', 'admin', 'manager', 'restaurant_manager'].includes(userRole) || isMasterAccount;

    if (!isAuthorized || !uid) {
      return res.status(403).json({ error: 'Unauthorized: Restaurant manager or owner role required' });
    }

    if (!riderId) return res.status(400).json({ error: 'riderId is required' });

    const { RiderDispatchEngine } = await import('../services/delivery/RiderDispatchEngine.js');
    const eligibleRiders = await RiderDispatchEngine.findEligibleRiders(id);
    const selected = eligibleRiders.find(r => r.uid === riderId);

    if (!selected) {
      return res.status(400).json({ error: 'Selected rider is ineligible (offline, busy, or out of branch radius).' });
    }

    const { adminDb } = await import('../config/firebase.js');
    let riderDoc = await adminDb.collection('users').doc(riderId).get();
    let rData = riderDoc.data() || {};
    if (!riderDoc.exists) {
      const dpDoc = await adminDb.collection('delivery_partners').doc(riderId).get();
      if (dpDoc.exists) {
        rData = dpDoc.data() || {};
      }
    }

    const nowIso = new Date().toISOString();
    const result = await OrderStateMachine.transition(id, 'partner_assigned', { uid: uid || 'system', role: userRole || 'restaurant_manager', name }, {
      deliveryPartnerId: riderId,
      deliveryPartnerName: rData.name || rData.displayName || 'Rider',
      deliveryPartnerPhone: rData.phone || rData.phoneNumber || '+91 91799 44445',
      partnerAssignedAt: nowIso,
      expectedPickupAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    if (!result.success) return res.status(400).json({ error: result.error });

    // Mark activeOrderId on rider record to enforce single assignment
    adminDb.collection('users').doc(riderId).set({ activeOrderId: id }, { merge: true }).catch(() => {});
    adminDb.collection('delivery_partners').doc(riderId).set({ activeOrderId: id }, { merge: true }).catch(() => {});

    // Notify Rider
    const { notificationEngine } = await import('../services/notification/NotificationEngine.js');
    await notificationEngine.send(riderId, {
      notification: {
        title: '🛵 New Delivery Assigned!',
        body: `Order #${id.slice(-6)} has been assigned to you.`,
      },
      data: { orderId: id, type: 'rider_assignment' }
    }, { category: 'alarm_actionable', priority: 'critical', orderId: id, targetApp: 'delivery' });

    res.json({ success: true, orderId: id, status: 'partner_assigned', rider: { id: riderId, name: rData.name } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:id/replace-rider
 * Executes the multi-order replacement saga & physical handover protocol (Rules BR-02, BR-03, BR-10).
 */
router.post('/:id/replace-rider', requireRole(['restaurant_manager', 'franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { oldRiderId, replacementRiderId, reason, idempotencyKey } = req.body;

    if (!oldRiderId) {
      res.status(400).json({ error: 'oldRiderId is required' });
      return;
    }
    if (!replacementRiderId) {
      res.status(400).json({ error: 'replacementRiderId is required' });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ error: 'A valid reason is required for rider replacement' });
      return;
    }

    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: id,
      oldRiderId,
      replacementRiderId,
      reason,
      initiatedByUid: req.user!.uid,
      initiatedByRole: req.user!.role || 'restaurant_manager',
      idempotencyKey
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Order Routes] replace-rider error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * POST /:id/handover-confirm
 * Receiving rider confirms physical custody transfer of an active delivery (Rule BR-10).
 */
router.post('/:id/handover-confirm', requireRole(['delivery', 'delivery_partner', 'owner', 'restaurant_manager', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { handoverId, receivingRiderId, latitude, longitude, notes } = req.body;

    const result = await RiderReplacementSagaService.confirmPhysicalHandover({
      orderId: id,
      handoverId,
      receivingRiderId: receivingRiderId || req.user!.uid,
      latitude,
      longitude,
      notes
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Order Routes] /:id/handover-confirm error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});


// ─── POST /:id/rating — Customer Post-Delivery Rating ───────────────────────
router.post('/:id/rating', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid;
    const { foodRating } = req.body;
    const overallRating = Number(req.body.overallRating || req.body.score || req.body.rating || 0);
    const deliveryRating = Number(req.body.deliveryRating || req.body.score || overallRating);
    const comment = req.body.comment || req.body.review || '';

    if (!overallRating || overallRating < 1 || overallRating > 5) {
      res.status(400).json({ error: 'Valid rating (1-5) is required.' });
      return;
    }

    const orderRef = adminDb.collection('orders').doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const orderData = snap.data()!;
    if (orderData.userId !== userId && req.user?.role !== 'owner' && req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: You can only rate your own orders.' });
      return;
    }

    if (String(orderData.status || '').toLowerCase() !== 'delivered') {
      res.status(400).json({ error: 'Only completed and delivered orders can be rated.', code: 'ORDER_NOT_DELIVERED' });
      return;
    }

    if (orderData.isRated === true) {
      res.status(400).json({ error: 'This order has already been rated.', code: 'ORDER_ALREADY_RATED' });
      return;
    }

    const ratingRecord = {
      orderId: id,
      userId,
      customerName: orderData.customerName || 'Customer',
      foodRating: Number(foodRating || overallRating),
      deliveryRating,
      overallRating,
      comment: comment ? String(comment).trim() : '',
      branchId: orderData.branchId || null,
      deliveryPartnerId: orderData.deliveryPartnerId || null,
      createdAt: new Date().toISOString(),
    };

    await adminDb.collection('order_ratings').add(ratingRecord);
    await orderRef.update({
      isRated: true,
      rating: ratingRecord,
      deliveryRating: {
        score: deliveryRating,
        review: comment,
        createdAt: ratingRecord.createdAt
      },
      updatedAt: new Date(),
    });

    // Authoritative Server-Side Delivery Partner Metrics Update
    if (orderData.deliveryPartnerId) {
      try {
        const partnerRef = adminDb.collection('users').doc(orderData.deliveryPartnerId);
        await adminDb.runTransaction(async (t) => {
          const pSnap = await t.get(partnerRef);
          if (pSnap.exists) {
            const pData = pSnap.data() || {};
            const currentMetrics = pData.metrics || {};
            const newRatingSum = (Number(currentMetrics.ratingSum) || 0) + deliveryRating;
            const newRatingCount = (Number(currentMetrics.ratingCount) || 0) + 1;
            t.update(partnerRef, {
              'metrics.ratingSum': newRatingSum,
              'metrics.ratingCount': newRatingCount,
              'metrics.averageRating': Number((newRatingSum / newRatingCount).toFixed(1))
            });
          }
        });
      } catch (pErr: any) {
        console.warn('[Orders] Partner rating metric update notice:', pErr?.message);
      }
    }

    res.json({ success: true, message: 'Thank you for your rating!', rating: ratingRecord });
  } catch (err: any) {
    console.error('[Orders] Rating error:', err);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// ─── POST /:id/reorder — 1-Click Reorder with Fresh Pricing & Stock Check ───
router.post('/:id/reorder', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid;

    const snap = await adminDb.collection('orders').doc(id).get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Original order not found' });
      return;
    }

    const oldOrder = snap.data()!;
    const isOwnerOrStaff = ['owner', 'admin', 'restaurant_manager', 'franchise_owner', 'cashier', 'kitchen_staff', 'developer', 'platform_owner'].includes(req.user?.role || '');
    const isCustomerOwner = (oldOrder.userId === userId || oldOrder.customerUid === userId);

    if (!isOwnerOrStaff && !isCustomerOwner) {
      res.status(403).json({ error: 'Access denied: You can only reorder your own orders' });
      return;
    }

    const items = oldOrder.items || [];
    if (!items || items.length === 0) {
      res.status(400).json({ error: 'No items in original order to reorder' });
      return;
    }

    // Revalidate items against current catalog
    const freshItems: any[] = [];
    let serverCalculatedTotal = 0;

    for (const it of items) {
      const itemId = it.menuItemId || it.id;
      let currentPrice = Number(it.price || 0);
      let isAvailable = true;

      if (itemId && typeof itemId === 'string' && !itemId.startsWith('item-')) {
        const prodSnap = await adminDb.collection('products').doc(itemId).get();
        if (prodSnap.exists) {
          const pData = prodSnap.data()!;
          if (pData.isAvailable === false || pData.isActive === false) isAvailable = false;
          currentPrice = Number(pData.offerPrice || pData.basePrice || pData.price || currentPrice);
        }
      }

      if (!isAvailable) {
        res.status(400).json({ error: `Item '${it.name}' is currently unavailable for reorder.` });
        return;
      }

      const qty = Number(it.quantity || 1);
      serverCalculatedTotal += currentPrice * qty;
      freshItems.push({
        ...it,
        price: currentPrice,
        quantity: qty,
      });
    }

    res.json({
      success: true,
      message: 'Reorder validated with current catalog prices',
      reorderItems: freshItems,
      subtotal: serverCalculatedTotal,
      taxes: Math.round(serverCalculatedTotal * 0.05),
      deliveryAddress: oldOrder.deliveryAddress,
      deliveryType: oldOrder.deliveryType || 'delivery',
    });
  } catch (err: any) {
    console.error('[Orders] Reorder error:', err);
    res.status(500).json({ error: 'Failed to prepare reorder' });
  }
});

// ─── POST /:id/acknowledge-cancellation — Customer Views/Acknowledges Cancelled Order ───
router.post('/:id/acknowledge-cancellation', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid;
    const orderRef = adminDb.collection('orders').doc(id);
    const snap = await orderRef.get();

    if (!snap.exists) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const orderData = snap.data()!;
    // Ownership check: only the customer who placed the order (or admin/owner) can acknowledge
    if (orderData.userId !== userId && !['owner', 'admin', 'developer'].includes(req.user?.role || '')) {
      res.status(403).json({ success: false, error: 'Forbidden: You do not own this order' });
      return;
    }

    await orderRef.update({
      cancellationAcknowledged: true,
      cancellationAcknowledgedAt: new Date().toISOString()
    });

    res.json({ success: true, message: 'Cancellation acknowledged successfully' });
  } catch (err: any) {
    console.error('[Orders] Acknowledge cancellation error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to acknowledge cancellation' });
  }
});

// ─── GET /:id/rider-contact — Authenticated Secure Endpoint to Retrieve Assigned Rider Contact ───
router.get('/:id/rider-contact', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.uid;
    const orderRef = adminDb.collection('orders').doc(id);
    const snap = await orderRef.get();

    if (!snap.exists) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const orderData = snap.data()!;
    const isStaff = ['owner', 'admin', 'developer', 'restaurant_manager', 'manager'].includes(req.user?.role || '');

    // Authorization: Only customer who placed the order or staff can access rider contact
    if (orderData.userId !== userId && !isStaff) {
      res.status(403).json({ success: false, error: 'Forbidden: Unauthorized access to order details' });
      return;
    }

    // Check if order has reached a terminal state
    const status = (orderData.status || '').toLowerCase();
    if (['delivered', 'cancelled', 'rejected', 'completed'].includes(status)) {
      res.status(400).json({ success: false, error: 'Order is no longer active' });
      return;
    }

    const riderId = orderData.deliveryPartnerId;
    if (!riderId) {
      res.json({
        success: true,
        assigned: false,
        message: 'No delivery partner assigned yet'
      });
      return;
    }

    // Retrieve rider verified contact info
    const riderDoc = await adminDb.collection('users').doc(riderId).get();
    const riderData = riderDoc.exists ? riderDoc.data()! : {};

    const riderPhone = riderData.phone || riderData.phoneNumber || orderData.deliveryPartnerPhone || '';
    const riderName = riderData.name || riderData.displayName || orderData.deliveryPartnerName || 'Delivery Partner';
    const vehicleNumber = riderData.vehicleNumber || orderData.deliveryVehicleNumber || '';

    res.json({
      success: true,
      assigned: true,
      rider: {
        name: riderName,
        phone: riderPhone,
        vehicleNumber
      }
    });
  } catch (err: any) {
    console.error('[Orders] Get rider contact error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch rider contact' });
  }
});

export default router;

