import { PaymentProvider, CreateIntentParams, CreateIntentResult, VerifyPaymentParams, VerifyPaymentResult, CreateRefundParams, RefundResult, ProviderHealthResult } from './PaymentProvider.interface.js';
import crypto from 'crypto';

export interface MockPaymentIntent {
  paymentId: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  createdAt: number;
  expiresAt: number;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'EXPIRED';
  userId?: string;
}

export class MockSandboxProvider implements PaymentProvider {
  public name: 'mock' = 'mock';
  private intents: Map<string, MockPaymentIntent> = new Map();

  public registerIntent(intent: MockPaymentIntent) {
    this.intents.set(intent.paymentId, intent);
    this.intents.set(intent.providerPaymentId, intent);
  }

  public getMockIntent(id: string): MockPaymentIntent | undefined {
    return this.intents.get(id);
  }

  public clearIntents() {
    this.intents.clear();
  }

  public async createPaymentIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const mockProviderOrderNo = `mock_order_${params.paymentId}_${Date.now()}`;
    const intent: MockPaymentIntent = {
      paymentId: params.paymentId,
      providerPaymentId: mockProviderOrderNo,
      amount: Number(params.amount || 0),
      currency: params.currency || 'INR',
      createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes TTL
      status: 'PENDING',
      userId: params.userId,
    };

    this.registerIntent(intent);

    return {
      provider: 'mock',
      providerPaymentId: mockProviderOrderNo,
      amount: params.amount,
      currency: params.currency || 'INR',
      sdkPayload: {
        key: 'rzp_test_mock_sandbox_key',
        amount: params.amount * 100,
        currency: params.currency || 'INR',
        name: 'Olive Pizza (Sandbox)',
        description: 'Artisan Pizza Order Sandbox Payment',
        order_id: mockProviderOrderNo,
        prefill: {
          name: params.customerName || 'Gourmet Customer',
          email: params.customerEmail || 'customer@olivepizza.app',
          contact: params.customerPhone || '9876543210',
        },
        theme: { color: '#f97316' },
      },
      checkoutUrl: `/#/checkout?sandbox_intent=${params.paymentId}&mock_order=${mockProviderOrderNo}`,
    };
  }

  public verifySignature(payload: string | object, signature: string): boolean {
    if (!signature) return false;
    return signature.startsWith('mock_sig_') || signature.length > 5;
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    const fallbackProviderId = params.providerPaymentId || params.paymentId || 'mock_unknown';

    // 1. Strict production isolation check: Never permit mock settlement in production
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SANDBOX_MOCK !== 'true') {
      return {
        verified: false,
        providerPaymentId: fallbackProviderId,
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: 'Mock payment provider is strictly disabled in production environment',
      };
    }

    // 2. Fetch the authoritative server-controlled mock intent
    let intent: MockPaymentIntent | undefined =
      this.intents.get(params.paymentId) ||
      (params.providerPaymentId ? this.intents.get(params.providerPaymentId) : undefined);

    // 3. Fallback to PostgreSQL canonical payments record if intent is not in-memory
    if (!intent && params.paymentId) {
      try {
        const { query } = await import('../../lib/db.js');
        const payRes = await query(
          `SELECT id, provider_payment_id, amount, currency, status, order_id, user_id, created_at, provider 
           FROM payments 
           WHERE id = $1 AND provider = 'mock' LIMIT 1`,
          [params.paymentId]
        );
        if (payRes.rows.length > 0) {
          const row = payRes.rows[0];
          intent = {
            paymentId: row.id,
            providerPaymentId: row.provider_payment_id || `mock_order_${row.id}`,
            amount: Number(row.amount || 0),
            currency: row.currency || 'INR',
            createdAt: new Date(row.created_at || Date.now()).getTime(),
            expiresAt: new Date(row.created_at || Date.now()).getTime() + 30 * 60 * 1000,
            status: row.status === 'PAYMENT_CAPTURED' || row.status === 'CAPTURED' ? 'CAPTURED' : 'PENDING',
            userId: row.user_id,
          };
          this.registerIntent(intent);
        }
      } catch (err: any) {
        console.warn('[MockSandboxProvider] Could not load payment intent from database:', err.message);
      }
    }

    // 4. Intent must exist prior to verification
    if (!intent) {
      return {
        verified: false,
        providerPaymentId: fallbackProviderId,
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: 'Mock payment intent not found. An intent must be created before verification.',
      };
    }

    // 5. Expiration check
    if (Date.now() > intent.expiresAt) {
      intent.status = 'EXPIRED';
      return {
        verified: false,
        providerPaymentId: intent.providerPaymentId,
        status: 'failed',
        amount: 0,
        currency: intent.currency,
        errorReason: 'Mock payment intent has expired',
      };
    }

    // 6. Signature verification if signature provided
    if (params.providerSignature && !this.verifySignature(params.providerPaymentId || '', params.providerSignature)) {
      return {
        verified: false,
        providerPaymentId: intent.providerPaymentId,
        status: 'failed',
        amount: 0,
        currency: intent.currency,
        errorReason: 'Invalid mock payment signature',
      };
    }

    const txId = params.providerTransactionId || `mock_tx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    intent.status = 'CAPTURED';

    return {
      verified: true,
      providerPaymentId: intent.providerPaymentId,
      providerTransactionId: txId,
      status: 'captured',
      amount: intent.amount, // Authoritatively registered amount from intent creation
      currency: intent.currency,
      rawResponse: { mockStatus: 'SUCCESS', mode: 'sandbox' },
    };
  }

  public async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    return {
      success: true,
      refundTransactionId: `mock_ref_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      amountRefunded: params.refundAmount,
      status: 'processed',
      rawResponse: { mockRefundStatus: 'COMPLETED', mode: 'sandbox' },
    };
  }

  public async getHealthStatus(): Promise<ProviderHealthResult> {
    return {
      provider: 'mock',
      healthy: true,
      latencyMs: 12,
      message: 'Mock Sandbox Provider Operational',
    };
  }
}

export const mockSandboxProvider = new MockSandboxProvider();
