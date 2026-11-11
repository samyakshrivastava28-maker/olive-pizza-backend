import { Router, Request, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { adminDb } from '../config/firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { orderEventService } from '../services/order/OrderEventService.js';
import { pgPool } from '../config/postgres.js';
import { withTimeout, getIstDateKey } from '../lib/utils.js';
import { z } from 'zod';
import { CustomerTemplates, RestaurantTemplates } from '../services/notification/NotificationTemplates.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';

import { DeliveryCapacityService } from '../services/delivery/DeliveryCapacityService.js';
import { webSocketServer } from '../services/websocket/WebSocketServer.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { StoreBoundDeliveryFleetService, RiderOperationalState } from '../services/delivery/StoreBoundDeliveryFleetService.js';
import { RiderReplacementSagaService } from '../services/delivery/RiderReplacementSagaService.js';
import { RiderOnboardingService } from '../services/delivery/RiderOnboardingService.js';
import { ApiSecurityMiddleware, ResponseSanitizationService } from '../security/index.js';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';
import { PostgresGpsService } from '../services/gps/PostgresGpsService.js';
import { RedisGpsService } from '../services/gps/RedisGpsService.js';

const router = Router();

const deliveryStatusSchema = z.object({
  status: z.enum(['delivered', 'out_for_delivery', 'picked_up', 'partner_assigned', 'ready'])
});

const partnerStatusSchema = z.object({
  status: z.enum(['online', 'offline', 'busy', 'on_delivery', 'break'])
});

// Fetch restaurant availability & delivery capacity (Public endpoint used by checkout & store status)
router.get('/availability', async (req: Request, res: Response) => {
  try {
    const data = await DeliveryCapacityService.getRestaurantAvailability();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

router.use(verifyToken);
router.use(ApiSecurityMiddleware.rejectParameterTampering());

// Customer gets live location via polling
router.get('/orders/:id/location', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const isStaff = ['owner', 'admin', 'restaurant_manager', 'delivery', 'delivery_partner', 'developer', 'platform_owner'].includes(user.role || '');

    const orderDoc = await adminDb.collection('orders').doc(id).get();
    if (orderDoc.exists) {
      const orderData = orderDoc.data()!;
      if (!isStaff && orderData.userId && orderData.userId !== user.uid) {
        res.status(403).json({ error: 'Access denied: You do not have permission to track this order' });
        return;
      }
    }

    // Query Authoritative Supabase GPS Telemetry
    let location = await PostgresGpsService.getLatestLocationByOrder(id);
    if (!location && orderDoc.exists && orderDoc.data()?.deliveryPartnerId) {
      location = await PostgresGpsService.getLatestLocation(orderDoc.data()!.deliveryPartnerId);
    }

    if (!location) {
      res.status(404).json({ error: 'Delivery tracking not found or rider offline' });
      return;
    }
    
    res.json({
      currentLat: Number(location.latitude),
      currentLng: Number(location.longitude),
      status: (location.onlineStatus ?? (location as any).online_status) ? 'active' : 'offline',
      speed: location.speed || 0,
      heading: location.heading || 0,
      updatedAt: location.lastUpdated || (location as any).last_updated
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tracking' });
  }
});

// Delivery partner gets their active tasks (Sanitized minimal DTO: customer PII & franchise financials omitted)
router.get('/tasks', requireRole(['delivery', 'delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const deliveryPartnerId = req.user?.uid;
    const snapshot = await adminDb.collection('orders')
      .where('deliveryPartnerId', '==', deliveryPartnerId)
      .where('status', 'in', ['partner_assigned', 'out_for_delivery', 'preparing', 'ready', 'picked_up'])
      .get();
      
    const tasks = snapshot.docs.map(doc => ResponseSanitizationService.toDeliveryOrderDTO({
      id: doc.id,
      ...doc.data()
    }));
    
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Update order status (used by delivery dashboard)
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Update order status (used by delivery dashboard)
router.patch('/orders/:id/status', requireRole(['owner', 'delivery', 'delivery_partner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const parsedBody = deliveryStatusSchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Invalid status update for delivery partner' });
      return;
    }
    const { status } = parsedBody.data;

    // Fetch order first to get details for notification
    const orderDoc = await adminDb.collection('orders').doc(id).get();
    if (!orderDoc.exists) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const orderData = orderDoc.data()!;

    // ── STRICT 100M DELIVERY COMPLETION VALIDATION ────────────────────────────
    if (status === 'delivered' && (req.user?.role === 'delivery' || req.user?.role === 'delivery_partner')) {
      const customerLat = orderData.deliveryAddress?.lat ?? orderData.deliveryAddressCoordinates?.lat ?? orderData.lat ?? orderData.customerLocation?.lat;
      const customerLng = orderData.deliveryAddress?.lng ?? orderData.deliveryAddressCoordinates?.lng ?? orderData.lng ?? orderData.customerLocation?.lng;

      if (customerLat != null && customerLng != null) {
        let riderLat = req.body.lat ?? req.body.latitude;
        let riderLng = req.body.lng ?? req.body.longitude;

        if (riderLat == null || riderLng == null) {
          try {
            const loc = await SupabaseGpsService.getLatestLocation(req.user.uid);
            if (loc) {
              riderLat = loc.latitude;
              riderLng = loc.longitude;
            }
          } catch (e: any) {
            console.warn('[Delivery Validation] Could not query latest Supabase location:', e.message);
          }
        }

        if (riderLat != null && riderLng != null) {
          const requiredRadiusMeters = process.env.DELIVERY_COMPLETION_RADIUS_METERS
            ? Number(process.env.DELIVERY_COMPLETION_RADIUS_METERS)
            : 200;

          const distMeters = calculateDistanceMeters(Number(riderLat), Number(riderLng), Number(customerLat), Number(customerLng));
          if (distMeters > requiredRadiusMeters) {
            res.status(400).json({
              error: `Delivery cannot be completed yet. You must be within ${requiredRadiusMeters} meters of the customer location.`,
              distanceMeters: Math.round(distMeters),
              requiredDistanceMeters: requiredRadiusMeters,
            });
            return;
          }
        }
      }
    }

    // Route transition through canonical OrderStateMachine (PostgreSQL -> Firestore projection)
    const transitionRes = await OrderStateMachine.transition(
      id,
      status as any,
      {
        uid: req.user?.uid || 'rider',
        role: req.user?.role || 'delivery_partner',
        name: (req.user as any)?.name || 'Delivery Partner',
        branchId: orderData.branchId
      },
      {
        deliveryProof: req.body.deliveryProof,
        deliveryPartnerId: orderData.deliveryPartnerId || req.user?.uid
      }
    );

    if (!transitionRes.success) {
      res.status(400).json({ error: transitionRes.error || 'Failed to transition order status' });
      return;
    }
    
    // Synchronous Dispatch
    setImmediate(async () => {
      try {
        const customerFirebaseUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId || orderData.user_id;
        if (customerFirebaseUid) {
          const shortId = orderData.dailyOrderNumber || `#${id.slice(-6).toUpperCase()}`;
          const cPayload = CustomerTemplates.orderUpdate(id, {
            orderNumber: shortId,
            status: status as any,
            deliveryPartnerName: orderData.deliveryPartnerName || 'Your Delivery Partner',
            totalAmount: Number(orderData.totalAmount || 0),
          });
          const category = status === 'delivered' ? 'simple_informational' : 'pinned_live';
          await notificationEngine.send(customerFirebaseUid, cPayload, { category, priority: 'high', orderId: id });
        }

        // Notify Restaurant Management when order is successfully delivered
        if (status === 'delivered') {
          const branchId = orderData.branchId;
          if (branchId) {
            const branchStaffUids = await notificationEngine.resolveBranchStaff(branchId);
            if (branchStaffUids.length > 0) {
            const shortId = orderData.dailyOrderNumber ? `#${orderData.dailyOrderNumber}` : (orderData.orderNumber || `#${id.slice(-6).toUpperCase()}`);
            const deliveredPayload = RestaurantTemplates.orderDelivered(id, {
              orderNumber: shortId,
              customerName: orderData.customerName || 'Customer',
              totalAmount: Number(orderData.totalAmount || 0),
              branchId,
              franchiseId: orderData.franchiseId || 'default',
              riderName: orderData.deliveryPartnerName,
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
              deliveredAt: new Date().toISOString()
            });
            await notificationEngine.sendBulk(branchStaffUids, deliveredPayload, {
              category: 'simple_informational',
              priority: 'high',
              orderId: id,
              targetApp: 'restaurant'
            });
            }
          }
        }
      } catch (e: any) {
        console.error('[Delivery Routes] Async notification failed:', e.message);
      }
    });

    // Emit event so emails are triggered
    try {
      orderEventService.emitStatusChange(id, status as any, req.user?.uid || 'system');
    } catch (e: any) {
      console.warn('[Delivery Routes] Event emit warning:', e.message);
    }
    
    // Auto-update rider status and navigation session expiry if delivered
    if (status === 'delivered' && req.user?.uid) {
      try {
        await DeliveryCapacityService.setPartnerStatus(req.user.uid, 'online', null); // becomes available again
      } catch (e: any) {
        console.warn('[Delivery Routes] setPartnerStatus warning:', e.message);
      }
      
      // Update Supabase navigation session and clear active order on delivery
      try {
        await SupabaseGpsService.clearActiveOrder(req.user.uid, id);
        await SupabaseGpsService.cleanupDeliveredGps(id);
      } catch (e: any) {
        console.warn('[Delivery Routes] Supabase GPS cleanup trigger warning:', e.message);
      }
    }

    res.json({ message: `Order status updated to ${status}` });
  } catch (error) {
    console.error('[Delivery Routes] Failed to update order status:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Forward action endpoint for delivery riders (/api/delivery/orders/:id/action)
router.post('/orders/:id/action', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  const { default: riderDeliveryRoutes } = await import('./riderDelivery.routes.js');
  // Re-route to riderDelivery action handler
  req.url = `/orders/${req.params.id}/action`;
  riderDeliveryRoutes(req, res, () => {});
});

// Update rider availability status (online/offline/busy)
router.patch('/partner-status', requireRole(['delivery', 'delivery_partner', 'owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const partnerId = req.user?.uid;
    const parsedBody = partnerStatusSchema.safeParse(req.body);
    if (!parsedBody.success || !partnerId) {
      res.status(400).json({ error: 'Invalid status update' });
      return;
    }
    await DeliveryCapacityService.setPartnerStatus(partnerId, parsedBody.data.status);
    res.json({ success: true, status: parsedBody.data.status });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update partner status' });
  }
});



// Join the notify queue
router.post('/notify-queue', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const customerId = req.user?.uid;
    if (!customerId) return res.status(401).json({ error: 'Unauthorized' });
    await DeliveryCapacityService.addToNotifyQueue(customerId, req.body.fcmToken);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to join queue' });
  }
});

// Update live delivery location (supports /orders/:id/location and /location)
const handleLocationUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { lat, lng, latitude, longitude, speed, heading, accuracy, orderId } = req.body;

    const actualLat = lat !== undefined ? lat : latitude;
    const actualLng = lng !== undefined ? lng : longitude;
    const targetOrderId = id || orderId || null;

    if (actualLat === undefined || actualLng === undefined) {
      res.status(400).json({ error: 'Missing coordinates' });
      return;
    }

    const deliveryPartnerId = req.user?.uid;
    if (!deliveryPartnerId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 1. Authoritative PostgreSQL delivery_locations update
    const gpsRes = await PostgresGpsService.upsertLatestLocation({
      deliveryPartnerId,
      activeOrderId: targetOrderId || null,
      latitude: Number(actualLat),
      longitude: Number(actualLng),
      accuracy: accuracy ? Number(accuracy) : null,
      speed: speed ? Number(speed) : null,
      heading: heading ? Number(heading) : null,
      onlineStatus: true
    });

    const locationUpdatePayload = {
      deliveryPartnerId,
      latitude: Number(actualLat),
      longitude: Number(actualLng),
      orderId: targetOrderId,
      franchiseId: gpsRes.franchiseId,
      branchId: gpsRes.branchId,
      timestamp: new Date().toISOString()
    };

    // Scoped WebSocket broadcasts: Customer tracking + Branch/Franchise Fleet Isolation
    try {
      if (targetOrderId) {
        webSocketServer.broadcastToOrder(targetOrderId, {
          type: 'RIDER_LOCATION_UPDATE',
          data: locationUpdatePayload
        });
      }

      if (gpsRes.franchiseId && gpsRes.branchId) {
        webSocketServer.broadcastToBranch(gpsRes.franchiseId, gpsRes.branchId, {
          type: 'RIDER_LOCATION_UPDATE',
          data: locationUpdatePayload
        });
      } else {
        webSocketServer.broadcastToRole('owner', {
          type: 'RIDER_LOCATION_UPDATE',
          data: locationUpdatePayload
        });
      }
    } catch {}

    // 2. Check Delivery Radius Warning (bounded Firestore + branch India coords)
    const settingsSnap = await withTimeout(adminDb.collection('settings').doc('store').get(), 'delivery.storeSettings', 1200).catch(() => null);
    const settings = settingsSnap?.data?.() || {};
    let storeLat = settings.restaurantLat || 21.0970;
    let storeLng = settings.restaurantLng || 81.0330;
    let maxRadius = settings.deliveryRadiusKm || 15;
    if (gpsRes.branchId) {
      const bCoords = await pgPool.query(
        `SELECT latitude, longitude, delivery_settings FROM restaurant_branches WHERE id = $1 LIMIT 1`,
        [gpsRes.branchId]
      ).catch(() => ({ rows: [] as any[] }));
      if (bCoords.rows[0]?.latitude != null && bCoords.rows[0]?.longitude != null) {
        storeLat = Number(bCoords.rows[0].latitude);
        storeLng = Number(bCoords.rows[0].longitude);
      }
      if (bCoords.rows[0]?.delivery_settings?.radiusKm) {
        maxRadius = Number(bCoords.rows[0].delivery_settings.radiusKm);
      }
    }

    const distance = DeliveryCapacityService.getDistanceKm(storeLat, storeLng, actualLat, actualLng);
    if (distance > maxRadius) {
      // Broadcast warning to owner via websockets/firestore
      const warningMsg = `⚠ Delivery Partner ${deliveryPartnerId} is outside delivery radius (${distance.toFixed(1)}km away).`;
      await withTimeout(adminDb.collection('owner_alerts').add({
        type: 'radius_warning',
        message: warningMsg,
        partnerId: deliveryPartnerId,
        distance,
        timestamp: FieldValue.serverTimestamp(),
        acknowledged: false
      }), 'delivery.ownerAlertAdd', 1000).catch(() => {});
      // Emit scoped websocket event to branch dashboard / fleet supervisor
      if (gpsRes.franchiseId && gpsRes.branchId) {
        webSocketServer.broadcastToBranch(gpsRes.franchiseId, gpsRes.branchId, {
          type: 'radius_warning',
          data: { partnerId: deliveryPartnerId, distance, maxRadius }
        });
      } else {
        webSocketServer.broadcastToRole('owner', {
          type: 'radius_warning',
          data: { partnerId: deliveryPartnerId, distance, maxRadius }
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Live tracking error:", error);
    res.status(500).json({ error: 'Failed to update location' });
  }
};

router.post('/orders/:id/location', requireRole(['delivery', 'delivery_partner']), handleLocationUpdate);
router.post('/location', requireRole(['delivery', 'delivery_partner']), handleLocationUpdate);


// ─── POST /orders/:id/assign-partner — Manual Rider Assignment ─────────────
router.post('/orders/:id/assign-partner', requireRole(['restaurant_manager', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { deliveryPartnerId, deliveryPartnerName, deliveryPartnerPhone } = req.body;

    if (!deliveryPartnerId) {
      res.status(400).json({ error: 'deliveryPartnerId is required' });
      return;
    }

    // Verify rider eligibility from PostgreSQL delivery_partners first, then bounded Firestore
    const pgRiderRes = await pgPool.query(
      `SELECT id, user_id, name, phone, is_online, status, active_order_id, franchise_id, branch_id
       FROM delivery_partners
       WHERE id = $1 OR user_id = $1
       LIMIT 1`,
      [deliveryPartnerId]
    ).catch(() => ({ rows: [] as any[] }));
    const pgRider = pgRiderRes.rows[0] || null;

    const riderDoc = await withTimeout(adminDb.collection('users').doc(deliveryPartnerId).get(), 'delivery.assignRiderRead', 1200).catch(() => null);
    if (!pgRider && (!riderDoc || !riderDoc.exists)) {
      res.status(404).json({ error: 'Delivery partner not found' });
      return;
    }

    const rData = riderDoc?.exists ? riderDoc.data()! : {};
    const isOnline = pgRider ? pgRider.is_online !== false : rData.isOnline !== false;
    const isActive = pgRider ? !['REVOKED', 'DEACTIVATED', 'SUSPENDED', 'REJECTED'].includes(String(pgRider.status || '').toUpperCase()) : rData.isActive !== false;
    const busyOrderId = pgRider?.active_order_id || rData.activeOrderId || null;

    if (!isOnline || !isActive) {
      res.status(400).json({ error: 'Selected delivery partner is currently offline or inactive.' });
      return;
    }

    if (busyOrderId && busyOrderId !== id) {
      res.status(400).json({ error: 'Selected delivery partner is already on an active delivery assignment.' });
      return;
    }

    const resolvedPartnerId = pgRider?.id || deliveryPartnerId;
    const resolvedPartnerName = deliveryPartnerName || pgRider?.name || rData.name || 'Delivery Partner';
    const resolvedPartnerPhone = deliveryPartnerPhone || pgRider?.phone || rData.phone || '';

    const result = await OrderStateMachine.transition(
      id,
      'partner_assigned',
      { uid: req.user!.uid, role: req.user!.role || 'restaurant_manager', name: req.user!.email },
      {
        deliveryPartnerId: resolvedPartnerId,
        deliveryPartnerName: resolvedPartnerName,
        deliveryPartnerPhone: resolvedPartnerPhone,
        manualAssignment: true,
        assignedByUid: req.user!.uid,
      }
    );

    if (!result.success) {
      res.status(400).json({ error: result.error || 'Failed to assign rider' });
      return;
    }

    await pgPool.query(
      `UPDATE delivery_partners SET active_order_id = $2, updated_at = NOW() WHERE id = $1 OR user_id = $1`,
      [resolvedPartnerId, id]
    ).catch(() => {});

    // Set rider busy status in Firestore (non-blocking if quota exhausted)
    await withTimeout(adminDb.collection('users').doc(deliveryPartnerId).set({
      activeOrderId: id,
      isBusy: true,
      updatedAt: new Date(),
    }, { merge: true }), 'delivery.assignRiderWrite', 1200).catch(() => {});

    res.json({ success: true, message: 'Rider manually assigned successfully', orderId: id, deliveryPartnerId: resolvedPartnerId });
  } catch (err: any) {
    console.error('[Delivery Routes] Manual assign error:', err);
    res.status(500).json({ error: 'Failed to assign rider' });
  }
});

// ─── POST /orders/:id/manual-assign — Server-Authoritative Manual Fleet Override ───
router.post('/orders/:id/manual-assign', requireRole(['restaurant_manager', 'owner', 'admin', 'developer', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { deliveryPartnerId, reason } = req.body;

    if (!deliveryPartnerId) {
      res.status(400).json({ error: 'deliveryPartnerId is required' });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ error: 'A valid reason is required for manual assignment override.' });
      return;
    }

    const actor = {
      uid: req.user!.uid,
      role: req.user!.role || 'restaurant_manager',
      name: req.user!.email || 'Manager'
    };

    const result = await StoreBoundDeliveryFleetService.manualAssignRider(id, deliveryPartnerId, actor, reason);
    if (!result.success) {
      res.status(400).json({ error: result.error || 'Manual assignment failed' });
      return;
    }

    res.json({ success: true, message: 'Rider assigned via manual override', orderId: id, deliveryPartnerId });
  } catch (err: any) {
    console.error('[Delivery Routes] manual-assign error:', err);
    res.status(500).json({ error: err.message || 'Failed to assign rider' });
  }
});

// ─── POST /orders/:id/emergency-reassign — Emergency Reassignment ───────────
router.post('/orders/:id/emergency-reassign', requireRole(['restaurant_manager', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason, targetRiderId } = req.body;

    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ error: 'A valid reason is required for emergency reassignment.' });
      return;
    }

    const actor = {
      uid: req.user!.uid,
      role: req.user!.role || 'restaurant_manager',
      name: req.user!.email || 'Manager'
    };

    const result = await StoreBoundDeliveryFleetService.emergencyReassign(id, reason, actor, targetRiderId);
    if (!result.success) {
      res.status(400).json({ error: result.error || 'Emergency reassignment failed' });
      return;
    }

    res.json({ success: true, message: 'Emergency reassignment processed', orderId: id, newRiderId: result.newRiderId });
  } catch (err: any) {
    console.error('[Delivery Routes] emergency-reassign error:', err);
    res.status(500).json({ error: err.message || 'Failed to process emergency reassignment' });
  }
});

// ─── GET /stores/:storeId/fleet-queue — Live Store Fleet & FIFO Queue ────────
router.get('/stores/:storeId/fleet-queue', requireRole(['restaurant_manager', 'owner', 'admin', 'developer', 'delivery', 'delivery_partner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { storeId } = req.params;
    const fleet = await StoreBoundDeliveryFleetService.getStoreFleet(storeId);
    const fifoQueue = await StoreBoundDeliveryFleetService.getStoreFifoQueue(storeId);

    res.json({
      success: true,
      storeId,
      fleet,
      fifoQueue,
      counts: {
        total: fleet.length,
        available: fifoQueue.length,
        onDelivery: fleet.filter(r => r.state === 'OUT_FOR_DELIVERY' || r.state === 'RESERVED').length,
        offline: fleet.filter(r => r.state === 'OFFLINE').length,
        paused: fleet.filter(r => r.state === 'PAUSED').length,
      }
    });
  } catch (err: any) {
    console.error('[Delivery Routes] fleet-queue error:', err);
    res.status(500).json({ error: 'Failed to fetch store fleet queue' });
  }
});

// ─── POST /rider/state — Rider Self-State Transition (AVAILABLE, PAUSED, RETURNING, OFFLINE) ──
router.post('/rider/state', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user!.uid;
    const { state, reason } = req.body;

    const validStates: RiderOperationalState[] = ['AVAILABLE', 'RETURNING', 'PAUSED', 'OFFLINE'];
    if (!validStates.includes(state)) {
      res.status(400).json({ error: `Invalid operational state. Allowed: ${validStates.join(', ')}` });
      return;
    }

    const result = await StoreBoundDeliveryFleetService.updateRiderState(uid, state, { reason });
    if (!result.success) {
      res.status(400).json({ error: result.error || 'Failed to update rider operational state' });
      return;
    }

    res.json({ success: true, state: result.state });
  } catch (err: any) {
    console.error('[Delivery Routes] rider/state error:', err);
    res.status(500).json({ error: 'Failed to update rider operational state' });
  }
});

// ─── GET /audit-logs — Delivery Assignment Audit Logs ────────────────────────
router.get('/audit-logs', requireRole(['restaurant_manager', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId, branchId, limit = '50' } = req.query;
    let q: any = adminDb.collection('delivery_fleet_audit_logs');

    if (orderId) {
      q = q.where('orderId', '==', String(orderId));
    } else if (branchId) {
      q = q.where('branchId', '==', String(branchId));
    }

    const snap = await q.limit(Number(limit)).get();
    const logs = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    logs.sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    res.json({ success: true, logs });
  } catch (err: any) {
    console.error('[Delivery Routes] audit-logs error:', err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ─── POST /orders/:id/decline — Rider Assignment Decline & Reassignment ────
router.post('/orders/:id/decline', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const riderId = req.user?.uid;
    const { reason } = req.body;

    const orderDoc = await withTimeout(adminDb.collection('orders').doc(id).get(), 'delivery.declineOrderRead', 1200).catch(() => null);
    const pgOrdRes = await pgPool.query(
      `SELECT id, order_status, delivery_partner_id, metadata FROM canonical_orders WHERE id = $1 LIMIT 1`,
      [id]
    ).catch(() => ({ rows: [] as any[] }));
    const pgOrd = pgOrdRes.rows[0] || null;
    if (!pgOrd && (!orderDoc || !orderDoc.exists)) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const oData = orderDoc?.exists ? orderDoc.data()! : (pgOrd?.metadata || {});
    const declinedPartners = Array.isArray(oData.declinedPartnerIds) ? [...oData.declinedPartnerIds] : [];
    if (riderId && !declinedPartners.includes(riderId)) {
      declinedPartners.push(riderId);
    }

    await pgPool.query(
      `UPDATE canonical_orders
       SET delivery_partner_id = NULL, delivery_partner_name = NULL, partner_assigned_at = NULL,
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{declinedPartnerIds}', $2::jsonb, true),
           updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(declinedPartners)]
    ).catch(() => {});

    // Clear active rider assignment on order and record declined ID (bounded Firestore)
    await withTimeout(adminDb.collection('orders').doc(id).set({
      deliveryPartnerId: null,
      deliveryPartnerName: null,
      deliveryPartnerPhone: null,
      declinedPartnerIds: declinedPartners,
      lastDeclineReason: reason || 'Rider declined assignment',
      updatedAt: new Date(),
    }, { merge: true }), 'delivery.declineOrderWrite', 1200).catch(() => {});

    // Release rider busy state
    if (riderId) {
      await pgPool.query(
        `UPDATE delivery_partners SET active_order_id = NULL, updated_at = NOW() WHERE id = $1 OR user_id = $1`,
        [riderId]
      ).catch(() => {});
      await withTimeout(adminDb.collection('users').doc(riderId).set({
        activeOrderId: null,
        isBusy: false,
        updatedAt: new Date(),
      }, { merge: true }), 'delivery.declineRiderRelease', 1200).catch(() => {});
    }

    // Auto-dispatch next available eligible rider in the background
    const { RiderDispatchEngine } = await import('../services/delivery/RiderDispatchEngine.js');
    RiderDispatchEngine.autoDispatchRider(id).catch((e) =>
      console.warn('[Delivery Routes] Reassignment notice:', e.message)
    );

    res.json({ success: true, message: 'Assignment declined. Next available rider is being dispatched.', orderId: id });
  } catch (err: any) {
    console.error('[Delivery Routes] Decline error:', err);
    res.status(500).json({ error: 'Failed to process rider decline' });
  }
});

// ─── GET /rider/me — Authorized Delivery Partner Profile ────────────────────
router.get('/rider/me', requireRole(['delivery', 'delivery_partner', 'owner', 'admin', 'developer', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user!.uid;
    const email = (req.user?.email || '').trim().toLowerCase();
    const pgRiderRes = await pgPool.query(
      `SELECT dp.id, dp.user_id, dp.name, dp.phone, dp.email, dp.franchise_id, dp.branch_id,
              dp.vehicle_type, dp.vehicle_number, dp.is_online, dp.active_order_id, dp.total_deliveries,
              rb.name AS branch_name, rb.address AS branch_address, rb.phone AS branch_phone
       FROM delivery_partners dp
       LEFT JOIN restaurant_branches rb ON rb.id = dp.branch_id
       WHERE dp.id = $1 OR dp.user_id = $1 OR ($2 <> '' AND LOWER(dp.email) = LOWER($2))
       ORDER BY (dp.id = $1 OR dp.user_id = $1) DESC
       LIMIT 1`,
      [uid, email]
    ).catch(() => ({ rows: [] as any[] }));
    const pgRider = pgRiderRes.rows[0] || null;

    const userDoc = await withTimeout(adminDb.collection('users').doc(uid).get(), 'delivery.riderMeRead', 1200).catch(() => null);
    if (!pgRider && (!userDoc || !userDoc.exists)) {
      res.status(404).json({ success: false, error: 'Rider profile not found in database' });
      return;
    }

    const data = userDoc?.exists ? userDoc.data()! : {};
    const isOwner = req.user!.role === 'owner' || req.user!.role === 'platform_owner';
    
    const rider = {
      uid,
      id: pgRider?.id || uid,
      name: pgRider?.name || data.name || req.user!.email?.split('@')[0] || 'Delivery Partner',
      email: pgRider?.email || data.email || req.user!.email || '',
      phone: pgRider?.phone || data.phone || data.contactPhone || null,
      role: isOwner ? 'owner' : (data.role || 'delivery_partner'),
      vehicleType: pgRider?.vehicle_type || data.vehicleType || null,
      vehicleNumber: pgRider?.vehicle_number || data.vehicleNumber || null,
      organizationId: data.organizationId || 'org_olive_pizza',
      franchiseId: pgRider?.franchise_id || data.franchiseId || req.user?.franchiseId || null,
      branchId: pgRider?.branch_id || data.branchId || req.user?.branchId || null,
      branchName: pgRider?.branch_name || data.branchName || null,
      branchAddress: pgRider?.branch_address || data.branchAddress || null,
      branchPhone: pgRider?.branch_phone || data.branchPhone || null,
      isOnline: pgRider ? pgRider.is_online !== false : data.isOnline !== false,
      rating: data.rating != null ? Number(data.rating) : null,
      totalDeliveriesLifetime: pgRider?.total_deliveries ?? data.totalDeliveriesLifetime ?? 0,
      activeOrderId: pgRider?.active_order_id || data.activeOrderId || null
    };

    res.json({ success: true, rider });
  } catch (err: any) {
    console.error('[Delivery Routes] /rider/me error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch rider profile' });
  }
});

// ─── POST /rider/status — Update Online Availability ────────────────────────
router.post('/rider/status', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user!.uid;
    const { isOnline, lat, lng, latitude, longitude, accuracy, speed, heading, backgroundService } = req.body;
    const isOnlineBool = Boolean(isOnline);
    const isBackgroundTelemetry = Boolean(backgroundService);

    const finalLat = lat ?? latitude;
    const finalLng = lng ?? longitude;

    await pgPool.query(
      `UPDATE delivery_partners
       SET is_online = $2,
           current_lat = COALESCE($3, current_lat),
           current_lng = COALESCE($4, current_lng),
           last_location_time = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE last_location_time END,
           updated_at = NOW()
       WHERE id = $1 OR user_id = $1`,
      [uid, isOnlineBool, finalLat != null ? Number(finalLat) : null, finalLng != null ? Number(finalLng) : null]
    ).catch(() => {});

    const updatePayload: any = {
      isOnline: isOnlineBool,
      status: isOnlineBool ? 'available' : 'offline',
      onlineStatusUpdatedAt: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp()
    };

    if (finalLat != null && finalLng != null) {
      updatePayload.latitude = Number(finalLat);
      updatePayload.longitude = Number(finalLng);
      updatePayload.lat = Number(finalLat);
      updatePayload.lng = Number(finalLng);
    }

    // Avoid continuous Firestore quota exhaustion during 5s background telemetry
    if (!isBackgroundTelemetry) {
      await Promise.all([
        withTimeout(adminDb.collection('users').doc(uid).set(updatePayload, { merge: true }), 'delivery.riderStatusUsersWrite', 1200).catch(() => {}),
        withTimeout(adminDb.collection('delivery_partners').doc(uid).set(updatePayload, { merge: true }), 'delivery.riderStatusDpWrite', 1200).catch(() => {}),
      ]);
    }

    if (finalLat != null && finalLng != null) {
      // ⚡ INSTANT WEBSOCKET BROADCAST to all active order listeners and fleet maps
      webSocketServer.handleDriverLocationUpdate({
        deliveryPartnerId: uid,
        orderId: req.body.activeOrderId || req.body.orderId || null,
        lat: Number(finalLat),
        lng: Number(finalLng),
        accuracy: accuracy != null ? Number(accuracy) : 5,
        speed: speed != null ? Number(speed) : 0,
        heading: heading != null ? Number(heading) : 0,
        battery: req.body.battery ? Number(req.body.battery) : 100,
        isMoving: speed ? Number(speed) > 1 : false,
        timestamp: req.body.timestamp || new Date().toISOString(),
        status: isOnlineBool ? 'ONLINE' : 'OFFLINE'
      });

      // 🛰️ Authoritative Ephemeral Layerbase Redis 7.2.15 GPS Engine
      await RedisGpsService.updateLocation({
        deliveryPartnerId: uid,
        franchiseId: req.user?.franchiseId || 'fra_primary',
        branchId: req.user?.branchId || 'main_branch',
        activeOrderId: req.body.activeOrderId || req.body.orderId || null,
        latitude: Number(finalLat),
        longitude: Number(finalLng),
        accuracy: accuracy != null ? Number(accuracy) : null,
        speed: speed != null ? Number(speed) : null,
        heading: heading != null ? Number(heading) : null,
        battery: req.body.battery ? Number(req.body.battery) : null,
        onlineStatus: isOnlineBool,
        timestamp: req.body.timestamp
      }).catch((redisErr) => {
        console.warn('[Delivery Routes] Redis GPS update warning:', redisErr.message);
      });
    }

    res.json({ success: true, isOnline: isOnlineBool });
  } catch (err: any) {
    console.error('[Delivery Routes] /rider/status error:', err);
    res.status(500).json({ success: false, error: 'Failed to update online status' });
  }
});

// ─── GET /rider/stats — Today's Shift Metrics (IST / Asia/Kolkata) ─────────
router.get('/rider/stats', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user!.uid;
    const todayStr = getIstDateKey();

    let assigned = 0;
    let completed = 0;
    let active = 0;
    let cancelled = 0;
    let earnings = 0;
    let totalDurationMin = 0;
    let durationCount = 0;

    const seenIds = new Set<string>();
    const pgStatsRes = await pgPool.query(
      `SELECT o.id, LOWER(o.order_status) AS status, o.partner_assigned_at, o.delivered_at
       FROM canonical_orders o
       WHERE (o.delivery_partner_id = $1 OR o.delivery_partner_id IN (SELECT id FROM delivery_partners WHERE user_id = $1 OR id = $1))
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [uid]
    ).catch(() => ({ rows: [] as any[] }));

    for (const row of pgStatsRes.rows) {
      seenIds.add(row.id);
      assigned++;
      if (row.status === 'delivered' || row.status === 'completed') {
        completed++;
        earnings += 40;
        if (row.partner_assigned_at && row.delivered_at) {
          const dur = (new Date(row.delivered_at).getTime() - new Date(row.partner_assigned_at).getTime()) / 60000;
          if (dur > 0) { totalDurationMin += dur; durationCount++; }
        }
      } else if (['partner_assigned', 'picked_up', 'out_for_delivery'].includes(row.status)) {
        active++;
      } else if (row.status === 'cancelled' || row.status === 'rejected') {
        cancelled++;
      }
    }

    const ordersSnap = await withTimeout(
      adminDb.collection('orders').where('deliveryPartnerId', '==', uid).limit(100).get(),
      'delivery.riderStatsRead',
      1200
    ).catch(() => null);

    ordersSnap?.forEach((doc: any) => {
      if (seenIds.has(doc.id)) return;
      const order = doc.data();
      assigned++;
      if (order.status === 'delivered') {
        completed++;
        earnings += 40;
        const start = order.pickedUpAt ? new Date(order.pickedUpAt).getTime() : (order.partnerAssignedAt ? new Date(order.partnerAssignedAt).getTime() : null);
        const end = order.deliveredAt ? new Date(order.deliveredAt).getTime() : null;
        if (start && end && end > start) {
          totalDurationMin += (end - start) / (60 * 1000);
          durationCount++;
        }
      } else if (['partner_assigned', 'picked_up', 'out_for_delivery'].includes(order.status)) {
        active++;
      } else if (order.status === 'cancelled') {
        cancelled++;
      }
    });

    const averageDeliveryTimeMin = durationCount > 0 ? Math.round(totalDurationMin / durationCount) : 0;

    res.json({
      success: true,
      today: {
        assigned,
        completed,
        active,
        cancelled,
        totalDistanceKm: 0,
        averageDeliveryTimeMin,
        earnings,
        currency: 'INR',
        date: todayStr
      }
    });
  } catch (err: any) {
    console.error('[Delivery Routes] /rider/stats error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch rider stats' });
  }
});

// ─── GET /rider/reports — Historical Summary ────────────────────────────────
router.get('/rider/reports', requireRole(['delivery', 'delivery_partner', 'owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user!.uid;
    const now = new Date();
    const currentMonth = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' });

    const seenIds = new Set<string>();
    const pgDeliveredRes = await pgPool.query(
      `SELECT id, partner_assigned_at, delivered_at
       FROM canonical_orders
       WHERE (delivery_partner_id = $1 OR delivery_partner_id IN (SELECT id FROM delivery_partners WHERE user_id = $1 OR id = $1))
         AND order_status IN ('DELIVERED', 'COMPLETED')
       LIMIT 200`,
      [uid]
    ).catch(() => ({ rows: [] as any[] }));

    let deliveredCount = 0;
    let onTimeCount = 0;
    let totalRated = 0;
    let sumRating = 0;

    for (const r of pgDeliveredRes.rows) {
      seenIds.add(r.id);
      deliveredCount++;
      if (r.partner_assigned_at && r.delivered_at) {
        const dur = (new Date(r.delivered_at).getTime() - new Date(r.partner_assigned_at).getTime()) / 60000;
        if (dur <= 30) onTimeCount++;
      }
    }

    const ordersSnap = await withTimeout(
      adminDb.collection('orders').where('deliveryPartnerId', '==', uid).where('status', '==', 'delivered').limit(200).get(),
      'delivery.riderReportsRead',
      1200
    ).catch(() => null);

    ordersSnap?.forEach((d: any) => {
      if (seenIds.has(d.id)) return;
      deliveredCount++;
      const o = d.data();
      const start = o.pickedUpAt ? new Date(o.pickedUpAt).getTime() : (o.partnerAssignedAt ? new Date(o.partnerAssignedAt).getTime() : null);
      const end = o.deliveredAt ? new Date(o.deliveredAt).getTime() : null;
      if (start && end) {
        const dur = (end - start) / (60 * 1000);
        if (dur <= 30) onTimeCount++;
      }
      if (typeof o.riderRating === 'number' && o.riderRating > 0) {
        sumRating += o.riderRating;
        totalRated++;
      }
    });

    const monthlyEarnings = deliveredCount * 40;
    const onTimeRate = deliveredCount > 0 ? Math.round((onTimeCount / deliveredCount) * 100) : 0;
    const averageRating = totalRated > 0 ? Number((sumRating / totalRated).toFixed(1)) : 5.0;

    const reports = deliveredCount > 0 ? [
      {
        month: currentMonth,
        totalDeliveries: deliveredCount,
        totalEarnings: monthlyEarnings,
        averageRating,
        onTimeRate
      }
    ] : [];

    res.json({ success: true, reports });
  } catch (err: any) {
    console.error('[Delivery Routes] /rider/reports error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch rider reports' });
  }
});

// ─── GATE 1: RIDER ONBOARDING & REPLACEMENT SAGA WORKFLOWS ────────────────

/**
 * POST /riders/onboard-request
 * Submit a rider onboarding request by Restaurant Manager or Franchise Manager (Rule BR-01).
 */
router.post('/riders/onboard-request', requireRole(['restaurant_manager', 'franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { branchId, franchiseId, riderName, phone, email, vehicleType, vehicleNumber } = req.body;
    const callerBranch = branchId || req.user!.branchId || 'main_branch';
    const callerFranchise = franchiseId || req.user!.franchiseId || 'fra_primary';

    const result = await RiderOnboardingService.submitRequest({
      requestedByUid: req.user!.uid,
      requestedByRole: req.user!.role || 'restaurant_manager',
      branchId: callerBranch,
      franchiseId: callerFranchise,
      riderName,
      phone,
      email,
      vehicleType,
      vehicleNumber
    });

    res.status(201).json(result);
  } catch (err: any) {
    console.error('[Delivery Routes] /riders/onboard-request error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * GET /riders/onboard-requests
 * Query rider onboarding requests scoped by role.
 */
router.get('/riders/onboard-requests', requireRole(['restaurant_manager', 'franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { branchId, franchiseId, status } = req.query;
    const requests = await RiderOnboardingService.listRequests({
      branchId: (branchId as string) || req.user!.branchId,
      franchiseId: (franchiseId as string) || req.user!.franchiseId,
      status: status as string,
      userRole: req.user!.role || 'restaurant_manager'
    });

    res.json({ success: true, count: requests.length, requests });
  } catch (err: any) {
    console.error('[Delivery Routes] /riders/onboard-requests error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /riders/onboard-requests/:id/review
 * Owner/Admin approves and activates or rejects rider onboarding request (Rule BR-01).
 */
router.post('/riders/onboard-requests/:id/review', requireRole(['owner', 'developer', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { action, notes } = req.body;

    if (!['APPROVE', 'REJECT'].includes((action || '').toUpperCase())) {
      res.status(400).json({ error: "Invalid action. Must be 'APPROVE' or 'REJECT'." });
      return;
    }

    const result = await RiderOnboardingService.reviewRequest({
      requestId: id,
      reviewerUid: req.user!.uid,
      reviewerRole: req.user!.role || 'owner',
      action: action.toUpperCase() as 'APPROVE' | 'REJECT',
      notes
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Delivery Routes] /riders/onboard-requests/:id/review error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * POST /riders/replace OR POST /orders/:id/replace-rider
 * Executes the multi-order replacement saga & physical handover protocol (Rules BR-02, BR-03, BR-10).
 */
async function handleRiderReplacement(req: AuthRequest, res: Response): Promise<void> {
  try {
    const targetOrderId = req.params.id || req.body.targetOrderId;
    const { oldRiderId, replacementRiderId, reason, idempotencyKey } = req.body;

    if (!targetOrderId) {
      res.status(400).json({ error: 'targetOrderId is required' });
      return;
    }
    if (!oldRiderId) {
      res.status(400).json({ error: 'oldRiderId is required' });
      return;
    }
    if (!reason || reason.trim().length < 3) {
      res.status(400).json({ error: 'A valid reason is required for rider replacement' });
      return;
    }

    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId,
      oldRiderId,
      replacementRiderId: replacementRiderId || undefined,
      reason,
      initiatedByUid: req.user!.uid,
      initiatedByRole: req.user!.role || 'restaurant_manager',
      idempotencyKey
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Delivery Routes] replace-rider error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
}

router.post('/riders/replace', requireRole(['restaurant_manager', 'franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer']), handleRiderReplacement);
router.post('/orders/:id/replace-rider', requireRole(['restaurant_manager', 'franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer']), handleRiderReplacement);

/**
 * POST /orders/:id/handover-confirm
 * Receiving rider confirms physical custody transfer of an active delivery (Rule BR-10).
 */
router.post('/orders/:id/handover-confirm', requireRole(['delivery', 'delivery_partner', 'owner', 'restaurant_manager', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { handoverId, receivingRiderId, latitude, longitude, notes, action } = req.body;

    if (action === 'REFUSE') {
      const result = await RiderReplacementSagaService.refusePhysicalHandover({
        orderId: id,
        handoverId,
        refusingRiderId: receivingRiderId || req.user!.uid,
        reason: notes || 'Receiving rider refused custody handover'
      });
      res.json(result);
      return;
    }

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
    console.error('[Delivery Routes] /orders/:id/handover-confirm error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * POST /orders/:id/handover-refuse
 * Receiving rider refuses physical custody transfer of an active delivery.
 */
router.post('/orders/:id/handover-refuse', requireRole(['delivery', 'delivery_partner', 'owner', 'restaurant_manager', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { handoverId, refusingRiderId, reason } = req.body;

    const result = await RiderReplacementSagaService.refusePhysicalHandover({
      orderId: id,
      handoverId,
      refusingRiderId: refusingRiderId || req.user!.uid,
      reason: reason || 'Receiving rider refused custody handover'
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Delivery Routes] /orders/:id/handover-refuse error:', err);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
  }
});

export default router;
