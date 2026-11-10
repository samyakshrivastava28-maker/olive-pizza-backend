import { adminDb } from '../../config/firebase.js';
import { notificationEngine } from '../notification/NotificationEngine.js';

export class DelayEscalationService {
  /**
   * Evaluates delay for an active preparing order.
   * State machine stages:
   *  0 -> Not delayed
   *  1 -> Minor delay (+5 min allowance) -> Notify Customer
   *  2 -> High demand delay (+3 min allowance) -> Notify Customer
   *  3 -> Severe delay -> Alert Owner
   */
  public static async evaluateOrderDelay(orderId: string): Promise<number> {
    const orderRef = adminDb.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return 0;

    const data = snap.data()!;
    if (['delivered', 'cancelled', 'ready', 'picked_up', 'out_for_delivery'].includes(data.status)) {
      return 0;
    }

    const expectedReadyAtStr = data.expectedReadyAt;
    if (!expectedReadyAtStr) return 0;

    const expectedReadyMs = new Date(expectedReadyAtStr).getTime();
    const nowMs = Date.now();
    if (nowMs <= expectedReadyMs) return 0;

    const currentStage = Number(data.delayEscalationStage || 0);
    const elapsedDelayMins = Math.floor((nowMs - expectedReadyMs) / (60 * 1000));

    // Stage 1: Initial delay (> 0 mins overdue)
    if (currentStage === 0 && elapsedDelayMins >= 1) {
      await orderRef.update({
        delayEscalationStage: 1,
        delayStage1At: new Date().toISOString(),
        delayAllowanceMinutes: 5,
        updatedAt: new Date(),
      });

      // Send Customer notification
      if (data.userId) {
        await notificationEngine.send(data.userId, {
          notification: {
            title: 'Freshness Update 🍕',
            body: 'Your artisan pizza is taking a little longer than expected to ensure perfection.',
          },
          data: { orderId, type: 'delay_stage_1', stage: '1' }
        }, { category: 'pinned_live', orderId });
      }
      return 1;
    }

    // Stage 2: Secondary delay (> 5 mins overdue)
    if (currentStage === 1 && elapsedDelayMins >= 6) {
      await orderRef.update({
        delayEscalationStage: 2,
        delayStage2At: new Date().toISOString(),
        delayAllowanceMinutes: 8,
        updatedAt: new Date(),
      });

      if (data.userId) {
        await notificationEngine.send(data.userId, {
          notification: {
            title: 'High Kitchen Demand ⚡',
            body: 'Our stone ovens are running at peak capacity. We appreciate your patience!',
          },
          data: { orderId, type: 'delay_stage_2', stage: '2' }
        }, { category: 'pinned_live', orderId });
      }
      return 2;
    }

    // Stage 3: Severe delay (> 10 mins overdue) -> Escalate to Owner
    if (currentStage === 2 && elapsedDelayMins >= 11) {
      await orderRef.update({
        delayEscalationStage: 3,
        delayStage3At: new Date().toISOString(),
        isSevereDelay: true,
        updatedAt: new Date(),
      });

      const ownerUids = await notificationEngine.resolveByRole('owner');
      if (ownerUids.length > 0) {
        await notificationEngine.sendBulk(ownerUids, {
          notification: {
            title: `⚠️ Severe Order Delay: #${data.dailyOrderNumber || orderId.slice(-6)}`,
            body: `Order at ${data.branchName || 'Main Branch'} is ${elapsedDelayMins}m overdue. Immediate manager attention required.`,
          },
          data: {
            orderId,
            type: 'severe_delay_alert',
            branchId: data.branchId || 'main_branch',
            elapsedDelayMins: String(elapsedDelayMins),
            originalExpectedReadyAt: expectedReadyAtStr,
          }
        }, { category: 'alarm_actionable', priority: 'critical', orderId });
      }
      return 3;
    }

    return currentStage;
  }
}
