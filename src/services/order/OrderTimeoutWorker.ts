import { adminDb } from '../../config/firebase.js';
import { query } from '../../lib/db.js';
import { OrderStateMachine } from './OrderStateMachine.js';

export class OrderTimeoutWorker {
  private static interval: NodeJS.Timeout | null = null;
  private static isProcessing = false;
  private static quotaBackoffUntil = 0;
  public static readonly DEFAULT_TIMEOUT_MINUTES = 10;

  /**
   * Starts the periodic background scanner (runs every 30 seconds).
   */
  public static init() {
    if (this.interval) return;
    console.log('⏰ [OrderTimeoutWorker] Initializing 10-minute order acceptance auto-cancel worker...');
    
    // Process immediately on boot, then every 30 seconds
    this.processTimedOutOrders().catch(err => 
      console.warn('[OrderTimeoutWorker] Startup run error:', err.message)
    );
    this.processAutoRiderAssignments().catch(err =>
      console.warn('[OrderTimeoutWorker] Auto rider assignment startup run error:', err.message)
    );

    this.interval = setInterval(() => {
      this.processTimedOutOrders().catch(err => 
        console.warn('[OrderTimeoutWorker] Scheduled run error:', err.message)
      );
      this.processAutoRiderAssignments().catch(err =>
        console.warn('[OrderTimeoutWorker] Scheduled auto rider assignment error:', err.message)
      );
    }, 30 * 1000);
  }

  public static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[OrderTimeoutWorker] Stopped.');
    }
  }

  /**
   * Authoritatively queries Firestore for pending orders that have exceeded their acceptance deadline.
   */
  public static async processTimedOutOrders(): Promise<{ processedCount: number; cancelledOrderIds: string[] }> {
    if (this.isProcessing || Date.now() < this.quotaBackoffUntil) {
      return { processedCount: 0, cancelledOrderIds: [] };
    }

    this.isProcessing = true;
    const cancelledOrderIds: string[] = [];

    try {
      let candidateOrders: Array<{ id: string; createdAt: any; deadline?: string }> = [];

      // 1. Primary: PostgreSQL canonical_orders
      try {
        const pgRes = await query(
          `SELECT id, created_at, order_status 
           FROM canonical_orders 
           WHERE order_status IN ('PENDING', 'pending', 'pending_acceptance') 
             AND order_date >= CURRENT_DATE - INTERVAL '1 day'
           ORDER BY created_at ASC
           LIMIT 50`
        );
        if (pgRes.rows.length > 0) {
          candidateOrders = pgRes.rows.map(r => ({
            id: r.id,
            createdAt: r.created_at,
            deadline: undefined
          }));
        }
      } catch (pgErr: any) {
        // Fall back to Firestore if PostgreSQL table is not populated yet
      }

      // 2. Fallback to Firestore only if PostgreSQL returned 0 and not under quota backoff
      if (candidateOrders.length === 0 && Date.now() >= this.quotaBackoffUntil) {
        try {
          const pendingSnap = await adminDb.collection('orders')
            .where('status', 'in', ['pending', 'pending_acceptance'])
            .limit(50)
            .get();

          for (const doc of pendingSnap.docs) {
            candidateOrders.push({
              id: doc.id,
              createdAt: doc.data().createdAt,
              deadline: doc.data().acceptanceDeadline
            });
          }
        } catch (fsErr: any) {
          if (fsErr?.message?.includes('RESOURCE_EXHAUSTED')) {
            this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
          }
          console.warn('[OrderTimeoutWorker] Timed-out orders Firestore notice:', fsErr?.message);
        }
      }

      if (candidateOrders.length === 0) {
        this.isProcessing = false;
        return { processedCount: 0, cancelledOrderIds: [] };
      }

      for (const item of candidateOrders) {
        const orderId = item.id;
        let deadline = item.deadline;
        if (!deadline) {
          let createdAtMs = Date.now();
          if (item.createdAt) {
            if (typeof item.createdAt?.toDate === 'function') {
              createdAtMs = item.createdAt.toDate().getTime();
            } else if (typeof item.createdAt === 'string' || typeof item.createdAt === 'number') {
              createdAtMs = new Date(item.createdAt).getTime();
            } else if (item.createdAt?._seconds) {
              createdAtMs = item.createdAt._seconds * 1000;
            } else if (item.createdAt instanceof Date) {
              createdAtMs = item.createdAt.getTime();
            }
          }
          const timeoutMinutes = Number(process.env.ORDER_ACCEPT_TIMEOUT_MINUTES || OrderTimeoutWorker.DEFAULT_TIMEOUT_MINUTES);
          deadline = new Date(createdAtMs + timeoutMinutes * 60 * 1000).toISOString();
        }

        if (new Date(deadline).getTime() <= Date.now()) {
          console.log(`[OrderTimeoutWorker] Order ${orderId} reached 10-min acceptance deadline (${deadline}). Triggering auto-cancellation...`);

          const result = await OrderStateMachine.transition(
            orderId,
            'cancelled',
            {
              uid: 'system',
              role: 'system',
              name: 'Order Acceptance Timeout Engine'
            },
            {
              cancellationReason: 'RESTAURANT_ACCEPT_TIMEOUT',
              cancellationSource: 'SYSTEM_TIMEOUT',
              acceptanceDeadline: deadline,
              autoCancelled: true,
              cancellationExplanation: 'The restaurant was unable to accept your order within the required 10 minutes.'
            }
          );

          if (result.success) {
            cancelledOrderIds.push(orderId);
            console.log(`[OrderTimeoutWorker] ✅ Order ${orderId} successfully auto-cancelled by system timeout.`);
          } else {
            console.log(`[OrderTimeoutWorker] ℹ️ Order ${orderId} transition result: ${result.error || 'Already progressed'}`);
          }
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('RESOURCE_EXHAUSTED')) {
        this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
      }
      console.warn('[OrderTimeoutWorker] Timed-out orders notice:', err?.message);
    } finally {
      this.isProcessing = false;
    }

    return { processedCount: cancelledOrderIds.length, cancelledOrderIds };
  }

  /**
   * Scans active delivery orders in kitchen prep / accepted states and automatically assigns
   * an eligible online rider when 5 minutes or less remain before order is prepared.
   */
  public static async processAutoRiderAssignments(): Promise<{ assignedCount: number }> {
    if (Date.now() < this.quotaBackoffUntil) {
      return { assignedCount: 0 };
    }
    let assignedCount = 0;
    try {
      let activeOrders: Array<{ id: string; status: string; expectedReadyAt?: any; prepAt?: any }> = [];

      // 1. Primary: PostgreSQL canonical_orders
      try {
        const pgActive = await query(
          `SELECT id, order_status, created_at, accepted_at, preparation_started_at, ready_at
           FROM canonical_orders
           WHERE order_type = 'delivery'
             AND order_status IN ('ACCEPTED', 'accepted', 'PREPARING', 'preparing', 'READY', 'ready')
             AND (delivery_partner_id IS NULL OR delivery_partner_id = '')
             AND order_date >= CURRENT_DATE - INTERVAL '1 day'
           ORDER BY created_at ASC
           LIMIT 25`
        );
        if (pgActive.rows.length > 0) {
          activeOrders = pgActive.rows.map(r => ({
            id: r.id,
            status: (r.order_status || '').toLowerCase(),
            expectedReadyAt: r.ready_at,
            prepAt: r.preparation_started_at || r.accepted_at || r.created_at
          }));
        }
      } catch (pgErr: any) {
        // Fall back to Firestore
      }

      // 2. Fallback to Firestore only if PostgreSQL returned 0 and not under quota backoff
      if (activeOrders.length === 0 && Date.now() >= this.quotaBackoffUntil) {
        try {
          const activeDeliverySnap = await adminDb.collection('orders')
            .where('status', 'in', ['accepted', 'preparing', 'ready'])
            .limit(25)
            .get();

          for (const orderDoc of activeDeliverySnap.docs) {
            const orderData = orderDoc.data();
            const fulfillment = (orderData.fulfillmentType || orderData.deliveryType || 'delivery').toLowerCase();
            if (fulfillment === 'delivery' && !orderData.deliveryPartnerId && !orderData.riderId) {
              activeOrders.push({
                id: orderDoc.id,
                status: orderData.status,
                expectedReadyAt: orderData.expectedReadyAt || orderData.estimatedReadyAt,
                prepAt: orderData.preparingAt || orderData.acceptedAt || orderData.createdAt
              });
            }
          }
        } catch (fsErr: any) {
          if (fsErr?.message?.includes('RESOURCE_EXHAUSTED')) {
            this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
          }
          console.warn('[OrderTimeoutWorker] Auto rider assignment Firestore notice:', fsErr?.message);
        }
      }

      if (activeOrders.length === 0) {
        return { assignedCount: 0 };
      }

      const { RiderDispatchEngine } = await import('../delivery/RiderDispatchEngine.js');
      const nowMs = Date.now();

      for (const order of activeOrders) {
        const orderId = order.id;
        const status = order.status;
        const expectedReadyAt = order.expectedReadyAt;

        let shouldAssign = false;

        if (status === 'ready') {
          shouldAssign = true;
        } else if (expectedReadyAt) {
          const readyMs = new Date(expectedReadyAt).getTime();
          const msRemaining = readyMs - nowMs;
          const minutesRemaining = msRemaining / (60 * 1000);

          if (minutesRemaining <= 5) {
            shouldAssign = true;
          }
        } else {
          const prepAt = order.prepAt;
          if (prepAt) {
            const prepMs = new Date(prepAt).getTime();
            if (nowMs - prepMs >= 7 * 60 * 1000) {
              shouldAssign = true;
            }
          }
        }

        if (shouldAssign) {
          console.log(`[OrderTimeoutWorker] 🛵 Order ${orderId} reached 5-minute pre-ready window (status: ${status}). Triggering automatic rider dispatch...`);
          try {
            const dispatchResult = await RiderDispatchEngine.autoDispatchRider(orderId);
            if (dispatchResult.success && dispatchResult.rider) {
              assignedCount++;
              console.log(`[OrderTimeoutWorker] ✅ Successfully auto-assigned rider '${dispatchResult.rider.name}' (${dispatchResult.rider.uid}) to order ${orderId}.`);
            } else {
              console.log(`[OrderTimeoutWorker] ℹ️ Auto-dispatch for order ${orderId}: ${dispatchResult.reason || 'Waiting for online rider'}`);
            }
          } catch (dispatchErr: any) {
            console.warn(`[OrderTimeoutWorker] Auto-dispatch error for order ${orderId}:`, dispatchErr?.message);
          }
        }
      }
    } catch (err: any) {
      if (err?.message?.includes('RESOURCE_EXHAUSTED')) {
        this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
      }
      console.warn('[OrderTimeoutWorker] Error in processAutoRiderAssignments:', err?.message);
    }

    return { assignedCount };
  }
}
