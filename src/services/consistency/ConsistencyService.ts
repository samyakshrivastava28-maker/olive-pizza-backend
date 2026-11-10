import { adminDb } from '../../config/firebase.js';
import { query, withTransaction } from '../../config/postgres.js';

/**
 * ⚖️ Cross-Database Consistency Coordinator
 * 
 * Manages dual-writes and compensating recovery between Standard PostgreSQL (financial/transactional)
 * and Google Cloud Firestore (business documents & real-time client sync).
 */
export class ConsistencyService {
  /**
   * Executes a coordinated Order Payment Settlement:
   * 1. Authoritative transaction in Standard PostgreSQL (payments ledger).
   * 2. Synchronizes order status in Firestore.
   * 3. On Firestore sync failure, logs a reconciliation record so no state is lost.
   */
  static async settleOrderPayment(params: {
    orderId: string;
    paymentId: string;
    providerPaymentId: string;
    userId: string;
    amount: number;
    paymentMethod: string;
    provider: string;
  }): Promise<{ success: boolean; postgresCommitted: boolean; firestoreSynced: boolean; error?: string }> {
    let postgresCommitted = false;
    let firestoreSynced = false;

    // 1. Authoritative PostgreSQL Payment Write
    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO payments (
            id, provider_payment_id, user_id, order_id, provider, amount, currency,
            status, payment_method, verified_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 'INR', 'SUCCESS', $7, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            status = 'SUCCESS',
            verified_at = NOW(),
            updated_at = NOW()`,
          [
            params.paymentId,
            params.providerPaymentId,
            params.userId,
            params.orderId,
            params.provider,
            params.amount,
            params.paymentMethod,
          ]
        );

        await client.query(
          `INSERT INTO payment_audit_logs (id, payment_id, order_id, action, actor_id, actor_role, details)
           VALUES ($1, $2, $3, 'PAYMENT_SETTLED', $4, 'SYSTEM', $5)`,
          [
            'aud_' + Math.random().toString(36).substring(2, 11),
            params.paymentId,
            params.orderId,
            params.userId,
            JSON.stringify({ amount: params.amount, provider: params.provider }),
          ]
        );
      });
      postgresCommitted = true;
    } catch (pgErr: any) {
      console.error('[ConsistencyService] PostgreSQL payment transaction failed:', pgErr.message);
      return { success: false, postgresCommitted: false, firestoreSynced: false, error: pgErr.message };
    }

    // 2. Secondary Firestore Order Document Update
    try {
      if (adminDb) {
        await adminDb.collection('orders').doc(params.orderId).update({
          paymentStatus: 'SUCCESS',
          paymentId: params.paymentId,
          paymentMethod: params.paymentMethod,
          status: 'accepted',
          updatedAt: new Date(),
        });
        firestoreSynced = true;
      }
    } catch (fsErr: any) {
      console.error('[ConsistencyService] Firestore sync warning (compensating reconciliation required):', fsErr.message);
      // Log stuck payment recovery in PostgreSQL for async reconciliation worker
      await query(
        `INSERT INTO payment_recovery_queue (id, payment_id, provider_payment_id, user_id, amount, status, last_error)
         VALUES ($1, $2, $3, $4, $5, 'PENDING_FIRESTORE_SYNC', $6)`,
        [
          'rec_' + Math.random().toString(36).substring(2, 11),
          params.paymentId,
          params.providerPaymentId,
          params.userId,
          params.amount,
          fsErr.message,
        ]
      );
    }

    return {
      success: postgresCommitted,
      postgresCommitted,
      firestoreSynced,
    };
  }
}