import { PaymentProvider, CreateIntentParams, CreateIntentResult, VerifyPaymentParams, VerifyPaymentResult, CreateRefundParams, RefundResult, ProviderHealthResult } from './PaymentProvider.interface.js';
import { getPaymentConfig } from '../../config/payment.config.js';
import crypto from 'crypto';

export class RazorpayProvider implements PaymentProvider {
  public name: 'razorpay' = 'razorpay';

  private getAuthHeader(): string {
    const config = getPaymentConfig();
    const credentials = `${config.razorpayKeyId}:${config.razorpayKeySecret}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  public async createPaymentIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const config = getPaymentConfig();
    if (!config.razorpayKeyId || !config.razorpayKeySecret) {
      throw new Error('Razorpay API keys not configured in payment.config.ts / process.env');
    }

    const amountInPaise = Math.round(params.amount * 100);

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.getAuthHeader(),
      },
      body: JSON.stringify({
        amount: amountInPaise,
        currency: params.currency || 'INR',
        receipt: `rcpt_${params.paymentId.slice(0, 10)}`,
        notes: {
          paymentId: params.paymentId,
          userId: params.userId,
          orderNotes: params.orderNotes || 'Olive Pizza Order',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Razorpay API Error ${response.status}: ${errText}`);
    }

    const rzpOrder: any = await response.json();

    return {
      provider: 'razorpay',
      providerPaymentId: rzpOrder.id,
      amount: params.amount,
      currency: params.currency || 'INR',
      sdkPayload: {
        key: config.razorpayKeyId,
        amount: rzpOrder.amount,
        currency: rzpOrder.currency,
        name: config.businessName,
        description: 'Artisan Pizza Order',
        order_id: rzpOrder.id,
        prefill: {
          name: params.customerName || '',
          email: params.customerEmail || '',
          contact: params.customerPhone || '',
        },
        theme: { color: '#f97316' },
      },
    };
  }

  public verifySignature(payload: string | object, signature: string, secretOverride?: string): boolean {
    const config = getPaymentConfig();
    const secret = secretOverride || config.razorpayWebhookSecret || config.razorpayKeySecret;
    if (!secret || !signature) return false;

    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    const config = getPaymentConfig();
    const { providerPaymentId, providerTransactionId, providerSignature } = params;

    // A real Razorpay payment ID (pay_...) is strictly required
    if (!providerTransactionId || typeof providerTransactionId !== 'string' || !providerTransactionId.startsWith('pay_')) {
      return {
        verified: false,
        providerPaymentId,
        providerTransactionId,
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: 'Missing or invalid Razorpay payment transaction ID (must start with "pay_")',
      };
    }

    // Verify HMAC-SHA256 signature for client callback (order_id|payment_id) if signature provided
    if (providerPaymentId && providerSignature) {
      const text = `${providerPaymentId}|${providerTransactionId}`;
      const expectedSignature = crypto
        .createHmac('sha256', config.razorpayKeySecret)
        .update(text)
        .digest('hex');

      const sigBuf = Buffer.from(providerSignature);
      const expBuf = Buffer.from(expectedSignature);
      const matches = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

      if (!matches) {
        return {
          verified: false,
          providerPaymentId,
          providerTransactionId,
          status: 'failed',
          amount: 0,
          currency: 'INR',
          errorReason: 'Razorpay HMAC Signature verification failed: invalid signature for order/payment pair',
        };
      }
    }

    // Always fetch and confirm authoritative details directly from Razorpay API GET /v1/payments/{id}
    try {
      const response = await fetch(`https://api.razorpay.com/v1/payments/${providerTransactionId}`, {
        method: 'GET',
        headers: {
          'Authorization': this.getAuthHeader(),
        },
      });

      if (response.ok) {
        const paymentData: any = await response.json();
        const isCaptured = paymentData.status === 'captured';
        const receivedAmount = Number(paymentData.amount) / 100;

        // If an order ID was passed, confirm the payment actually belongs to this Razorpay order
        if (providerPaymentId && paymentData.order_id && paymentData.order_id !== providerPaymentId) {
          return {
            verified: false,
            providerPaymentId,
            providerTransactionId: paymentData.id,
            status: 'failed',
            amount: receivedAmount,
            currency: paymentData.currency || 'INR',
            errorReason: `Razorpay payment ${paymentData.id} belongs to order ${paymentData.order_id}, not expected order ${providerPaymentId}`,
            rawResponse: paymentData,
          };
        }

        return {
          verified: isCaptured,
          providerPaymentId: paymentData.order_id || providerPaymentId,
          providerTransactionId: paymentData.id,
          status: isCaptured ? 'captured' : (paymentData.status === 'authorized' ? 'pending' : 'failed'),
          amount: receivedAmount,
          currency: paymentData.currency || 'INR',
          errorReason: isCaptured ? undefined : `Razorpay payment is in state '${paymentData.status}', not captured`,
          rawResponse: paymentData,
        };
      } else {
        const errText = await response.text().catch(() => '');
        return {
          verified: false,
          providerPaymentId,
          providerTransactionId,
          status: 'failed',
          amount: 0,
          currency: 'INR',
          errorReason: `Razorpay payment lookup failed with HTTP ${response.status}: ${errText.slice(0, 180)}`,
        };
      }
    } catch (err: any) {
      return {
        verified: false,
        providerPaymentId,
        providerTransactionId,
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: `Razorpay verification network exception: ${err?.message || 'Connection error'}`,
      };
    }
  }

  public async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    const amountInPaise = Math.round(params.refundAmount * 100);

    const response = await fetch(`https://api.razorpay.com/v1/payments/${params.providerTransactionId}/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.getAuthHeader(),
      },
      body: JSON.stringify({
        amount: amountInPaise,
        notes: {
          reason: params.reason,
          paymentId: params.paymentId,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Razorpay Refund Error: ${errText}`);
    }

    const rzpRefund: any = await response.json();

    return {
      success: true,
      refundTransactionId: rzpRefund.id,
      amountRefunded: Number(rzpRefund.amount) / 100,
      status: rzpRefund.status === 'processed' ? 'processed' : 'pending',
      rawResponse: rzpRefund,
    };
  }

  public async getHealthStatus(): Promise<ProviderHealthResult> {
    const start = Date.now();
    try {
      const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
        method: 'GET',
        headers: { 'Authorization': this.getAuthHeader() },
      });
      const latencyMs = Date.now() - start;
      return {
        provider: 'razorpay',
        healthy: response.ok,
        latencyMs,
        message: response.ok ? 'Razorpay API Active' : `Razorpay API returned ${response.status}`,
      };
    } catch (err: any) {
      return {
        provider: 'razorpay',
        healthy: false,
        latencyMs: Date.now() - start,
        message: err.message,
      };
    }
  }
}

export const razorpayProvider = new RazorpayProvider();
