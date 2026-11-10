import { query } from '../../lib/db.js';
import crypto from 'crypto';

export interface RecoveryItem {
  id: string;
  paymentId: string;
  providerPaymentId: string;
  userId: string;
  amount: number;
  sessionData: any;
  retryCount: number;
  status: 'PENDING' | 'RECOVERED' | 'FAILED_MANUAL_REVIEW';
  lastError?: string;
  createdAt: string;
}

export class PaymentRecoveryQueue {
  public static async enqueue(paymentId: string, providerPaymentId: string, userId: string, amount: number, sessionData: any, errorMsg: string): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    console.warn(`⚠️ [PaymentRecoveryQueue] Enqueuing stuck payment ID=${paymentId} for auto-recovery. Error: ${errorMsg}`);

    try {
      await query(`
        INSERT INTO payment_recovery_queue (id, payment_id, provider_payment_id, user_id, amount, session_data, retry_count, status, last_error, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 0, 'PENDING', $7, $8)
      `, [id, paymentId, providerPaymentId, userId, amount, JSON.stringify(sessionData), errorMsg, createdAt]);
    } catch (err: any) {
      console.error('[PaymentRecoveryQueue] Failed to write recovery record to DB:', err.message);
    }

    return id;
  }

  public static async processPendingRecoveries(processOrderFn: (item: RecoveryItem) => Promise<boolean>): Promise<{ processed: number; recovered: number }> {
    let processed = 0;
    let recovered = 0;

    try {
      const res = await query(`
        SELECT * FROM payment_recovery_queue
        WHERE status = 'PENDING' AND retry_count < 3
        ORDER BY created_at ASC LIMIT 10
      `);

      for (const row of res.rows) {
        processed++;
        const item: RecoveryItem = {
          id: row.id,
          paymentId: row.payment_id,
          providerPaymentId: row.provider_payment_id,
          userId: row.user_id,
          amount: Number(row.amount),
          sessionData: typeof row.session_data === 'string' ? JSON.parse(row.session_data) : row.session_data,
          retryCount: Number(row.retry_count),
          status: row.status,
          lastError: row.last_error,
          createdAt: row.created_at,
        };

        try {
          const success = await processOrderFn(item);
          if (success) {
            recovered++;
            await query(`UPDATE payment_recovery_queue SET status = 'RECOVERED', updated_at = NOW() WHERE id = $1`, [item.id]);
            console.log(`✅ [PaymentRecoveryQueue] Successfully auto-recovered payment ID=${item.paymentId}!`);
          } else {
            const nextCount = item.retryCount + 1;
            const newStatus = nextCount >= 3 ? 'FAILED_MANUAL_REVIEW' : 'PENDING';
            await query(`UPDATE payment_recovery_queue SET retry_count = $1, status = $2, updated_at = NOW() WHERE id = $3`, [nextCount, newStatus, item.id]);
          }
        } catch (err: any) {
          const nextCount = item.retryCount + 1;
          const newStatus = nextCount >= 3 ? 'FAILED_MANUAL_REVIEW' : 'PENDING';
          await query(`UPDATE payment_recovery_queue SET retry_count = $1, status = $2, last_error = $3, updated_at = NOW() WHERE id = $4`, [nextCount, newStatus, err.message, item.id]);
        }
      }
    } catch (err: any) {
      // Table may not exist yet
    }

    return { processed, recovered };
  }
}
