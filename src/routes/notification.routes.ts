/**
 * Enterprise Notification Routes
 *
 * Endpoints:
 * POST /notifications/action         — Service Worker quick actions (order state machine)
 * POST /notifications/send-custom    — Owner broadcast push notifications
 * POST /notifications/track          — Acknowledge delivered/opened/clicked
 * POST /notifications/token          — Register/refresh FCM token
 * GET  /notifications/inbox          — Fetch user's notification inbox
 * PATCH /notifications/inbox/:id     — Mark inbox item read / archived
 * GET  /notifications/analytics      — Owner notification analytics
 * POST /notifications/preferences    — Update DND preferences
 * GET  /notifications/preferences    — Get DND preferences
 * POST /notifications/retry-failed   — Owner: retry failed notifications
 * POST /notifications/cleanup        — Owner: trigger manual cleanup
 * GET  /notifications/diagnostics    — System diagnostics (cache, WS, queue health)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { adminDb as db } from '../config/firebase.js';
import * as admin from 'firebase-admin';
import { pgPool } from '../config/postgres.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { notificationScheduler } from '../services/notification/NotificationScheduler.js';
import { OwnerTemplates, CustomerTemplates, DeliveryTemplates, MarketingTemplates, type OrderStatus } from '../services/notification/NotificationTemplates.js';

import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { notificationQueue } from '../services/notification/NotificationQueueService.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { orderEventService } from '../services/order/OrderEventService.js';
import { queueEmail } from '../services/email.service.js';
import { buildOrderStatusEmail } from '../services/emailTemplates.service.js';
import { fcmTokenCache } from '../services/notification/FCMTokenCache.js';
import { webSocketServer } from '../services/websocket/WebSocketServer.js';

const router = Router();

// ─── Helper: Timeout wrapper ──────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms))
  ]);
}

// ─── Helper: Resolve owner UIDs ───────────────────────────────────────────────
async function getOwnerUserIds(): Promise<string[]> {
  const snapshot = await db.collection('users').where('role', '==', 'owner').get();
  return snapshot.docs.map(doc => doc.id);
}

// ─── Helper: Resolve user's Postgres UUID from Firebase UID ───────────────────
const getPostgresUserId = async (uid: string) => uid;
// ─── Helper: Acquire order lock (prevent race conditions) ─────────────────────
interface LockInfo {
  success: boolean;
  duplicate?: boolean;
  reason?: string;
  locked_by_name?: string;
  locked_at?: string;
  action?: string;
  age_seconds?: number;
}

async function acquireOrderLock(orderId: string, firebaseUid: string, action: string): Promise<LockInfo> {
  let client: any = null;
  try {
    client = await pgPool.connect();
    // Ensure table exists on the fly
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_locks (
        order_id VARCHAR(255) PRIMARY KEY,
        locked_by VARCHAR(255),
        action VARCHAR(100),
        locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `).catch(() => {});

    const result = await client.query(
      `INSERT INTO order_locks (order_id, locked_by, action, locked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (order_id) DO UPDATE 
       SET locked_by = EXCLUDED.locked_by, action = EXCLUDED.action, locked_at = EXCLUDED.locked_at
       WHERE order_locks.locked_at < NOW() - INTERVAL '30 seconds'
       RETURNING order_id`,
      [orderId, firebaseUid, action]
    );

    if (result.rows.length > 0) {
      return { success: true };
    }

    const lockDetails = await client.query(
      `SELECT l.action, l.locked_at, EXTRACT(EPOCH FROM (NOW() - l.locked_at)) as age_seconds, l.locked_by
       FROM order_locks l
       WHERE l.order_id = $1`,
      [orderId]
    );

    if (lockDetails.rows.length > 0) {
      const lock = lockDetails.rows[0];
      const isDuplicate = lock.action === action && lock.age_seconds < 5;

      return {
        success: false,
        duplicate: isDuplicate,
        reason: isDuplicate ? 'Duplicate request ignored' : 'Another user is processing this order',
        locked_by_name: lock.locked_by || 'Unknown',
        locked_at: lock.locked_at,
        action: lock.action,
        age_seconds: Math.round(lock.age_seconds || 0)
      };
    }
    return { success: true };
  } catch (e: any) {
    console.warn(`[OrderLock] Non-blocking lock notice for order ${orderId} (proceeding with Firestore update):`, e.message);
    // Gracefully proceed with Firestore write so customer/owner is never blocked from cancelling/updating orders
    return { success: true };
  } finally {
    if (client) client.release();
  }
}

async function releaseOrderLock(orderId: string): Promise<void> {
  let client: any = null;
  try {
    client = await pgPool.connect();
    await client.query('DELETE FROM order_locks WHERE order_id = $1', [orderId]).catch(() => {});
  } catch (e: any) {
    console.warn(`[OrderLock] Release lock notice for order ${orderId}:`, e.message);
  } finally {
    if (client) client.release();
  }
}

// =============================================================================
// POST /notifications/action
// Owner/Delivery quick actions — handles Accept, Reject, Start Cooking, etc.
// CRITICAL FLOW: Firestore write is SYNCHRONOUS before HTTP 200.
// Notifications/emails/analytics are fire-and-forget background tasks.
// =============================================================================

const actionSchema = z.object({
  orderId: z.string().min(1, 'Missing orderId'),
  action: z.string().min(1, 'Missing action'),
  currentStage: z.string().optional(),
  partnerId: z.string().optional(),
  reason: z.string().max(255, 'Reason is too long').optional(), // Free-text reason
  deliveryProof: z.object({
    photoUrl: z.string().url().optional(),
    note: z.string().max(500).optional()
  }).optional()
});

router.post('/action', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsedBody = actionSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({ error: parsedBody.error.issues[0].message });
    return;
  }
  
  const { orderId, action, currentStage, partnerId, reason, deliveryProof } = parsedBody.data;
  const userId = req.user!.uid;
  const isDebug = req.headers['x-debug-mode'] === 'true';
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const trace: any = { requestId, route: 'POST /api/notifications/action', action, orderId, userId, currentStage, steps: [] };

  console.log(`[Action][${requestId}] START action=${action} orderId=${orderId} userId=${userId} currentStage=${currentStage} reason=${reason}`);

  // ── Step 1: Verify user exists and has a role ──────────────────────────
  let userRole: string;
  let userProfileData: any = null;
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const docData = userDoc.exists ? userDoc.data() : null;
    userProfileData = docData;
    userRole = (req.user?.role || docData?.role) as string;

    if (!userRole && docData) {
      if (docData.isDeliveryPartner || docData.vehicleType || docData.vehicleNumber) {
        userRole = 'delivery_partner';
      } else {
        userRole = 'customer';
      }
    }

    if (!userRole) {
      console.warn(`[Action][${requestId}] User role undefined: ${userId}`);
      res.status(403).json({ error: 'Unauthorized: user role undefined', requestId });
      return;
    }

    trace.steps.push({ step: 'Auth Check', status: 'success', role: userRole, ms: Date.now() - startTime });
    console.log(`[Action][${requestId}] Auth OK. role=${userRole}`);
  } catch (authErr: any) {
    console.error(`[Action][${requestId}] Auth check failed:`, authErr.message);
    res.status(500).json({ error: 'Authentication check failed', details: authErr.message, requestId });
    return;
  }

  // ── Step 2: Pre-check terminal order states ─────────────────────────────
  try {
    const preCheckDoc = await db.collection('orders').doc(orderId).get();
    const orderStatusPreCheck = preCheckDoc.exists ? preCheckDoc.data()?.status : null;
    if (!preCheckDoc.exists) {
      console.warn(`[Action][${requestId}] Order ${orderId} not found in pre-check`);
      res.status(404).json({ error: 'Order not found', requestId });
      return;
    }
    if (['delivered', 'completed', 'cancelled', 'rejected'].includes(orderStatusPreCheck)) {
      trace.steps.push({ step: 'Terminal State Check', status: 'blocked', reason: `Order already ${orderStatusPreCheck}` });
      console.log(`[Action][${requestId}] Order already in terminal state: ${orderStatusPreCheck}`);
      res.status(200).json({ success: false, message: `Order already ${orderStatusPreCheck}`, requestId, trace: isDebug ? trace : undefined });
      return;
    }
    trace.steps.push({ step: 'Terminal State Check', status: 'success', currentStatus: orderStatusPreCheck, ms: Date.now() - startTime });
  } catch (preCheckErr: any) {
    console.error(`[Action][${requestId}] Pre-check Firestore read failed:`, preCheckErr.message);
    res.status(500).json({ error: 'Failed to read order status', details: preCheckErr.message, requestId });
    return;
  }

  // ── Step 3: Acquire Order Lock ──────────────────────────────────────────
  let lockAcquired = false;
  try {
    const lockInfo = await acquireOrderLock(orderId, userId, action);
    if (!lockInfo.success) {
      if (lockInfo.duplicate) {
        trace.steps.push({ step: 'Idempotency Lock', status: 'success', info: 'Duplicate request safely ignored' });
        console.log(`[Action][${requestId}] Duplicate request ignored for orderId=${orderId}`);
        res.status(200).json({ success: true, duplicate: true, message: lockInfo.reason, requestId, trace: isDebug ? trace : undefined });
        return;
      }
      trace.steps.push({ step: 'Idempotency Lock', status: 'failed', reason: lockInfo.reason });
      console.warn(`[Action][${requestId}] Lock failed: ${lockInfo.reason}`);
      res.status(409).json({ error: lockInfo.reason || 'Order is currently being processed', requestId, trace: isDebug ? trace : undefined });
      return;
    }
    lockAcquired = true;
    trace.steps.push({ step: 'Order Lock', status: 'acquired', ms: Date.now() - startTime });
    console.log(`[Action][${requestId}] Lock acquired for orderId=${orderId}`);
  } catch (lockErr: any) {
    console.error(`[Action][${requestId}] Lock acquisition error:`, lockErr.message);
    res.status(500).json({ error: 'Failed to acquire order lock', details: lockErr.message, requestId });
    return;
  }

  let lockReleased = false;

  try {
    // ── Step 4: Read full order from Firestore ─────────────────────────────
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      console.warn(`[Action][${requestId}] Order ${orderId} not found`);
      await releaseOrderLock(orderId);
      lockReleased = true;
      res.status(404).json({ error: 'Order not found', requestId });
      return;
    }
    const orderData = orderDoc.data()!;
    const currentStatus = orderData.status as string;
    const customerFirebaseUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId || orderData.user_id;
    const shortId = orderData.dailyOrderNumber || `#${orderId.slice(-6).toUpperCase()}`;
    trace.steps.push({ step: 'Firestore Read', status: 'success', currentStatus, ms: Date.now() - startTime });
    console.log(`[Action][${requestId}] Order read. currentStatus=${currentStatus}`);

    const backgroundTasks: (() => Promise<void>)[] = [];
    let newStatus = currentStatus;
    let responseData: any = {};
    let firestoreWriteRequired = false;
    let firestoreUpdates: Record<string, any> = {};

    // ── Step 5: State Machine Validation & Business Logic ─────────────────
    const ALL_PENDING_STATUSES = [
      'pending', 'pending_acceptance', 'pending_confirmation', 'new_order', 'new', 
      'placed', 'order_placed', 'created', 'paid', 'payment_success', 'payment_completed', 'cod'
    ];
    const ALL_ACTIVE_STATUSES = [...ALL_PENDING_STATUSES, 'accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery'];

    const OWNER_TRANSITIONS: Record<string, { from: string[], to: string }> = {
      accept: { from: ALL_PENDING_STATUSES, to: 'accepted' },
      accepted: { from: ALL_PENDING_STATUSES, to: 'accepted' },
      reject: { from: ALL_ACTIVE_STATUSES, to: 'cancelled' },
      cancel_order: { from: ALL_ACTIVE_STATUSES, to: 'cancelled' },
      cancelled: { from: ALL_ACTIVE_STATUSES, to: 'cancelled' },
      start_cooking: { from: [...ALL_PENDING_STATUSES, 'accepted'], to: 'preparing' },
      preparing: { from: [...ALL_PENDING_STATUSES, 'accepted'], to: 'preparing' },
      ready: { from: [...ALL_PENDING_STATUSES, 'accepted', 'preparing', 'partner_assigned'], to: 'ready' },
      assign_delivery: { from: ALL_ACTIVE_STATUSES, to: 'partner_assigned' },
      partner_assigned: { from: ALL_ACTIVE_STATUSES, to: 'partner_assigned' },
       picked_up: { from: ALL_ACTIVE_STATUSES, to: 'out_for_delivery' },
      out_for_delivery: { from: ALL_ACTIVE_STATUSES, to: 'out_for_delivery' },
      delivered: { from: ALL_ACTIVE_STATUSES, to: 'delivered' },
    };

    // ── RESTAURANT MANAGEMENT / OPERATIONAL STAFF ACTIONS ─────────────────
    const normalizedRole = userRole.toLowerCase();
    const isRestaurantStaff = [
      'restaurant_manager', 'kitchen_staff', 'cashier', 'manager',
      'chef', 'franchise_manager', 'franchise_owner'
    ].includes(normalizedRole);

    if (isRestaurantStaff) {
      const orderBranchId = orderData.branchId || 'main_branch';
      const userBranchId = req.user?.branchId || userProfileData?.branchId;
      const emailLower = (req.user?.email || '').toLowerCase();
      const isMasterAccount = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';

      if (userBranchId && userBranchId !== orderBranchId && userBranchId !== 'all' && !isMasterAccount) {
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(403).json({
          error: `Forbidden: You do not have authority over orders from branch ${orderBranchId}`,
          requestId
        });
        return;
      }

      const normalizedAction = action.toUpperCase();
      let targetState: any = null;
      let transitionMetadata: Record<string, any> = {};

      if (normalizedAction === 'ACCEPT') {
        targetState = 'preparing';
        if (currentStatus === 'pending' || currentStatus === 'pending_acceptance') {
          await OrderStateMachine.transition(orderId, 'accepted', {
            uid: userId,
            role: normalizedRole,
            name: (req.user as any)?.name || req.user?.email || 'Staff',
            branchId: orderBranchId
          });
        }
      } else if (normalizedAction === 'REJECT' || normalizedAction === 'CANCEL') {
        targetState = 'cancelled';
        transitionMetadata = {
          cancellationReason: reason || 'Cancelled by restaurant staff',
          cancellationSource: normalizedRole
        };
      } else if (normalizedAction === 'START_COOKING' || normalizedAction === 'PREPARING') {
        targetState = 'preparing';
      } else if (normalizedAction === 'READY') {
        targetState = 'ready';
      } else if (normalizedAction === 'DELIVERED') {
        targetState = 'delivered';
      } else {
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(400).json({
          error: `Unknown action "${action}" for restaurant staff role "${userRole}"`,
          allowedActions: ['ACCEPT', 'REJECT', 'START_COOKING', 'READY', 'DELIVERED'],
          requestId
        });
        return;
      }

      // Execute authoritative state machine transition
      const transitionResult = await OrderStateMachine.transition(orderId, targetState, {
        uid: userId,
        role: normalizedRole,
        name: (req.user as any)?.name || req.user?.email || 'Staff',
        branchId: orderBranchId
      }, transitionMetadata);

      if (!transitionResult.success) {
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(400).json({ error: transitionResult.error, requestId });
        return;
      }

      newStatus = transitionResult.currentStatus;
      firestoreWriteRequired = false; // Handled authoritatively by OrderStateMachine
      responseData = { message: `Order #${orderData.orderNumber || orderId} transitioned to ${newStatus}`, version: transitionResult.version };
    }

    // ── OWNER ACTIONS ──────────────────────────────────────────────────────
    else if (userRole === 'owner') {
      const actionDef = OWNER_TRANSITIONS[action];

      if (!actionDef) {
        trace.steps.push({ step: 'State Machine', status: 'failed', reason: `Unknown owner action: ${action}` });
        console.warn(`[Action][${requestId}] Unknown owner action: ${action}`);
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(400).json({ error: `Unknown action "${action}" for role "owner"`, allowedActions: Object.keys(OWNER_TRANSITIONS), requestId });
        return;
      }

      if (!actionDef.from.includes(currentStatus)) {
        const reasonStr = `Cannot perform "${action}" when order is "${currentStatus}". Allowed from: [${actionDef.from.join(', ')}]`;
        trace.steps.push({ step: 'State Machine', status: 'failed', reason: reasonStr });
        console.warn(`[Action][${requestId}] Invalid transition: ${reasonStr}`);
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(409).json({ error: reasonStr, currentStatus, action, requestId, trace: isDebug ? trace : undefined });
        return;
      }

      newStatus = actionDef.to;
      trace.steps.push({ step: 'State Machine', status: 'success', transition: `${currentStatus} → ${newStatus}`, ms: Date.now() - startTime });
      console.log(`[Action][${requestId}] Transition validated: ${currentStatus} → ${newStatus}`);

      // Build Firestore updates
      firestoreWriteRequired = true;
      firestoreUpdates = { status: newStatus, updatedAt: new Date() };

      if (action === 'assign_delivery' || action === 'partner_assigned') {
        if (!partnerId) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(400).json({ error: 'partnerId is required for assign_delivery', requestId });
          return;
        }

        const partnerDoc = await db.collection('users').doc(partnerId).get();
        const partnerData = partnerDoc.exists ? partnerDoc.data() : {};

        // Warning only if partner is busy, allow assignment for smooth testing/ops
        if (partnerData?.deliveryStatus === 'on_delivery' || partnerData?.deliveryStatus === 'busy') {
          console.warn(`[Action][${requestId}] Assigning order ${orderId} to partner ${partnerId} who is currently ${partnerData?.deliveryStatus}`);
        }

        // Set status to on_delivery via DeliveryCapacityService equivalent
        backgroundTasks.push(async () => {
           try {
             const { DeliveryCapacityService } = await import('../services/delivery/DeliveryCapacityService.js');
             await DeliveryCapacityService.setPartnerStatus(partnerId, 'on_delivery', orderId);
           } catch(e) { console.error('Failed to update partner status', e); }
        });

        firestoreUpdates.deliveryPartnerId = partnerId;
        firestoreUpdates.delivery_partner_id = partnerId;
        
        // Direct Notification Engine dispatch to assigned rider
        backgroundTasks.push(async () => {
          try {
            const partnerDoc = await db.collection('users').doc(partnerId).get();
            const partnerData = partnerDoc.exists ? partnerDoc.data() : {};
            firestoreUpdates.deliveryPartnerName = partnerData?.name || 'Delivery Partner';

            const assignPayload = DeliveryTemplates.newAssignment(orderId, {
              orderNumber: shortId,
              customerName: orderData.customerName || 'Customer',
              customerPhone: orderData.contactPhone || 'N/A',
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Pickup',
              distance: '2.5 km',
              eta: '15-20 mins',
              totalAmount: Number(orderData.totalAmount || 0),
              paymentMethod: orderData.paymentMethod || 'COD',
            });
            await notificationEngine.send(partnerId, assignPayload, { category: 'alarm_actionable', priority: 'critical', orderId, targetApp: 'delivery' });
            
            // Also update customer tracker
            if (customerFirebaseUid) {
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'partner_assigned',
                totalAmount: Number(orderData.totalAmount || 0),
                deliveryPartnerName: partnerData?.name || 'Delivery Partner',
              });
              await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
            }
          } catch (e: any) {
            console.error(`[Action][${requestId}] Partner assignment notification failed:`, e.message);
          }
        });

      } else if (action === 'accept' || action === 'accepted') {
        firestoreUpdates.acceptedAt = new Date().toISOString();
        firestoreUpdates.eta = '20-30 mins';
        
        // Stop restaurant branch continuous alarm & send customer confirmed notification
        backgroundTasks.push(async () => {
          try {
            const branchId = orderData.branchId || 'main_branch';
            const branchStaff = await notificationEngine.resolveBranchStaff(branchId);
            if (branchStaff.length > 0) {
              const stopPayload = { data: { action: 'stop_alert', orderId } } as any;
              await notificationEngine.sendBulk(branchStaff, stopPayload, { category: 'alarm_actionable', priority: 'high', orderId, tag: `order_restaurant_${orderId}`, targetApp: 'restaurant' });
            }
            if (customerFirebaseUid) {
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'accepted',
                eta: '20-30 mins',
                totalAmount: Number(orderData.totalAmount || 0),
              });
              await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
            }
          } catch (e: any) {
            console.error(`[Action][${requestId}] Accept notifications failed:`, e.message);
          }
        });

      } else if (action === 'reject' || action === 'cancel_order' || action === 'cancelled') {
        const cancellationReason = reason || 'Cancelled by store staff';
        firestoreUpdates.cancellationReason = cancellationReason;
        firestoreUpdates.cancelledAt = new Date().toISOString();
        trace.steps.push({ step: 'Cancellation Reason', status: 'success', reason: cancellationReason });

        // Stop restaurant branch continuous alarm & send unpinned customer cancellation notification
        backgroundTasks.push(async () => {
          try {
            const branchId = orderData.branchId || 'main_branch';
            const branchStaff = await notificationEngine.resolveBranchStaff(branchId);
            if (branchStaff.length > 0) {
              const stopPayload = { data: { action: 'stop_alert', orderId } } as any;
              await notificationEngine.sendBulk(branchStaff, stopPayload, { category: 'alarm_actionable', priority: 'high', orderId, tag: `order_restaurant_${orderId}`, targetApp: 'restaurant' });
            }
            if (customerFirebaseUid) {
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'cancelled',
                totalAmount: Number(orderData.totalAmount || 0),
                cancellationReason,
              });
              await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'simple_informational', priority: 'high', orderId });
            }
          } catch (e: any) {
            console.error(`[Action][${requestId}] Cancellation notifications failed:`, e.message);
          }
        });

      } else if (action === 'start_cooking') {
        firestoreUpdates.preparingAt = new Date().toISOString();
        backgroundTasks.push(async () => {
          if (customerFirebaseUid) {
            const cPayload = CustomerTemplates.orderUpdate(orderId, {
              orderNumber: shortId,
              status: 'preparing',
              totalAmount: Number(orderData.totalAmount || 0),
            });
            await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
          }
        });

      } else if (action === 'ready') {
        firestoreUpdates.readyAt = new Date().toISOString();
        backgroundTasks.push(async () => {
          if (customerFirebaseUid) {
            const cPayload = CustomerTemplates.orderUpdate(orderId, {
              orderNumber: shortId,
              status: 'ready',
              totalAmount: Number(orderData.totalAmount || 0),
            });
            await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
          }
        });
      }

      const isCancellation = action === 'reject' || action === 'cancel_order';
      responseData = { message: `Order ${
        isCancellation ? 'cancelled' :
        action === 'accept' ? 'accepted' :
        action === 'assign_delivery' ? 'partner assigned' : newStatus}` };
    }

    // ── DELIVERY ACTIONS ───────────────────────────────────────────────────
    else if (userRole === 'delivery' || userRole === 'delivery_partner' || userRole === 'rider' || req.user?.role === 'delivery' || req.user?.role === 'delivery_partner') {
      if (action === 'accept_delivery') {
        // Set/bind delivery partner to order
        firestoreWriteRequired = true;
        firestoreUpdates = { 
          status: 'partner_assigned', 
          deliveryPartnerId: userId, 
          delivery_partner_id: userId,
          updatedAt: new Date(),
          acceptedAt: new Date().toISOString()
        };
        newStatus = 'partner_assigned';
        
        // Delivery partner accepted assignment -> update customer notification
        backgroundTasks.push(async () => {
          try {
            if (customerFirebaseUid) {
              const cPayload = CustomerTemplates.orderUpdate(orderId, {
                orderNumber: shortId,
                status: 'partner_assigned',
                deliveryPartnerName: orderData.deliveryPartnerName || 'Your Delivery Partner',
                totalAmount: Number(orderData.totalAmount || 0),
              });
              await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
            }
          } catch (e: any) {
            console.error(`[Action][${requestId}] Partner accept notification failed:`, e.message);
          }
        });

        responseData = { message: 'Delivery accepted' };
      } else if (action === 'reject_delivery') {
        // Partner declines assignment — mandatory reason required
        if (!reason) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(400).json({ error: 'Rejection reason is mandatory.', requestId });
          return;
        }

        if (orderData.delivery_partner_id !== userId && orderData.deliveryPartnerId !== userId) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(403).json({ error: 'You are not assigned to this order', requestId });
          return;
        }
        if (!['partner_assigned', 'picked_up'].includes(currentStatus)) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(409).json({ error: `Cannot reject delivery with status "${currentStatus}"`, requestId });
          return;
        }

        // Return order to 'ready', unassign partner, record declined partner
        newStatus = 'ready';
        firestoreWriteRequired = true;
        const declinedIds = Array.isArray(orderData.declinedPartnerIds)
          ? [...orderData.declinedPartnerIds, userId]
          : [userId];
        firestoreUpdates = {
          status: newStatus,
          updatedAt: new Date(),
          deliveryPartnerId: null,
          delivery_partner_id: null,
          deliveryPartnerName: null,
          declinedPartnerIds: declinedIds,
          rejectedAt: new Date().toISOString(),
          lastRejectionReason: reason,
        };

        // Notify owners via standard push (non-alarm per spec)
        backgroundTasks.push(async () => {
          try {
            const ownerUids = await notificationEngine.resolveByRole('owner');
            if (ownerUids.length > 0) {
              const rejectPayload = MarketingTemplates.systemAlert({
                title: '🚴 Delivery Partner Declined',
                body: `Order ${shortId} was declined by the delivery partner (${reason}). Please reassign.`,
              });
              await notificationEngine.sendBulk(ownerUids, rejectPayload, { category: 'simple_informational', priority: 'high', orderId });
            }
          } catch (e: any) {
            console.error(`[Action][${requestId}] Owner rider-declined push failed:`, e.message);
          }
        });
        responseData = { message: 'Delivery declined — order returned to ready pool' };

      } else if (action === 'picked_up' || action === 'out_for_delivery' || action === 'pickup_delivery') {
        const allowedFrom = ['partner_assigned', 'ready', 'preparing', 'accepted'];
        if (!allowedFrom.includes(currentStatus)) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(409).json({ error: `Cannot pick up order with status "${currentStatus}". Allowed: [${allowedFrom.join(', ')}]`, requestId });
          return;
        }
        newStatus = 'out_for_delivery';
        firestoreWriteRequired = true;
        firestoreUpdates = { status: newStatus, updatedAt: new Date(), pickedUpAt: new Date().toISOString() };
        
        backgroundTasks.push(async () => {
          if (customerFirebaseUid) {
            const cPayload = CustomerTemplates.orderUpdate(orderId, {
              orderNumber: shortId,
              status: 'out_for_delivery',
              deliveryPartnerName: orderData.deliveryPartnerName || 'Your Delivery Partner',
              totalAmount: Number(orderData.totalAmount || 0),
            });
            await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'pinned_live', priority: 'high', orderId });
          }
        });

        responseData = { message: 'Picked up — out for delivery' };
      } else if (action === 'delivered' || action === 'complete_delivery') {
        const allowedFrom = ['out_for_delivery', 'picked_up', 'partner_assigned', 'ready'];
        if (!allowedFrom.includes(currentStatus)) {
          await releaseOrderLock(orderId);
          lockReleased = true;
          res.status(409).json({ error: `Cannot deliver order with status "${currentStatus}". Allowed: [${allowedFrom.join(', ')}]`, requestId });
          return;
        }
        const { deliveryProof } = req.body;
        newStatus = 'delivered';
        firestoreWriteRequired = true;
        firestoreUpdates = { status: newStatus, updatedAt: new Date(), deliveredAt: new Date().toISOString(), ...(deliveryProof ? { deliveryProof } : {}) };
        
        backgroundTasks.push(async () => {
          if (customerFirebaseUid) {
            const cPayload = CustomerTemplates.orderUpdate(orderId, {
              orderNumber: shortId,
              status: 'delivered',
              deliveryPartnerName: orderData.deliveryPartnerName || 'Your Delivery Partner',
              totalAmount: Number(orderData.totalAmount || 0),
            });
            await notificationEngine.send(customerFirebaseUid, cPayload, { category: 'simple_informational', priority: 'high', orderId });
          }
        });

        responseData = { message: 'Delivered — order complete' };
      } else {
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(400).json({ error: `Unknown delivery action "${action}"`, allowedActions: ['accept_delivery', 'reject_delivery', 'picked_up', 'out_for_delivery', 'delivered'], requestId });
        return;
      }
    }

    // ── SYSTEM ACTIONS ─────────────────────────────────────────────────────
    else if (action === 'stop_alert') {
      try {
        const branchId = (orderData?.branchId || '').trim();
        const franchiseId = (orderData?.franchiseId || '').trim();
        if (branchId) {
          const branchStaff = await notificationEngine.resolveBranchStaff(branchId, franchiseId);
          if (branchStaff.length > 0) {
            const stopPayload = { data: { action: 'stop_alert', orderId } };
            await notificationEngine.sendBulk(branchStaff, stopPayload as any, { category: 'alarm_actionable', priority: 'high', tag: `order_restaurant_stop_${orderId}`, orderId, targetApp: 'restaurant' });
          }
        }
      } catch (e: any) {
        console.error(`[ManualAction] Failed to send stop_alert for ${orderId}:`, e.message);
      }
      await releaseOrderLock(orderId);
      lockReleased = true;
      res.json({ success: true, message: 'Alert stopped', requestId });
      return;
    }

    else {
      await releaseOrderLock(orderId);
      lockReleased = true;
      trace.steps.push({ step: 'Validation', status: 'failed', reason: `Unknown action "${action}" for role "${userRole}"` });
      res.status(400).json({ error: `Unknown action "${action}" for role "${userRole}"`, requestId, trace: isDebug ? trace : undefined });
      return;
    }

    // ── Step 6: SYNCHRONOUS Firestore Write (BEFORE returning HTTP 200) ────
    if (firestoreWriteRequired) {
      try {
        await db.collection('orders').doc(orderId).update(firestoreUpdates);
        trace.steps.push({ step: 'Firestore Write', status: 'success', newStatus, ms: Date.now() - startTime });
        console.log(`[Action][${requestId}] ✅ Firestore write SUCCESS. orderId=${orderId} newStatus=${newStatus} ms=${Date.now() - startTime}`);

        // Automatically free delivery partner back to online/available status
        if (['delivered', 'cancelled', 'rejected'].includes(newStatus)) {
          const partnerId = orderData.deliveryPartnerId || orderData.delivery_partner_id || (userRole === 'delivery' || userRole === 'delivery_partner' ? userId : null);
          if (partnerId) {
            db.collection('users').doc(partnerId).update({
              deliveryStatus: 'online',
              status: 'online',
              assignedOrderId: null,
              activeOrderId: null,
            }).catch(e => console.warn(`[Action] Partner status reset warning: ${e.message}`));
          }
        }
      } catch (firestoreErr: any) {
        console.error(`[Action][${requestId}] ❌ Firestore write FAILED:`, firestoreErr.message);
        trace.steps.push({ step: 'Firestore Write', status: 'failed', error: firestoreErr.message });
        await releaseOrderLock(orderId);
        lockReleased = true;
        res.status(500).json({
          error: 'Order status update failed. Firestore write error.',
          details: firestoreErr.message,
          requestId,
          trace: isDebug ? trace : undefined
        });
        return;
      }
    }

    // ── Step 7: Release Lock ───────────────────────────────────────────────
    await releaseOrderLock(orderId);
    lockReleased = true;

    // ── Step 8: Return HTTP 200 ───────────────────────────────────────────
    trace.processingTime = Date.now() - startTime;
    console.log(`[Action][${requestId}] ✅ HTTP 200 sent. action=${action} newStatus=${newStatus} ms=${trace.processingTime}`);
    res.json({ success: true, newStatus, requestId, ...responseData, trace: isDebug ? trace : undefined });

    // ── Step 9: Background side-effects (AFTER HTTP 200 sent) ─────────────
    if (firestoreWriteRequired && newStatus) {
      backgroundTasks.push(async () => {
        try {
          await orderEventService.emitStatusChange(orderId, newStatus as any, userId);
        } catch (e: any) {
          console.warn(`[Action] emitStatusChange email trigger warning for ${orderId}:`, e.message);
        }
      });
    }

    // Stop the assigned rider's looping assignment alarm whenever this order status is updated
    // by restaurant/owner staff. The push is bound to the exact rider UID and DELIVERY app.
    const assignedRiderUid = String(orderData?.deliveryPartnerId || orderData?.delivery_partner_id || '').trim();
    if (firestoreWriteRequired && assignedRiderUid && action !== 'stop_alert') {
      backgroundTasks.push(async () => {
        const { notificationEngine } = await import('../services/notification/NotificationEngine.js');
        await notificationEngine.send(assignedRiderUid, {
          data: {
            action: 'stop_alert',
            orderId,
            recipientUid: assignedRiderUid,
            reason: 'order_status_updated',
            resultingStatus: String(newStatus || action || '')
          }
        } as any, {
          category: 'alarm_actionable',
          priority: 'high',
          orderId,
          tag: `order_delivery_stop_${orderId}`,
          targetApp: 'delivery',
          eventId: `ORDER_ALERT_STOPPED:${orderId}:${String(newStatus || action || 'updated')}`
        });
      });
    }

    if (backgroundTasks.length > 0) {
      Promise.allSettled(backgroundTasks.map(task =>
        withTimeout(task(), 8000, 'background_task')
      )).then(results => {
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            console.error(`[Action][${requestId}] Background task[${i}] rejected or timed out:`, result.reason);
          }
        });
        console.log(`[Action][${requestId}] Background tasks settled: ${results.filter(r => r.status === 'fulfilled').length} ok, ${results.filter(r => r.status === 'rejected').length} failed`);
      }).catch(err => {
          console.error(`[Action][${requestId}] Background tasks Promise.allSettled error:`, err);
      });
    }

  } catch (error: any) {
    console.error(`[Action][${requestId}] ❌ Unhandled error: ${error.message}`, error.stack);
    trace.steps.push({ step: 'Fatal Error', status: 'failed', error: error.message, stack: error.stack });
    trace.processingTime = Date.now() - startTime;
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', details: error.message, requestId, trace: isDebug ? trace : undefined });
    }
  } finally {
    if (!lockReleased) {
      try {
        await releaseOrderLock(orderId);
      } catch (lockReleaseErr: any) {
        console.error(`[Action][${requestId}] Failed to release lock in finally:`, lockReleaseErr.message);
      }
    }
  }
});

// =============================================================================
// POST /notifications/token
/**
 * Authoritatively determines the safe app name and role by querying PostgreSQL app_users
 * using indexed lookup on user ID and email.
 */
async function resolveAuthorizedAppAndRole(
  userId: string,
  email: string | undefined,
  requestedApp: string | undefined,
  requestedRole: string | undefined
): Promise<{
  safeAppName: string;
  effectiveRole: string;
  branchId: string | null;
  franchiseId: string | null;
}> {
  const rawApp = (requestedApp || '').toLowerCase().trim();
  let candidateApp = rawApp;
  if (candidateApp === 'restaurant_manager') candidateApp = 'restaurant';
  if (candidateApp === 'delivery_partner') candidateApp = 'delivery';
  if (candidateApp === 'franchise_manager') candidateApp = 'franchise';

  const cleanEmail = (email || '').toLowerCase().trim();

  try {
    const userRes = await pgPool.query(
      `SELECT id, email, role, allowed_apps, branch_id, franchise_id, is_active 
       FROM app_users 
       WHERE id = $1 OR (email IS NOT NULL AND email = $2)
       LIMIT 1`,
      [userId, cleanEmail]
    );

    if (userRes.rows.length > 0) {
      const dbUser = userRes.rows[0];
      if (dbUser.is_active === false) {
        return { safeAppName: 'customer', effectiveRole: 'customer', branchId: null, franchiseId: null };
      }

      const allowedApps: string[] = Array.isArray(dbUser.allowed_apps)
        ? dbUser.allowed_apps.map((a: string) => String(a).toUpperCase().trim())
        : [];
      const dbRole = (dbUser.role || '').toLowerCase().trim();
      const isOwner = dbRole === 'owner' || dbRole === 'platform_owner' || allowedApps.includes('OWNER');

      // 1. Restaurant Manager
      if (candidateApp === 'restaurant') {
        const isAllowedRestaurant = isOwner ||
          allowedApps.includes('RESTAURANT_MANAGER') ||
          allowedApps.includes('RESTAURANT') ||
          ['restaurant_manager', 'manager', 'kitchen_staff', 'chef', 'cashier'].includes(dbRole);

        if (isAllowedRestaurant) {
          return {
            safeAppName: 'restaurant',
            effectiveRole: requestedRole || (dbRole === 'restaurant_manager' ? dbRole : 'restaurant_manager'),
            branchId: dbUser.branch_id || 'main_branch',
            franchiseId: dbUser.franchise_id || 'fra_rajnandgaon'
          };
        }
      }

      // 2. POS
      if (candidateApp === 'pos') {
        const isAllowedPos = isOwner ||
          allowedApps.includes('POS') ||
          ['cashier', 'pos_operator', 'restaurant_manager', 'manager'].includes(dbRole);

        if (isAllowedPos) {
          return {
            safeAppName: 'pos',
            effectiveRole: requestedRole || 'cashier',
            branchId: dbUser.branch_id || 'main_branch',
            franchiseId: dbUser.franchise_id || 'fra_rajnandgaon'
          };
        }
      }

      // 3. Delivery
      if (candidateApp === 'delivery') {
        const isAllowedDelivery = isOwner ||
          allowedApps.includes('DELIVERY') ||
          dbRole === 'delivery_partner' || dbRole === 'rider';

        if (isAllowedDelivery) {
          return {
            safeAppName: 'delivery',
            effectiveRole: 'delivery_partner',
            branchId: dbUser.branch_id || 'main_branch',
            franchiseId: dbUser.franchise_id || 'fra_rajnandgaon'
          };
        }

        // Also check delivery_partners table
        const dpCheck = await pgPool.query(
          `SELECT id, branch_id, franchise_id, status FROM delivery_partners 
           WHERE id = $1 OR (email IS NOT NULL AND email = $2) 
           LIMIT 1`,
          [userId, cleanEmail]
        );
        if (dpCheck.rows.length > 0 && dpCheck.rows[0].status === 'APPROVED') {
          return {
            safeAppName: 'delivery',
            effectiveRole: 'delivery_partner',
            branchId: dpCheck.rows[0].branch_id || 'main_branch',
            franchiseId: dpCheck.rows[0].franchise_id || 'fra_rajnandgaon'
          };
        }
      }

      // 4. Franchise
      if (candidateApp === 'franchise') {
        const isAllowedFranchise = isOwner ||
          allowedApps.includes('FRANCHISE_MANAGER') ||
          allowedApps.includes('FRANCHISE') ||
          ['franchise_manager', 'franchise_owner'].includes(dbRole);

        if (isAllowedFranchise) {
          return {
            safeAppName: 'franchise',
            effectiveRole: requestedRole || (dbRole === 'franchise_manager' ? dbRole : 'franchise_manager'),
            branchId: dbUser.branch_id || null,
            franchiseId: dbUser.franchise_id || 'fra_rajnandgaon'
          };
        }
      }

      // 5. Owner
      if (candidateApp === 'owner') {
        if (isOwner) {
          return {
            safeAppName: 'owner',
            effectiveRole: 'owner',
            branchId: null,
            franchiseId: null
          };
        }
      }

      // If user is owner running an unspecified app
      if (isOwner && !candidateApp) {
        return {
          safeAppName: 'owner',
          effectiveRole: 'owner',
          branchId: null,
          franchiseId: null
        };
      }
    }
  } catch (err: any) {
    console.warn('[NotificationRoutes] Database user resolution error:', err?.message);
  }

  return {
    safeAppName: 'customer',
    effectiveRole: 'customer',
    branchId: null,
    franchiseId: null
  };
}

// =============================================================================
// POST /notifications/token — Register FCM Token (Role & App Bound)
// =============================================================================
router.post('/token', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token, oldToken, deviceId, deviceName, platform, browser, appVersion, appName } = req.body;
    const user = req.user!;
    const userId = user.uid;

    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const resolved = await resolveAuthorizedAppAndRole(
      userId,
      user.email,
      appName,
      req.body.role || user.role
    );

    const effectiveBranchId = user.branchId || req.body.branchId || resolved.branchId;
    const effectiveFranchiseId = user.franchiseId || req.body.franchiseId || resolved.franchiseId;

    await notificationQueue.registerToken(userId, token, {
      oldToken,
      deviceId,
      deviceName,
      platform,
      browser,
      appVersion,
      appName: resolved.safeAppName,
      role: resolved.effectiveRole,
      franchiseId: effectiveFranchiseId || undefined,
      branchId: effectiveBranchId || undefined,
      terminalId: user.terminalId || req.body.terminalId
    });
    res.json({ success: true, appName: resolved.safeAppName, role: resolved.effectiveRole });
  } catch (error: any) {
    console.error('[NotificationRoutes] Token registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Alias for frontend compatibility
router.post('/register-token', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token, oldToken, deviceId, deviceName, platform, browser, appVersion, appName } = req.body;
    const user = req.user!;
    const userId = user.uid;

    if (!token) {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const resolved = await resolveAuthorizedAppAndRole(
      userId,
      user.email,
      appName,
      req.body.role || user.role
    );

    const effectiveBranchId = user.branchId || req.body.branchId || resolved.branchId;
    const effectiveFranchiseId = user.franchiseId || req.body.franchiseId || resolved.franchiseId;

    await notificationQueue.registerToken(userId, token, {
      oldToken,
      deviceId,
      deviceName,
      platform,
      browser,
      appVersion,
      appName: resolved.safeAppName,
      role: resolved.effectiveRole,
      franchiseId: effectiveFranchiseId || undefined,
      branchId: effectiveBranchId || undefined,
      terminalId: user.terminalId || req.body.terminalId
    });
    res.json({ success: true, appName: resolved.safeAppName, role: resolved.effectiveRole });
  } catch (error: any) {
    console.error('[NotificationRoutes] Register token error:', error);
    res.status(500).json({ error: error.message });
  }
});


// =============================================================================
// POST /notifications/token/deregister
// =============================================================================
router.post('/token/deregister', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { token } = req.body;
    const userId = req.user!.uid;

    const client = await pgPool.connect();
    try {
      let result;
      if (token && token !== 'all') {
        result = await client.query(
          `UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW()
           WHERE token = $1 AND user_id = $2`,
          [token, userId]
        );
        try {
          const { FieldValue } = await import('firebase-admin/firestore');
          const cryptoMod = await import('crypto');
          const tokenHash = cryptoMod.createHash('sha256').update(token).digest('hex').slice(0, 16);
          await db.collection('users').doc(userId).collection('devices').doc(tokenHash).delete().catch(() => {});
          await db.collection('users').doc(userId).update({
            fcmTokens: FieldValue.arrayRemove(token),
          }).catch(() => {});
        } catch (fsErr: any) {
          console.warn('[TokenDeregister] Firestore arrayRemove failed (non-fatal):', fsErr.message);
        }
      } else {
        result = await client.query(
          `UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW()
           WHERE user_id = $1`,
          [userId]
        );
        try {
          await db.collection('users').doc(userId).update({
            fcmTokens: [],
          }).catch(() => {});
        } catch {}
      }
      console.log(`[TokenDeregister] Deactivated ${result.rowCount} token(s) for user ${userId}`);
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[NotificationRoutes] Token deregistration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// POST /notifications/activity-token (Register iOS ActivityKit APNs Push Token)
// =============================================================================
router.post('/activity-token', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId, token, deviceId } = req.body;
    const userId = req.user!.uid;

    if (!orderId || !token) {
      res.status(400).json({ error: 'orderId and token are required' });
      return;
    }

    // Verify order ownership
    let isOwner = true; // default true if checks pass
    try {
      const canonOrder = await pgPool.query('SELECT user_id, customer_id FROM canonical_orders WHERE id = $1', [orderId]);
      if (canonOrder.rows.length > 0) {
        isOwner = canonOrder.rows[0].user_id === userId || canonOrder.rows[0].customer_id === userId;
      } else {
        const orderSnap = await db.collection('orders').doc(orderId).get();
        if (orderSnap.exists) {
          const d = orderSnap.data() || {};
          isOwner = d.userId === userId || d.customerId === userId || d.customerUid === userId || d.firebaseUid === userId;
        }
      }
    } catch (verErr: any) {
      console.warn('[ActivityToken] Ownership check failed:', verErr.message);
    }

    if (!isOwner) {
      res.status(403).json({ error: 'Not authorized for this order' });
      return;
    }

    // Upsert token in order_activity_tokens
    await pgPool.query(
      `INSERT INTO order_activity_tokens (order_id, user_id, token, device_id, platform, updated_at)
       VALUES ($1, $2, $3, $4, 'ios', NOW())
       ON CONFLICT (order_id, token) DO UPDATE
       SET updated_at = NOW(), device_id = EXCLUDED.device_id`,
      [orderId, userId, token, deviceId || null]
    );

    console.log(`[ActivityToken] Registered Live Activity push token for order ${orderId} (user: ${userId})`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[NotificationRoutes] Activity token registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// DELETE /notifications/activity-token (Deregister iOS ActivityKit Push Token)
// =============================================================================
router.delete('/activity-token', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { orderId, token } = req.body;
    const userId = req.user!.uid;

    if (!orderId) {
      res.status(400).json({ error: 'orderId is required' });
      return;
    }

    if (token) {
      await pgPool.query(
        `DELETE FROM order_activity_tokens WHERE order_id = $1 AND token = $2`,
        [orderId, token]
      );
    } else {
      await pgPool.query(
        `DELETE FROM order_activity_tokens WHERE order_id = $1 AND user_id = $2`,
        [orderId, userId]
      );
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('[NotificationRoutes] Activity token deletion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// POST /notifications/track
// =============================================================================
router.post('/track', async (req: Request, res: Response): Promise<void> => {
  try {
    const { queueId, stage, orderId } = req.body;
    if (!queueId || !stage) {
      res.status(400).json({ error: 'queueId and stage required' });
      return;
    }

    const client = await pgPool.connect();
    try {
      if (stage === 'delivered') {
        await client.query(`UPDATE notification_queue SET status = 'delivered' WHERE id = $1`, [queueId]);
      } else if (stage === 'opened') {
        await client.query(`UPDATE notification_queue SET status = 'opened' WHERE id = $1`, [queueId]);
        if (orderId) {
          await client.query(
            `UPDATE notification_inbox SET is_read = TRUE, read_at = NOW() WHERE tag LIKE $1`,
            [`%${orderId}%`]
          );
        }
      } else if (stage === 'action_performed') {
        await client.query(`UPDATE notification_queue SET status = 'action_performed' WHERE id = $1`, [queueId]);
      }
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET /notifications/inbox
// =============================================================================
router.get('/inbox', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.uid;
    const pgUserId = await getPostgresUserId(userId);
    if (!pgUserId) {
      res.json({ items: [] });
      return;
    }

    const client = await pgPool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM notification_inbox
         WHERE user_id = $1
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY created_at DESC
         LIMIT 100`,
        [pgUserId]
      );
      res.json({ items: result.rows });
    } finally {
      client.release();
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// PATCH /notifications/inbox/:id
// =============================================================================
router.patch('/inbox/:id', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { isRead, isArchived } = req.body;
    const userId = req.user!.uid;
    const pgUserId = await getPostgresUserId(userId);
    if (!pgUserId) { res.status(404).json({ error: 'User not found' }); return; }

    const client = await pgPool.connect();
    try {
      await client.query(
        `UPDATE notification_inbox
         SET is_read = COALESCE($1, is_read),
             is_archived = COALESCE($2, is_archived),
             read_at = CASE WHEN $1 = TRUE AND read_at IS NULL THEN NOW() ELSE read_at END,
             updated_at = NOW()
         WHERE id = $3 AND user_id = $4`,
        [isRead, isArchived, id, pgUserId]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// POST /notifications/send-custom (Owner/Admin/Developer only)
// =============================================================================
router.post('/send-custom', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner', 'restaurant_manager', 'manager', 'franchise_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, body, targetUser, category, couponCode, expiryDate } = req.body;
    const rawAudience = (req.body.targetAudience || req.body.audience || 'customers').toLowerCase();
    const callerRole = (req.user?.role || 'customer').toLowerCase();
    const callerBranchId = req.user?.branchId || req.body.branchId;
    const isRestaurantManager = ['restaurant_manager', 'manager', 'kitchen_staff', 'cashier'].includes(callerRole);

    if (!title || !body) {
      res.status(400).json({ error: 'Title and body are required' });
      return;
    }

    let audience = rawAudience;
    if (audience === 'riders') audience = 'delivery';

    const isReportCategory = category === 'monthly_report' || category === 'report';
    if (isReportCategory && (audience === 'customers' || audience === 'delivery')) {
      res.status(403).json({ error: 'Forbidden: Internal monthly and financial reports cannot be sent to customers or delivery personnel.' });
      return;
    }

    let targetUids: string[] = [];

    if (isRestaurantManager) {
      if (!callerBranchId) {
        res.status(403).json({ error: 'Restaurant staff must have a valid branch assignment to broadcast notifications.' });
        return;
      }

      if (audience === 'customers') {
        const branchOrdersSnap = await db.collection('orders')
          .where('branchId', '==', callerBranchId)
          .limit(250)
          .get();
        const uids = new Set<string>();
        branchOrdersSnap.docs.forEach(d => {
          const u = d.data()?.userId || d.data()?.customerId || d.data()?.customerUid;
          if (u) uids.add(u);
        });
        targetUids = Array.from(uids);
      } else if (audience === 'delivery') {
        const branchRidersSnap = await db.collection('users')
          .where('role', 'in', ['delivery', 'delivery_partner'])
          .where('branchId', '==', callerBranchId)
          .get();
        targetUids = branchRidersSnap.docs.map(d => d.id);
      } else if (audience === 'staff') {
        targetUids = await notificationEngine.resolveBranchStaff(callerBranchId);
      } else {
        // 'all' within this branch
        const staff = await notificationEngine.resolveBranchStaff(callerBranchId);
        const branchRidersSnap = await db.collection('users')
          .where('role', 'in', ['delivery', 'delivery_partner'])
          .where('branchId', '==', callerBranchId)
          .get();
        const riderUids = branchRidersSnap.docs.map(d => d.id);
        const branchOrdersSnap = await db.collection('orders')
          .where('branchId', '==', callerBranchId)
          .limit(250)
          .get();
        const custUids = new Set<string>();
        branchOrdersSnap.docs.forEach(d => {
          const u = d.data()?.userId || d.data()?.customerId || d.data()?.customerUid;
          if (u) custUids.add(u);
        });
        targetUids = Array.from(new Set([...staff, ...riderUids, ...Array.from(custUids)]));
      }
    } else {
      // Owner / Admin / Developer
      const client = await pgPool.connect();
      try {
        if (audience === 'customers') {
          targetUids = await notificationEngine.resolveByRole('customer');
        } else if (audience === 'delivery') {
          targetUids = await notificationEngine.resolveByRole('delivery_partner');
        } else if (audience === 'owners') {
          targetUids = await notificationEngine.resolveByRole('owner');
        } else if (audience === 'staff') {
          targetUids = await notificationEngine.resolveByRole('restaurant_manager');
        } else if (audience === 'specific' && targetUser) {
          const queryStr = String(targetUser).trim();
          if (queryStr.includes('@')) {
            const userSnap = await db.collection('users').where('email', '==', queryStr).limit(1).get();
            if (!userSnap.empty) targetUids = [userSnap.docs[0].id];
          } else {
            targetUids = [queryStr];
          }
        } else {
          const res = await client.query("SELECT DISTINCT user_id as firebase_uid FROM fcm_tokens WHERE is_active = TRUE");
          targetUids = res.rows.map(r => r.firebase_uid);
          if (targetUids.length === 0) {
            const allUsersSnap = await db.collection('users').get();
            targetUids = allUsersSnap.docs.map(d => d.id);
          }
        }
      } finally {
        client.release();
      }
    }

    let payload: any;
    const isAlarmTest = category === 'alarm_actionable' || req.body.priority === 'critical' || req.body.alert === 'continuous';
    const effectiveUrl = req.body.deepLink || req.body.url || '/';
    const imageUrl = req.body.imageUrl || req.body.image;

    if (category === 'coupon' && couponCode) {
      payload = MarketingTemplates.couponAlert({ title, body, couponCode, expiryDate: expiryDate || 'soon' });
    } else if (category === 'announcement') {
      payload = MarketingTemplates.announcement({ title, body, url: effectiveUrl });
    } else if (isAlarmTest) {
      if (audience === 'delivery') {
        payload = DeliveryTemplates.newAssignment(`test_${Date.now()}`, {
          orderNumber: 'TEST-99',
          customerName: 'Test Customer',
          customerPhone: '9999999999',
          deliveryAddress: 'Test Location',
          distance: '1.2 km',
          eta: '10 mins',
          totalAmount: 499,
          paymentMethod: 'ONLINE',
        });
      } else {
        payload = OwnerTemplates.newOrder(`test_${Date.now()}`, {
          customerName: 'Test Customer',
          orderNumber: 'TEST-99',
          totalAmount: 499,
          items: ['1x Test Pizza'],
          paymentMethod: 'ONLINE',
          deliveryAddress: 'Test Location',
          orderTime: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        });
      }
    } else {
      payload = {
        notification: { title, body, ...(imageUrl ? { image: imageUrl } : {}) },
        data: {
          title,
          body,
          url: effectiveUrl,
          deepLink: effectiveUrl,
          category: category || 'marketing',
          source: isRestaurantManager ? 'restaurant_broadcast' : 'owner_broadcast',
          branchId: callerBranchId || undefined,
          ...(imageUrl ? { image: imageUrl } : {})
        },
        ...(imageUrl ? { apns: { fcmOptions: { image: imageUrl } } } : {})
      };
    }

    notificationEngine.sendBulk(targetUids, payload, {
      priority: isAlarmTest ? 'critical' : 'normal',
      category: isAlarmTest ? 'alarm_actionable' : (category || 'marketing'),
    }).catch(err => console.error('[NotificationRoutes] sendBulk failed:', err));

    res.json({ success: true, message: `Dispatched notifications to ${targetUids.length} users` });
  } catch (error: any) {
    console.error('[NotificationRoutes] send-custom error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET /notifications/analytics (Owner/Admin only)
// =============================================================================
router.get('/analytics', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pgPool.connect();
  try {
    const [analytics, queueStats, tokenStats, deliveryLogs, activeOrders] = await Promise.all([
      client.query(
        `SELECT * FROM notification_analytics
         WHERE period_date >= CURRENT_DATE - INTERVAL '7 days'
         ORDER BY period_date DESC, category`
      ),
      client.query(
        `SELECT status, COUNT(*) as count FROM notification_queue GROUP BY status`
      ),
      client.query(
        `SELECT is_active, COUNT(*) as count FROM fcm_tokens GROUP BY is_active`
      ),
      client.query(
        `SELECT id, target_user_id, status, error_message, retry_count, created_at, updated_at 
         FROM notification_queue 
         ORDER BY created_at DESC LIMIT 50`
      ),
      db.collection('orders').where('status', 'not-in', ['delivered', 'completed', 'cancelled']).count().get(),
    ]);

    res.json({
      analytics: analytics.rows,
      queue: queueStats.rows,
      tokens: tokenStats.rows,
      logs: deliveryLogs.rows,
      activeOrders: (activeOrders as admin.firestore.AggregateQuerySnapshot<{ count: admin.firestore.AggregateField<number> }>).data().count || 0,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// =============================================================================
// POST /notifications/preferences
// =============================================================================
router.post('/preferences', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.uid;
    const pgUserId = await getPostgresUserId(userId);
    if (!pgUserId) { res.status(404).json({ error: 'User not found' }); return; }

    const { muteMarketing, muteLowPriority, alwaysReceiveOrders, alwaysReceiveAlerts, quietHoursStart, quietHoursEnd } = req.body;

    const client = await pgPool.connect();
    try {
      await client.query(
        `INSERT INTO notification_preferences (user_id, mute_marketing, mute_low_priority, always_receive_orders, always_receive_alerts, quiet_hours_start, quiet_hours_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET
           mute_marketing = EXCLUDED.mute_marketing,
           mute_low_priority = EXCLUDED.mute_low_priority,
           always_receive_orders = EXCLUDED.always_receive_orders,
           always_receive_alerts = EXCLUDED.always_receive_alerts,
           quiet_hours_start = EXCLUDED.quiet_hours_start,
           quiet_hours_end = EXCLUDED.quiet_hours_end,
           updated_at = NOW()`,
        [pgUserId, muteMarketing ?? false, muteLowPriority ?? false, alwaysReceiveOrders ?? true, alwaysReceiveAlerts ?? true, quietHoursStart, quietHoursEnd]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET /notifications/preferences
// =============================================================================
router.get('/preferences', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.uid;
    const pgUserId = await getPostgresUserId(userId);
    if (!pgUserId) { res.json({ preferences: null }); return; }

    const client = await pgPool.connect();
    try {
      const result = await client.query('SELECT * FROM notification_preferences WHERE user_id = $1', [pgUserId]);
      res.json({ preferences: result.rows[0] || null });
    } finally {
      client.release();
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// POST /notifications/cleanup (Owner/Admin only)
// =============================================================================
router.post('/cleanup', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await notificationQueue.runCleanup();
    res.json({ success: true, message: 'Cleanup complete' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// GET /notifications/debug (Owner/Admin/Developer only)
// =============================================================================
router.get('/debug', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  const pgClient = await pgPool.connect();
  try {
    const queueStatsRes = await pgClient.query(
      `SELECT status, COUNT(*) as count FROM notification_queue GROUP BY status ORDER BY count DESC`
    );
    const queueSize = queueStatsRes.rows.find((r: any) => r.status === 'queued')?.count || 0;
    const failedNotifications = queueStatsRes.rows.find((r: any) => r.status === 'failed')?.count || 0;
    const avgRes = await pgClient.query(
      "SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_sec FROM notification_queue WHERE status = 'sent'"
    );

    res.json({
      queueSize: parseInt(queueSize, 10),
      failedNotifications: parseInt(failedNotifications, 10),
      averageDeliveryTimeSec: parseFloat(avgRes.rows[0]?.avg_sec || '0').toFixed(2),
      queueStatusBreakdown: queueStatsRes.rows,
      environment: process.env.NODE_ENV || 'development',
      serverTime: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[NotificationRoutes] /debug error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    pgClient.release();
  }
});

// =============================================================================
// POST /notifications/test-center (Owner/Developer only)
// =============================================================================
router.post('/test-center', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.uid;
    const { action, targetUserId, delayMs } = req.body;
    let payload: any = {};
    const tag = `test_center_${Date.now()}`;

    const buildPayload = (title: string, body: string, isAlarm: boolean = false) => {
      const p: any = {
        notification: { title, body },
        data: { category: 'test', action: 'test_action' }
      };
      if (isAlarm) {
        p.data.alert = 'continuous';
        p.data.sound = 'order_alert.mp3';
        p.android = { priority: 'high' };
      }
      return p;
    };

    let targetId = targetUserId || userId;

    if (action === 'owner') {
      payload = buildPayload('Test Owner Notification', 'This is a standard push for the owner.');
    } else if (action === 'customer') {
      payload = buildPayload('Test Customer Notification', 'This is a standard push for the customer.');
      payload.data.role = 'customer';
    } else if (action === 'delivery') {
      payload = buildPayload('Test Delivery Notification', 'This is a standard push for the delivery partner.');
      payload.data.role = 'delivery';
    } else if (action === 'alarm') {
      payload = buildPayload('🚨 TEST ALARM 🚨', 'This should trigger the continuous ringtone and WakeLock.', true);
    } else if (action === 'force_email') {
      payload = buildPayload('Email Fallback Test', 'This should fail FCM and fall back to email immediately.');
      payload.data.role = 'customer';
      payload.data.stage = 'update';
      targetId = '00000000-0000-0000-0000-000000000000';
    } else {
      res.status(400).json({ error: 'Unknown test action' });
      return;
    }

    if (delayMs && delayMs > 0) {
      setTimeout(() => {
        notificationEngine.send(targetId, payload, { priority: 'high', tag, category: 'test' }).catch(console.error);
      }, delayMs);
      res.json({ success: true, message: `Scheduled ${action} with ${delayMs}ms delay.` });
    } else {
      await notificationEngine.send(targetId, payload, { priority: 'high', tag, category: 'test' });
      res.json({ success: true, queueId: 'none', message: `Queued ${action} immediately.` });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Diagnostics (Protected: Owner/Admin/Developer only) ───────────────────────
router.get('/diagnostics', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const queueStats = await pgPool.query(`
      SELECT status, COUNT(*) as count
      FROM notification_queue
      GROUP BY status
      ORDER BY status
    `).catch(() => ({ rows: [] }));

    const cacheStats = fcmTokenCache.stats();
    const wsStats = webSocketServer.stats();

    const recentFailed = await pgPool.query(`
      SELECT id, target_user_id, category, retry_count, created_at, updated_at
      FROM notification_queue
      WHERE status = 'failed' OR retry_count > 0
      ORDER BY updated_at DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    res.json({
      timestamp: new Date().toISOString(),
      queue: {
        statusBreakdown: queueStats.rows,
        recentFailed: recentFailed.rows,
      },
      fcmTokenCache: {
        cachedUsers: cacheStats.size,
        ttlMs: 5 * 60 * 1000,
        entries: cacheStats.entries.map(e => ({
          userId: e.userId.slice(0, 8) + '...',
          tokenCount: e.tokenCount,
          ageMs: e.ageMs,
        })),
      },
      webSocket: wsStats,
      health: 'ok',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get broadcast notification audit logs (Protected: Owner/Admin/Developer only) ─
router.get('/history', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logsSnap = await db.collection('notification_logs').orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ docs: [] } as any));
    const logs: any[] = [];
    logsSnap.docs.forEach((d: any) => logs.push({ id: d.id, ...d.data() }));
    res.json({ success: true, logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message, logs: [] });
  }
});

// ─── Broadcast notification (Protected: Owner/Admin/Developer only) ─────────────
router.post('/send', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, body, targetAudience, imageUrl, deepLink } = req.body;
    if (!title || !body) {
      res.status(400).json({ error: 'Title and body required' });
      return;
    }
    
    await db.collection('notification_logs').add({
      title,
      body,
      targetAudience: targetAudience || 'all',
      imageUrl: imageUrl || null,
      deepLink: deepLink || null,
      status: 'sent',
      sentByUid: req.user?.uid,
      sentByEmail: req.user?.email,
      createdAt: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Broadcast dispatched' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
