/**
 * OrderFulfillmentWorker.ts — Durable Order Dispatch & Late Alert Reconciliation
 * 
 * Runs periodic, restart-safe reconciliation loops:
 * 1. Automatic Rider Dispatch: Derives trigger dynamically at (expectedReadyAt - 3 minutes).
 * 2. One-Time Late-Delivery Alerts: Triggers exactly once when deliveryEta is breached,
 *    marking the canonical record atomically to prevent alert storms.
 */

import { query } from '../../lib/db.js';
import { adminDb } from '../../config/firebase.js';
import { RiderDispatchEngine } from './RiderDispatchEngine.js';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { DeliveryTemplates, CustomerTemplates } from '../notification/NotificationTemplates.js';

export class OrderFulfillmentWorker {
  private static isRunning = false;
  private static timer: NodeJS.Timeout | null = null;
  public static readonly POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

  public static start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('🚀 [OrderFulfillmentWorker] Background dispatch and late-alert worker started (30s interval).');

    // Run immediate check, then schedule recurring interval
    this.runReconciliationCycle().catch((e) => console.warn('[FulfillmentWorker] Initial cycle notice:', e.message));

    this.timer = setInterval(() => {
      this.runReconciliationCycle().catch((e) => console.warn('[FulfillmentWorker] Interval cycle notice:', e.message));
    }, this.POLL_INTERVAL_MS);
  }

  public static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('⏹️ [OrderFulfillmentWorker] Background worker stopped.');
  }

  /**
   * Executes a single idempotent reconciliation pass
   */
  public static async runReconciliationCycle() {
    await this.processPendingDispatches();
    await this.processLateDeliveryAlerts();
  }

  /**
   * 1. Automatic Rider Dispatch derived from expectedReadyAt - 3 minutes
   */
  private static async processPendingDispatches() {
    const now = new Date();
    const nowMs = now.getTime();

    // Query active delivery orders from Firestore that are accepted or preparing and lack an assigned partner
    try {
      const snap = await adminDb.collection('orders')
        .where('status', 'in', ['accepted', 'preparing'])
        .get()
        .catch(() => ({ docs: [] } as any));

      for (const doc of snap.docs) {
        const order = doc.data();
        const orderId = doc.id;

        // Skip non-delivery orders
        const fulfillment = (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase();
        if (fulfillment !== 'delivery') continue;

        // Skip if already has an assigned partner
        if (order.deliveryPartnerId || order.riderId) continue;

        // Check authoritative readyAt
        const readyAtStr = order.expectedReadyAt || order.estimatedReadyAt;
        if (!readyAtStr) continue;

        const readyMs = new Date(readyAtStr).getTime();
        if (isNaN(readyMs)) continue;

        // Dispatch window: 3 minutes before readiness
        const dispatchThresholdMs = readyMs - 3 * 60 * 1000;

        if (nowMs >= dispatchThresholdMs) {
          console.log(`[OrderFulfillmentWorker] Dispatching rider for order ${orderId} (T-3m readiness reached)`);
          await RiderDispatchEngine.autoDispatchRider(orderId).catch((err: any) => {
            console.warn(`[OrderFulfillmentWorker] Auto-dispatch notice for ${orderId}:`, err.message);
          });
        }
      }
    } catch (err: any) {
      console.warn('[OrderFulfillmentWorker] Firestore dispatch scan notice:', err.message);
    }
  }

  /**
   * 2. One-Time Late-Delivery Alert when deliveryEta is exceeded
   */
  private static async processLateDeliveryAlerts() {
    const now = new Date();
    const nowIso = now.toISOString();

    try {
      // Find orders in progress that have an ETA, have exceeded it, and haven't had an alert sent
      const snap = await adminDb.collection('orders')
        .where('status', 'in', ['accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery'])
        .get()
        .catch(() => ({ docs: [] } as any));

      for (const doc of snap.docs) {
        const order = doc.data();
        const orderId = doc.id;

        // Must have an ETA and not already alerted
        if (!order.deliveryEta || order.lateAlertSentAt || order.lateDeliveryAlertSentAt) {
          continue;
        }

        const etaMs = new Date(order.deliveryEta).getTime();
        if (isNaN(etaMs) || now.getTime() <= etaMs) {
          continue; // Not late yet
        }

        // Atomically claim the late alert flag in Firestore
        const orderRef = adminDb.collection('orders').doc(orderId);
        let claimed = false;

        try {
          await adminDb.runTransaction(async (t) => {
            const freshSnap = await t.get(orderRef);
            if (!freshSnap.exists) return;
            const freshData = freshSnap.data()!;
            if (freshData.lateAlertSentAt || freshData.lateDeliveryAlertSentAt) return; // already sent concurrently

            t.update(orderRef, {
              lateAlertSentAt: nowIso,
              lateDeliveryAlertSentAt: nowIso,
              updatedAt: now,
            });
            claimed = true;
          });
        } catch (txnErr) {
          console.warn(`[OrderFulfillmentWorker] Late alert claim race for ${orderId}`);
        }

        if (!claimed) continue;

        // Persist to PostgreSQL canonical_orders
        await query(`
          UPDATE canonical_orders
          SET late_alert_sent_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND late_alert_sent_at IS NULL
        `, [orderId]).catch(() => {});

        console.log(`🚨 [OrderFulfillmentWorker] Emitting 1-time late delivery alert for order ${orderId}`);

        // A. Send Late Alert to Assigned Delivery Partner
        const assignedRiderId = order.deliveryPartnerId || order.riderId;
        if (assignedRiderId) {
          const riderAlertPayload = {
            title: '⚠️ Delivery Running Late',
            body: `Order #${order.dailyOrderNumber || orderId.slice(-6).toUpperCase()} is past its estimated delivery time. Please expedite delivery safely.`,
            sound: 'urgent_alarm',
            data: {
              type: 'LATE_DELIVERY_ALERT',
              orderId,
              status: order.status,
              sound: 'urgent_alarm',
            }
          };

          await notificationEngine.send(assignedRiderId, riderAlertPayload, {
            category: 'alarm_actionable',
            priority: 'critical',
            orderId,
            targetApp: 'delivery'
          }).catch((err: any) => console.warn(`[OrderFulfillmentWorker] Rider late alert notice:`, err.message));
        }

        // B. Send Honest Delay Notification to Customer
        const customerUid = order.userId || order.customerId;
        if (customerUid && customerUid !== 'guest') {
          const customerDelayPayload = CustomerTemplates.orderDelay(
            orderId,
            order.dailyOrderNumber ? `#${order.dailyOrderNumber}` : orderId.slice(-6).toUpperCase(),
            10 // 10 minute estimated extension
          );

          await notificationEngine.send(customerUid, customerDelayPayload, {
            category: 'order_status',
            priority: 'high',
            orderId,
            targetApp: 'customer'
          }).catch((err: any) => console.warn(`[OrderFulfillmentWorker] Customer late alert notice:`, err.message));
        }
      }
    } catch (err: any) {
      console.warn('[OrderFulfillmentWorker] Late alert scan notice:', err.message);
    }
  }
}
