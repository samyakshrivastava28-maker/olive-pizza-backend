import { Router, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { verifyToken, AuthRequest, requireRole } from '../middleware/auth.middleware.js';
import { idempotency } from '../middleware/idempotency.middleware.js';
import { POSService } from '../services/pos/POSService.js';
import { ESCPOSFormatter, ReceiptData } from '../services/pos/ESCPOSFormatter.js';
import { FranchiseGoogleSheetsService } from '../services/reports/FranchiseGoogleSheetsService.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { SheetsSyncWorker } from '../services/reports/SheetsSyncWorker.js';
import { POSTelemetryHealthService } from '../services/pos/POSTelemetryHealthService.js';
import { orderEventService } from '../services/order/OrderEventService.js';
import { OwnerTemplates, CustomerTemplates } from '../services/notification/NotificationTemplates.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { CanonicalOrderService } from '../services/pos/CanonicalOrderService.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { SalesCalculationEngine } from '../services/reports/SalesCalculationEngine.js';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { POSShiftRepository } from '../repositories/posShift.repository.js';
import { query } from '../lib/db.js';
import { FranchisePricingSyncService } from '../services/menu/FranchisePricingSyncService.js';
import { PaymentService } from '../services/payment/PaymentService.js';
import crypto from 'crypto';
import net from 'net';

const router = Router();

// Middleware: Require POS Operational authorization (Owner, Franchise Manager, or approved POS operator)
const requirePOSRole = async (req: AuthRequest, res: Response, next: any): Promise<void> => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const emailLower = (user.email || '').toLowerCase().trim();
  const isOwnerRole =
    user.role === 'owner' ||
    user.role === 'platform_owner' ||
    user.role === 'admin' ||
    user.role === 'developer';

  // 1. Owner & Admin Accounts: Operational and terminal access requiring explicit POS grant
  if (isOwnerRole) {
    const allowedApps = Array.isArray((user as any).allowedApps) ? (user as any).allowedApps : [];
    const hasPosAppGrant = allowedApps.map((a: any) => String(a).toUpperCase()).includes('POS');
    if (!hasPosAppGrant) {
      res.status(403).json({ error: 'Forbidden: POS operational access requires an explicit active POS app grant.', code: 'APP_ACCESS_DENIED' });
      return;
    }

    const requestedBranchId = (req.headers['x-branch-id'] || req.query.branchId || req.body?.branchId || user.branchId) as string;
    const requestedFranchiseId = (req.headers['x-franchise-id'] || req.query.franchiseId || req.body?.franchiseId || user.franchiseId) as string;

    if (!requestedBranchId || !requestedFranchiseId) {
      res.status(400).json({ error: 'Bad Request: Missing branchId or franchiseId scope for POS session.', code: 'MISSING_POS_SCOPE' });
      return;
    }

    req.user.franchiseId = requestedFranchiseId;
    req.user.branchId = requestedBranchId;
    req.user.terminalId = (req.headers['x-terminal-id'] || user.terminalId || `pos_${requestedFranchiseId}`) as string;
    next();
    return;
  }

  // 2. Staff Accounts Authorized by Owner
  const allowedPosRoles = ['pos_operator', 'cashier'];
  let isAuthorized = allowedPosRoles.includes(user.role);

  // Check user.allowedApps
  if (!isAuthorized) {
    const allowedApps = Array.isArray((user as any).allowedApps) ? (user as any).allowedApps : [];
    if (allowedApps.map((a: any) => String(a).toUpperCase()).includes('POS')) {
      isAuthorized = true;
    }
  }

  // Check PostgreSQL app_users for authoritative grant
  if (!isAuthorized) {
    try {
      const pgUserRes = await query(
        `SELECT role, franchise_id, branch_id, allowed_apps, is_active, status FROM app_users WHERE (email IS NOT NULL AND LOWER(email) = $1) OR id = $2 LIMIT 1`,
        [emailLower, user.uid]
      );
      if (pgUserRes.rows.length > 0) {
        const pgUser = pgUserRes.rows[0];
        if (pgUser.is_active === false || pgUser.status === 'REVOKED' || pgUser.status === 'SUSPENDED' || pgUser.status === 'DISABLED') {
          res.status(403).json({ error: 'Forbidden: Account has been deactivated or revoked', code: 'ACCOUNT_REVOKED' });
          return;
        }
        const pgApps: string[] = Array.isArray(pgUser.allowed_apps) ? pgUser.allowed_apps : [];
        if (pgApps.map(a => String(a).toUpperCase()).includes('POS') || allowedPosRoles.includes(pgUser.role)) {
          isAuthorized = true;
          if (pgUser.franchise_id && !user.franchiseId) user.franchiseId = pgUser.franchise_id;
          if (pgUser.branch_id && !user.branchId) user.branchId = pgUser.branch_id;
        }
      }
    } catch (pgErr: any) {
      console.error('[requirePOSRole] PostgreSQL authoritative check failure:', pgErr.message);
      res.status(503).json({ error: 'Database unavailable: Authoritative check failed', code: 'DATABASE_UNAVAILABLE' });
      return;
    }
  }

  if (!isAuthorized) {
    res.status(403).json({
      error: 'Forbidden: POS access requires cashier or pos_operator role, or an explicit POS grant in PostgreSQL.',
      code: 'APP_ACCESS_DENIED'
    });
    return;
  }

  // Enforce server-authoritative franchise and branch scope
  let franchiseId = user.franchiseId;
  let branchId = user.branchId;

  if (!franchiseId || !branchId) {
    try {
      const uDoc = await adminDb.collection('users').doc(user.uid).get();
      if (uDoc.exists) {
        const uData = uDoc.data()!;
        franchiseId = franchiseId || uData.franchiseId;
        branchId = branchId || uData.branchId;
      }
    } catch {}
  }

  if (!franchiseId) {
    franchiseId = 'fra_primary';
  }
  if (!branchId) {
    branchId = 'main_branch';
  }

  // Check if franchise has POS enabled (only block if explicitly false)
  try {
    const fraSnap = await adminDb.collection('franchises').doc(franchiseId).get();
    if (fraSnap.exists) {
      const fData = fraSnap.data()!;
      if (fData.posEnabled === false) {
        res.status(403).json({
          error: 'Forbidden: POS is not enabled for this franchise. A Franchise Manager must request POS access.'
        });
        return;
      }
      if (!branchId) {
        branchId = fData.primaryBranchId || fData.branchId || franchiseId;
      }
    }
  } catch {
    // Database transient error - continue with resolved parameters
  }

  req.user.franchiseId = franchiseId;
  req.user.branchId = branchId;
  req.user.terminalId = user.terminalId || `pos_${franchiseId}`;

  next();
};

// ============================================================================
// 1. POS SESSION & TERMINAL INFO
// ============================================================================
router.get('/session', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const terminalId = user.terminalId || `pos_${user.franchiseId}`;
    const branchId = user.branchId!;
    const franchiseId = user.franchiseId!;

    // Retrieve active shift if any
    const activeShift = await POSService.getActiveShift(branchId, terminalId);

    // Retrieve branch details
    let branchName = 'Olive Pizza';
    let branchAddress = '';
    let branchPhone = '';
    let gstNumber = '';

    try {
      const branchSnap = await adminDb.collection('franchises').doc(franchiseId).get();
      if (branchSnap.exists) {
        const bData = branchSnap.data()!;
        branchName = bData.name || branchName;
        branchAddress = bData.address || branchAddress;
        branchPhone = bData.phone || branchPhone;
        gstNumber = bData.gstNumber || gstNumber;
      }
    } catch {}

    res.json({
      success: true,
      session: {
        cashierUid: user.uid,
        cashierName: user.email?.split('@')[0] || 'Cashier',
        cashierEmail: user.email,
        role: user.role,
        terminalId,
        branchId,
        branchName,
        branchAddress,
        branchPhone,
        gstNumber,
        franchiseId,
        activeShift
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 2. FAST POS MENU (Categorized with stock & customization options)
// ============================================================================
// ============================================================================
// 2. FAST POS MENU (Branch-scoped, channel-filtered with stock & customizations)
// ============================================================================
router.get('/menu', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    
    // Effective branch: Owner can pass ?branchId=...; Cashiers are strictly scoped
    const requestedBranchId = (req.query.branchId as string) || (req.headers['x-branch-id'] as string);
    const effectiveBranchId = isOwner && requestedBranchId ? requestedBranchId : user.branchId!;
    const effectiveFranchiseId = isOwner && req.query.franchiseId ? (req.query.franchiseId as string) : user.franchiseId!;

    const itemsMap = new Map<string, any>();

    // 1. Fetch Master Products
    const pSnap = await adminDb.collection('products').get();
    let masterProducts = pSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 2. Fetch Branch Menu Overrides (Firestore + PostgreSQL)
    const oSnap = await adminDb.collection('branch_menu_overrides')
      .where('branchId', '==', effectiveBranchId)
      .get()
      .catch(() => ({ docs: [] } as any));

    const overridesMap = new Map<string, any>();
    oSnap.docs.forEach((d: any) => overridesMap.set(d.data().productId, d.data()));

    // Merge with PostgreSQL canonical franchise prices
    try {
      const pgPricesMap = await FranchisePricingSyncService.getBranchPricesMap(effectiveBranchId);
      for (const [pId, pData] of pgPricesMap.entries()) {
        const existing = overridesMap.get(pId) || {};
        overridesMap.set(pId, {
          ...existing,
          customPrice: pData.sellingPrice,
          sellingPrice: pData.sellingPrice,
          isEnabledForBranch: pData.isAvailable ?? existing.isEnabledForBranch ?? true,
          version: pData.version
        });
      }
    } catch (pgErr: any) {
      console.warn('[POSMenu] Postgres franchise_prices lookup warning:', pgErr?.message);
    }

    masterProducts.forEach((mp: any) => {
      const override = overridesMap.get(mp.id);
      
      // Branch Enabled Check: defaults to true unless explicitly disabled for branch
      const isEnabledForBranch = override ? (override.isEnabledForBranch ?? override.isAvailable ?? true) : (mp.isActive ?? mp.isAvailable ?? true);
      if (!isEnabledForBranch) return;

      // Channel Check: Product must be available on at least one POS channel (Dine-In, Takeaway, or POS Delivery)
      const channels = override?.channelAvailability || mp.channelAvailability || {
        online: true,
        dineIn: true,
        takeaway: true,
        posDelivery: true
      };

      const hasPOSChannel = channels.dineIn || channels.takeaway || channels.posDelivery || (!channels.online && !channels.dineIn && !channels.takeaway ? true : false);
      if (!hasPOSChannel) return;

      // Stock Status Check
      const stockStatus = override?.stockStatus || (mp.isAvailable !== false ? 'IN_STOCK' : 'OUT_OF_STOCK');
      const isAvailable = stockStatus === 'IN_STOCK';

      const customPrice = override?.customPrice ?? override?.sellingPrice;
      const basePrice = (customPrice !== undefined && customPrice !== null && !isNaN(Number(customPrice)))
        ? Number(customPrice)
        : Number(mp.basePrice || mp.price || 249);
      const offerPrice = mp.offerPrice ? Number(mp.offerPrice) : undefined;
      const price = offerPrice && offerPrice > 0 && offerPrice < basePrice ? offerPrice : basePrice;

      let name = String(mp.productName || mp.name || mp.title || '').trim();
      if (!name || name.toLowerCase() === 'pizza') name = 'Artisan Pizza';


      itemsMap.set(mp.id, {
        id: mp.id,
        name,
        productName: name,
        description: mp.description || 'Olive Pizza Stone Oven specialty.',
        basePrice: price,
        price,
        customPrice: customPrice !== undefined && !isNaN(Number(customPrice)) ? Number(customPrice) : undefined,
        version: override?.version || 1,
        category: mp.category || 'Veg Pizzas',
        image: mp.imageUrl || mp.image || '',
        imageUrl: mp.imageUrl || mp.image || '',
        isVegetarian: mp.isVegetarian ?? true,
        stockStatus,
        isAvailable,
        channelAvailability: channels,
        isPhysicalOnly: !channels.online,
        variants: override?.allowedSizes || mp.variants || [
          { name: '8" Regular', price: 0 },
          { name: '10" Medium', price: 90 },
          { name: '12" Large', price: 180 }
        ],
        crusts: override?.allowedCrusts || mp.crusts || [
          { name: 'Classic Hand-Tossed', price: 0 },
          { name: 'Thin & Crispy', price: 40 },
          { name: 'Cheese Burst', price: 80 }
        ],
        addons: override?.allowedAddons || mp.addons || [
          { id: 'add_cheese', name: 'Extra Mozzarella', price: 60 },
          { id: 'add_paneer', name: 'Fresh Paneer', price: 50 },
          { id: 'add_olives', name: 'Sliced Olives', price: 40 },
          { id: 'add_mushrooms', name: 'Grilled Mushrooms', price: 40 },
          { id: 'add_jalapenos', name: 'Jalapenos', price: 30 }
        ]
      });
    });

    // 3. Fetch Combos
    try {
      const cSnap = await adminDb.collection('combos').get();
      cSnap.docs.forEach((doc) => {
        const data = doc.data();
        const isActive = data.isActive ?? data.isAvailable ?? true;
        if (!isActive) return;

        const price = Number(data.price ?? data.offerPrice ?? data.basePrice ?? 499);
        const name = String(data.name || data.title || data.comboName || 'Artisan Combo').trim();

        itemsMap.set(doc.id, {
          id: doc.id,
          name,
          productName: name,
          description: data.description || 'Special curated pizza & beverage combo.',
          basePrice: price,
          price,
          category: 'Combos & Deals',
          image: data.imageUrl || data.image || '',
          imageUrl: data.imageUrl || data.image || '',
          isVegetarian: true,
          stockStatus: 'IN_STOCK',
          isAvailable: true,
          isComboOnly: true,
          variants: [],
          crusts: [],
          addons: []
        });
      });
    } catch (cErr: any) {
      console.warn('[POSMenu] Combos fetch warning:', cErr.message);
    }

    const items = Array.from(itemsMap.values());
    res.json({
      success: true,
      branchId: effectiveBranchId,
      franchiseId: effectiveFranchiseId,
      count: items.length,
      items
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 3. SERVER-AUTHORITATIVE BILL CALCULATION
// ============================================================================
router.post('/calculate', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { items, orderType, discountAmount, couponCode } = req.body;
    if (!items || !Array.isArray(items)) {
      res.status(400).json({ success: false, error: 'Items array is required' });
      return;
    }

    const calculation = await POSService.calculateBill({
      items,
      orderType: orderType || 'DINE_IN',
      discountAmount,
      couponCode,
      branchId: user.branchId || undefined
    });

    res.json({ success: true, ...calculation });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4. POS ORDER CREATION & BILL FINALIZATION
// ============================================================================
router.post('/orders', verifyToken, requirePOSRole, idempotency(), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const {
      items,
      orderType,
      tableNumber,
      customerName,
      customerPhone,
      deliveryAddress,
      paymentMethod,
      amountReceived,
      changeDue,
      edcAuthCode,
      discountAmount,
      couponCode,
      notes,
      terminalId: reqTerminalId
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, error: 'Cannot place an empty bill' });
      return;
    }

    const branchId = user.branchId!;
    let franchiseId = user.franchiseId!;

    // Enforce branch ownership validation against authenticated franchise tenant
    try {
      const branchAuthCheck = await query(
        `SELECT id, franchise_id, is_open FROM restaurant_branches WHERE id = $1 LIMIT 1`,
        [branchId]
      );
      if (branchAuthCheck.rows.length === 0) {
        res.status(403).json({
          success: false,
          error: `Forbidden: Branch "${branchId}" does not exist in authorized restaurant records.`
        });
        return;
      }
      const trustedBranchFranchise = branchAuthCheck.rows[0].franchise_id;
      if (franchiseId) {
        if (!trustedBranchFranchise) {
          res.status(403).json({
            success: false,
            error: `Forbidden: Branch "${branchId}" has no assigned franchise ownership. Operation rejected.`
          });
          return;
        }
        if (trustedBranchFranchise !== franchiseId) {
          res.status(403).json({
            success: false,
            error: `Forbidden: Cross-franchise access rejected. Branch "${branchId}" belongs to franchise "${trustedBranchFranchise}", not "${franchiseId}".`
          });
          return;
        }
      }
      franchiseId = trustedBranchFranchise || franchiseId;
    } catch (authErr: any) {
      console.error('[POS Orders] Branch authorization query failed:', authErr.message || authErr);
      res.status(500).json({
        success: false,
        error: `Database authorization failure verifying branch "${branchId}". Operation rejected.`
      });
      return;
    }

    // Server-authoritative calculation
    const resolvedOrderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' = 
      ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(orderType) ? orderType : 'DINE_IN';

    const calc = await POSService.calculateBill({
      items,
      orderType: resolvedOrderType,
      discountAmount,
      couponCode,
      branchId
    });

    const terminalId = user.terminalId || `pos_${user.franchiseId}`;
    let branchName = 'Olive Pizza';

    try {
      const bDoc = await adminDb.collection('franchises').doc(branchId).get();
      if (bDoc.exists) {
        const bData = bDoc.data()!;
        branchName = bData.name || branchName;
        franchiseId = franchiseId || bData.franchiseId;
      }
    } catch (bErr) {
      console.warn('[POS] Branch lookup notice:', bErr);
    }
    const cashierName = user.email?.split('@')[0] || 'Counter Cashier';

    // Typed Payment Validation Contract:
    // Resolve mismatch between nested paymentDetails and top-level fields
    const paymentDetails = req.body.paymentDetails || {};
    const rawMethod = (paymentDetails.method || paymentMethod || 'CASH').toString().toUpperCase();
    const resolvedPaymentMethod: 'CASH' | 'UPI' | 'CARD' | 'SPLIT' = 
      ['CASH', 'UPI', 'CARD', 'SPLIT'].includes(rawMethod) ? (rawMethod as any) : 'CASH';

    // Server-side validate cash tender & change due
    const cashReceived = Number(paymentDetails.cashReceived ?? amountReceived ?? 0);
    const serverChangeDue = cashReceived >= calc.finalTotal ? parseFloat((cashReceived - calc.finalTotal).toFixed(2)) : 0;

    // Generate or retain target order ID for payment binding & canonical idempotency
    const incomingOrderId = (req.body.id || req.body.orderId || '').toString().trim();
    const orderId = incomingOrderId || ('pos_' + crypto.randomUUID().slice(0, 12));

    let paymentStatus: 'PAID' | 'PENDING' | 'PARTIAL' | 'FAILED' = 'PENDING';

    if (resolvedPaymentMethod === 'CASH') {
      if (cashReceived >= (calc.finalTotal - 0.05)) {
        paymentStatus = 'PAID';
      } else {
        paymentStatus = 'PARTIAL'; // Underpaid cash tender
      }
    } else if (resolvedPaymentMethod === 'CARD' || resolvedPaymentMethod === 'UPI') {
      // Server-verified payments and anti-reuse binding:
      // Client-supplied flags (isCardVerified, isUpiVerified, verified) and arbitrary reference strings (edcAuthCode, upiRef, transactionId)
      // are NEVER trusted as proof of payment.
      // Payment can only be marked PAID if a captured server-side record exists in PostgreSQL `payments`
      // covering the required total and is atomically bound to this target order ID without having been consumed by another order.
      const paymentRef = (paymentDetails.paymentId || req.body.paymentId || paymentDetails.providerTransactionId || req.body.providerTransactionId || '').toString().trim();
      let isVerifiedByServer = false;
      if (paymentRef) {
        const bindRes = await PaymentService.verifyAndBindCapturedPayment({
          paymentRef,
          targetOrderId: orderId,
          expectedAmount: calc.finalTotal,
          expectedMethod: resolvedPaymentMethod,
        });
        isVerifiedByServer = bindRes.verified;
        if (!bindRes.verified && bindRes.reason === 'ALREADY_CONSUMED') {
          console.warn(`[POS Order] Payment settlement rejected: Payment ${paymentRef} is already bound to another order.`);
        }
      }

      // Reject forged success attempts and uncaptured/already-consumed payments
      paymentStatus = isVerifiedByServer ? 'PAID' : 'PENDING';
    } else if (resolvedPaymentMethod === 'SPLIT') {
      const splitCash = Number(paymentDetails.splitCash ?? 0);
      const splitDigital = Number(paymentDetails.splitUPI ?? paymentDetails.splitDigital ?? 0);
      const digitalRef = (paymentDetails.paymentId || req.body.paymentId || paymentDetails.providerTransactionId || '').toString().trim();
      let isDigitalVerifiedByServer = false;
      if (digitalRef && splitDigital > 0) {
        const bindRes = await PaymentService.verifyAndBindCapturedPayment({
          paymentRef: digitalRef,
          targetOrderId: orderId,
          expectedAmount: splitDigital,
        });
        isDigitalVerifiedByServer = bindRes.verified;
      }

      if (splitCash + splitDigital >= (calc.finalTotal - 0.05)) {
        paymentStatus = (splitDigital === 0 || isDigitalVerifiedByServer) ? 'PAID' : 'PARTIAL';
      } else {
        paymentStatus = 'PARTIAL';
      }
    } else {
      // Unrecognized methods must never default to PAID!
      paymentStatus = 'PENDING';
    }

    // Map orderSource
    const orderSourceMap: Record<string, string> = {
      DINE_IN: 'POS_DINE_IN',
      TAKEAWAY: 'POS_TAKEAWAY',
      DELIVERY: 'POS_DELIVERY'
    };
    const orderSource = (orderSourceMap[resolvedOrderType] || 'POS_DINE_IN') as any;

    // Authoritative PostgreSQL Order, Immutable Item Snapshot & Permanent Bill Creation
    const canonical = await CanonicalOrderService.createCanonicalOrder({
      id: orderId,
      orderSource,
      orderType: resolvedOrderType.toLowerCase() as any,
      customerName: customerName || (resolvedOrderType === 'DINE_IN' ? `Table ${tableNumber || 'Guest'}` : 'Walk-in Customer'),
      customerPhone: customerPhone || 'N/A',
      deliveryAddress: resolvedOrderType === 'DELIVERY' ? deliveryAddress : undefined,
      tableNumber: resolvedOrderType === 'DINE_IN' ? (tableNumber || 'T-1') : undefined,
      items: calc.items.map(it => ({
        menuItemId: it.menuItemId || it.id,
        name: it.name,
        price: it.price,
        quantity: it.quantity,
        size: it.size || 'Regular',
        crust: it.crust || 'Normal',
        addons: it.addons || []
      })),
      subtotal: calc.subtotal,
      discountAmount: calc.discountAmount,
      couponCode: calc.couponCode || undefined,
      taxAmount: calc.taxes,
      cgst: calc.cgst,
      sgst: calc.sgst,
      deliveryFee: calc.deliveryFee,
      totalAmount: calc.finalTotal,
      paymentMethod: resolvedPaymentMethod,
      paymentStatus,
      orderStatus: resolvedOrderType === 'DINE_IN' ? 'preparing' : 'pending_acceptance',
      franchiseId,
      branchId,
      cashierId: user.uid,
      cashierName,
      terminalId,
      notes: notes || ''
    });

    const newOrderId = canonical.id;
    const permanentBillNo = canonical.permanentBillNo;
    const dailyOrderNumber = canonical.dailyOrderNo;
    const orderNumber = `#${dailyOrderNumber}`;
    const billNumber = `#${permanentBillNo}`;
    const today = canonical.orderDate;

    // Consistent Payment Status (Defect 2):
    // Use the exact same validated payment outcome in PostgreSQL and the Firestore projection.
    const finalValidatedPaymentStatus = paymentStatus;

    const orderDocData = {
      id: newOrderId,
      permanentBillNo,
      billNumber,
      dailyOrderNumber,
      orderNumber,
      orderDateLocal: today,
      userId: user.uid,
      customerName: customerName || (resolvedOrderType === 'DINE_IN' ? `Table ${tableNumber || 'Guest'}` : 'Walk-in Customer'),
      contactPhone: customerPhone || 'N/A',
      items: calc.items,
      subtotal: calc.subtotal,
      discountAmount: calc.discountAmount,
      couponCode: calc.couponCode,
      taxes: calc.taxes,
      cgst: calc.cgst,
      sgst: calc.sgst,
      deliveryFee: calc.deliveryFee,
      totalAmount: calc.finalTotal,
      finalTotal: calc.finalTotal,
      status: resolvedOrderType === 'DINE_IN' ? 'preparing' : 'pending_acceptance',
      paymentMethod: resolvedPaymentMethod,
      paymentStatus: finalValidatedPaymentStatus,
      paymentDetails: {
        method: resolvedPaymentMethod,
        amountReceived: Number(amountReceived || (resolvedPaymentMethod === 'CASH' ? cashReceived : calc.finalTotal)),
        changeDue: Number(changeDue || serverChangeDue),
        edcAuthCode: edcAuthCode || null,
        paidAt: finalValidatedPaymentStatus === 'PAID' ? new Date().toISOString() : null
      },
      orderType: resolvedOrderType.toLowerCase(),
      source: 'POS',
      orderSource,
      tableNumber: resolvedOrderType === 'DINE_IN' ? (tableNumber || 'T-1') : null,
      deliveryAddress: resolvedOrderType === 'DELIVERY' ? { addressLine: deliveryAddress || 'Counter Delivery' } : null,
      cashierName,
      terminalId,
      branchId,
      branchName,
      franchiseId,
      notes: notes || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Update active shift sales tally asynchronously
    setImmediate(async () => {
      try {
        const activeShift = await POSService.getActiveShift(branchId, terminalId);
        if (activeShift) {
          const shiftRef = adminDb.collection('pos_shifts').doc(activeShift.id);
          const pMethod = (paymentMethod || 'CASH').toUpperCase();
          const amount = calc.finalTotal;

          const updates: any = {
            totalRevenue: (activeShift.totalRevenue || 0) + amount,
            totalBills: (activeShift.totalBills || 0) + 1,
            updatedAt: new Date().toISOString()
          };

          if (pMethod === 'CASH') {
            updates.cashSales = (activeShift.cashSales || 0) + amount;
            updates.expectedCash = (activeShift.openingCash || 0) + updates.cashSales;
          } else if (pMethod === 'UPI') {
            updates.upiSales = (activeShift.upiSales || 0) + amount;
          } else if (pMethod === 'CARD') {
            updates.cardSales = (activeShift.cardSales || 0) + amount;
          } else {
            updates.otherSales = (activeShift.otherSales || 0) + amount;
          }

          await shiftRef.set(updates, { merge: true });

          // Authoritative PostgreSQL pos_shifts sale recording
          try {
            const cashAmount = pMethod === 'CASH' ? amount : 0;
            const digitalAmount = pMethod !== 'CASH' ? amount : 0;
            await POSShiftRepository.recordSale(activeShift.id, cashAmount, digitalAmount);
          } catch (pgErr: any) {
            console.warn('[POS] PostgreSQL pos_shifts recordSale notice:', pgErr.message);
          }
        }
      } catch (shiftErr: any) {
        console.warn('[POS] Shift tally update warning:', shiftErr.message);
      }

      // Notify Kitchen & Owner
      try {
        await orderEventService.emitNewOrder(newOrderId);
      } catch {}

      // Queue Google Sheets Live 22-Column Sync
      try {
        await SheetsSyncWorker.queueOrder(newOrderId, {
          orderNumber,
          customerName: orderDocData.customerName,
          customerPhone: orderDocData.contactPhone,
          totalAmount: calc.finalTotal,
          subtotal: calc.subtotal,
          discountAmount: calc.discountAmount,
          taxes: calc.taxes,
          deliveryFee: calc.deliveryFee,
          paymentMethod: orderDocData.paymentMethod,
          orderType: resolvedOrderType,
          orderSource,
          tableNumber: orderDocData.tableNumber,
          terminalId,
          cashierName,
          branchName: orderDocData.branchName,
          franchiseId,
          status: orderDocData.status,
          itemCount: calc.items.reduce((sum, it) => sum + (it.quantity || 1), 0),
          items: calc.items,
          couponCode: calc.couponCode || undefined,
          createdAt: new Date().toISOString()
        });
      } catch (sErr: any) {
        console.warn('[POS] SheetsSyncWorker notice:', sErr.message);
      }
    });

    // Generate formatted receipt representation
    const receiptData: ReceiptData = {
      orderNumber,
      billId: newOrderId,
      permanentBillNo,
      billNumber,
      date: today,
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      orderType: resolvedOrderType,
      tableNumber: orderDocData.tableNumber || undefined,
      customerName: orderDocData.customerName,
      customerPhone: orderDocData.contactPhone,
      deliveryAddress: deliveryAddress || undefined,
      cashierName,
      terminalId,
      branchName: orderDocData.branchName,
      items: calc.items,
      subtotal: calc.subtotal,
      discountAmount: calc.discountAmount,
      couponCode: calc.couponCode || undefined,
      taxes: calc.taxes,
      deliveryFee: calc.deliveryFee,
      finalTotal: calc.finalTotal,
      paymentMethod: orderDocData.paymentMethod,
      paymentStatus: 'PAID',
      amountReceived: Number(amountReceived || calc.finalTotal),
      changeDue: Number(changeDue || 0),
      edcAuthCode: edcAuthCode || undefined
    };

    const receiptText = ESCPOSFormatter.generatePlainTextReceipt(receiptData);

    res.status(201).json({
      success: true,
      message: 'Bill created and saved successfully',
      orderId: newOrderId,
      permanentBillNo,
      billNumber,
      dailyOrderNumber,
      orderNumber,
      finalTotal: calc.finalTotal,
      order: OrderProjectionService.projectForPOS(orderDocData, newOrderId),
      receipt: {
        text: receiptText,
        data: receiptData
      }
    });
  } catch (error: any) {
    console.error('[POS] Order creation failed:', error);
    if (error.code === 'IDEMPOTENCY_CONFLICT' || error.statusCode === 409) {
      res.status(409).json({ success: false, code: 'IDEMPOTENCY_CONFLICT', error: error.message });
      return;
    }
    res.status(500).json({ success: false, error: error.message || 'Failed to create bill' });
  }
});

// ============================================================================
// 4.5. ADVANCED DETERMINISTIC BILL SEARCH (SECTION 11 — ZERO AI, 100% SQL)
// ============================================================================
router.get('/search', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    const branchId = isOwner && req.query.branchId ? (req.query.branchId as string) : user.branchId!;
    const franchiseId = isOwner && req.query.franchiseId ? (req.query.franchiseId as string) : user.franchiseId!;

    const permBillNo = req.query.permanentBillNo ? parseInt(req.query.permanentBillNo as string, 10) : undefined;
    const dailyOrderNo = req.query.dailyOrderNo ? parseInt(req.query.dailyOrderNo as string, 10) : undefined;

    const results = await CanonicalOrderService.searchCanonicalOrders({
      permanentBillNo: permBillNo,
      dailyOrderNo: dailyOrderNo,
      orderId: req.query.orderId as string,
      customerPhone: req.query.customerPhone as string,
      customerName: req.query.customerName as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      minAmount: req.query.minAmount ? parseFloat(req.query.minAmount as string) : undefined,
      maxAmount: req.query.maxAmount ? parseFloat(req.query.maxAmount as string) : undefined,
      paymentMethod: req.query.paymentMethod as string,
      paymentStatus: req.query.paymentStatus as string,
      orderStatus: req.query.orderStatus as string,
      orderSource: req.query.orderSource as string,
      orderType: req.query.orderType as string,
      itemName: req.query.itemName as string,
      branchId,
      franchiseId,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0
    });

    const projectedOrders = results.map((o: any) => OrderProjectionService.projectForPOS(o, o.order_id || o.id));

    res.json({
      success: true,
      count: projectedOrders.length,
      orders: projectedOrders
    });
  } catch (error: any) {
    console.error('[POS Search] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4.6. LIVE ONLINE ORDERS FOR POS WORKSPACE (SECTION 5 & 21)
// ============================================================================
router.get('/online-orders/live', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const orders = await CanonicalOrderService.getLiveOnlineOrders(branchId);
    const projectedOrders = orders.map((o: any) => OrderProjectionService.projectForPOS(o, o.order_id || o.id));
    res.json({ success: true, count: projectedOrders.length, orders: projectedOrders });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/online-orders/:id/accept', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const branchId = user.branchId;

    // Validate that order belongs to cashier's assigned branch
    let orderDoc = await adminDb.collection('orders').doc(id).get().catch(() => null);
    let orderData = orderDoc?.exists ? orderDoc.data() : null;
    if (!orderData) {
      try {
        orderData = await OrderPersistenceArchiveService.getHistoricalOrder(id);
      } catch {}
    }

    if (!orderData) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const orderBranch = orderData.branchId || orderData.branch_id;
    if (orderBranch && branchId && orderBranch !== branchId && branchId !== 'all') {
      res.status(403).json({ success: false, error: 'Forbidden: You cannot accept orders assigned to a different branch.' });
      return;
    }

    const transitionRes = await OrderStateMachine.transition(id, 'accepted', {
      uid: user.uid,
      role: user.role || 'cashier',
      name: (user as any).name || 'POS Operator'
    });

    if (!transitionRes.success) {
      res.status(400).json({ success: false, error: transitionRes.error || 'Failed to accept order' });
      return;
    }

    try {
      await orderEventService.emitStatusChange(id, 'accepted', user.uid);
    } catch {}

    res.json({ success: true, message: 'Order accepted' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/online-orders/:id/reject', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason = 'Store busy / items unavailable' } = req.body;
    const user = req.user!;
    const branchId = user.branchId;

    // Validate that order belongs to cashier's assigned branch
    let orderDoc = await adminDb.collection('orders').doc(id).get().catch(() => null);
    let orderData = orderDoc?.exists ? orderDoc.data() : null;
    if (!orderData) {
      try {
        orderData = await OrderPersistenceArchiveService.getHistoricalOrder(id);
      } catch {}
    }

    if (!orderData) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const orderBranch = orderData.branchId || orderData.branch_id;
    if (orderBranch && branchId && orderBranch !== branchId && branchId !== 'all') {
      res.status(403).json({ success: false, error: 'Forbidden: You cannot reject orders assigned to a different branch.' });
      return;
    }

    await CanonicalOrderService.cancelOrRefundOrder({
      orderId: id,
      reason,
      cancelledBy: user.email || 'Cashier'
    });

    try {
      await orderEventService.emitStatusChange(id, 'cancelled', user.uid);
    } catch {}

    res.json({ success: true, message: 'Order rejected' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4.7. AUDITABLE VOID & REFUND BILL (SECTION 18)
// ============================================================================
router.post('/orders/:id/cancel', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason, refundAmount } = req.body;
    const user = req.user!;

    if (!reason) {
      res.status(400).json({ success: false, error: 'Cancellation reason is required for audit' });
      return;
    }

    const result = await CanonicalOrderService.cancelOrRefundOrder({
      orderId: id,
      reason,
      refundAmount: refundAmount ? parseFloat(refundAmount) : undefined,
      cancelledBy: user.email || 'Staff'
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 5. RECENT BILLS HISTORY & SEARCH
// ============================================================================
router.get('/history', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const limitCount = Math.min(100, Math.max(10, Number(req.query.limit) || 30));
    const searchQuery = (req.query.q as string || '').trim().toLowerCase();

    const snap = await adminDb.collection('orders')
      .where('branchId', '==', branchId)
      .orderBy('createdAt', 'desc')
      .limit(limitCount)
      .get()
      .catch(async () => {
        return await adminDb.collection('orders').where('branchId', '==', branchId).limit(limitCount).get();
      });

    let bills: any[] = snap.docs.map(doc => OrderProjectionService.projectForPOS(doc.data(), doc.id));

    if (searchQuery) {
      bills = bills.filter(b => 
        (b.orderNumber && b.orderNumber.toLowerCase().includes(searchQuery)) ||
        (b.customerPhone && b.customerPhone.toLowerCase().includes(searchQuery)) ||
        (b.customerName && b.customerName.toLowerCase().includes(searchQuery)) ||
        (b.tableNumber && b.tableNumber.toLowerCase().includes(searchQuery))
      );
    }

    res.json({ success: true, count: bills.length, bills });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 6. VOID BILL
// ============================================================================
router.post('/void', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { orderId, reason } = req.body;

    if (!orderId || !reason) {
      res.status(400).json({ success: false, error: 'orderId and void reason are required' });
      return;
    }

    const result = await POSService.voidBill({
      orderId,
      reason,
      voidedByUid: user.uid,
      voidedByName: user.email || 'Cashier',
      terminalId: user.terminalId || `pos_${user.franchiseId}`,
      branchId: user.branchId!
    });

    res.json({ ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 7. MULTI-TERMINAL HELD BILLS
// ============================================================================
router.get('/held-bills', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const heldBills = await POSService.getHeldBills(branchId);
    res.json({ success: true, count: heldBills.length, heldBills });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/hold', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { title, orderType, tableNumber, customerName, customerPhone, deliveryAddress, items, subtotal, discountAmount, taxes, finalTotal } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, error: 'Cannot hold an empty bill' });
      return;
    }

    const heldBill = await POSService.holdBill({
      title: title || `${orderType || 'DINE_IN'} - ${tableNumber || customerName || 'Cart'}`,
      orderType: orderType || 'DINE_IN',
      tableNumber,
      customerName,
      customerPhone,
      deliveryAddress,
      items,
      subtotal: Number(subtotal || 0),
      discountAmount: Number(discountAmount || 0),
      taxes: Number(taxes || 0),
      finalTotal: Number(finalTotal || 0),
      heldByCashier: user.email?.split('@')[0] || 'Cashier',
      terminalId: user.terminalId || `pos_${user.franchiseId}`,
      branchId: user.branchId!,
      franchiseId: user.franchiseId!
    });

    res.status(201).json({ success: true, heldBill });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/held-bills/:id', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const isGlobal = ['owner', 'admin', 'developer', 'platform_owner'].includes(user.role || '');

    const heldDoc = await adminDb.collection('pos_held_bills').doc(req.params.id).get();
    if (!heldDoc.exists) {
      res.status(404).json({ success: false, error: 'Held bill not found' });
      return;
    }

    const heldData = heldDoc.data()!;
    if (!isGlobal && heldData.branchId && heldData.branchId !== branchId) {
      res.status(403).json({ success: false, error: 'Access denied: Cannot delete held bill from another branch' });
      return;
    }

    const success = await POSService.deleteHeldBill(req.params.id);
    res.json({ success });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 8. SHIFT MANAGEMENT (Open / Close / Current)
// ============================================================================
router.get('/shifts/current', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const terminalId = req.user?.terminalId || `pos_${req.user?.franchiseId}`;

    const activeShift = await POSService.getActiveShift(branchId, terminalId);
    res.json({ success: true, shift: activeShift });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/shifts/open', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const franchiseId = user.franchiseId!;
    const terminalId = user.terminalId || `pos_${user.franchiseId}`;
    const { openingCash, notes } = req.body;

    const shift = await POSService.openShift({
      branchId,
      franchiseId,
      terminalId,
      cashierUid: user.uid,
      cashierName: user.email?.split('@')[0] || 'Cashier',
      openingCash: Number(openingCash || 0),
      notes
    });

    // Authoritative PostgreSQL pos_shifts insertion
    try {
      await POSShiftRepository.openShift({
        id: shift.id,
        terminalId,
        franchiseId,
        branchId,
        cashierId: user.uid,
        cashierName: shift.cashierName || user.email?.split('@')[0] || 'Cashier',
        openingCash: Number(openingCash || 0),
        notes
      });
    } catch (pgErr: any) {
      console.warn('[POS] PostgreSQL pos_shifts openShift notice:', pgErr.message);
    }

    res.status(201).json({ success: true, shift });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/shifts/close', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { shiftId, closingCash, actualCash, notes } = req.body;
    if (!shiftId) {
      res.status(400).json({ success: false, error: 'shiftId is required' });
      return;
    }

    const user = req.user!;
    const branchId = user.branchId!;
    const isGlobal = ['owner', 'admin', 'developer', 'platform_owner'].includes(user.role || '');

    const shiftDoc = await adminDb.collection('pos_shifts').doc(shiftId).get();
    if (shiftDoc.exists) {
      const shiftData = shiftDoc.data()!;
      if (!isGlobal && shiftData.branchId && shiftData.branchId !== branchId) {
        res.status(403).json({ success: false, error: 'Access denied: Shift belongs to another branch' });
        return;
      }
    }

    const resolvedActualCash = Number(actualCash != null ? actualCash : (closingCash || 0));
    const shift = await POSService.closeShift(shiftId, resolvedActualCash, notes);

    // Authoritative PostgreSQL pos_shifts closing & reconciliation
    try {
      await POSShiftRepository.closeShift(shiftId, resolvedActualCash, notes);
    } catch (pgErr: any) {
      console.warn('[POS] PostgreSQL pos_shifts closeShift notice:', pgErr.message);
    }

    res.json({ success: true, shift });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 9. DAILY SUMMARY
// ============================================================================
router.get('/summary', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const summary = await POSService.getDailySummary(branchId);
    res.json({ success: true, summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 10. THERMAL RECEIPT & PRINT PREVIEW
// ============================================================================
router.get('/receipt/:orderId', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await adminDb.collection('orders').doc(req.params.orderId).get();
    if (!doc.exists) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    const d = doc.data()!;
    const user = req.user!;
    const branchId = user.branchId!;
    const isGlobal = ['owner', 'admin', 'developer', 'platform_owner'].includes(user.role || '');

    if (!isGlobal && d.branchId && d.branchId !== branchId) {
      res.status(403).json({ success: false, error: 'Access denied: Receipt belongs to another branch' });
      return;
    }

    const receiptData: ReceiptData = {
      orderNumber: d.dailyOrderNumber ? `#${d.dailyOrderNumber}` : (d.orderNumber || `#${doc.id.slice(0, 6)}`),
      billId: doc.id,
      date: d.orderDateLocal || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()),
      time: d.createdAt?.toDate ? d.createdAt.toDate().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '12:00 PM',
      orderType: (d.orderSource || d.orderType || 'DINE_IN').toUpperCase(),
      tableNumber: d.tableNumber || undefined,
      customerName: d.customerName || 'Walk-in Customer',
      customerPhone: d.contactPhone || 'N/A',
      deliveryAddress: d.deliveryAddress?.addressLine || undefined,
      cashierName: d.cashierName || 'Cashier',
      terminalId: d.terminalId || 'POS-TERM-01',
      branchName: d.branchName || 'Olive Pizza — Rajnandgaon HQ',
      items: d.items || [],
      subtotal: Number(d.subtotal || d.totalAmount || 0),
      discountAmount: Number(d.discountAmount || 0),
      couponCode: d.couponCode || undefined,
      taxes: Number(d.taxes || 0),
      deliveryFee: Number(d.deliveryFee || 0),
      finalTotal: Number(d.totalAmount || d.finalTotal || 0),
      paymentMethod: d.paymentMethod || 'CASH',
      paymentStatus: d.paymentStatus || 'PENDING',
      amountReceived: d.paymentDetails?.amountReceived || undefined,
      changeDue: d.paymentDetails?.changeDue || undefined,
      edcAuthCode: d.paymentDetails?.edcAuthCode || undefined
    };

    const text = ESCPOSFormatter.generatePlainTextReceipt(receiptData);
    res.json({ success: true, text, data: receiptData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 11. POS TERMINAL MANAGEMENT & ACTIVATION (Franchise-Controlled)
// ============================================================================

// List terminals for authorized franchise
router.get('/terminals', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const franchiseId = user.franchiseId;
    if (!franchiseId) {
      res.status(403).json({ success: false, error: 'AUTHORIZED_FRANCHISE_SCOPE_REQUIRED: Account has no assigned franchise.' });
      return;
    }

    const snap = await adminDb.collection('pos_terminals')
      .where('franchiseId', '==', franchiseId)
      .get();

    const terminals = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, terminals });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Franchise Manager registers a new POS terminal
router.post('/terminals/register', verifyToken, requireRole(['franchise_owner', 'manager', 'restaurant_manager', 'admin', 'owner', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { branchId, terminalName } = req.body;

    const franchiseId = user.franchiseId || req.body.franchiseId;
    const effectiveBranchId = branchId || user.branchId;

    if (!franchiseId || !effectiveBranchId) {
      res.status(400).json({ success: false, error: 'franchiseId and branchId are required to register a terminal.' });
      return;
    }
    const terminalId = `POS-${effectiveBranchId.toUpperCase().slice(0, 4)}-${crypto.randomInt(1000, 10000)}`;
    const activationCode = String(crypto.randomInt(100000, 1000000)); // Cryptographically secure 6-digit PIN
    const activationCodeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24hr expiration

    const terminalDoc = {
      terminalId,
      terminalName: terminalName || `Terminal ${terminalId}`,
      franchiseId,
      branchId: effectiveBranchId,
      registeredByUid: user.uid,
      registeredByEmail: user.email,
      activationCode,
      activationCodeExpiresAt,
      status: 'PENDING_ACTIVATION', // 'PENDING_ACTIVATION' | 'ACTIVE' | 'REVOKED'
      createdAt: new Date().toISOString(),
      lastActiveAt: null
    };

    await adminDb.collection('pos_terminals').doc(terminalId).set(terminalDoc);

    const publicApiUrl = process.env.VITE_API_BASE_URL || 'https://olivepizza-owner.onrender.com';

    res.json({
      success: true,
      terminal: terminalDoc,
      activationCode,
      activationCodeExpiresAt,
      qrPayload: JSON.stringify({
        terminalId,
        activationCode,
        franchiseId,
        branchId: effectiveBranchId,
        backendUrl: `${publicApiUrl}/api/pos`
      })
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POS client activates with 6-digit code (Strictly authenticated and single-use)
router.post('/terminals/activate', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { activationCode, deviceFingerprint } = req.body;
    if (!activationCode || typeof activationCode !== 'string') {
      res.status(400).json({ success: false, error: 'Valid activation code is required' });
      return;
    }

    const cleanCode = String(activationCode).trim();
    const snap = await adminDb.collection('pos_terminals')
      .where('activationCode', '==', cleanCode)
      .limit(1)
      .get();

    if (snap.empty) {
      res.status(404).json({ success: false, error: 'Invalid or expired activation code' });
      return;
    }

    const doc = snap.docs[0];
    let activatedData: any;
    try {
      // Make activation single-use under concurrency: only the transaction that still sees
      // this exact live code may consume it and bind the terminal.
      activatedData = await adminDb.runTransaction(async (transaction) => {
        const latestSnap = await transaction.get(doc.ref);
        if (!latestSnap.exists) {
          const missing: any = new Error('POS terminal no longer exists.');
          missing.status = 404;
          throw missing;
        }
        const latest = latestSnap.data() || {};
        if (latest.activationCode !== cleanCode) {
          const consumed: any = new Error('This activation code has already been used or replaced. Generate a new code from the management portal.');
          consumed.status = 409;
          throw consumed;
        }

        const currentStatus = String(latest.status || latest.activationStatus || '').toUpperCase();
        if (currentStatus === 'REVOKED' || currentStatus === 'DEACTIVATED' || latest.isActive === false) {
          const revoked: any = new Error('This POS terminal has been deactivated by franchise management.');
          revoked.status = 403;
          throw revoked;
        }
        if (currentStatus === 'ACTIVE' || currentStatus === 'ACTIVATED') {
          const active: any = new Error('This POS terminal has already been activated.');
          active.status = 409;
          throw active;
        }
        if (latest.activationCodeExpiresAt && new Date(latest.activationCodeExpiresAt).getTime() < Date.now()) {
          const expired: any = new Error('This activation code has expired. Generate a new code from the management portal.');
          expired.status = 400;
          throw expired;
        }

        const activatedAt = new Date().toISOString();
        transaction.update(doc.ref, {
          status: 'ACTIVE',
          activationStatus: 'ACTIVATED',
          isActive: true,
          activationCode: null,
          activationCodeExpiresAt: null,
          activatedByUid: req.user?.uid || 'authenticated_cashier',
          activatedByEmail: req.user?.email || '',
          deviceFingerprint: deviceFingerprint || 'DESKTOP-WIN-POS',
          activatedAt,
          lastActiveAt: activatedAt
        });
        return { ...latest, activatedAt };
      });
    } catch (activationError: any) {
      res.status(Number.isInteger(activationError?.status) ? activationError.status : 500).json({
        success: false,
        error: activationError?.message || 'Unable to activate this terminal.'
      });
      return;
    }

    res.json({
      success: true,
      message: 'POS Terminal activated successfully',
      terminal: {
        terminalId: activatedData.terminalId || doc.id,
        terminalName: activatedData.terminalName,
        franchiseId: activatedData.franchiseId,
        branchId: activatedData.branchId,
        status: 'ACTIVE'
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Franchise Manager deactivates / revokes a POS terminal
router.post('/terminals/:terminalId/revoke', verifyToken, requireRole(['franchise_owner', 'manager', 'restaurant_manager', 'admin', 'owner', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { terminalId } = req.params;
    const { reason } = req.body;

    const docRef = adminDb.collection('pos_terminals').doc(terminalId);
    const doc = await docRef.get();

    if (!doc.exists) {
      res.status(404).json({ success: false, error: 'Terminal not found' });
      return;
    }

    await docRef.update({
      status: 'REVOKED',
      revokedAt: new Date().toISOString(),
      revokedByEmail: req.user?.email,
      revocationReason: reason || 'Deactivated by Franchise Manager'
    });

    res.json({ success: true, message: `Terminal ${terminalId} revoked successfully` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


router.get('/analytics/summary', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    const branchId = isOwner && req.query.branchId ? (req.query.branchId as string) : user.branchId!;
    const franchiseId = isOwner && req.query.franchiseId ? (req.query.franchiseId as string) : user.franchiseId!;
    const period = (req.query.period as any) || 'today';
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;

    const { dateRange, periodLabel } = SalesCalculationEngine.resolveDateRange(period, startDate, endDate);

    const summary = await SalesCalculationEngine.getSalesSummary({
      branchId,
      franchiseId,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      periodLabel
    });

    res.json({ success: true, summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analytics/hourly-trend', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const dateStr = (req.query.date as string) || BillingNumberService.getLocalDateString();

    const hourlyRes = await query(`
      SELECT
        EXTRACT(HOUR FROM order_time)::integer AS hour_num,
        COUNT(*)::integer AS order_count,
        COALESCE(SUM(total_amount), 0)::numeric AS total_sales
      FROM canonical_orders
      WHERE branch_id = $1 AND order_date = $2::date AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided')
      GROUP BY hour_num
      ORDER BY hour_num ASC;
    `, [branchId, dateStr]);

    const hoursMap = new Map<number, { sales: number; orders: number }>();
    hourlyRes.rows.forEach(r => {
      hoursMap.set(parseInt(r.hour_num, 10), {
        sales: parseFloat(r.total_sales),
        orders: parseInt(r.order_count, 10)
      });
    });

    const hours = [];
    let peakHour = { hour: '12:00', sales: 0 };

    for (let h = 10; h <= 23; h++) {
      const data = hoursMap.get(h) || { sales: 0, orders: 0 };
      const label = `${h}:00`;
      hours.push({
        hour: label,
        label: `${h > 12 ? h - 12 : h} ${h >= 12 ? 'PM' : 'AM'}`,
        sales: data.sales,
        orders: data.orders
      });
      if (data.sales > peakHour.sales) {
        peakHour = { hour: label, sales: data.sales };
      }
    }

    res.json({
      success: true,
      trend: {
        date: dateStr,
        hours,
        peakHour
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analytics/product-performance', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const branchId = user.branchId!;
    const franchiseId = user.franchiseId!;
    const limitCount = Number(req.query.limit) || 8;

    const { dateRange } = SalesCalculationEngine.resolveDateRange('this_month');

    const products = await SalesCalculationEngine.getItemSalesSummary({
      branchId,
      franchiseId,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit: limitCount
    });

    res.json({
      success: true,
      products: products.map(p => ({
        name: p.itemName,
        category: p.sizeVariant || 'Regular',
        quantitySold: p.quantitySold,
        revenue: p.salesValue
      }))
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/analytics/sync-status', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

    const pendingSnap = await adminDb.collection('orders')
      .where('branchId', '==', branchId)
      .where('orderDateLocal', '==', today)
      .where('sheetsSynced', '==', false)
      .get()
      .catch(() => ({ size: 0 }));

    res.json({
      success: true,
      syncHealth: pendingSnap.size === 0 ? 'SYNCED' : pendingSnap.size < 5 ? 'SYNCING' : 'DELAYED',
      pendingSyncCount: pendingSnap.size,
      lastSyncTimestamp: new Date().toISOString(),
      destination: 'Google Sheets (Monthly 13-Tab Workbook)',
      isLiveReportingActive: true
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/shifts/cash-adjustment', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { shiftId, type, amount, reason } = req.body;
    if (!type || !amount) {
      res.status(400).json({ success: false, error: 'type and amount are required' });
      return;
    }

    let targetShiftId = shiftId;
    if (!targetShiftId) {
      const active = await POSService.getActiveShift(user.branchId!, user.terminalId || `pos_${user.franchiseId}`);
      if (!active) {
        res.status(400).json({ success: false, error: 'No active shift found for this terminal. Open a shift first.' });
        return;
      }
      targetShiftId = active.id;
    }

    const result = await POSService.recordCashAdjustment({
      shiftId: targetShiftId,
      branchId: user.branchId!,
      terminalId: user.terminalId || `pos_${user.franchiseId}`,
      type,
      amount: Number(amount),
      reason: reason || 'Manual drawer adjustment',
      cashierUid: user.uid,
      cashierName: user.email?.split('@')[0] || 'Cashier'
    });

    // Authoritative PostgreSQL pos_shifts adjustment
    try {
      await POSShiftRepository.recordCashAdjustment(targetShiftId, type, Number(amount), reason || 'Manual drawer adjustment');
    } catch (pgErr: any) {
      console.warn('[POS] PostgreSQL pos_shifts cashAdjustment notice:', pgErr.message);
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ─── 13. GLOBAL OWNER: ALL POS TERMINALS VIEW (GET /all-terminals) ───────────
router.get('/all-terminals', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isGlobalOwner = ['owner', 'admin', 'developer', 'platform_owner'].includes(req.user?.role || '');

    const userFranchiseId = req.user?.franchiseId;

    // Fetch all franchises
    const fSnap = await adminDb.collection('franchise_entities').get();
    const franchisesMap = new Map<string, any>();
    fSnap.docs.forEach(d => franchisesMap.set(d.id, { id: d.id, ...(d.data() as any) }));

    // Fetch all branches
    const bSnap = await adminDb.collection('franchises').get();
    const branchesMap = new Map<string, any>();
    bSnap.docs.forEach(d => branchesMap.set(d.id, { id: d.id, ...(d.data() as any) }));

    // Fetch all POS terminals
    const posSnap = await adminDb.collection('pos_terminals').get();
    let terminals = posSnap.docs.map(d => {
      const data = d.data() as any;
      // Redact sensitive activation codes from general listing
      const { activationCode, ...safeData } = data;
      return { id: d.id, ...safeData };
    });

    if (terminals.length === 0) {
      terminals = [];
    }

    if (!isGlobalOwner && userFranchiseId) {
      terminals = terminals.filter(t => t.franchiseId === userFranchiseId);
    }

    const enriched = terminals.map(t => {
      const fra = franchisesMap.get(t.franchiseId) || { name: 'Franchise', city: 'Chhattisgarh' };
      const br = branchesMap.get(t.branchId) || { name: 'Branch' };
      return {
        ...t,
        franchiseName: fra.name || fra.city,
        franchiseCode: fra.code || 'FRA',
        branchName: br.name || t.branchId,
        todaySales: t.todaySales || 14800,
        todayOrders: t.todayOrders || 32,
        currentShift: t.currentShift || 'Current Active Shift',
        assignedUserName: t.assignedUserName || 'Counter Cashier'
      };
    });

    res.json({
      success: true,
      terminals: enriched,
      isGlobalOwner,
      totalTerminals: enriched.length,
      activeTerminals: enriched.filter(t => t.isActive).length
    });
  } catch (error: any) {
    console.error('[POSRoutes] Error loading all POS terminals:', error);
    res.status(500).json({ error: 'Failed to load all POS terminals' });
  }
});

// ─── 14. GLOBAL OWNER: SWITCH POS OPERATIONAL CONTEXT (POST /owner-context/switch) ───
router.post('/owner-context/switch', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { franchiseId, branchId, terminalId, previousContext } = req.body;

    if (!franchiseId || !branchId || !terminalId) {
      res.status(400).json({ error: 'franchiseId, branchId, and terminalId are required for context switch' });
      return;
    }

    // Resolve franchise
    const fSnap = await adminDb.collection('franchise_entities').doc(franchiseId).get();
    let franchiseName = fSnap.exists ? (fSnap.data() as any)?.name : `Franchise ${franchiseId}`;

    // Resolve branch
    const bSnap = await adminDb.collection('franchises').doc(branchId).get();
    let branchName = bSnap.exists ? (bSnap.data() as any)?.name : `Branch ${branchId}`;

    // Resolve terminal
    const tSnap = await adminDb.collection('pos_terminals').doc(terminalId).get();
    const terminalData = tSnap.exists ? (tSnap.data() as any) : {
      id: terminalId,
      terminalName: 'POS Billing Terminal',
      isActive: true,
      activationStatus: 'ACTIVATED'
    };

    if (tSnap.exists && terminalData.isActive === false) {
      res.status(403).json({ error: 'Cannot switch context to a revoked or deactivated POS terminal', code: 'TERMINAL_REVOKED' });
      return;
    }

    res.json({
      success: true,
      message: `Owner POS context switched to ${franchiseName} ➔ ${branchName} ➔ ${terminalData.terminalName}`,
      session: {
        isOwnerMode: true,
        cashierName: `👑 Owner (${req.user?.email?.split('@')[0] || 'Master'})`,
        cashierUid: req.user?.uid || 'owner_global',
        role: 'owner',
        terminalId,
        terminalName: terminalData.terminalName || 'POS Terminal',
        branchId,
        branchName,
        franchiseId,
        franchiseName,
        organizationId: 'org_olive_pizza',
        sessionStartedAt: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('[POSRoutes] Error switching owner POS context:', error);
    res.status(500).json({ error: 'Failed to switch owner POS context' });
  }
});


// ============================================================================
// 14. ONLINE ORDER AUTOMATIC BILLING & THERMAL PRINT PIPELINE
// ============================================================================

// GET /api/pos/pending-online-prints — Retrieve accepted online orders pending POS print
router.get('/pending-online-prints', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const franchiseId = req.user?.franchiseId!;
    const ordersSnap = await adminDb.collection('orders')
      .where('branchId', '==', branchId)
      .limit(50)
      .get()
      .catch(() => ({ docs: [] } as any));
    const pendingPrints = ordersSnap.docs
      .map((doc: any) => ({ id: doc.id, ...doc.data() }))
      .filter((o: any) => {
        const isOnline = o.orderSource === 'CUSTOMER_APP' || o.source === 'ONLINE' || !o.orderSource;
        const isAccepted = ['CONFIRMED', 'PREPARING', 'ACCEPTED', 'KITCHEN', 'READY'].includes(o.status);
        const notPrinted = o.printStatus !== 'PRINTED';
        return isOnline && isAccepted && notPrinted;
      });
    res.json({ success: true, branchId, franchiseId, count: pendingPrints.length, orders: pendingPrints });
  } catch (error: any) {
    console.error('[POSRoutes] Error fetching pending online prints:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/claim-print — Atomically claim print job for a specific terminal
router.post('/claim-print', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId, terminalId } = req.body;
    if (!orderId || !terminalId) {
      res.status(400).json({ success: false, error: 'orderId and terminalId are required' });
      return;
    }
    const resolvedTerminalId = terminalId || req.user?.terminalId || `pos_${req.user?.franchiseId}`;

    const orderRef = adminDb.collection('orders').doc(orderId);
    const result = await adminDb.runTransaction(async (transaction: any) => {
      const orderDoc = await transaction.get(orderRef);
      if (!orderDoc.exists) {
        throw new Error('Order not found');
      }
      const data = orderDoc.data();
      if (data.printStatus === 'PRINTED' && data.printedByTerminal && data.printedByTerminal !== resolvedTerminalId) {
        return { success: false, alreadyPrinted: true, message: `Already printed by terminal ${data.printedByTerminal}` };
      }
      transaction.update(orderRef, {
        printStatus: 'PRINTING',
        printedByTerminal: resolvedTerminalId,
        printClaimedAt: new Date().toISOString()
      });
      return { success: true, alreadyPrinted: false, message: 'Print job claimed' };
    });

    res.json(result);
  } catch (error: any) {
    console.error('[POSRoutes] Error claiming print job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/complete-print — Confirm successful print output
router.post(['/complete-print', '/update-print-status'], verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId, terminalId } = req.body;
    if (!orderId) {
      res.status(400).json({ success: false, error: 'orderId is required' });
      return;
    }
    const resolvedTerminalId = terminalId || req.user?.terminalId || `pos_${req.user?.franchiseId}`;

    await adminDb.collection('orders').doc(orderId).update({
      printStatus: 'PRINTED',
      printedAt: new Date().toISOString(),
      printedByTerminal: resolvedTerminalId,
      printVerified: true
    });

    res.json({ success: true, message: 'Print marked as completed' });
  } catch (error: any) {
    console.error('[POSRoutes] Error completing print:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/pos/printer-settings — Get terminal printer configuration
router.get('/printer-settings', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const terminalId = req.user?.terminalId || `pos_${req.user?.franchiseId}`;
    const branchId = req.user?.branchId!;
    const docSnap = await adminDb.collection('pos_printer_settings').doc(branchId + '_' + terminalId).get();
    const settings = docSnap.exists ? docSnap.data() : {
      terminalId,
      branchId,
      printerName: 'Default Thermal Printer (80mm)',
      connectionType: 'USB',
      paperSize: '80mm',
      autoPrintOnline: true,
      isPrimaryTerminal: true,
      lanIp: '',
      lanPort: 9100
    };
    res.json({ success: true, settings });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/printer-settings — Save terminal printer configuration
router.post('/printer-settings', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { printerName, connectionType, paperSize, autoPrintOnline, isPrimaryTerminal, lanIp, lanPort } = req.body;
    const terminalId = req.user?.terminalId || `pos_${req.user?.franchiseId}`;
    const branchId = req.user?.branchId!;
    const settingsPayload = {
      terminalId,
      branchId,
      printerName: printerName || 'Thermal Printer',
      connectionType: connectionType || 'USB',
      paperSize: paperSize || '80mm',
      autoPrintOnline: typeof autoPrintOnline === 'boolean' ? autoPrintOnline : true,
      isPrimaryTerminal: typeof isPrimaryTerminal === 'boolean' ? isPrimaryTerminal : true,
      lanIp: lanIp || '',
      lanPort: Number(lanPort || 9100),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.email || 'cashier'
    };
    await adminDb.collection('pos_printer_settings').doc(branchId + '_' + terminalId).set(settingsPayload, { merge: true });
    res.json({ success: true, message: 'Printer settings saved successfully', settings: settingsPayload });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 15. POS LOOKER STUDIO & GOOGLE SHEETS BI CONFIGURATION
// ============================================================================

// GET /api/pos/looker-studio/config — Get Looker Studio & Google Sheets metadata scoped to terminal
router.get('/looker-studio/config', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const branchId = req.user?.branchId!;
    const franchiseId = req.user?.franchiseId!;

    // Retrieve Looker Studio configuration
    const docSnap = await adminDb.collection('settings').doc('looker_studio').get();
    const data = docSnap.exists ? docSnap.data() : {};

    let spreadsheetId = null;
    let spreadsheetName = 'Olive Pizza Reports';
    try {
      const fMetaSnap = await adminDb.collection('franchise_sheets_metadata').doc(franchiseId).get();
      if (fMetaSnap.exists && fMetaSnap.data()?.spreadsheetId) {
        spreadsheetId = fMetaSnap.data()?.spreadsheetId;
        spreadsheetName = fMetaSnap.data()?.spreadsheetName || spreadsheetName;
      }
    } catch {}

    if (!spreadsheetId) {
      const spreadsheetDoc = await adminDb.collection('settings').doc('google_sheets').get();
      const sheetData = spreadsheetDoc.exists ? spreadsheetDoc.data() : {};
      spreadsheetId = sheetData?.spreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || null;
    }

    const defaultEmbedUrl = data?.embedUrl || process.env.LOOKER_STUDIO_EMBED_URL || 'https://lookerstudio.google.com/embed/reporting/olive-pizza-bi-dashboard';

    res.json({
      success: true,
      embedUrl: defaultEmbedUrl,
      spreadsheetId,
      liveSheetUrl: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : 'https://docs.google.com/spreadsheets',
      branchId,
      franchiseId,
      lastSyncedAt: data?.lastSyncedAt || new Date().toISOString()
    });
  } catch (error: any) {
    console.error('[POSRoutes] Error fetching Looker Studio config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/looker-studio/set-embed-url — Owner/Admin can update Looker Studio embed URL
router.post('/looker-studio/set-embed-url', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { embedUrl } = req.body;
    if (!embedUrl) {
      res.status(400).json({ success: false, error: 'embedUrl is required' });
      return;
    }

    await adminDb.collection('settings').doc('looker_studio').set({
      embedUrl: embedUrl.trim(),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.email || 'admin'
    }, { merge: true });

    res.json({
      success: true,
      message: 'Looker Studio embed URL updated successfully',
      embedUrl: embedUrl.trim()
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================================
// 11. POS CUSTOMER IDENTITY, PHONE LOOKUP & PROFILE ASSOCIATION
// ============================================================================

// Helper: Normalize 10-digit Indian phone number
function normalizeIndianPhone(inputPhone: string): string | null {
  if (!inputPhone) return null;
  const digits = inputPhone.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return digits;
  }
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return digits.slice(2);
  }
  return null;
}

// GET /api/pos/customers/lookup — Fast, scoped customer lookup by 10-digit mobile number
router.get('/customers/lookup', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawPhone = (req.query.phone as string) || '';
    const cleanPhone = normalizeIndianPhone(rawPhone);

    if (!cleanPhone) {
      res.status(400).json({ 
        success: false, 
        error: 'Please provide a valid 10-digit Indian mobile number (e.g. 9876543210)' 
      });
      return;
    }

    // 1. Query canonical 'users' collection
    const usersRef = adminDb.collection('users');
    let userSnap = await usersRef.where('phone', '==', cleanPhone).limit(1).get();
    
    if (userSnap.empty) {
      userSnap = await usersRef.where('phone', '==', '+91' + cleanPhone).limit(1).get();
    }

    if (!userSnap.empty) {
      const uDoc = userSnap.docs[0];
      const uData = uDoc.data();
      const name = (uData.name || uData.userName || '').trim();

      // Count previous orders for loyalty context
      let totalOrders = 0;
      try {
        const orderCountSnap = await adminDb.collection('orders')
          .where('userId', '==', uDoc.id)
          .limit(10)
          .get();
        totalOrders = orderCountSnap.size;
      } catch {}

      res.json({
        success: true,
        found: true,
        customer: {
          id: uDoc.id,
          name: name || 'Valued Customer',
          phone: cleanPhone,
          email: uData.email || null,
          totalOrders,
          isOnlineCustomer: !uData.source || uData.source === 'ONLINE' || uData.source === 'CUSTOMER_APP',
          isPOSCustomer: uData.source === 'POS',
          createdAt: uData.createdAt || null
        }
      });
      return;
    }

    // 2. If not found in users, check recent canonical orders
    const ordersRef = adminDb.collection('orders');
    const orderSnap = await ordersRef.where('contactPhone', '==', cleanPhone).limit(1).get();

    if (!orderSnap.empty) {
      const oData = orderSnap.docs[0].data();
      const name = (oData.customerName || '').trim();

      if (name && name.toLowerCase() !== 'walk-in customer') {
        // Auto-provision canonical customer doc
        const custId = `cust_${cleanPhone}`;
        const now = new Date().toISOString();
        await usersRef.doc(custId).set({
          id: custId,
          uid: custId,
          name,
          phone: cleanPhone,
          role: 'customer',
          source: 'POS',
          createdAt: now,
          updatedAt: now
        }, { merge: true });

        res.json({
          success: true,
          found: true,
          customer: {
            id: custId,
            name,
            phone: cleanPhone,
            totalOrders: 1,
            isOnlineCustomer: false,
            isPOSCustomer: true
          }
        });
        return;
      }
    }

    // 3. Not found — Ready for new customer creation
    res.json({
      success: true,
      found: false,
      phone: cleanPhone,
      message: 'No existing customer profile found. Ready to register new customer.'
    });
  } catch (error: any) {
    console.error('[POSCustomers] Error in customer lookup:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/customers/lookup — Support POST body lookup
router.post('/customers/lookup', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const rawPhone = req.body.phone || '';
    const cleanPhone = normalizeIndianPhone(rawPhone);

    if (!cleanPhone) {
      res.status(400).json({ 
        success: false, 
        error: 'Please provide a valid 10-digit Indian mobile number (e.g. 9876543210)' 
      });
      return;
    }

    const usersRef = adminDb.collection('users');
    let userSnap = await usersRef.where('phone', '==', cleanPhone).limit(1).get();
    
    if (userSnap.empty) {
      userSnap = await usersRef.where('phone', '==', '+91' + cleanPhone).limit(1).get();
    }

    if (!userSnap.empty) {
      const uDoc = userSnap.docs[0];
      const uData = uDoc.data();
      const name = (uData.name || uData.userName || '').trim();

      res.json({
        success: true,
        found: true,
        customer: {
          id: uDoc.id,
          name: name || 'Valued Customer',
          phone: cleanPhone,
          email: uData.email || null,
          isOnlineCustomer: !uData.source || uData.source === 'ONLINE' || uData.source === 'CUSTOMER_APP',
          isPOSCustomer: uData.source === 'POS'
        }
      });
      return;
    }

    res.json({
      success: true,
      found: false,
      phone: cleanPhone
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/customers/save — Save new/permanent customer profile from POS counter
router.post('/customers/save', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { phone: rawPhone, name, email, address } = req.body;
    const cleanPhone = normalizeIndianPhone(rawPhone);

    if (!cleanPhone) {
      res.status(400).json({ success: false, error: 'Valid 10-digit mobile number is required' });
      return;
    }

    const cleanName = (name || '').trim();
    if (!cleanName || cleanName.toLowerCase() === 'walk-in customer') {
      res.status(400).json({ success: false, error: 'Customer name is required for profile creation' });
      return;
    }

    const now = new Date().toISOString();
    const isGlobal = ['owner', 'admin', 'developer'].includes(req.user?.role || '');
    const branchId = req.user?.branchId || (isGlobal ? (req.headers['x-branch-id'] as string) : null) || null;
    const franchiseId = req.user?.franchiseId || (isGlobal ? (req.headers['x-franchise-id'] as string) : null) || null;
    const cashierUid = req.user?.uid || 'pos_cashier';

    // 1. Check if customer already exists by phone
    const usersRef = adminDb.collection('users');
    let userSnap = await usersRef.where('phone', '==', cleanPhone).limit(1).get();
    if (userSnap.empty) {
      userSnap = await usersRef.where('phone', '==', '+91' + cleanPhone).limit(1).get();
    }

    let customerId: string;

    if (!userSnap.empty) {
      // Update existing customer profile
      const existingDoc = userSnap.docs[0];
      customerId = existingDoc.id;
      await usersRef.doc(customerId).set({
        name: cleanName,
        updatedAt: now,
        lastPOSBranchId: branchId,
        lastPOSFranchiseId: franchiseId
      }, { merge: true });
    } else {
      // Create new canonical customer profile
      customerId = `cust_${cleanPhone}`;
      const newCustomerDoc = {
        id: customerId,
        uid: customerId,
        name: cleanName,
        phone: cleanPhone,
        email: email ? email.trim().toLowerCase() : null,
        role: 'customer',
        source: 'POS',
        registeredAtBranchId: branchId,
        registeredAtFranchiseId: franchiseId,
        registeredByCashierUid: cashierUid,
        createdAt: now,
        updatedAt: now
      };
      await usersRef.doc(customerId).set(newCustomerDoc, { merge: true });
    }

    res.json({
      success: true,
      message: 'Customer profile saved successfully in canonical Olive Pizza database',
      customer: {
        id: customerId,
        name: cleanName,
        phone: cleanPhone
      }
    });
  } catch (error: any) {
    console.error('[POSCustomers] Error saving customer profile:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/customers/update-name — Explicitly update customer name with audit tracking
router.post('/customers/update-name', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { customerId, name, phone } = req.body;
    const cleanName = (name || '').trim();

    if (!customerId || !cleanName) {
      res.status(400).json({ success: false, error: 'customerId and new name are required' });
      return;
    }

    const now = new Date().toISOString();
    await adminDb.collection('users').doc(customerId).set({
      name: cleanName,
      updatedAt: now
    }, { merge: true });

    res.json({
      success: true,
      message: 'Customer name updated successfully',
      customer: {
        id: customerId,
        name: cleanName,
        phone: phone || ''
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// POST /api/pos/stock/toggle — Local branch product stock toggle (Available vs Out of Stock)
router.post('/stock/toggle', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { productId, stockStatus } = req.body;

    if (!productId || !['IN_STOCK', 'OUT_OF_STOCK'].includes(stockStatus)) {
      res.status(400).json({ success: false, error: 'productId and valid stockStatus (IN_STOCK | OUT_OF_STOCK) are required' });
      return;
    }

    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    const branchId = (isOwner && req.query.branchId as string) || user.branchId!;
    const docKey = `${branchId}_${productId}`;

    const now = new Date().toISOString();
    await adminDb.collection('branch_menu_overrides').doc(docKey).set({
      branchId,
      productId,
      stockStatus,
      updatedAt: now,
      updatedByUid: user.uid,
      updatedByEmail: user.email
    }, { merge: true });

    res.json({
      success: true,
      message: `Product ${productId} is now ${stockStatus === 'IN_STOCK' ? 'Available Today' : 'Out of Stock'} for branch ${branchId}`,
      productId,
      branchId,
      stockStatus,
      isAvailable: stockStatus === 'IN_STOCK'
    });
  } catch (error: any) {
    console.error('[POSStock] Error toggling stock status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/stock/custom-price — Update branch custom price from POS (Manager only)
router.post(['/stock/custom-price', '/branch/:branchId/custom-price'], verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    if (user.role === 'cashier' || user.role === 'pos_operator') {
      res.status(403).json({ success: false, error: 'Forbidden: Cashiers and POS operators are not authorized to alter franchise selling prices.' });
      return;
    }
    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    const branchId = req.params.branchId || (isOwner && req.query.branchId as string) || user.branchId!;
    const { productId, customPrice, price, isAvailable, isEnabled } = req.body;

    if (!productId) {
      res.status(400).json({ success: false, error: 'productId is required' });
      return;
    }
    const effectivePrice = customPrice !== undefined ? customPrice : price;
    if (effectivePrice === undefined || effectivePrice === null || isNaN(Number(effectivePrice))) {
      res.status(400).json({ success: false, error: 'Valid customPrice is required' });
      return;
    }

    const syncResult = await FranchisePricingSyncService.syncPrice({
      branchId,
      productId,
      franchiseId: user.franchiseId,
      customPrice: Number(effectivePrice),
      isAvailable,
      isEnabled,
      updatedBy: user.email || 'pos_operator'
    });

    res.json({
      success: true,
      message: `Branch custom price updated to ₹${syncResult.customPrice}`,
      ...syncResult
    });
  } catch (error: any) {
    console.error('[POSStock] Error updating branch custom price:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// GET /api/pos/branches — Return all branches for Owner context switcher
router.get('/branches', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const isOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);

    if (!isOwner) {
      // Return only the cashier's assigned branch
      res.json({
        success: true,
        isOwner: false,
        branches: [{
          franchiseId: user.franchiseId!,
          branchId: user.branchId!,
          name: (user as any).branchName || 'Olive Pizza',
          code: `OP-${user.franchiseId?.slice(0, 4).toUpperCase()}`,
          city: 'Chhattisgarh'
        }]
      });
      return;
    }

    // Master Owner gets all active franchise branches
    const fSnap = await adminDb.collection('franchise_entities').get().catch(() => ({ docs: [] } as any));
    let branches = fSnap.docs.map((d: any) => {
      const data = d.data();
      return {
        franchiseId: d.id,
        branchId: data.branchId || d.id,
        name: data.franchiseName || data.name || 'Olive Pizza Branch',
        code: data.code || `OP-${d.id.slice(0, 4).toUpperCase()}`,
        city: data.city || 'Chhattisgarh'
      };
    });

    res.json({
      success: true,
      isOwner: true,
      branches
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 12. POS USER ACCOUNT PROVISIONING (Owner-Controlled Only)
// ============================================================================

// GET /api/pos/users — List all POS accounts
router.get('/users', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const snap = await adminDb.collection('users')
      .where('role', 'in', ['cashier', 'restaurant_manager', 'manager'])
      .get();

    const users = snap.docs.map(doc => {
      const d = doc.data();
      return {
        userId: doc.id,
        email: d.email,
        name: d.name || d.displayName || d.email?.split('@')[0],
        role: d.role || 'cashier',
        franchiseId: d.franchiseId || null,
        branchId: d.branchId || null,
        terminalId: d.terminalId || null,
        organizationId: d.organizationId || 'org_olive_pizza',
        status: d.isActive === false ? 'DISABLED' : (d.status || 'ACTIVE'),
        permissions: d.permissions || [
          'pos.view',
          'pos.create_bill',
          'pos.accept_online_order',
          'pos.manage_products',
          'pos.apply_discount',
          'pos.reprint_bill',
          'pos.view_history',
          'pos.manage_shift'
        ],
        lastLoginAt: d.lastLoginAt || null,
        createdAt: d.createdAt || null
      };
    });

    res.json({ success: true, count: users.length, users });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/users/create — Owner provisions a new POS cashier/manager account
router.post('/users/create', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      email,
      name,
      franchiseId,
      branchId,
      terminalId,
      role = 'cashier',
      permissions
    } = req.body;

    if (!email || !franchiseId || !branchId) {
      res.status(400).json({ success: false, error: 'email, franchiseId, and branchId are required' });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const userId = `pos_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`;
    const now = new Date().toISOString();

    const defaultPermissions = [
      'pos.view',
      'pos.create_bill',
      'pos.accept_online_order',
      'pos.manage_products',
      'pos.apply_discount',
      'pos.reprint_bill',
      'pos.view_history',
      'pos.manage_shift'
    ];

    const userPayload = {
      uid: userId,
      userId,
      email: cleanEmail,
      name: name || cleanEmail.split('@')[0],
      role,
      organizationId: 'org_olive_pizza',
      franchiseId,
      branchId,
      terminalId: terminalId || `POS-${branchId.toUpperCase().slice(0, 4)}-01`,
      status: 'ACTIVE',
      isActive: true,
      permissions: Array.isArray(permissions) ? permissions : defaultPermissions,
      createdByUid: req.user?.uid,
      createdByEmail: req.user?.email,
      createdAt: now,
      updatedAt: now
    };

    await adminDb.collection('users').doc(userId).set(userPayload, { merge: true });

    res.status(201).json({
      success: true,
      message: `POS user ${cleanEmail} created successfully for ${branchId}`,
      user: userPayload
    });
  } catch (error: any) {
    console.error('[POSUsers] Error creating POS user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/users/:userId/status — Owner toggles active / disabled / revoked status
router.post('/users/:userId/status', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;
    const { status } = req.body; // 'ACTIVE' | 'DISABLED' | 'REVOKED'

    if (!['ACTIVE', 'DISABLED', 'REVOKED'].includes(status)) {
      res.status(400).json({ success: false, error: 'Valid status (ACTIVE | DISABLED | REVOKED) is required' });
      return;
    }

    const isActive = status === 'ACTIVE';
    const now = new Date().toISOString();

    await adminDb.collection('users').doc(userId).set({
      status,
      isActive,
      updatedAt: now,
      updatedByUid: req.user?.uid,
      updatedByEmail: req.user?.email
    }, { merge: true });

    res.json({
      success: true,
      message: `POS user ${userId} status updated to ${status}`,
      userId,
      status,
      isActive
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 13. POS TELEMETRY, HEALTH HEARTBEAT & OFFLINE SYNC
// ============================================================================

// POST /api/pos/health/heartbeat — Terminal periodic heartbeat
router.post('/health/heartbeat', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const {
      terminalId,
      branchId,
      franchiseId,
      shiftId,
      isOnline = true,
      pendingSyncCount = 0,
      printerStatus = 'UNKNOWN',
      appVersion = '1.0.0',
      batteryLevel,
      clientTimestamp
    } = req.body;

    const resolvedTerminalId = terminalId || user.terminalId || `pos_${user.franchiseId}`;
    const resolvedBranchId = branchId || user.branchId!;
    const resolvedFranchiseId = franchiseId || user.franchiseId!;

    const result = await POSTelemetryHealthService.recordHeartbeat({
      terminalId: resolvedTerminalId,
      branchId: resolvedBranchId,
      franchiseId: resolvedFranchiseId,
      cashierUid: user.uid,
      cashierName: user.email?.split('@')[0] || 'Counter Cashier',
      shiftId,
      isOnline,
      pendingSyncCount,
      printerStatus,
      appVersion,
      batteryLevel,
      clientTimestamp
    });

    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/pos/health/telemetry — Global telemetry for authorized Owner/Developer dashboard
router.get('/health/telemetry', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const telemetry = await POSTelemetryHealthService.getGlobalTelemetryOverview();
    res.json({ success: true, ...telemetry });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/bills/sync-offline — Batch idempotent sync of offline-created bills
router.post(['/bills/sync-offline', '/bills/offline-sync'], verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { bills } = req.body;

    if (!bills || !Array.isArray(bills) || bills.length === 0) {
      res.status(400).json({ success: false, error: 'bills array is required' });
      return;
    }

    const branchId = user.branchId!;
    let franchiseId = user.franchiseId!;

    // Enforce branch ownership validation against authenticated franchise tenant
    try {
      const branchAuthCheck = await query(
        `SELECT id, franchise_id, is_open FROM restaurant_branches WHERE id = $1 LIMIT 1`,
        [branchId]
      );
      if (branchAuthCheck.rows.length === 0) {
        res.status(403).json({
          success: false,
          error: `Forbidden: Branch "${branchId}" does not exist in authorized restaurant records.`
        });
        return;
      }
      const trustedBranchFranchise = branchAuthCheck.rows[0].franchise_id;
      if (franchiseId) {
        if (!trustedBranchFranchise) {
          res.status(403).json({
            success: false,
            error: `Forbidden: Branch "${branchId}" has no assigned franchise ownership. Operation rejected.`
          });
          return;
        }
        if (trustedBranchFranchise !== franchiseId) {
          res.status(403).json({
            success: false,
            error: `Forbidden: Cross-franchise access rejected. Branch "${branchId}" belongs to franchise "${trustedBranchFranchise}", not "${franchiseId}".`
          });
          return;
        }
      }
      franchiseId = trustedBranchFranchise || franchiseId;
    } catch (authErr: any) {
      console.error('[POS Sync-Offline] Branch authorization query failed:', authErr.message || authErr);
      res.status(500).json({
        success: false,
        error: `Database authorization failure verifying branch "${branchId}". Operation rejected.`
      });
      return;
    }

    const processedBills: any[] = [];
    let duplicateCount = 0;

    for (const bill of bills) {
      const idempotencyKey = bill.idempotencyKey || bill.orderId || `offline_${Date.now()}`;
      const syncOrderId = bill.orderId || idempotencyKey;
      
      try {
        // 1. Check PostgreSQL canonical ledger first for stable duplicate suppression
        const existingOrder = await query(
          `SELECT id, permanent_bill_no, daily_order_no, payment_status, total_amount, request_fingerprint 
           FROM canonical_orders 
           WHERE id = $1 LIMIT 1`,
          [syncOrderId]
        );

        if (existingOrder.rows.length > 0) {
          const existRow = existingOrder.rows[0];
          const incomingTotal = Number(bill.finalTotal ?? bill.totalAmount ?? bill.total ?? 0);
          const existingTotal = Number(existRow.total_amount);

          let isFingerprintConflict = false;
          if (existRow.request_fingerprint && Array.isArray(bill.items) && bill.items.length > 0) {
            try {
              const incomingFingerprint = CanonicalOrderService.computeOrderFingerprint({
                id: syncOrderId,
                orderSource: bill.orderSource || 'POS_TAKEAWAY',
                orderType: bill.orderType,
                customerPhone: bill.customerPhone,
                franchiseId,
                branchId,
                terminalId: bill.session?.terminalId,
                items: bill.items,
                subtotal: bill.subtotal || 0,
                discountAmount: bill.discountAmount || 0,
                taxAmount: bill.taxAmount || 0,
                deliveryFee: bill.deliveryFee || 0,
                totalAmount: incomingTotal,
                paymentMethod: bill.paymentMethod || 'CASH'
              });
              if (incomingFingerprint !== existRow.request_fingerprint) {
                isFingerprintConflict = true;
              }
            } catch (fpErr) {
              // fallback to amount comparison
            }
          }

          if (isFingerprintConflict || (incomingTotal > 0 && Math.abs(incomingTotal - existingTotal) > 0.05)) {
            processedBills.push({
              id: existRow.id,
              idempotencyKey,
              status: 'CONFLICT',
              success: false,
              code: 'IDEMPOTENCY_CONFLICT',
              error: `Idempotency conflict: key "${idempotencyKey}" was previously recorded with conflicting details.`,
              permanentBillNo: Number(existRow.permanent_bill_no),
              duplicate: false
            });
            continue;
          }

          duplicateCount++;
          processedBills.push({
            id: existRow.id,
            idempotencyKey,
            status: 'ALREADY_SYNCED',
            success: true,
            permanentBillNo: Number(existRow.permanent_bill_no),
            dailyOrderNumber: Number(existRow.daily_order_no),
            billNumber: `#${existRow.permanent_bill_no}`,
            duplicate: true
          });
          continue;
        }

        // Calculate server-authoritative totals
        const calc = await POSService.calculateBill({
          items: bill.items || [],
          orderType: bill.orderSource === 'POS_DINE_IN' ? 'DINE_IN' : (bill.orderSource === 'POS_TAKEAWAY' ? 'TAKEAWAY' : 'DELIVERY'),
          discountAmount: bill.discountAmount || 0,
          couponCode: bill.couponCode,
          branchId
        });

        const orderId = syncOrderId;

        // Payment status resolution for offline bills (Defect 1 & 2):
        // Cash is locally collected in physical cash drawer.
        // Offline UPI, Card, and Split digital remain PENDING (reconciliation-required) on the server.
        // Client-supplied flags (isUpiVerified, isCardVerified) are strictly rejected as proof of settlement.
        const offlinePayMethod = (bill.payment?.method || bill.paymentMethod || 'CASH').toString().toUpperCase();
        let offlinePayStatus = 'PENDING';
        if (offlinePayMethod === 'CASH') {
          offlinePayStatus = 'PAID';
        } else {
          const digitalRef = (bill.payment?.paymentId || bill.paymentId || bill.payment?.providerTransactionId || '').toString().trim();
          let isServerVerified = false;
          if (digitalRef) {
            const bindRes = await PaymentService.verifyAndBindCapturedPayment({
              paymentRef: digitalRef,
              targetOrderId: syncOrderId,
              expectedAmount: calc.finalTotal,
              expectedMethod: offlinePayMethod,
            });
            isServerVerified = bindRes.verified;
            if (!bindRes.verified && bindRes.reason === 'ALREADY_CONSUMED') {
              console.warn(`[SyncOffline] Payment ${digitalRef} already consumed by another order. Marked PENDING for reconciliation.`);
            }
          }
          offlinePayStatus = isServerVerified ? 'PAID' : 'PENDING';
        }

        // Authoritative Canonical PostgreSQL Order, Items, and Bill Commit (Atomic & Mandatory)
        const canonicalResult = await CanonicalOrderService.createCanonicalOrder({
          id: orderId,
          orderSource: 'POS',
          orderType: bill.orderSource || 'POS_DINE_IN',
          customerName: bill.customerName || 'Walk-in Customer',
          customerPhone: bill.customerPhone || 'N/A',
          items: (calc.items || []).map((it: any) => ({
            menuItemId: it.menuItemId || it.id,
            name: it.name,
            price: it.price,
            quantity: it.quantity,
            size: it.size,
            crust: it.crust,
            addons: it.addons
          })),
          subtotal: calc.subtotal,
          discountAmount: calc.discountAmount,
          taxAmount: calc.taxes,
          totalAmount: calc.finalTotal,
          paymentMethod: offlinePayMethod,
          paymentStatus: offlinePayStatus,
          orderStatus: 'completed',
          franchiseId,
          branchId,
          cashierId: user.uid,
          cashierName: bill.session?.cashierName || user.email?.split('@')[0],
          terminalId: bill.session?.terminalId || user.terminalId || `pos_${user.franchiseId}`
        });

        const permBillNo = canonicalResult.permanentBillNo;

        // Consistent Offline Payment Status (Defect 2):
        // Use the exact same validated payment outcome in PostgreSQL and the Firestore projection.
        // Never default to 'PAID' when canonical status is unknown or pending!
        const orderData = {
          id: orderId,
          orderId,
          idempotencyKey,
          permanentBillNo: permBillNo,
          billNumber: `#${permBillNo}`,
          dailyOrderNumber: canonicalResult.dailyOrderNo,
          orderNumber: `#${canonicalResult.dailyOrderNo}`,
          orderDateLocal: canonicalResult.orderDate,
          orderTimeLocal: canonicalResult.orderTime,
          userId: user.uid,
          customerName: bill.customerName || 'Walk-in Customer',
          contactPhone: bill.customerPhone || 'N/A',
          items: calc.items,
          totalAmount: calc.finalTotal,
          subtotal: calc.subtotal,
          discountAmount: calc.discountAmount,
          taxAmount: calc.taxes,
          deliveryFee: calc.deliveryFee,
          paymentMethod: offlinePayMethod,
          paymentStatus: offlinePayStatus,
          status: 'completed',
          source: 'POS',
          orderType: bill.orderSource || 'POS_DINE_IN',
          orderSource: bill.orderSource || 'POS_DINE_IN',
          tableNumber: bill.tableNumber || null,
          terminalId: bill.session?.terminalId || user.terminalId || `pos_${user.franchiseId}`,
          branchId,
          franchiseId,
          cashierName: bill.session?.cashierName || user.email?.split('@')[0],
          cashierUid: user.uid,
          isOfflineSync: true,
          offlineCreatedAt: bill.createdAt || new Date().toISOString(),
          syncedAt: new Date().toISOString(),
          createdAt: bill.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await adminDb.collection('orders').doc(orderId).set(orderData, { merge: true });

        // Async Google Sheets reporting queue (non-blocking)
        SheetsSyncWorker.queueOrder(orderId, {
          id: orderId,
          franchiseId,
          branchId,
          totalAmount: calc.finalTotal,
          customerName: orderData.customerName,
          paymentMethod: orderData.paymentMethod,
          orderType: orderData.orderType,
          items: calc.items,
          createdAt: orderData.createdAt
        }).catch((sheetsErr) => {
          console.warn('[OfflineSync] Sheets sync queue warning (non-fatal):', sheetsErr?.message);
        });

        // Active shift sales tally for offline synchronized bill
        try {
          const activeShift = await POSService.getActiveShift(branchId, orderData.terminalId);
          if (activeShift) {
            const shiftRef = adminDb.collection('pos_shifts').doc(activeShift.id);
            const isCash = orderData.paymentMethod === 'CASH';
            const cashAmount = isCash ? calc.finalTotal : 0;
            const digitalAmount = !isCash ? calc.finalTotal : 0;
            await shiftRef.set({
              totalRevenue: (activeShift.totalRevenue || 0) + calc.finalTotal,
              totalBills: (activeShift.totalBills || 0) + 1,
              cashSales: (activeShift.cashSales || 0) + cashAmount,
              expectedCash: (activeShift.openingCash || 0) + (activeShift.cashSales || 0) + cashAmount,
              updatedAt: new Date().toISOString()
            }, { merge: true });

            await POSShiftRepository.recordSale(activeShift.id, cashAmount, digitalAmount);
          }
        } catch (shErr: any) {
          console.warn('[SyncOffline] Active shift sale tally update notice:', shErr.message);
        }

        processedBills.push({
          id: orderId,
          idempotencyKey,
          status: 'SYNCED',
          success: true,
          permanentBillNo: permBillNo || null,
          duplicate: false
        });
      } catch (billErr: any) {
        console.error(`[SyncOffline] Error syncing offline bill ${idempotencyKey}:`, billErr?.message);
        processedBills.push({
          idempotencyKey,
          status: 'FAILED',
          success: false,
          error: billErr?.message || 'Bill synchronization error'
        });
      }
    }

    const successCount = processedBills.filter(b => b.success).length;
    res.json({
      success: true,
      message: `Processed ${processedBills.length} offline transactions (${successCount} succeeded, ${duplicateCount} duplicates suppressed)`,
      processedCount: processedBills.length,
      successCount,
      duplicateCount,
      results: processedBills
    });
  } catch (error: any) {
    console.error('[OfflineSync] Error synchronizing offline bills:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/pos/reprint-audit — Log authorized receipt reprint into audit log
router.post('/reprint-audit', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { orderId, billNumber, reason = 'Customer requested duplicate receipt' } = req.body;

    if (!orderId) {
      res.status(400).json({ success: false, error: 'orderId is required' });
      return;
    }

    const now = new Date().toISOString();
    await adminDb.collection('restaurant_audit_logs').add({
      action: 'POS_RECEIPT_REPRINT',
      orderId,
      billNumber: billNumber || orderId,
      terminalId: user.terminalId || `pos_${user.franchiseId}`,
      branchId: user.branchId!,
      franchiseId: user.franchiseId!,
      cashierUid: user.uid,
      cashierEmail: user.email,
      reason,
      timestamp: now
    });

    res.json({
      success: true,
      message: 'Reprint action audited successfully',
      orderId,
      auditedAt: now
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// 4.10. TEST NETWORK / WIFI PRINTER (SECTION 10)
// ============================================================================
router.post('/printer/test-network', verifyToken, requirePOSRole, async (req: AuthRequest, res: Response): Promise<void> => {
  const { ip, port = 9100 } = req.body;
  if (!ip) {
    res.status(400).json({ success: false, error: 'Printer IP address is required' });
    return;
  }

  const socket = new net.Socket();
  socket.setTimeout(3500);

  let responded = false;
  const finish = (success: boolean, error?: string) => {
    if (responded) return;
    responded = true;
    socket.destroy();
    res.json({ success, message: success ? `Network printer reached at ${ip}:${port}` : error });
  };

  socket.connect(Number(port), ip, () => {
    // Send ESC @ (initialize printer)
    socket.write(Buffer.from([0x1B, 0x40]));
    finish(true);
  });

  socket.on('timeout', () => {
    finish(false, `Connection timed out to printer at ${ip}:${port}`);
  });

  socket.on('error', (err) => {
    finish(false, `Socket connection error: ${err.message}`);
  });
});

export default router;


