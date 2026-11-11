import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { Router, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { pgPool } from '../config/postgres.js';
import { webSocketServer } from '../services/websocket/WebSocketServer.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { DeliveryDataLifecycleService } from '../services/delivery/DeliveryDataLifecycleService.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';
import { RestaurantTemplates, CustomerTemplates, DeliveryTemplates } from '../services/notification/NotificationTemplates.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { RiderDispatchEngine } from '../services/delivery/RiderDispatchEngine.js';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { RiderWorkScheduleService } from '../services/delivery/RiderWorkScheduleService.js';
import { withTimeout, getIstDateKey, getIstStartOfDay } from '../lib/utils.js';

const router = Router();

async function resolveRiderContext(uid: string, email?: string): Promise<{
  riderIds: string[];
  primaryPartnerId: string;
  partnerRow: any | null;
}> {
  let partnerRow: any | null = null;
  const emailLower = (email || '').trim().toLowerCase();
  try {
    const dpRes = await pgPool.query(
      `SELECT id, user_id, name, phone, email, branch_id, franchise_id, vehicle_type, vehicle_number, is_online, status, active_order_id, current_lat, current_lng, last_location_time, created_at
       FROM delivery_partners
       WHERE id = $1 OR user_id = $1 OR ($2 <> '' AND LOWER(email) = LOWER($2))
       ORDER BY (id = $1) DESC
       LIMIT 1`,
      [uid, emailLower]
    );
    if (dpRes.rows.length > 0) {
      partnerRow = dpRes.rows[0];
    }
  } catch (err: any) {
    console.warn('[RiderDelivery] Failed to resolve rider PG profile:', err.message);
  }
  const riderIds = Array.from(new Set([uid, partnerRow?.id, partnerRow?.user_id].filter(Boolean)));
  return {
    riderIds,
    primaryPartnerId: partnerRow?.id || uid,
    partnerRow,
  };
}

// Helper to calculate distance in meters using Haversine formula
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

router.use(verifyToken);
// Only delivery partners, managers, or owners are authorized
router.use(requireRole(['delivery_partner', 'delivery', 'owner', 'admin', 'developer', 'restaurant_manager', 'manager']));

// 1. GET /me - Rider Profile & Restaurant Operational Context
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { partnerRow } = await resolveRiderContext(uid, req.user?.email);

    let userData: any = {};
    try {
      const userDoc = await withTimeout(adminDb.collection('users').doc(uid).get(), 'riderDelivery.meUserRead', 1200);
      if (userDoc.exists) userData = userDoc.data()!;
    } catch (fsErr: any) {
      console.warn('[RiderDelivery] Firestore user read notice in /me:', fsErr.message);
    }

    const branchId = partnerRow?.branch_id || userData.branchId || req.user?.branchId || 'main_branch';
    const franchiseId = partnerRow?.franchise_id || userData.franchiseId || req.user?.franchiseId || 'fra_primary';

    let branchData: any = null;
    try {
      const bRes = await pgPool.query(
        `SELECT name, address, phone, delivery_settings, operating_hours FROM restaurant_branches WHERE id = $1 LIMIT 1`,
        [branchId]
      );
      if (bRes.rows.length > 0) {
        const b = bRes.rows[0];
        branchData = {
          name: b.name,
          address: b.address,
          phone: b.phone,
          maxDeliveryRadiusKm: b.delivery_settings?.radiusKm ?? 15,
          openingTime: b.operating_hours?.open || '12:00',
          closingTime: b.operating_hours?.close || '23:59',
        };
      }
    } catch {}

    if (!branchData) {
      const branchDoc = await withTimeout(adminDb.collection('franchises').doc(branchId).get(), 'riderDelivery.meBranchRead', 1200).catch(() => null);
      branchData = branchDoc && branchDoc.exists ? branchDoc.data() : null;
    }

    const workingSchedule = [
      { day: 'Monday', hours: '12:00 PM - 11:00 PM', isOff: false },
      { day: 'Tuesday', hours: '12:00 PM - 11:00 PM', isOff: false },
      { day: 'Wednesday', hours: '12:00 PM - 11:00 PM', isOff: false },
      { day: 'Thursday', hours: '12:00 PM - 11:00 PM', isOff: false },
      { day: 'Friday', hours: '12:00 PM - 11:30 PM', isOff: false },
      { day: 'Saturday', hours: '12:00 PM - 11:30 PM', isOff: false },
      { day: 'Sunday', hours: '12:00 PM - 11:30 PM', isOff: false }
    ];

    res.json({
      success: true,
      rider: {
        uid,
        id: partnerRow?.id || uid,
        partnerId: partnerRow?.id || uid,
        name: partnerRow?.name || userData.name || userData.displayName || 'Rider',
        email: partnerRow?.email || userData.email || req.user?.email || '',
        phone: partnerRow?.phone || userData.phone || userData.phoneNumber || null,
        role: 'delivery_partner',
        vehicleType: partnerRow?.vehicle_type || userData.vehicleType || null,
        vehicleNumber: partnerRow?.vehicle_number || userData.vehicleNumber || null,
        organizationId: userData.organizationId || 'org_olive_pizza',
        franchiseId,
        branchId,
        branchName: branchData?.name || null,
        branchAddress: branchData?.address || null,
        branchPhone: branchData?.phone || null,
        isOnline: partnerRow ? partnerRow.is_online !== false : userData.isOnline !== false,
        workingSchedule,
        joiningDate: partnerRow?.created_at || userData.createdAt || null,
        emergencyContact: userData.emergencyContact || (branchData?.phone ? { name: 'Support Hotline', phone: branchData.phone } : null)
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch rider profile' });
  }
});

// 2. GET /today - Today's Operational Shift Report (IST / Asia/Kolkata)
router.get('/today', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid!;
    const { riderIds } = await resolveRiderContext(uid, req.user?.email);
    const todayStart = getIstStartOfDay();
    const todayIso = todayStart.toISOString();
    const todayIstKey = getIstDateKey();

    let assignedCount = 0;
    let completedCount = 0;
    let activeCount = 0;
    let cancelledCount = 0;
    let totalEarnings = 0;
    let totalDistanceKm = 0;
    let totalMinutes = 0;
    const seenIds = new Set<string>();

    try {
      const pgRes = await pgPool.query(
        `SELECT id, LOWER(order_status) AS status, delivery_fee, partner_assigned_at, delivered_at
         FROM canonical_orders
         WHERE delivery_partner_id = ANY($1::text[]) AND created_at >= $2`,
        [riderIds, todayStart]
      );
      for (const row of pgRes.rows) {
        seenIds.add(row.id);
        assignedCount++;
        if (row.status === 'delivered' || row.status === 'completed') {
          completedCount++;
          totalEarnings += Number(row.delivery_fee || 40);
          totalDistanceKm += 3.8;
          if (row.partner_assigned_at && row.delivered_at) {
            const mins = Math.round((new Date(row.delivered_at).getTime() - new Date(row.partner_assigned_at).getTime()) / 60000);
            totalMinutes += mins > 0 ? mins : 24;
          } else {
            totalMinutes += 24;
          }
        } else if (['accepted', 'partner_assigned', 'preparing', 'ready', 'picked_up', 'out_for_delivery'].includes(row.status)) {
          activeCount++;
        } else if (row.status === 'cancelled' || row.status === 'rejected') {
          cancelledCount++;
        }
      }
    } catch (pgErr: any) {
      console.warn('[RiderDelivery] PostgreSQL /today query notice:', pgErr.message);
    }

    const ordersSnap = await withTimeout(
      adminDb.collection('orders')
        .where('deliveryPartnerId', '==', uid)
        .where('createdAt', '>=', todayIso)
        .get(),
      'riderDelivery.todayOrders',
      1200
    ).catch(() => ({ docs: [] } as any));

    (ordersSnap.docs || []).forEach((doc: any) => {
      if (seenIds.has(doc.id)) return;
      seenIds.add(doc.id);
      assignedCount++;
      const data = doc.data();
      const st = (data.status || '').toLowerCase();
      if (st === 'delivered' || st === 'completed') {
        completedCount++;
        totalEarnings += Number(data.deliveryFee || 40);
        totalDistanceKm += Number(data.deliveryDistanceKm || 3.8);
        totalMinutes += Number(data.deliveryDurationMin || 24);
      } else if (['accepted', 'partner_assigned', 'preparing', 'ready', 'picked_up', 'out_for_delivery'].includes(st)) {
        activeCount++;
      } else if (st === 'cancelled' || st === 'rejected') {
        cancelledCount++;
      }
    });

    const avgTime = completedCount > 0 ? Math.round(totalMinutes / completedCount) : 0;

    res.json({
      success: true,
      today: {
        assigned: assignedCount,
        completed: completedCount,
        active: activeCount,
        cancelled: cancelledCount,
        totalDistanceKm: Number(totalDistanceKm.toFixed(1)),
        averageDeliveryTimeMin: avgTime,
        earnings: totalEarnings,
        currency: 'INR',
        date: todayIstKey
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch today's delivery report" });
  }
});

// 3. GET /monthly-reports - Monthly Historical Aggregates
router.get('/monthly-reports', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid!;
    const branchId = req.user?.branchId || 'main_branch';
    const reports = await DeliveryDataLifecycleService.getRiderMonthlyReports(uid, branchId);
    res.json({ success: true, reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch monthly reports' });
  }
});

// 4. GET /active-orders - Live Assigned Deliveries for Authenticated Rider
router.get('/active-orders', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid!;
    const { riderIds } = await resolveRiderContext(uid, req.user?.email);
    const activeStatuses = ['partner_assigned', 'accepted', 'ready', 'preparing', 'picked_up', 'out_for_delivery'];

    const orders: any[] = [];
    const seenOrderIds = new Set<string>();

    // Authoritative Primary Query: PostgreSQL canonical_orders strictly scoped to authenticated rider identities
    try {
      const ordRes = await pgPool.query(
        `SELECT id
         FROM canonical_orders
         WHERE order_status IN ('ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'PARTNER_ASSIGNED')
           AND delivery_partner_id = ANY($1::text[])
         ORDER BY created_at DESC
         LIMIT 20`,
        [riderIds]
      );

      for (const row of ordRes.rows) {
        const hist = await OrderPersistenceArchiveService.getHistoricalOrder(row.id);
        if (hist && activeStatuses.includes(hist.status)) {
          orders.push(OrderProjectionService.projectForDeliveryRider(hist, hist.id));
          seenOrderIds.add(hist.id);
        }
      }
    } catch (pgErr: any) {
      console.warn('[RiderDelivery] PostgreSQL active orders lookup notice:', pgErr.message);
    }

    // Secondary Merge: Firestore orders assigned to this rider (bounded so Spark quota never stalls active-orders)
    try {
      for (const rid of riderIds.slice(0, 5)) {
        const snap = await withTimeout(
          adminDb.collection('orders')
            .where('deliveryPartnerId', '==', rid)
            .where('status', 'in', activeStatuses)
            .get(),
          `riderDelivery.activeOrders.${rid}`,
          1200
        );

        for (const d of snap.docs) {
          if (!seenOrderIds.has(d.id)) {
            seenOrderIds.add(d.id);
            orders.push(OrderProjectionService.projectForDeliveryRider(d.data(), d.id));
          }
        }
      }
    } catch (fsErr: any) {
      console.warn('[RiderDelivery] Firestore active orders read notice:', fsErr.message);
    }

    res.json({ success: true, orders });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch active orders' });
  }
});

// 5. GET /history - Detailed History (CURRENT MONTH ONLY)
router.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid!;
    const { riderIds } = await resolveRiderContext(uid, req.user?.email);
    const currentMonthStartDate = DeliveryDataLifecycleService.getCurrentMonthStartDate();
    const currentMonthStart = currentMonthStartDate.toISOString();

    const orders: any[] = [];
    const seenIds = new Set<string>();
    try {
      const histRes = await pgPool.query(
        `SELECT id FROM canonical_orders
         WHERE delivery_partner_id = ANY($1::text[]) AND created_at >= $2
         ORDER BY created_at DESC LIMIT 100`,
        [riderIds, currentMonthStartDate]
      );
      for (const row of histRes.rows) {
        const hist = await OrderPersistenceArchiveService.getHistoricalOrder(row.id);
        if (hist) {
          seenIds.add(hist.id);
          orders.push(OrderProjectionService.projectForDeliveryRider(hist, hist.id));
        }
      }
    } catch (pgErr: any) {
      console.warn('[RiderDelivery] PG /history lookup notice:', pgErr.message);
    }

    const snap = await withTimeout(
      adminDb.collection('orders')
        .where('deliveryPartnerId', '==', uid)
        .where('createdAt', '>=', currentMonthStart)
        .orderBy('createdAt', 'desc')
        .limit(100)
        .get(),
      'riderDelivery.historyRead',
      1200
    ).catch(() => ({ docs: [] } as any));

    for (const d of snap.docs || []) {
      if (!seenIds.has(d.id)) {
        seenIds.add(d.id);
        orders.push(OrderProjectionService.projectForDeliveryRider(d.data(), d.id));
      }
    }

    res.json({
      success: true,
      currentMonth: DeliveryDataLifecycleService.getCurrentMonthKey(),
      orders
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch current month delivery history' });
  }
});

// Helper for handling rider delivery actions idempotently
async function processRiderOrderAction(req: AuthRequest, res: Response, forcedAction?: string): Promise<void> {
  const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.requestId || req.body.idempotencyKey || `act_${Date.now()}`;
  try {
    const orderId = req.params.id;
    const action = forcedAction || req.body.action;
    const { riderLat, riderLng, proofImageUrl, signatureUrl, notes, reason, expectedVersion, clientCoordinates } = req.body;
    const uid = req.user?.uid!;
    const { riderIds, partnerRow } = await resolveRiderContext(uid, req.user?.email);
    const name = partnerRow?.name || (req.user as any)?.name || req.user?.email || 'Delivery Partner';
    const userRole = (req.user?.role || '').toLowerCase();

    const isMasterAccount = userRole === 'owner' || userRole === 'platform_owner' || req.user?.isGlobalOwner === true;
    const isDeliveryRole = userRole === 'delivery_partner' || userRole === 'delivery' || userRole === 'rider' || isMasterAccount;

    if (!isDeliveryRole) {
      res.status(403).json({
        success: false,
        error: 'Forbidden: Delivery partner authorization required',
        code: 'DELIVERY_PARTNER_REQUIRED'
      });
      return;
    }

    if (!action) {
      res.status(400).json({ success: false, error: 'Action is required' });
      return;
    }

    const orderRef = adminDb.collection('orders').doc(orderId);
    let orderData: any = null;
    try {
      orderData = await OrderPersistenceArchiveService.getHistoricalOrder(orderId);
    } catch (pgErr: any) {
      console.warn(`[RiderDelivery] PostgreSQL order read notice for ${orderId}:`, pgErr.message);
    }

    if (!orderData) {
      try {
        const orderDoc = await withTimeout(orderRef.get(), `riderDelivery.orderRead.${orderId}`, 1200);
        if (orderDoc.exists) orderData = orderDoc.data()!;
      } catch (fsErr: any) {
        console.warn(`[RiderDelivery] Firestore order read notice for ${orderId}:`, fsErr.message);
      }
    }

    if (!orderData) {
      res.status(404).json({ success: false, error: 'Order not found' });
      return;
    }

    // Optimistic Concurrency / Version Check
    if (expectedVersion !== undefined && orderData.version !== undefined && Number(orderData.version) !== Number(expectedVersion)) {
      res.status(409).json({
        success: false,
        error: `Version conflict: order is at version ${orderData.version}, expected ${expectedVersion}`,
        code: 'VERSION_CONFLICT',
        currentVersion: orderData.version
      });
      return;
    }

    // Ownership check: delivery partner can only execute actions on their own assigned order
    if (
      orderData.deliveryPartnerId &&
      !riderIds.includes(orderData.deliveryPartnerId) &&
      !isMasterAccount
    ) {
      res.status(403).json({ success: false, error: 'Forbidden: This order is assigned to a different delivery partner.' });
      return;
    }

    const currentStatus = (orderData.status || '').toLowerCase();

    // Check terminal states
    if (['cancelled', 'rejected', 'failed'].includes(currentStatus)) {
      res.status(400).json({ success: false, error: `Cannot execute action on ${currentStatus} order.` });
      return;
    }

    // Idempotency: Check if this idempotency key was already processed
    if (orderData.lastActionIdempotencyKey === idempotencyKey) {
      res.json({
        success: true,
        duplicate: true,
        message: 'Action already processed (idempotent)',
        orderId,
        status: currentStatus,
        idempotencyKey
      });
      return;
    }

    // For operational actions, rider MUST be online and have a valid GPS fix
    if (req.user?.role === 'delivery_partner' || req.user?.role === 'delivery') {
      let partnerData: any = {};
      if (partnerRow) {
        partnerData = {
          isOnline: partnerRow.is_online !== false,
          lastLocationUpdate: partnerRow.last_location_time
        };
      }
      if (partnerData.isOnline === undefined) {
        try {
          const partnerDoc = await withTimeout(adminDb.collection('delivery_partners').doc(uid).get(), `riderDelivery.dpRead.${uid}`, 1200);
          if (partnerDoc.exists) partnerData = partnerDoc.data()!;
        } catch (err: any) {
          console.warn(`[RiderDelivery] Delivery partner profile read notice for ${uid}:`, err.message);
        }
      }

      // Check Supabase delivery_locations if partnerData online status not resolved
      if (partnerData.isOnline === undefined) {
        try {
          const loc = await SupabaseGpsService.getLatestLocation(uid);
          if (loc) {
            partnerData.isOnline = loc.online_status ?? true;
            partnerData.lastLocationUpdate = loc.last_updated;
          }
        } catch {}
      }

      if (partnerData.isOnline === false) {
        res.status(403).json({
          success: false,
          code: 'RIDER_OFFLINE',
          error: 'You are currently off-duty. You must be Online with active GPS to perform delivery actions.'
        });
        return;
      }

      // Check GPS freshness (within 90 seconds)
      const lastUpdate = partnerData.lastLocationUpdate || partnerData.timestamp;
      const lastTime = lastUpdate ? new Date(lastUpdate).getTime() : 0;
      if (!lastTime || Date.now() - lastTime > 90 * 1000) {
        const inlineLat = Number(req.body?.lat ?? req.body?.riderLat);
        const inlineLng = Number(req.body?.lng ?? req.body?.riderLng);
        if (isNaN(inlineLat) || isNaN(inlineLng) || inlineLat < -90 || inlineLat > 90 || inlineLng < -180 || inlineLng > 180) {
          let hasFreshGps = false;
          try {
            const loc = await SupabaseGpsService.getLatestLocation(uid);
            if (loc && loc.last_updated && (Date.now() - new Date(loc.last_updated).getTime() <= 90 * 1000)) {
              hasFreshGps = true;
            }
          } catch {}

          if (!hasFreshGps && process.env.NODE_ENV === 'production') {
            res.status(403).json({
              success: false,
              code: 'GPS_REQUIRED',
              error: 'Active GPS fix is required to perform delivery actions. Please enable location on your device.'
            });
            return;
          }
        }
      }
    }

    const normalizedAction = action.toUpperCase().trim();

    switch (normalizedAction) {
      case 'ACCEPT':
      case 'ACCEPT_DELIVERY': {
        // Concurrency check: if already accepted by another rider
        if (orderData.deliveryPartnerId && !riderIds.includes(orderData.deliveryPartnerId)) {
          res.status(409).json({
            success: false,
            error: 'Order already accepted by another delivery partner.',
            code: 'ORDER_ALREADY_ACCEPTED',
            orderId,
            assignedPartnerId: orderData.deliveryPartnerId
          });
          return;
        }

        const nowIso = new Date().toISOString();
        const assignedPartnerId = orderData.deliveryPartnerId || partnerRow?.id || uid;
        const updateData: Record<string, any> = {
          riderAccepted: true,
          riderAcceptedAt: nowIso,
          riderAssignmentStatus: 'accepted',
          lastActionIdempotencyKey: idempotencyKey,
          updatedAt: new Date()
        };

        if (!orderData.deliveryPartnerId) {
          updateData.deliveryPartnerId = assignedPartnerId;
          updateData.deliveryPartnerName = name;
        }

        await withTimeout(orderRef.set(updateData, { merge: true }), `riderDelivery.acceptOrderWrite.${orderId}`, 1200).catch(() => {});

        try {
          const { query } = await import('../lib/db.js');
          await query(`
            UPDATE canonical_orders
            SET delivery_partner_id = $1,
                delivery_partner_name = $2,
                partner_assigned_at = COALESCE(partner_assigned_at, NOW()),
                updated_at = NOW()
            WHERE id = $3
          `, [assignedPartnerId, name, orderId]);
          await query(`
            UPDATE delivery_partners
            SET active_order_id = $2, updated_at = NOW()
            WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])
          `, [riderIds, orderId]);
        } catch (pgErr: any) {}

        // Update rider busy status & active order lock (bounded Firestore so quota never stalls rider accept)
        await withTimeout(adminDb.collection('users').doc(uid).set({
          activeOrderId: orderId,
          isBusy: true,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.acceptUserWrite.${uid}`, 1200).catch(() => {});
        await withTimeout(adminDb.collection('delivery_partners').doc(uid).set({
          activeOrderId: orderId,
          isBusy: true,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.acceptDpWrite.${uid}`, 1200).catch(() => {});

        // Send updated in-place notification to rider for next action (PICKED_UP)
        setImmediate(async () => {
          try {
            const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
            const updatePayload = DeliveryTemplates.deliveryUpdate(orderId, {
              orderNumber: shortId,
              customerName: orderData.customerName || 'Customer',
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
              stage: 'arrived_restaurant',
              eta: '10 mins'
            });
            await notificationEngine.send(uid, updatePayload, {
              category: 'alarm_actionable',
              priority: 'high',
              orderId,
              targetApp: 'delivery'
            });
          } catch (notifErr: any) {
            console.warn('[RiderDelivery] Notice update failed:', notifErr.message);
          }
        });

        res.json({
          success: true,
          message: 'Delivery assignment accepted',
          orderId,
          status: 'accepted',
          canonicalStatus: orderData.status || 'partner_assigned',
          idempotencyKey
        });
        return;
      }

      case 'DECLINE':
      case 'DECLINE_DELIVERY': {
        const declinedPartners = Array.isArray(orderData.declinedPartnerIds) ? [...orderData.declinedPartnerIds] : [];
        if (!declinedPartners.includes(uid)) {
          declinedPartners.push(uid);
        }

        await pgPool.query(
          `UPDATE canonical_orders
           SET delivery_partner_id = NULL, delivery_partner_name = NULL, partner_assigned_at = NULL, updated_at = NOW()
           WHERE id = $1`,
          [orderId]
        ).catch(() => {});
        await pgPool.query(
          `UPDATE delivery_partners SET active_order_id = NULL, updated_at = NOW()
           WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])`,
          [riderIds]
        ).catch(() => {});

        await withTimeout(orderRef.set({
          deliveryPartnerId: null,
          deliveryPartnerName: null,
          deliveryPartnerPhone: null,
          declinedPartnerIds: declinedPartners,
          riderAssignmentStatus: 'declined',
          lastDeclineReason: reason || 'Declined from notification tray',
          lastActionIdempotencyKey: idempotencyKey,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.declineOrderWrite.${orderId}`, 1200).catch(() => {});

        // Release rider busy state
        await withTimeout(adminDb.collection('users').doc(uid).set({
          activeOrderId: null,
          isBusy: false,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.declineUserWrite.${uid}`, 1200).catch(() => {});
        await withTimeout(adminDb.collection('delivery_partners').doc(uid).set({
          activeOrderId: null,
          isBusy: false,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.declineDpWrite.${uid}`, 1200).catch(() => {});

        // Asynchronously auto-dispatch next available rider
        setImmediate(async () => {
          try {
            await RiderDispatchEngine.autoDispatchRider(orderId);
          } catch (dispatchErr: any) {
            console.warn('[RiderDelivery] Reassignment after decline notice:', dispatchErr.message);
          }
        });

        res.json({
          success: true,
          message: 'Assignment declined. Next available rider is being dispatched.',
          orderId,
          status: 'declined',
          idempotencyKey
        });
        return;
      }

      case 'ARRIVED_AT_STORE': {
        await withTimeout(orderRef.set({
          riderArrivedAtStoreAt: new Date().toISOString(),
          lastActionIdempotencyKey: idempotencyKey,
          updatedAt: new Date().toISOString()
        }, { merge: true }), `riderDelivery.arrivedStore.${orderId}`, 1200).catch(() => {});
        res.json({
          success: true,
          message: 'Arrived at store recorded',
          orderId,
          status: currentStatus,
          idempotencyKey
        });
        return;
      }

      case 'PICKED_UP': {
        if (['picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus)) {
          res.json({
            success: true,
            duplicate: true,
            message: 'Order already picked up',
            orderId,
            status: currentStatus,
            idempotencyKey
          });
          return;
        }

        const pickResult = await OrderStateMachine.transition(orderId, 'picked_up', { uid, role: 'delivery_partner', name }, {
          pickedUpAt: new Date().toISOString(),
          lastActionIdempotencyKey: idempotencyKey
        });

        if (!pickResult.success) {
          // Direct fallback if state machine transition was strict on intermediate status
          await withTimeout(orderRef.set({
            status: 'picked_up',
            pickedUpAt: new Date().toISOString(),
            lastActionIdempotencyKey: idempotencyKey,
            updatedAt: new Date()
          }, { merge: true }), `riderDelivery.pickedUpWrite.${orderId}`, 1200).catch(() => {});
        }

        try {
          const { query } = await import('../lib/db.js');
          await query(`
            UPDATE canonical_orders
            SET order_status = 'PICKED_UP', updated_at = NOW()
            WHERE id = $1
          `, [orderId]);
        } catch (pgErr: any) {}

        // Notify customer that order was picked up
        setImmediate(async () => {
          try {
            const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId;
            if (customerUid) {
              const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'picked_up' as any,
                deliveryPartnerName: name,
                totalAmount: Number(orderData.totalAmount || 0)
              });
              await notificationEngine.send(customerUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
            }

            // In-place notification update for rider (Next: OUT_FOR_DELIVERY)
            const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
            const updatePayload = DeliveryTemplates.deliveryUpdate(orderId, {
              orderNumber: shortId,
              customerName: orderData.customerName || 'Customer',
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
              stage: 'picked_up'
            });
            await notificationEngine.send(uid, updatePayload, {
              category: 'alarm_actionable',
              priority: 'high',
              orderId,
              targetApp: 'delivery'
            });
          } catch (notifErr: any) {
            console.warn('[RiderDelivery] Picked up notifications notice:', notifErr.message);
          }
        });

        res.json({
          success: true,
          message: 'Order picked up successfully',
          orderId,
          status: 'picked_up',
          idempotencyKey
        });
        return;
      }

      case 'OUT_FOR_DELIVERY': {
        if (['out_for_delivery', 'delivered'].includes(currentStatus)) {
          res.json({
            success: true,
            duplicate: true,
            message: 'Order already out for delivery',
            orderId,
            status: currentStatus,
            idempotencyKey
          });
          return;
        }

        const outResult = await OrderStateMachine.transition(orderId, 'out_for_delivery', { uid, role: 'delivery_partner', name }, {
          outForDeliveryAt: new Date().toISOString(),
          lastActionIdempotencyKey: idempotencyKey
        });

        if (!outResult.success) {
          await withTimeout(orderRef.set({
            status: 'out_for_delivery',
            outForDeliveryAt: new Date().toISOString(),
            lastActionIdempotencyKey: idempotencyKey,
            updatedAt: new Date()
          }, { merge: true }), `riderDelivery.outForDeliveryWrite.${orderId}`, 1200).catch(() => {});
        }

        try {
          const { query } = await import('../lib/db.js');
          await query(`
            UPDATE canonical_orders
            SET order_status = 'OUT_FOR_DELIVERY', updated_at = NOW()
            WHERE id = $1
          `, [orderId]);
        } catch (pgErr: any) {}

        // Notify customer that order is out for delivery
        setImmediate(async () => {
          try {
            const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId;
            if (customerUid) {
              const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'out_for_delivery' as any,
                deliveryPartnerName: name,
                totalAmount: Number(orderData.totalAmount || 0)
              });
              await notificationEngine.send(customerUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
            }

            // In-place notification update for rider (Next: DELIVERED)
            const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
            const updatePayload = DeliveryTemplates.deliveryUpdate(orderId, {
              orderNumber: shortId,
              customerName: orderData.customerName || 'Customer',
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
              stage: 'out_for_delivery'
            });
            await notificationEngine.send(uid, updatePayload, {
              category: 'alarm_actionable',
              priority: 'high',
              orderId,
              targetApp: 'delivery'
            });
          } catch (notifErr: any) {
            console.warn('[RiderDelivery] Out for delivery notifications notice:', notifErr.message);
          }
        });

        res.json({
          success: true,
          message: 'Order is now out for delivery',
          orderId,
          status: 'out_for_delivery',
          idempotencyKey
        });
        return;
      }

      case 'ARRIVED_AT_CUSTOMER': {
        await withTimeout(orderRef.set({
          riderArrivedAtCustomerAt: new Date().toISOString(),
          lastActionIdempotencyKey: idempotencyKey,
          updatedAt: new Date().toISOString()
        }, { merge: true }), `riderDelivery.arrivedCustomer.${orderId}`, 1200).catch(() => {});
        res.json({
          success: true,
          message: 'Arrived at customer location recorded',
          orderId,
          status: currentStatus,
          idempotencyKey
        });
        return;
      }

      case 'DELIVERED': {
        if (currentStatus === 'delivered') {
          res.json({
            success: true,
            duplicate: true,
            message: 'Order already marked delivered',
            orderId,
            status: 'delivered',
            idempotencyKey
          });
          return;
        }

        // COD Payment Collection Gate: Enforce payment collection before delivery completion
        const paymentMethod = (orderData.paymentMethod || '').toLowerCase();
        const isCod = paymentMethod === 'cod' || orderData.isCod === true;
        if (isCod) {
          const pStatus = (orderData.paymentStatus || '').toUpperCase();
          const isPaid = orderData.isPaid === true || pStatus === 'PAID' || pStatus === 'COLLECTED';
          if (!isPaid) {
            res.status(400).json({
              success: false,
              error: 'Payment has not been collected for this Cash on Delivery order. Please collect payment (Cash or dynamic UPI QR) before marking delivered.'
            });
            return;
          }
        }

        // Mandatory 50-metre Delivery Location Gate
        const { GeofenceVerificationService } = await import('../services/delivery/GeofenceVerificationService.js');
        const resolvedRiderCoords = clientCoordinates || (
          (riderLat != null && riderLng != null) ? { lat: Number(riderLat), lng: Number(riderLng) } : undefined
        );
        const geofenceResult = await GeofenceVerificationService.verifyRiderProximity(
          orderId,
          uid,
          orderData,
          resolvedRiderCoords
        );

        if (!geofenceResult.allowed) {
          res.status(400).json({
            success: false,
            error: `50-metre delivery gate violated: ${geofenceResult.reason || 'You are outside the 50m customer delivery radius.'}`,
            distanceMeters: geofenceResult.distanceMeters,
            requiredMeters: geofenceResult.requiredMeters
          });
          return;
        }

        // Section 4.2 Enforce Provisional Dispatch Reconciliation Gate:
        // A provisional dispatch cannot complete delivery until canonically reconciled in PostgreSQL
        if (orderData.isProvisionalDispatch) {
          const { ProvisionalDispatchService } = await import('../services/delivery/ProvisionalDispatchService.js');
          const recon = await ProvisionalDispatchService.reconcileProvisionalDispatch(orderId);
          if (!recon.reconciled) {
            res.status(400).json({
              success: false,
              code: 'PROVISIONAL_RECONCILIATION_REQUIRED',
              error: `Delivery completion blocked: ${recon.reason || 'Order is currently provisional and awaiting canonical reconciliation in PostgreSQL.'}`
            });
            return;
          }
        }

        const updates: any = {
          status: 'delivered',
          deliveredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastActionIdempotencyKey: idempotencyKey,
          clientCoordinates: {
            lat: geofenceResult.riderLat || riderLat,
            lng: geofenceResult.riderLng || riderLng,
          },
          proofOfDelivery: {
            proofImageUrl: proofImageUrl || null,
            signatureUrl: signatureUrl || null,
            notes: notes || 'Delivered via notification action',
            completedLat: geofenceResult.riderLat || riderLat || null,
            completedLng: geofenceResult.riderLng || riderLng || null,
            completedAt: new Date().toISOString()
          }
        };

        const delResult = await OrderStateMachine.transition(orderId, 'delivered', { uid, role: 'delivery_partner', name }, updates);
        if (!delResult.success) {
          res.status(400).json({
            success: false,
            error: delResult.error || 'Failed to complete delivery transition',
          });
          return;
        }

        try {
          const { query } = await import('../lib/db.js');
          await query(`
            UPDATE canonical_orders
            SET order_status = 'DELIVERED', delivered_at = NOW(), updated_at = NOW()
            WHERE id = $1
          `, [orderId]);
          await query(`
            UPDATE canonical_bills
            SET payment_status = 'PAID'
            WHERE order_id = $1
          `, [orderId]);
          await query(`
            UPDATE delivery_partners
            SET active_order_id = NULL, updated_at = NOW()
            WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])
          `, [riderIds]);
        } catch (pgErr: any) {
          console.warn('[RiderDelivery] PostgreSQL delivered sync notice:', pgErr.message);
        }

        // Release rider active order lock in users & delivery_partners
        await withTimeout(adminDb.collection('users').doc(uid).set({
          activeOrderId: null,
          isBusy: false,
          lastDeliveredOrderId: orderId,
          lastDeliveredAt: new Date().toISOString(),
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.deliveredUserWrite.${uid}`, 1200).catch(() => {});
        await withTimeout(adminDb.collection('delivery_partners').doc(uid).set({
          activeOrderId: null,
          isBusy: false,
          updatedAt: new Date()
        }, { merge: true }), `riderDelivery.deliveredDpWrite.${uid}`, 1200).catch(() => {});

        // Release navigation session and clear active order in Supabase GPS
        try {
          await SupabaseGpsService.clearActiveOrder(uid, orderId);
          await SupabaseGpsService.cleanupDeliveredGps(orderId);
        } catch (navErr: any) {
          console.warn('[RiderDelivery] Supabase GPS close warning:', navErr.message);
        }

        // Asynchronously notify Restaurant Management and Customer of delivery
        setImmediate(async () => {
          try {
            const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId;
            if (customerUid) {
              const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'delivered' as any,
                deliveryPartnerName: name,
                totalAmount: Number(orderData.totalAmount || 0)
              });
              await notificationEngine.send(customerUid, cPayload, { category: 'simple_informational', priority: 'high', orderId });
            }

            const branchId = orderData.branchId || 'main_branch';
            const branchStaffUids = await notificationEngine.resolveBranchStaff(branchId);
            if (branchStaffUids.length > 0) {
              const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`);
              const deliveredPayload = RestaurantTemplates.orderDelivered(orderId, {
                orderNumber: shortId,
                customerName: orderData.customerName || 'Customer',
                totalAmount: Number(orderData.totalAmount || 0),
                branchId,
                franchiseId: orderData.franchiseId || 'default',
                riderName: name,
                deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
                deliveredAt: new Date().toISOString()
              });
              await notificationEngine.sendBulk(branchStaffUids, deliveredPayload, {
                category: 'simple_informational',
                priority: 'high',
                orderId,
                targetApp: 'restaurant'
              });
            }
          } catch (notifErr: any) {
            console.warn('[RiderDelivery] Failed to dispatch delivery completion notifications:', notifErr.message);
          }
        });

        // Trigger queue retry for this branch since rider is now free
        const deliveryBranchId = orderData.branchId || orderData.branch_id || 'main_branch';
        import('../services/delivery/PendingDispatchQueueService.js').then(({ PendingDispatchQueueService }) => {
          PendingDispatchQueueService.onRiderAvailable(deliveryBranchId).catch((err: any) => {
            console.warn('[RiderDelivery] onRiderAvailable trigger error on delivery completion:', err.message);
          });
        }).catch(() => {});

        res.json({
          success: true,
          message: 'Delivery successfully completed and verified',
          orderId,
          status: 'delivered',
          idempotencyKey
        });
        return;
      }

      default:
        res.status(400).json({ success: false, error: `Unsupported action: ${action}` });
    }
  } catch (error: any) {
    console.error('[RiderDelivery] Action error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to process action' });
  }
}

// 8b. POST /orders/:id/action - Unified Idempotent Notification & Live Action Handler
router.post('/orders/:id/action', (req: AuthRequest, res: Response) => {
  return processRiderOrderAction(req, res);
});

// Specific Action Endpoints (Aliases matching mobile client & delivery store)
router.post('/orders/:id/accept', (req: AuthRequest, res: Response) => {
  return processRiderOrderAction(req, res, 'ACCEPT_DELIVERY');
});

router.post('/orders/:id/decline', (req: AuthRequest, res: Response) => {
  return processRiderOrderAction(req, res, 'DECLINE_DELIVERY');
});

router.post('/orders/:id/pickup', (req: AuthRequest, res: Response) => {
  return processRiderOrderAction(req, res, 'PICKED_UP');
});

router.post('/orders/:id/complete', (req: AuthRequest, res: Response) => {
  return processRiderOrderAction(req, res, 'DELIVERED');
});


// 9. POST /status - Toggle Online / Offline Working Status
router.post('/status', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { isOnline } = req.body;
    const uid = req.user?.uid!;

    if (isOnline === undefined) {
      res.status(400).json({ error: 'isOnline boolean is required' });
      return;
    }

    const targetOnline = Boolean(isOnline);
    const { riderIds, partnerRow } = await resolveRiderContext(uid, req.user?.email);
    const appUserRes = await pgPool.query(
      `SELECT role, status, is_active, franchise_id, branch_id FROM app_users WHERE id = $1 OR firebase_uid = $1 LIMIT 1`,
      [uid]
    ).catch(() => ({ rows: [] as any[] }));
    const appUser = appUserRes.rows[0] || null;

    const userRef = adminDb.collection('users').doc(uid);
    const riderRef = adminDb.collection('delivery_partners').doc(uid);
    const [statusUserSnap, statusRiderSnap] = await Promise.all([
      withTimeout(userRef.get(), 'riderDelivery.statusUserRead', 1200).catch(() => null),
      withTimeout(riderRef.get(), 'riderDelivery.statusRiderRead', 1200).catch(() => null)
    ]);
    const statusUser = statusUserSnap?.exists ? statusUserSnap.data() || {} : {};
    const statusRider = statusRiderSnap?.exists ? statusRiderSnap.data() || {} : {};
    const role = String(statusUser.role || statusRider.role || appUser?.role || req.user?.role || '').toLowerCase();
    const pgState = String(partnerRow?.status || appUser?.status || '').toLowerCase();
    const fsState = String(statusUser.accountStatus || statusUser.status || statusRider.accountStatus || statusRider.status || '').toLowerCase();
    const blockedStates = ['disabled', 'deactivated', 'rejected', 'revoked', 'deleted', 'suspended', 'blocked'];
    const isActive = (appUser ? appUser.is_active !== false : true)
      && statusUser.isActive !== false && statusRider.isActive !== false
      && !blockedStates.includes(pgState) && !blockedStates.includes(fsState);

    const hasRecord = Boolean(partnerRow || appUser || statusUserSnap?.exists || statusRiderSnap?.exists);
    if (!isActive || !hasRecord) {
      res.status(403).json({ success: false, code: 'RIDER_ACCOUNT_INACTIVE', error: 'This delivery account is not active. Ask the owner to review your access.' });
      return;
    }

    // Native background tracking is a location heartbeat only. It can never re-enable a rider
    // after the scheduler has set them offline or after an owner disables the account.
    if (req.body?.backgroundService === true) {
      if (!['delivery_partner', 'delivery', 'rider'].includes(role)) {
        res.status(403).json({ success: false, code: 'DELIVERY_PARTNER_REQUIRED', error: 'A delivery partner account is required for background tracking.' });
        return;
      }
      const currentlyOnline = partnerRow ? partnerRow.is_online === true : (statusUser.isOnline === true || statusRider.isOnline === true);
      if (!targetOnline || !currentlyOnline) {
        res.status(409).json({ success: false, code: 'RIDER_OFFLINE', error: 'Background location cannot change an offline rider back to online.' });
        return;
      }
      const rawLat = req.body?.lat ?? req.body?.latitude;
      const rawLng = req.body?.lng ?? req.body?.longitude;
      const lat = Number(rawLat);
      const lng = Number(rawLng);
      if (rawLat === undefined || rawLng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        res.status(400).json({ success: false, code: 'INVALID_LOCATION', error: 'Valid latitude and longitude are required.' });
        return;
      }
      await pgPool.query(
        `UPDATE delivery_partners SET current_lat = $2, current_lng = $3, last_location_time = NOW(), updated_at = NOW()
         WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])`,
        [riderIds, lat, lng]
      ).catch(() => {});
      const locationUpdate = {
        lat, lng, latitude: lat, longitude: lng,
        accuracy: Number.isFinite(Number(req.body?.accuracy)) ? Number(req.body.accuracy) : null,
        lastLocationUpdate: new Date().toISOString(),
        lastBackgroundLocationUpdate: new Date().toISOString()
      };
      await Promise.all([
        withTimeout(userRef.set(locationUpdate, { merge: true }), 'riderDelivery.bgUserWrite', 1000).catch(() => {}),
        withTimeout(riderRef.set(locationUpdate, { merge: true }), 'riderDelivery.bgRiderWrite', 1000).catch(() => {})
      ]);
      res.json({ success: true, backgroundLocationUpdated: true, isOnline: true });
      return;
    }

    if (targetOnline && ['delivery_partner', 'delivery', 'rider'].includes(role)) {
      const scheduleSnap = await withTimeout(adminDb.collection('rider_work_schedules').doc(uid).get(), 'riderDelivery.scheduleRead', 1000).catch(() => null);
      if (scheduleSnap?.exists) {
        const schedule = scheduleSnap.data() as any;
        if (schedule?.enabled && !RiderWorkScheduleService.isCurrentlyScheduled({ uid, ...schedule })) {
          res.status(403).json({
            success: false,
            code: 'OUTSIDE_WORK_SCHEDULE',
            error: 'Your saved work time is not active. Use Continue Work or wait for your next scheduled start.'
          });
          return;
        }
      }
    }

    // If going Online, GPS fix is strictly mandatory (check body coords, then PG, then bounded Firestore)
    if (targetOnline) {
      const rawLat = req.body?.lat ?? req.body?.latitude;
      const rawLng = req.body?.lng ?? req.body?.longitude;
      let hasValidCoords = false;

      if (rawLat !== undefined && rawLng !== undefined) {
        const numLat = Number(rawLat);
        const numLng = Number(rawLng);
        if (!isNaN(numLat) && !isNaN(numLng) && numLat >= -90 && numLat <= 90 && numLng >= -180 && numLng <= 180) {
          hasValidCoords = true;
        }
      }

      if (!hasValidCoords && partnerRow?.current_lat != null && partnerRow?.current_lng != null && partnerRow?.last_location_time) {
        const pgLastTime = new Date(partnerRow.last_location_time).getTime();
        if (Date.now() - pgLastTime < 90 * 1000) {
          hasValidCoords = true;
        }
      }

      if (!hasValidCoords) {
        const partnerDoc = await withTimeout(adminDb.collection('delivery_partners').doc(uid).get(), 'riderDelivery.gpsCheckRead', 1200).catch(() => null);
        const pData = partnerDoc?.data?.() || {};
        const lastUpdate = pData.lastLocationUpdate || pData.timestamp;
        const lastTime = lastUpdate ? new Date(lastUpdate).getTime() : 0;
        const isRecent = Date.now() - lastTime < 90 * 1000;
        if (!isRecent || pData.lat == null || pData.lng == null) {
          res.status(400).json({
            success: false,
            code: 'GPS_REQUIRED',
            error: 'Active GPS fix is required to go Online. Please ensure device location is enabled and signal is acquired.'
          });
          return;
        }
      }
    }

    const updates: Record<string, any> = {
      isOnline: targetOnline,
      onlineStatusUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const inLat = req.body?.lat ?? req.body?.latitude;
    const inLng = req.body?.lng ?? req.body?.longitude;
    let validInLat: number | null = null;
    let validInLng: number | null = null;
    if (inLat !== undefined && inLng !== undefined) {
      const numLat = Number(inLat);
      const numLng = Number(inLng);
      if (!isNaN(numLat) && !isNaN(numLng)) {
        validInLat = numLat;
        validInLng = numLng;
        updates.lat = numLat;
        updates.lng = numLng;
        updates.latitude = numLat;
        updates.longitude = numLng;
        updates.lastLocationUpdate = new Date().toISOString();
      }
    }

    // Authoritative PostgreSQL update FIRST so auto-dispatch always sees the rider's online status & GPS
    try {
      await pgPool.query(
        `UPDATE delivery_partners
         SET is_online = $2,
             current_lat = COALESCE($3, current_lat),
             current_lng = COALESCE($4, current_lng),
             last_location_time = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE last_location_time END,
             updated_at = NOW()
         WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])`,
        [riderIds, targetOnline, validInLat, validInLng]
      );
    } catch (pgErr: any) {
      console.warn('[RiderDelivery] PostgreSQL status update warning:', pgErr.message);
    }

    await Promise.all([
      withTimeout(adminDb.collection('users').doc(uid).set(updates, { merge: true }), 'riderDelivery.statusUserWrite', 1200).catch(() => {}),
      withTimeout(adminDb.collection('delivery_partners').doc(uid).set(updates, { merge: true }), 'riderDelivery.statusRiderWrite', 1200).catch(() => {})
    ]);

    // When rider goes online, trigger pending dispatch queue retry for their branch
    if (targetOnline) {
      const riderBranchId = partnerRow?.branch_id || appUser?.branch_id || statusUser.branchId || statusUser.branch_id || statusRider.branchId || statusRider.branch_id || 'main_branch';
      import('../services/delivery/PendingDispatchQueueService.js').then(({ PendingDispatchQueueService }) => {
        PendingDispatchQueueService.onRiderAvailable(riderBranchId).catch((e: any) => {
          console.warn('[RiderDelivery] onRiderAvailable trigger error on checkin:', e.message);
        });
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `Rider status updated to ${isOnline ? 'Online' : 'Offline'}`,
      isOnline: Boolean(isOnline)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update working status' });
  }
});

// 10. POST /location - Ingest Live Rider Telemetry
router.post('/location', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { lat, lng, heading, speed, battery, activeOrderId } = req.body;
    const uid = req.user?.uid!;

    if (lat === undefined || lng === undefined) {
      res.status(400).json({ error: 'lat and lng are required' });
      return;
    }

    const numLat = Number(lat);
    const numLng = Number(lng);
    const numHeading = Number(heading || 0);
    const numSpeed = Number(speed || 0);
    const numBattery = Number(battery || 100);
    const timestamp = new Date().toISOString();

    // Determine active order & branch for this rider from PostgreSQL first, then bounded Firestore
    const { riderIds, partnerRow } = await resolveRiderContext(uid, req.user?.email);
    let effectiveOrderId = activeOrderId || partnerRow?.active_order_id || null;
    if (!effectiveOrderId) {
      try {
        const pgActiveRes = await pgPool.query(
          `SELECT id FROM canonical_orders
           WHERE delivery_partner_id = ANY($1::text[])
             AND order_status IN ('PARTNER_ASSIGNED', 'PICKED_UP', 'OUT_FOR_DELIVERY')
           ORDER BY created_at DESC LIMIT 1`,
          [riderIds]
        );
        if (pgActiveRes.rows[0]?.id) {
          effectiveOrderId = pgActiveRes.rows[0].id;
        }
      } catch {}
    }
    if (!effectiveOrderId) {
      try {
        const userDoc = await withTimeout(adminDb.collection('users').doc(uid).get(), 'riderDelivery.locUserRead', 1000);
        if (userDoc.exists && userDoc.data()?.activeOrderId) {
          effectiveOrderId = userDoc.data()!.activeOrderId;
        } else {
          const activeSnap = await withTimeout(
            adminDb.collection('orders')
              .where('deliveryPartnerId', '==', uid)
              .where('status', 'in', ['partner_assigned', 'picked_up', 'out_for_delivery'])
              .limit(1)
              .get(),
            'riderDelivery.locActiveOrderRead',
            1000
          );
          if (!activeSnap.empty) {
            effectiveOrderId = activeSnap.docs[0].id;
          }
        }
      } catch (err: any) {
        console.warn('[RiderLocation] Failed to resolve active order:', err?.message);
      }
    }

    const riderBranchId = partnerRow?.branch_id || req.user?.branchId || 'main_branch';
    const locationData = {
      riderId: uid,
      uid,
      lat: numLat,
      lng: numLng,
      heading: numHeading,
      speed: numSpeed,
      battery: numBattery,
      activeOrderId: effectiveOrderId,
      branchId: riderBranchId,
      timestamp
    };

    await pgPool.query(
      `UPDATE delivery_partners
       SET current_lat = $2, current_lng = $3, last_location_time = NOW(), updated_at = NOW()
       WHERE id = ANY($1::text[]) OR user_id = ANY($1::text[])`,
      [riderIds, numLat, numLng]
    ).catch(() => {});

    // 1. Bounded Firestore position mirror
    await Promise.all([
      withTimeout(adminDb.collection('delivery_partners').doc(uid).set(locationData, { merge: true }), 'riderDelivery.locDpWrite', 1000).catch(() => {}),
      withTimeout(adminDb.collection('users').doc(uid).set({
        location: { lat: numLat, lng: numLng },
        lastLocationUpdate: timestamp,
        ...(effectiveOrderId ? { activeOrderId: effectiveOrderId } : {})
      }, { merge: true }), 'riderDelivery.locUserWrite', 1000).catch(() => {})
    ]);

    // Note: Live GPS is streamed strictly via Supabase delivery_locations (Single Source of Truth)
    // and WebSocket broadcast. High-frequency duplicate writes to Firestore orders are eliminated.

    // 2. Authoritative Supabase delivery_locations update (triggers Supabase Realtime for public.delivery_locations)
    await SupabaseGpsService.upsertLatestLocation({
      deliveryPartnerId: uid,
      activeOrderId: effectiveOrderId,
      latitude: numLat,
      longitude: numLng,
      speed: numSpeed,
      heading: numHeading,
      onlineStatus: true
    });

    // 4. Instant WebSocket broadcast (<5ms latency to all listening customers & owners)
    try {
      webSocketServer.handleDriverLocationUpdate({
        deliveryPartnerId: uid,
        orderId: effectiveOrderId,
        lat: numLat,
        lng: numLng,
        accuracy: 5,
        speed: numSpeed,
        heading: numHeading,
        battery: numBattery,
        isMoving: numSpeed > 1,
        timestamp,
        status: 'ONLINE'
      });
    } catch (wsErr: any) {
      console.warn('[RiderLocation] WebSocket broadcast notice:', wsErr?.message);
    }

    // 5. Temporary telemetry for audit and history purge
    await withTimeout(adminDb.collection('delivery_temporary_telemetry').add(locationData), 'riderDelivery.telemetryWrite', 800).catch(() => {});

    res.json({ success: true, timestamp, activeOrderId: effectiveOrderId });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update location' });
  }
});

export default router;
