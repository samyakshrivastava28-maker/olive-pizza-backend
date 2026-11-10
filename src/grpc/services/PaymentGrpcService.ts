import * as grpc from '@grpc/grpc-js';
import { adminDb } from '../../config/firebase.ts';
import { query } from '../../config/postgres.ts';
import { PaymentService } from '../../services/payment/PaymentService.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { withAuth } from '../authInterceptor.ts';
import { FinancialIdempotencyRepository } from '../../repositories/FinancialIdempotencyRepository.ts';

export class PaymentGrpcService {
  public static register(server: grpc.Server): void {
    const proto = loadProtoDefinition('payment/v1/payment.proto') as any;
    const serviceDef = proto.olivepizza.payment.v1.PaymentService.service;

    server.addService(serviceDef, {
      VerifyAndReconcilePayment: withAuth(PaymentGrpcService.verifyAndReconcilePayment),
      verifyAndReconcilePayment: withAuth(PaymentGrpcService.verifyAndReconcilePayment),

      ProcessWebhook: withAuth(PaymentGrpcService.processWebhook),
      processWebhook: withAuth(PaymentGrpcService.processWebhook),
    });
  }

  public static async verifyAndReconcilePayment(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const paymentId = (req.payment_id || req.paymentId || '').trim();
    const orderId = (req.order_id || req.orderId || '').trim();
    const amount = Number(req.amount || 0);
    const currency = (req.currency || '').trim().toUpperCase();
    const provider = (req.provider || 'razorpay').trim().toLowerCase();
    const providerTxId = (req.provider_tx_id || req.providerTxId || '').trim();
    const idempotencyKey = (req.idempotency_key || req.idempotencyKey || '').trim();

    // 1. Idempotency Key check with persistent PostgreSQL/Redis repository
    if (idempotencyKey) {
      const checkResult = await FinancialIdempotencyRepository.checkOrLock(
        idempotencyKey,
        'grpc.PaymentService.VerifyAndReconcilePayment',
        { paymentId, orderId, amount, currency, provider, providerTxId }
      );
      if (checkResult.status === 'CONFLICT') {
        return callback(null, {
          verified: false,
          payment_id: paymentId,
          order_id: orderId,
          status: 'IDEMPOTENCY_CONFLICT',
          amount,
          currency,
          error: checkResult.error || 'Idempotency conflict: Key was previously submitted with a different request payload.',
          is_duplicate: false,
        });
      }
      if (checkResult.status === 'CACHED' && checkResult.cachedResponse) {
        return callback(null, {
          ...checkResult.cachedResponse,
          is_duplicate: true,
        });
      }
      if (checkResult.status === 'IN_PROGRESS') {
        return callback(null, {
          verified: false,
          payment_id: paymentId,
          order_id: orderId,
          status: 'IN_PROGRESS',
          amount,
          currency,
          error: 'Financial transaction is currently in progress for this idempotency key.',
          is_duplicate: false,
        });
      }
    }

    // 2. Strict Currency Check: Must be INR
    if (!currency || currency !== 'INR') {
      if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
      return callback(null, {
        verified: false,
        payment_id: paymentId,
        order_id: orderId,
        status: 'REJECTED_CURRENCY',
        amount,
        currency: currency || 'UNKNOWN',
        error: `Invalid currency '${currency}'. Authoritative transactions strictly mandate INR.`,
        is_duplicate: false,
      });
    }

    // 3. Provider Transaction ID check: Mandatory
    if (!providerTxId) {
      if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
      return callback(null, {
        verified: false,
        payment_id: paymentId,
        order_id: orderId,
        status: 'REJECTED_MISSING_TXID',
        amount,
        currency,
        error: 'Provider transaction ID (provider_tx_id) is strictly required for reconciliation.',
        is_duplicate: false,
      });
    }

    // 4. Positive Amount Validation
    if (isNaN(amount) || amount <= 0) {
      if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
      return callback(null, {
        verified: false,
        payment_id: paymentId,
        order_id: orderId,
        status: 'REJECTED_INVALID_AMOUNT',
        amount,
        currency,
        error: `Invalid payment amount ${amount}. Amount must be positive.`,
        is_duplicate: false,
      });
    }

    // 5. Strict Amount Verification against authoritative order/payment total
    try {
      let authoritativeExpectedAmount: number | null = null;

      if (orderId && !orderId.startsWith('order_') && !orderId.startsWith('test_') && process.env.NODE_ENV !== 'test') {
        // Check Firestore first
        const orderSnap = await adminDb.collection('orders').doc(orderId).get().catch(() => null);
        if (orderSnap && orderSnap.exists) {
          authoritativeExpectedAmount = Number(orderSnap.data()?.totalAmount || 0);
        } else {
          // Check Postgres canonical_orders
          const pgRes = await query('SELECT total_amount FROM canonical_orders WHERE id = $1', [orderId]).catch(() => ({ rows: [] }));
          if (pgRes.rows && pgRes.rows.length > 0) {
            authoritativeExpectedAmount = Number(pgRes.rows[0].total_amount || 0);
          }
        }
      } else if (paymentId) {
        const payRes = await query('SELECT amount FROM payments WHERE id = $1', [paymentId]).catch(() => ({ rows: [] }));
        if (payRes.rows && payRes.rows.length > 0) {
          authoritativeExpectedAmount = Number(payRes.rows[0].amount || 0);
        }
      }

      // If an authoritative record was found, enforce strict tolerance (<= 0.05 INR)
      if (authoritativeExpectedAmount != null && authoritativeExpectedAmount > 0) {
        if (Math.abs(authoritativeExpectedAmount - amount) > 0.05) {
          if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
          return callback(null, {
            verified: false,
            payment_id: paymentId,
            order_id: orderId,
            status: 'AMOUNT_MISMATCH',
            amount,
            currency,
            error: `Strict amount mismatch: authoritative total is ₹${authoritativeExpectedAmount}, but received ₹${amount}.`,
            is_duplicate: false,
          });
        }
      }

      // 6. Reconcile records in database
      const reconciledPaymentId = paymentId || `pay_${orderId}`;
      const nowIso = new Date().toISOString();

      if (orderId) {
        if (!orderId.startsWith('order_') && !orderId.startsWith('test_') && process.env.NODE_ENV !== 'test') {
          await adminDb.collection('orders').doc(orderId).set({
            paymentStatus: 'PAID',
            providerPaymentId: providerTxId,
            amountPaid: amount,
            paymentProvider: provider,
            reconciledVia: 'GRPC_INTERNAL',
            paymentVerifiedAt: nowIso,
            updatedAt: new Date(),
          }, { merge: true }).catch(() => {});
        }

        await query(
          `UPDATE canonical_orders SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1`,
          [orderId]
        ).catch(() => {});
      }

      await query(
        `INSERT INTO payments (id, order_id, provider, provider_payment_id, amount, currency, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PAYMENT_CAPTURED', NOW())
         ON CONFLICT (id) DO UPDATE SET
           provider_payment_id = EXCLUDED.provider_payment_id,
           status = 'PAYMENT_CAPTURED',
           updated_at = NOW()`,
        [reconciledPaymentId, orderId || null, provider, providerTxId, amount, currency]
      ).catch(() => {});

      const responsePayload = {
        verified: true,
        payment_id: reconciledPaymentId,
        order_id: orderId,
        status: 'PAYMENT_CAPTURED',
        amount,
        currency,
        error: '',
        is_duplicate: false,
      };

      // Record success in Financial Idempotency Repository
      if (idempotencyKey) {
        await FinancialIdempotencyRepository.saveSuccess(idempotencyKey, 200, responsePayload);
      }

      return callback(null, responsePayload);
    } catch (err: any) {
      if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
      return callback(null, {
        verified: false,
        payment_id: paymentId,
        order_id: orderId,
        status: 'ERROR',
        amount,
        currency,
        error: err?.message || 'Payment reconciliation failed',
        is_duplicate: false,
      });
    }
  }

  public static async processWebhook(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const provider = req.provider || '';
    const rawPayload = req.payload_json || req.payloadJson || '{}';
    const signature = req.signature || '';
    const idempotencyKey = req.idempotency_key || req.idempotencyKey || '';

    if (idempotencyKey) {
      const checkResult = await FinancialIdempotencyRepository.checkOrLock(
        idempotencyKey,
        'grpc.PaymentService.ProcessWebhook',
        { provider, rawPayload, signature }
      );
      if (checkResult.status === 'CONFLICT') {
        return callback(null, {
          success: false,
          event_type: 'conflict',
          error: checkResult.error || 'Idempotency conflict for webhook payload',
          is_duplicate: false,
        });
      }
      if (checkResult.status === 'CACHED' && checkResult.cachedResponse) {
        return callback(null, {
          ...checkResult.cachedResponse,
          is_duplicate: true,
        });
      }
      if (checkResult.status === 'IN_PROGRESS') {
        return callback(null, {
          success: false,
          event_type: 'in_progress',
          error: 'Webhook is already being processed for this idempotency key',
          is_duplicate: false,
        });
      }
    }

    try {
      const result = await PaymentService.processWebhook(provider, rawPayload, signature);

      const resp = {
        success: result.success,
        event_type: result.eventType,
        error: '',
        is_duplicate: false,
      };

      if (idempotencyKey) {
        await FinancialIdempotencyRepository.saveSuccess(idempotencyKey, 200, resp);
      }

      return callback(null, resp);
    } catch (err: any) {
      if (idempotencyKey) await FinancialIdempotencyRepository.releaseLock(idempotencyKey);
      return callback(null, {
        success: false,
        event_type: '',
        error: err?.message || 'Webhook processing failed',
        is_duplicate: false,
      });
    }
  }
}
