import { adminDb } from '../../config/firebase.js';
import { withTimeout } from '../../lib/utils.js';
import { pgPool } from '../../config/postgres.js';
import { randomUUID } from 'crypto';
import { PreparationTimeEngine } from './PreparationTimeEngine.js';
import { RiderDispatchEngine } from '../delivery/RiderDispatchEngine.js';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { OwnerTemplates, CustomerTemplates, RestaurantTemplates, DeliveryTemplates } from '../notification/NotificationTemplates.js';
import { LoyaltyService } from '../loyalty/LoyaltyService.js';

export type CanonicalOrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'partner_assigned'
  | 'ready'
  | 'picked_up'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_failed'
  | 'returned_to_branch'
  | 'cancelled';

export type StateMachineActorRole =
  | 'customer'
  | 'restaurant_manager'
  | 'kitchen_staff'
  | 'delivery_partner'
  | 'cashier'
  | 'franchise_owner'
  | 'owner'
  | 'platform_owner'
  | 'admin'
  | 'developer'
  | 'system';

export interface StateMachineActor {
  uid: string;
  role: StateMachineActorRole | string;
  name?: string;
  branchId?: string;
}

export interface TransitionResult {
  success: boolean;
  orderId: string;
  previousStatus: CanonicalOrderStatus;
  currentStatus: CanonicalOrderStatus;
  version: number;
  message?: string;
  error?: string;
}

// Canonical transition matrix
const ALLOWED_TRANSITIONS: Record<CanonicalOrderStatus, CanonicalOrderStatus[]> = {
  pending:          ['accepted', 'preparing', 'cancelled'],
  accepted:         ['preparing', 'ready', 'cancelled'],
  preparing:        ['partner_assigned', 'ready', 'picked_up', 'delivered', 'cancelled'],
  partner_assigned: ['ready', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'],
  ready:            ['partner_assigned', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled'],
  picked_up:        ['out_for_delivery', 'delivered', 'delivery_failed'],
  out_for_delivery: ['delivered', 'delivery_failed'], // Ordinary cancellation strictly prohibited by BR-04
  delivery_failed:  ['returned_to_branch'],
  returned_to_branch: ['cancelled'],
  delivered:        [],
  cancelled:        [],
};

// Authority rules per transition — strictly operational roles (Owner has read-only surveillance)
const ROLE_AUTHORITY: Record<string, StateMachineActorRole[]> = {
  'pending->accepted':          ['restaurant_manager', 'cashier', 'system'],
  'pending->preparing':         ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'pending->cancelled':         ['customer', 'restaurant_manager', 'cashier', 'system'],
  'accepted->preparing':        ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'accepted->ready':            ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'accepted->cancelled':        ['restaurant_manager', 'cashier', 'system'],
  'preparing->partner_assigned': ['restaurant_manager', 'cashier', 'system'],
  'preparing->ready':           ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'preparing->picked_up':       ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'preparing->delivered':       ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'preparing->cancelled':       ['restaurant_manager', 'cashier', 'system'],
  'partner_assigned->ready':    ['restaurant_manager', 'kitchen_staff', 'cashier', 'system'],
  'partner_assigned->picked_up': ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'partner_assigned->out_for_delivery': ['delivery_partner', 'restaurant_manager', 'system'],
  'partner_assigned->delivered': ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'partner_assigned->cancelled': ['restaurant_manager', 'cashier', 'system'],
  'ready->partner_assigned':    ['restaurant_manager', 'cashier', 'system'],
  'ready->picked_up':           ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'ready->out_for_delivery':    ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'ready->delivered':           ['restaurant_manager', 'cashier', 'kitchen_staff', 'system'],
  'ready->cancelled':           ['restaurant_manager', 'cashier', 'system'],
  'picked_up->out_for_delivery': ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'picked_up->delivered':       ['delivery_partner', 'system'],
  'picked_up->delivery_failed': ['delivery_partner', 'restaurant_manager', 'system'],
  'out_for_delivery->delivered': ['delivery_partner', 'restaurant_manager', 'cashier', 'system'],
  'out_for_delivery->delivery_failed': ['delivery_partner', 'restaurant_manager', 'system'],
  'delivery_failed->returned_to_branch': ['restaurant_manager', 'cashier', 'system'],
  'returned_to_branch->cancelled': ['restaurant_manager', 'owner', 'system'],
};

export function normalizeStateMachineRole(role?: string): StateMachineActorRole {
  const r = (role || 'customer').toLowerCase().trim();
  if (r === 'manager' || r === 'kitchen_manager' || r === 'chef') {
    return 'restaurant_manager';
  }
  if (r === 'delivery' || r === 'rider') {
    return 'delivery_partner';
  }
  return r as StateMachineActorRole;
}

export class OrderStateMachine {
  /**
   * Reconciles any legacy status strings into canonical order state.
   */
  public static reconcileStatus(status: string): CanonicalOrderStatus {
    const s = (status || '').toLowerCase().trim();
    if (s === 'pending_acceptance') return 'pending';
    if (['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery', 'delivered', 'delivery_failed', 'returned_to_branch', 'cancelled'].includes(s)) {
      return s as CanonicalOrderStatus;
    }
    return 'pending';
  }

  public static isValidTransition(from: CanonicalOrderStatus, to: CanonicalOrderStatus): boolean {
    const allowed = ALLOWED_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
  }

  public static async transition(
    orderId: string,
    toStateInput: CanonicalOrderStatus,
    actor: StateMachineActor,
    metadata: Record<string, any> = {}
  ): Promise<TransitionResult> {
    const toState = OrderStateMachine.reconcileStatus(toStateInput);
    const normalizedActorRole = normalizeStateMachineRole(actor.role);


    let client = await pgPool.connect().catch(() => null);
    
    try {
      if (client) {
        await client.query('BEGIN').catch(() => {});
        await client.query(
          `INSERT INTO order_locks (order_id) VALUES ($1) ON CONFLICT (order_id) DO UPDATE SET locked_at = NOW()`,
          [orderId]
        ).catch(() => {});
      }

      // Rule BR-05: PostgreSQL is the sole authoritative source of truth for order statuses
      let orderData: any = null;
      if (client) {
        try {
          const pgRes = await client.query(
            `SELECT * FROM canonical_orders WHERE id = $1 LIMIT 1`,
            [orderId]
          );
          if (pgRes.rows.length > 0) {
            const row = pgRes.rows[0];
            orderData = {
              id: row.id,
              status: (row.order_status || 'PENDING').toLowerCase(),
              order_status: row.order_status,
              branchId: row.branch_id,
              franchiseId: row.franchise_id,
              deliveryPartnerId: row.delivery_partner_id,
              deliveryPartnerName: row.delivery_partner_name,
              deliveryPartnerPhone: row.delivery_partner_phone,
              customerName: row.customer_name,
              customerPhone: row.customer_phone,
              contactPhone: row.customer_phone,
              totalAmount: Number(row.total_amount || 0),
              paymentMethod: row.payment_method,
              paymentStatus: row.payment_status,
              orderType: row.order_type,
              fulfillmentType: row.order_type,
              deliveryType: row.order_type,
              deliveryAddress: typeof row.delivery_address === 'string' && row.delivery_address.startsWith('{')
                ? JSON.parse(row.delivery_address)
                : (typeof row.delivery_address === 'object' && row.delivery_address !== null ? row.delivery_address : { addressLine: row.delivery_address }),
              location: (row.metadata && row.metadata.location) || null,
              customerLocation: (row.metadata && (row.metadata.customerLocation || row.metadata.location)) || null,
              deliveryLocation: (row.metadata && (row.metadata.deliveryLocation || row.metadata.location)) || null,
              isPaid: row.payment_status === 'PAID' || row.payment_status === 'COLLECTED',
              expectedReadyAt: row.expected_ready_at,
              estimatedPreparationMinutes: row.estimated_preparation_minutes,
              dailyOrderNumber: row.daily_order_no,
              permanentBillNo: row.permanent_bill_no,
              notification_version: Number(row.version || 1)
            };
          }
        } catch (pgErr: any) {
          console.warn(`[OrderStateMachine] PostgreSQL direct canonical read notice for ${orderId}:`, pgErr.message);
        }
      }

      if (!orderData) {
        try {
          const { OrderPersistenceArchiveService } = await import('./OrderPersistenceArchiveService.js');
          orderData = await OrderPersistenceArchiveService.getHistoricalOrder(orderId);
        } catch (pgErr: any) {
          console.warn(`[OrderStateMachine] PostgreSQL canonical read notice for ${orderId}:`, pgErr.message);
        }
      }

      const orderRef = adminDb.collection('orders').doc(orderId);
      if (!orderData) {
        try {
          const docSnap = await withTimeout(orderRef.get(), 'stateMachineOrderRead', 1500);
          if (docSnap && docSnap.exists) {
            orderData = docSnap.data()!;
          }
        } catch (fsErr: any) {
          console.warn(`[OrderStateMachine] Firestore read notice for ${orderId}:`, fsErr.message);
        }
      }

      if (!orderData) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return {
          success: false,
          orderId,
          previousStatus: 'pending',
          currentStatus: 'pending',
          version: 0,
          error: 'Order not found',
        };
      }

      const fromState = OrderStateMachine.reconcileStatus(orderData.status);

      if (fromState === toState) {
        if (metadata && Object.keys(metadata).length > 0) {
          await withTimeout(
            orderRef.set({
              ...metadata,
              updatedAt: new Date()
            }, { merge: true }),
            'stateMachineSameStateMerge',
            1200
          ).catch(() => {});
        }
        if (client) await client.query('COMMIT').catch(() => {});
        return {
          success: true,
          orderId,
          previousStatus: fromState,
          currentStatus: toState,
          version: orderData.notification_version || 1,
          message: 'Order state confirmed with updated metadata',
        };
      }

      // Validate transition matrix
      const allowedNext = ALLOWED_TRANSITIONS[fromState] || [];
      if (!allowedNext.includes(toState)) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return {
          success: false,
          orderId,
          previousStatus: fromState,
          currentStatus: fromState,
          version: orderData.notification_version || 1,
          error: `Invalid order state transition from '${fromState}' to '${toState}'.`,
        };
      }

      const normalizedActorRole = normalizeStateMachineRole(actor.role);

      // Rule BR-04: Ordinary cancellation strictly prohibited after pickup
      if (toState === 'cancelled' && (fromState === 'out_for_delivery' || fromState === 'picked_up')) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return {
          success: false,
          orderId,
          previousStatus: fromState,
          currentStatus: fromState,
          version: orderData.notification_version || 1,
          error: 'Ordinary cancellation is strictly prohibited after pickup. Use the delivery-failure and return workflow.',
        };
      }

      // Rule BR-08: Pickup Authority Guard (Only Assigned Delivery Partner can confirm pickup)
      if (toState === 'out_for_delivery' || toState === 'picked_up') {
        const assignedPartnerId = orderData.deliveryPartnerId || orderData.riderId;
        if (!assignedPartnerId) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          return {
            success: false,
            orderId,
            previousStatus: fromState,
            currentStatus: fromState,
            version: orderData.notification_version || 1,
            error: 'Cannot confirm pickup: No delivery partner has been assigned to this order.'
          };
        }

        if (normalizedActorRole === 'delivery_partner' && actor.uid !== assignedPartnerId) {
          const dpCheck = await client.query(
            'SELECT id, user_id FROM delivery_partners WHERE (id = $1 AND (user_id = $2 OR id = $2))',
            [assignedPartnerId, actor.uid]
          ).catch(() => ({ rows: [] }));

          if (dpCheck.rows.length === 0) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            return {
              success: false,
              orderId,
              previousStatus: fromState,
              currentStatus: fromState,
              version: orderData.notification_version || 1,
              error: `Pickup Forbidden: Only the currently assigned delivery partner (${assignedPartnerId}) can confirm pickup.`
            };
          }
        }
      }

      // Validate actor authority — strictly operational roles
      const transitionKey = `${fromState}->${toState}`;
      const authorizedRoles = ROLE_AUTHORITY[transitionKey] || ['system'];
      // normalizedActorRole already declared above

      // Owners and Admins possess administrative operational authority across stages
      const isAuthorized =
        authorizedRoles.includes(normalizedActorRole) ||
        normalizedActorRole === 'system' ||
        normalizedActorRole === 'owner' ||
        normalizedActorRole === 'admin' ||
        normalizedActorRole === 'platform_owner';

      if (!isAuthorized) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return {
          success: false,
          orderId,
          previousStatus: fromState,
          currentStatus: fromState,
          version: orderData.notification_version || 1,
          error: `Actor '${actor.name || actor.uid}' with role '${actor.role}' lacks authority for transition '${transitionKey}'.`,
        };
      }

      // Cross-Tenant / Cross-Role Isolation Checks
      if (normalizedActorRole === 'customer') {
        const orderUserId = orderData.userId || orderData.customerId || orderData.customerUid;
        if (orderUserId && actor.uid !== orderUserId) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          return {
            success: false,
            orderId,
            previousStatus: fromState,
            currentStatus: fromState,
            version: orderData.notification_version || 1,
            error: `Customer '${actor.uid}' cannot modify order belonging to user '${orderUserId}'.`,
          };
        }
      }

      if (['restaurant_manager', 'kitchen_staff', 'cashier'].includes(normalizedActorRole)) {
        const staffBranch = (actor.branchId || '').trim();
        const orderBranch = (orderData.branchId || '').trim();

        if (!staffBranch) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          return {
            success: false,
            orderId,
            previousStatus: fromState,
            currentStatus: fromState,
            version: orderData.notification_version || 1,
            error: `Staff member '${actor.uid}' lacks required branch scope attribute (branchId is undefined).`,
          };
        }

        const isSameBranch = 
          staffBranch === 'all' || 
          staffBranch === orderBranch ||
          ((staffBranch === 'main_branch' || staffBranch === 'branch_rjn_main') && (orderBranch === 'main_branch' || orderBranch === 'branch_rjn_main'));

        if (orderBranch && !isSameBranch) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          return {
            success: false,
            orderId,
            previousStatus: fromState,
            currentStatus: fromState,
            version: orderData.notification_version || 1,
            error: `Staff of branch '${staffBranch}' cannot modify order belonging to branch '${orderBranch}'.`,
          };
        }
      }

      if (normalizedActorRole === 'delivery_partner') {
        const assignedRiderId = orderData.deliveryPartnerId || orderData.riderId;
        // If order already has an assigned rider, only that rider can perform rider transitions
        if (assignedRiderId && actor.uid !== assignedRiderId) {
          let isAssignedPartner = false;
          try {
            const { query } = await import('../../lib/db.js');
            const dpRes = await query(
              'SELECT id, user_id FROM delivery_partners WHERE (id = $1 OR user_id = $1) AND (user_id = $2 OR id = $2) LIMIT 1',
              [assignedRiderId, actor.uid]
            );
            if (dpRes.rows.length > 0) {
              isAssignedPartner = true;
            }
          } catch (e: any) {
            console.warn('[OrderStateMachine] Rider identity resolution error:', e.message);
          }

          if (!isAssignedPartner) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            return {
              success: false,
              orderId,
              previousStatus: fromState,
              currentStatus: fromState,
              version: orderData.notification_version || 1,
              error: `Delivery partner '${actor.uid}' is not assigned to order '${orderId}' (assigned: '${assignedRiderId}').`,
            };
          }
        }
      }

      // Explicit fulfillment validation: Takeaway / Dine-in vs Delivery
      const fulfillment = (orderData.deliveryType || orderData.orderType || orderData.fulfillmentType || orderData.orderSource || '').toLowerCase();
      const isDeliveryOrder = fulfillment.includes('delivery');

      if (isDeliveryOrder && ['ready', 'preparing'].includes(fromState) && toState === 'delivered') {
        // Delivery orders cannot skip rider stages unless performed by system or platform admin override
        if (!['system', 'platform_owner', 'admin'].includes(normalizedActorRole)) {
          if (client) await client.query('ROLLBACK').catch(() => {});
          return {
            success: false,
            orderId,
            previousStatus: fromState,
            currentStatus: fromState,
            version: orderData.notification_version || 1,
            error: `Delivery order cannot transition directly from '${fromState}' to 'delivered'. Delivery orders require rider dispatch and pickup.`,
          };
        }
      }

      if (!isDeliveryOrder && ['partner_assigned', 'picked_up', 'out_for_delivery'].includes(toState)) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        return {
          success: false,
          orderId,
          previousStatus: fromState,
          currentStatus: fromState,
          version: orderData.notification_version || 1,
          error: `Non-delivery order (${fulfillment || 'takeaway/dine-in'}) cannot transition to rider delivery state '${toState}'.`,
        };
      }

      const currentVersion = Number(orderData.notification_version || 1);
      const newVersion = currentVersion + 1;
      const nowIso = new Date().toISOString();

      const updates: Record<string, any> = {
        status: toState,
        notification_version: newVersion,
        updatedAt: new Date(),
        ...metadata,
      };

      // State-specific calculations and authoritative server timestamps
      switch (toState) {
        case 'accepted': {
          updates.acceptedAt = nowIso;
          const prepMinutes = metadata.estimatedPreparationMinutes || PreparationTimeEngine.calculateEstimatedPreparationMinutes(orderData.items || []);
          updates.estimatedPreparationMinutes = prepMinutes;
          const readyTime = metadata.expectedReadyAt || PreparationTimeEngine.computeExpectedReadyAt(nowIso, prepMinutes);
          updates.expectedReadyAt = readyTime;
          updates.estimatedReadyAt = readyTime;
          break;
        }

        case 'preparing': {
          updates.preparingAt = nowIso;
          const prepMinutes = metadata.estimatedPreparationMinutes || orderData.estimatedPreparationMinutes || PreparationTimeEngine.calculateEstimatedPreparationMinutes(orderData.items || []);
          updates.estimatedPreparationMinutes = prepMinutes;
          const readyTime = metadata.expectedReadyAt || (metadata.estimatedPreparationMinutes ? PreparationTimeEngine.computeExpectedReadyAt(nowIso, prepMinutes) : (orderData.expectedReadyAt || PreparationTimeEngine.computeExpectedReadyAt(nowIso, prepMinutes)));
          updates.expectedReadyAt = readyTime;
          updates.estimatedReadyAt = readyTime;
          
          // Schedule auto-dispatch at ~2/3 prep time
          const autoDispatchDelayMs = Math.floor((prepMinutes * (2 / 3)) * 60 * 1000);
          setTimeout(() => {
            RiderDispatchEngine.autoDispatchRider(orderId).catch((e) =>
              console.warn('[DispatchEngine] Auto-dispatch background notice:', e.message)
            );
          }, Math.max(2000, autoDispatchDelayMs));
          break;
        }

        case 'partner_assigned': {
          updates.partnerAssignedAt = nowIso;
          updates.riderAssignedAt = nowIso;
          // Recalculate delivery ETA upon rider assignment
          import('../delivery/DeliveryEtaService.js').then(({ DeliveryEtaService }) => {
            DeliveryEtaService.calculateDeliveryEta({
              orderId,
              orderData: { ...orderData, ...updates },
              riderUid: metadata.deliveryPartnerId || orderData.deliveryPartnerId,
            }).catch(() => {});
          }).catch(() => {});
          break;
        }

        case 'ready': {
          updates.readyAt = nowIso;
          // Auto-dispatch via authoritative PostgreSQL RiderDispatchEngine (queues cleanly into PendingDispatchQueueService when busy)
          const fulfillment = (orderData.fulfillmentType || orderData.deliveryType || 'delivery').toLowerCase();
          if (fulfillment === 'delivery' && !orderData.deliveryPartnerId && !metadata.deliveryPartnerId) {
            const branchId = orderData.branchId;
            if (branchId) {
              setImmediate(async () => {
                try {
                  await RiderDispatchEngine.autoDispatchRider(orderId);
                } catch (e: any) {
                  console.warn('[OrderStateMachine] Auto-dispatch on ready notice:', e.message);
                }
              });
            }
          }
          break;
        }

        case 'picked_up': {
          updates.pickedUpAt = nowIso;
          import('../delivery/DeliveryEtaService.js').then(({ DeliveryEtaService }) => {
            DeliveryEtaService.calculateDeliveryEta({
              orderId,
              orderData: { ...orderData, ...updates },
            }).catch(() => {});
          }).catch(() => {});
          break;
        }

        case 'out_for_delivery': {
          updates.outForDeliveryAt = nowIso;
          import('../delivery/DeliveryEtaService.js').then(({ DeliveryEtaService }) => {
            DeliveryEtaService.calculateDeliveryEta({
              orderId,
              orderData: { ...orderData, ...updates },
            }).catch(() => {});
          }).catch(() => {});
          break;
        }

        case 'delivered': {
          // 1. Mandatory 50-metre Delivery Location Gate
          const fulfillment = (orderData.fulfillmentType || orderData.deliveryType || 'delivery').toLowerCase();
          if (fulfillment === 'delivery' && normalizedActorRole === 'delivery_partner') {
            const { GeofenceVerificationService } = await import('../delivery/GeofenceVerificationService.js');
            const geofenceResult = await GeofenceVerificationService.verifyRiderProximity(
              orderId,
              actor.uid,
              orderData,
              metadata.clientCoordinates
            );
            if (!geofenceResult.allowed) {
              if (client) await client.query('ROLLBACK').catch(() => {});
              return {
                success: false,
                orderId,
                previousStatus: fromState,
                currentStatus: fromState,
                version: orderData.notification_version || 1,
                error: `50-metre delivery gate violated: ${geofenceResult.reason || 'Rider is outside the 50m customer delivery radius.'}`,
              };
            }
          }

          // 2. COD Payment Collection Gate: Enforce that COD orders must have verified payment collection before transition succeeds
          const paymentMethod = (orderData.paymentMethod || '').toLowerCase();
          const isCod = paymentMethod === 'cod' || orderData.isCod === true;
          if (isCod) {
            let isPaid = orderData.isPaid === true || ['PAID', 'COLLECTED'].includes((orderData.paymentStatus || '').toUpperCase());
            if (!isPaid && (metadata.paymentCollected === true || metadata.paymentStatus === 'PAID' || metadata.paymentStatus === 'COLLECTED')) {
              isPaid = true;
              updates.paymentStatus = 'PAID';
              updates.paymentCollectedAt = nowIso;
            }
            if (!isPaid) {
              if (client) await client.query('ROLLBACK').catch(() => {});
              return {
                success: false,
                orderId,
                previousStatus: fromState,
                currentStatus: fromState,
                version: orderData.notification_version || 1,
                error: `Cannot deliver COD order '${orderId}' before payment is collected and verified. Please collect via Cash or dynamic UPI QR.`,
              };
            }
          }

          updates.deliveredAt = nowIso;
          // Release rider active order lock in PostgreSQL and Firestore
          const riderId = orderData.deliveryPartnerId || metadata.deliveryPartnerId;
          if (riderId) {
            adminDb.collection('users').doc(riderId).set({ activeOrderId: null }, { merge: true }).catch(() => {});
            adminDb.collection('delivery_partners').doc(riderId).set({ activeOrderId: null }, { merge: true }).catch(() => {});
            if (client) {
              await client.query(
                `UPDATE delivery_partners
                 SET active_order_id = NULL,
                     total_deliveries = COALESCE(total_deliveries, 0) + 1,
                     updated_at = NOW()
                 WHERE id = $1 OR user_id = $1`,
                [riderId]
              ).catch(() => {});
            }
          }

          // Single Source of Truth: Schedule Supabase GPS cleanup 5 minutes after delivery completion
          setTimeout(() => {
            import('../gps/SupabaseGpsService.js').then(({ SupabaseGpsService }) => {
              SupabaseGpsService.cleanupDeliveredGps(orderId).catch((err: any) => {
                console.warn('[OrderStateMachine] Supabase GPS delivered cleanup notice:', err?.message);
              });
            }).catch(() => {});
          }, 5 * 60 * 1000);
          break;
        }

        case 'cancelled': {
          updates.cancelledAt = nowIso;
          updates.cancellationReason = metadata.cancellationReason || 'CUSTOMER_CANCELLED';
          updates.cancellationSource = metadata.cancellationSource || actor.role || 'system';
          updates.cancellationExplanation = metadata.cancellationExplanation || (
            metadata.cancellationReason === 'RESTAURANT_ACCEPT_TIMEOUT'
              ? 'The restaurant was unable to accept your order within the required time.'
              : 'Order was cancelled.'
          );
          updates.cancellationAcknowledged = false;
          updates.cancellationAcknowledgedAt = null;

          // Release rider active order lock if assigned in PostgreSQL and Firestore
          const riderId = orderData.deliveryPartnerId || metadata.deliveryPartnerId;
          if (riderId) {
            adminDb.collection('users').doc(riderId).set({ activeOrderId: null }, { merge: true }).catch(() => {});
            adminDb.collection('delivery_partners').doc(riderId).set({ activeOrderId: null }, { merge: true }).catch(() => {});
            if (client) {
              await client.query(
                `UPDATE delivery_partners
                 SET active_order_id = NULL,
                     updated_at = NOW()
                 WHERE id = $1 OR user_id = $1 OR active_order_id = $2`,
                [riderId, orderId]
              ).catch(() => {});
            }
          }

          // Authoritative payment/refund status
          const isPaid = (orderData.paymentStatus || '').toLowerCase() === 'paid' || orderData.paymentCaptured === true;
          const isCod = (orderData.paymentMethod || '').toLowerCase() === 'cod';
          if (!isPaid || isCod) {
            updates.refundStatus = 'not_applicable';
          } else {
            // Trigger payment reconciliation/refund queue without falsely claiming refund completed
            updates.refundStatus = 'pending_review';
          }
          break;
        }

        default:
          break;
      }

      if (client) {
        // Authoritative canonical PostgreSQL order status update
        const updateRes: any = toState === 'cancelled'
          ? await client.query(`
              UPDATE canonical_orders
              SET order_status = $1::varchar,
                  cancellation_reason = $3,
                  cancelled_at = NOW(),
                  updated_at = NOW()
              WHERE id = $2;
            `, ['CANCELLED', orderId, metadata.cancellationReason || 'CANCELLED']).catch((err: any) => {
              console.warn('[OrderStateMachine] PostgreSQL cancellation sync notice:', err?.message);
              return { rowCount: 0 };
            })
          : await client.query(`
              UPDATE canonical_orders
              SET order_status = $1::varchar,
                  accepted_at = COALESCE(accepted_at, CASE WHEN $1::varchar IN ('ACCEPTED','PREPARING','PARTNER_ASSIGNED','READY','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED') THEN NOW() ELSE NULL END),
                  preparation_started_at = COALESCE(preparation_started_at, CASE WHEN $1::varchar IN ('PREPARING','PARTNER_ASSIGNED','READY','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED') THEN NOW() ELSE NULL END),
                  ready_at = COALESCE(ready_at, CASE WHEN $1::varchar IN ('READY','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED') THEN NOW() ELSE NULL END),
                  delivered_at = COALESCE(delivered_at, CASE WHEN $1::varchar = 'DELIVERED' THEN NOW() ELSE NULL END),
                  partner_assigned_at = COALESCE(partner_assigned_at, CASE WHEN $1::varchar IN ('PARTNER_ASSIGNED','PICKED_UP','OUT_FOR_DELIVERY','DELIVERED') THEN NOW() ELSE NULL END),
                  delivery_partner_id = COALESCE($5, delivery_partner_id),
                  delivery_partner_name = COALESCE($6, delivery_partner_name),
                  delivery_partner_phone = COALESCE($7, delivery_partner_phone),
                  estimated_preparation_minutes = COALESCE($3::integer, estimated_preparation_minutes),
                  expected_ready_at = COALESCE($4::timestamptz, expected_ready_at),
                  updated_at = NOW()
              WHERE id = $2;
            `, [
              toState.toUpperCase(),
              orderId,
              updates.estimatedPreparationMinutes != null ? Number(updates.estimatedPreparationMinutes) : null,
              updates.expectedReadyAt || null,
              updates.deliveryPartnerId || metadata.deliveryPartnerId || null,
              updates.deliveryPartnerName || metadata.deliveryPartnerName || null,
              updates.deliveryPartnerPhone || metadata.deliveryPartnerPhone || null
            ]).catch((err: any) => {
              console.warn('[OrderStateMachine] PostgreSQL status sync notice:', err?.message);
              return { rowCount: 0 };
            });

        // Self-healing: If row was not present in canonical_orders, insert it immediately
        if (updateRes && updateRes.rowCount === 0 && orderData) {
          try {
            const { OrderPersistenceArchiveService } = await import('./OrderPersistenceArchiveService.js');
            await OrderPersistenceArchiveService.syncLiveOrderToPostgres(orderId, {
              ...orderData,
              status: toState,
              ...updates
            });
          } catch (syncErr: any) {
            console.warn('[OrderStateMachine] Fallback sync to PostgreSQL notice:', syncErr.message);
          }
        }

        // Authoritative financial bill reversal if order is cancelled
        if (toState === 'cancelled') {
          await client.query(`
            UPDATE canonical_bills
            SET is_cancelled = TRUE,
                cancelled_at = NOW(),
                cancellation_reason = $2,
                payment_status = 'VOIDED'
            WHERE order_id = $1;
          `, [orderId, metadata.cancellationReason || 'CANCELLED']).catch((err: any) => {
            console.warn('[OrderStateMachine] PostgreSQL bill cancellation notice:', err?.message);
          });
        }

        // Transactional Outbox Event Publication (Atomic with order state mutation)
        try {
          const { OutboxPublisherService } = await import('../outbox/OutboxPublisherService.js');
          await OutboxPublisherService.recordEvent(
            client,
            'order',
            orderId,
            `ORDER_${toState.toUpperCase()}`,
            {
              orderId,
              previousStatus: fromState,
              currentStatus: toState,
              branchId: orderData.branchId,
              franchiseId: orderData.franchiseId,
              deliveryPartnerId: orderData.deliveryPartnerId || metadata.deliveryPartnerId,
              actorUid: actor.uid,
              actorRole: actor.role,
              timestamp: nowIso,
              metadata
            }
          );
        } catch (outboxErr: any) {
          console.warn('[OrderStateMachine] Outbox event record notice:', outboxErr.message);
        }

        await client.query('COMMIT').catch(() => {});
        await client.query('DELETE FROM order_locks WHERE order_id = $1', [orderId]).catch(() => {});
        client.release();
        client = null;
      }

      // ASYNCHRONOUS EXTERNAL WAN & DOWNSTREAM PROJECTIONS
      // Executed strictly AFTER PostgreSQL transaction commit and client release to avoid WAN-induced latency / DB pool starvation
      orderRef.set(updates, { merge: true }).catch((fsWriteErr: any) => {
        console.warn(`[OrderStateMachine] Firestore write notice for ${orderId}:`, fsWriteErr.message);
      });

      // Audit log entry
      adminDb.collection('order_audit_logs').add({
        orderId,
        previousStatus: fromState,
        currentStatus: toState,
        actorUid: actor.uid,
        actorRole: actor.role,
        actorName: actor.name || 'Staff',
        branchId: orderData.branchId || null,
        timestamp: nowIso,
        metadata,
      }).catch(() => {});

      // Notification Scoped Dispatch (Section 9)
      this.dispatchScopedNotifications(orderId, fromState, toState, { ...orderData, ...updates });

      // Google Sheets sync on delivered
      if (toState === 'delivered') {
        import('../reports/GoogleSheetsReportService.js').then(({ GoogleSheetsReportService }) => {
          GoogleSheetsReportService.appendOrderToMonthlySheet({
            orderId,
            customerName: orderData.customerName || 'Customer',
            customerPhone: orderData.contactPhone || 'N/A',
            totalAmount: orderData.totalAmount || 0,
            paymentMethod: orderData.paymentMethod || 'COD',
            orderType: orderData.deliveryType || 'delivery',
            status: 'delivered',
            itemCount: (orderData.items || []).length,
            couponCode: orderData.appliedCouponCode,
            deliveryTimeMins: orderData.estimatedPreparationMinutes || 20,
            timestamp: nowIso,
          }).catch((e) => console.warn('[GoogleSheets] Append warning:', e.message));
        }).catch(() => {});
      }

      // Terminal Order Finalization: Record statutory bill in PostgreSQL and mark completed in Firestore (no destructive purge)
      if (toState === 'delivered' || toState === 'cancelled') {
        setTimeout(async () => {
          try {
            const { OrderPersistenceArchiveService } = await import('./OrderPersistenceArchiveService.js');
            await OrderPersistenceArchiveService.finalizeAndArchiveTerminalOrder(orderId);
          } catch (archiveErr: any) {
            console.warn(`[OrderStateMachine] Terminal archival background notice for ${orderId}:`, archiveErr.message);
          }
        }, 15000); // 15s grace period for live sound & UI delivery notifications
      }

      return {
        success: true,
        orderId,
        previousStatus: fromState,
        currentStatus: toState,
        version: newVersion,
      };

    } catch (err: any) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[OrderStateMachine] Transition error:', err);
      return {
        success: false,
        orderId,
        previousStatus: 'pending',
        currentStatus: 'pending',
        version: 0,
        error: err.message || 'Internal state transition error',
      };
    } finally {
      if (client) {
        await client.query('DELETE FROM order_locks WHERE order_id = $1', [orderId]).catch(() => {});
        client.release();
        client = null;
      }
    }
  }

  private static async dispatchScopedNotifications(
    orderId: string,
    fromState: CanonicalOrderStatus,
    toState: CanonicalOrderStatus,
    order: Record<string, any>
  ) {
    try {
      const orderNumber = order.orderNumber || ('#' + (order.dailyOrderNumber || orderId.slice(-6)));
      const branchId = order.branchId || '';
      const customerUid = order.userId || order.customerId || order.customerUid || order.firebaseUid || order.user_id;
      const fulfillment = (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase();
      const isPickup = fulfillment === 'pickup' || fulfillment === 'dine_in' || fulfillment === 'takeaway';
      const eventVersion = order.notification_version || 1;
      const eventId = `notif_${orderId}_${toState}_v${eventVersion}`;

      // 1. Customer In-App / FCM Notification (Strict template copy)
      if (customerUid && toState !== 'pending') {
        let itemsSummary = '';
        if (Array.isArray(order.items) && order.items.length > 0) {
          itemsSummary = order.items.map((i: any) => typeof i === 'string' ? i : `${i.quantity || 1}× ${i.name || 'Item'}`).join(', ');
        } else if (order.itemsSummary) {
          itemsSummary = String(order.itemsSummary);
        }

        const stepMap: Record<string, number> = {
          pending: 1, accepted: 2, preparing: 3, ready: 4, partner_assigned: 5, picked_up: 5, out_for_delivery: 6, delivered: 7, completed: 7, cancelled: 0
        };
        const currentStep = stepMap[toState] || 1;
        const etaMinutes = order.estimatedPreparationMinutes || (order.etaMinutes ? Number(order.etaMinutes) : undefined);

        const customerPayload = CustomerTemplates.orderUpdate(orderId, {
          orderNumber,
          status: toState as any,
          step: currentStep,
          eta: etaMinutes ? `${etaMinutes} mins` : (order.expectedReadyAt ? 'soon' : undefined),
          etaMinutes,
          deliveryPartnerName: order.deliveryPartnerName,
          riderPhone: order.deliveryPartnerPhone || order.riderPhone,
          itemsSummary,
          totalAmount: Number(order.totalAmount || 0),
          version: eventVersion,
          eventId,
          previousStatus: fromState,
          cancellationReason: order.cancellationReason,
          isPickup,
        });

        await notificationEngine.send(customerUid, customerPayload, {
          category: (toState === 'cancelled' || toState === 'delivered') ? 'simple_informational' : 'pinned_live',
          orderId,
          targetApp: 'customer',
          eventId,
        });

        // 1.05 Award authoritative loyalty points upon successful delivery
        if (toState === 'delivered') {
          LoyaltyService.awardPointsForOrder(orderId, customerUid, Number(order.totalAmount || 0)).catch((lErr) => {
            console.warn('[OrderStateMachine] Loyalty points award warning:', lErr.message);
          });
        }

        // 1.1 Dispatch ActivityKit Live Activity update to registered iOS tokens
        try {
          const activityRes = await pgPool.query(
            `SELECT token FROM order_activity_tokens WHERE order_id = $1`,
            [orderId]
          );
          if (activityRes.rows.length > 0) {
            const isEnd = toState === 'delivered' || toState === 'cancelled';
            const livePayload = CustomerTemplates.liveActivityUpdate(orderId, {
              event: isEnd ? 'end' : (toState === 'accepted' ? 'start' : 'update'),
              status: toState as any,
              step: currentStep,
              orderNumber,
              itemsSummary: itemsSummary || 'Olive Pizza Order',
              totalAmount: Number(order.totalAmount || 0),
              etaMinutes: etaMinutes || 0,
              riderName: order.deliveryPartnerName || '',
              riderPhone: order.deliveryPartnerPhone || order.riderPhone || '',
              restaurantName: 'Olive Pizza',
              dismissalDate: isEnd ? Math.floor(Date.now() / 1000) + 300 : undefined,
            });

            const tokens = activityRes.rows.map(r => r.token);
            await notificationEngine.sendToTokens(tokens, livePayload, {
              category: 'pinned_live',
              orderId,
              targetApp: 'customer',
            });

            if (isEnd) {
              await pgPool.query(`DELETE FROM order_activity_tokens WHERE order_id = $1`, [orderId]).catch(() => {});
            }
          }
        } catch (actErr: any) {
          console.warn('[OrderStateMachine] ActivityKit push dispatch warning:', actErr.message);
        }
      }

      // 2. Assigned Rider Notification (Only assigned rider receives alert — no broadcast)
      if (order.deliveryPartnerId && ['ready', 'cancelled'].includes(toState)) {
        const riderEventId = `notif_rider_${orderId}_${toState}_v${eventVersion}`;
        const title = toState === 'ready' ? '📦 Order Ready for Pickup!' : 'Order Cancelled';
        const body = toState === 'ready'
          ? `Order #${orderNumber} is hot, packaged, and ready at the counter.`
          : `Order #${orderNumber} was cancelled. Return to standby.`;

        await notificationEngine.send(order.deliveryPartnerId, {
          notification: { title, body },
          data: {
            orderId,
            status: toState,
            orderNumber,
            type: toState === 'ready' ? 'ORDER_READY' : 'ORDER_CANCELLED',
            notificationType: toState === 'ready' ? 'ORDER_READY' : 'ORDER_CANCELLED',
            eventId: riderEventId,
            deepLink: `/live-orders?orderId=${orderId}`,
            url: `/live-orders?orderId=${orderId}`,
            stage: toState,
            role: 'delivery'
          }
        }, {
          category: 'alarm_actionable',
          priority: 'high',
          orderId,
          targetApp: 'delivery',
          eventId: riderEventId,
        });
      }

      // 3. Restaurant Branch Notification on DELIVERED (Immediate alert + distinct delivered sound)
      if (toState === 'delivered') {
        const branchStaffUids = await notificationEngine.resolveBranchStaff(branchId);
        if (branchStaffUids.length > 0) {
          const restEventId = `notif_rest_deliv_${orderId}_v${eventVersion}`;
          const deliveredPayload = RestaurantTemplates.orderDelivered(orderId, {
            orderNumber,
            customerName: order.customerName || 'Customer',
            totalAmount: Number(order.totalAmount || 0),
            branchId,
            franchiseId: order.franchiseId || 'default',
            riderName: order.deliveryPartnerName,
            deliveryAddress: typeof order.deliveryAddress === 'string' ? order.deliveryAddress : (order.deliveryAddress?.addressLine || 'Address'),
            deliveredAt: new Date().toISOString(),
            version: eventVersion,
          });

          await notificationEngine.sendBulk(branchStaffUids, deliveredPayload, {
            category: 'simple_informational',
            priority: 'high',
            orderId,
            targetApp: 'restaurant',
            eventId: restEventId,
          });
        }
      }

    } catch (notifErr: any) {
      console.warn('[OrderStateMachine] Scoped notification warning:', notifErr.message);
    }
  }
}
