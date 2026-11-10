import { query } from '../../lib/db.js';
import { PaymentProviderFactory } from './PaymentProviderFactory.js';
import { PaymentRecoveryQueue } from './PaymentRecoveryQueue.js';

export interface ReconciliationReport {
  timestamp: string;
  totalChecked: number;
  matchedCount: number;
  mismatchedCount: number;
  autoHealedCount: number;
  details: any[];
}

export class PaymentReconciliationService {
  private static timer: NodeJS.Timeout | null = null;

  public static startCronJob(intervalMs: number = 15 * 60 * 1000): void {
    if (this.timer) return;
    console.log(`[PaymentReconciliation] Starting background reconciliation cron job (Interval: ${intervalMs / 1000}s)...`);

    this.timer = setInterval(async () => {
      try {
        await this.runReconciliation();
      } catch (err: any) {
        console.error('[PaymentReconciliation] Cron run error:', err.message);
      }
    }, intervalMs);
  }

  public static async runReconciliation(): Promise<ReconciliationReport> {
    console.log('[PaymentReconciliation] Running payment reconciliation check...');
    const report: ReconciliationReport = {
      timestamp: new Date().toISOString(),
      totalChecked: 0,
      matchedCount: 0,
      mismatchedCount: 0,
      autoHealedCount: 0,
      details: [],
    };

    try {
      // Fetch payments created in last 24h with state PAYMENT_PENDING or PAYMENT_AUTHORIZED
      const res = await query(`
        SELECT * FROM payments
        WHERE status IN ('PAYMENT_PENDING', 'PAYMENT_AUTHORIZED', 'INTENT_CREATED')
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 50
      `);

      report.totalChecked = res.rows.length;
      const provider = PaymentProviderFactory.getProvider();

      for (const row of res.rows) {
        if (!row.provider_payment_id) continue;

        try {
          const verifyResult = await provider.verifyPayment({
            paymentId: row.id,
            providerPaymentId: row.provider_payment_id,
          });

          if (verifyResult.verified && verifyResult.status === 'captured') {
            report.mismatchedCount++;
            console.warn(`⚠️ [PaymentReconciliation] Mismatch found! Local payment ID=${row.id} status is ${row.status}, but provider confirms captured! Auto-healing...`);

            // Auto-heal local record
            await query(`
              UPDATE payments
              SET status = 'PAYMENT_CAPTURED', verified_at = NOW(), updated_at = NOW()
              WHERE id = $1
            `, [row.id]);

            // Enqueue for order creation if order_id is missing
            if (!row.order_id) {
              await PaymentRecoveryQueue.enqueue(
                row.id,
                row.provider_payment_id,
                row.user_id,
                Number(row.amount),
                row.metadata ? JSON.parse(row.metadata) : {},
                'Auto-healed by Payment Reconciliation Cron'
              );
            }

            report.autoHealedCount++;
          } else {
            report.matchedCount++;
          }
        } catch (pErr: any) {
          console.warn(`[PaymentReconciliation] Verification failed for payment ${row.id}:`, pErr.message);
        }
      }
    } catch (err: any) {
      console.warn('[PaymentReconciliation] DB query skipped:', err.message);
    }

    console.log(`[PaymentReconciliation] Complete. Checked: ${report.totalChecked}, Auto-healed: ${report.autoHealedCount}`);
    return report;
  }

  public static stopCronJob(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
