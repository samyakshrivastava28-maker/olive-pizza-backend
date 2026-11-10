import { PaymentProvider, CreateIntentParams, CreateIntentResult, VerifyPaymentParams, VerifyPaymentResult, CreateRefundParams, RefundResult, ProviderHealthResult } from './PaymentProvider.interface.js';
import { getPaymentConfig } from '../../config/payment.config.js';
import crypto from 'crypto';

export class CashfreeProvider implements PaymentProvider {
  public name: 'cashfree' = 'cashfree';

  private getHeaders() {
    const config = getPaymentConfig();
    return {
      'Content-Type': 'application/json',
      'x-api-version': '2023-08-01',
      'x-client-id': config.cashfreeAppId,
      'x-client-secret': config.cashfreeSecretKey,
    };
  }

  public async createPaymentIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const config = getPaymentConfig();
    if (!config.cashfreeAppId || !config.cashfreeSecretKey) {
      throw new Error('Cashfree App ID or Secret Key not configured in payment.config.ts / process.env');
    }

    const orderId = `cf_order_${params.paymentId.replace(/-/g, '').slice(0, 16)}_${Date.now()}`;
    const baseUrl = config.sandboxMode
      ? 'https://sandbox.cashfree.com/pg/orders'
      : 'https://api.cashfree.com/pg/orders';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        order_id: orderId,
        order_amount: params.amount,
        order_currency: params.currency || 'INR',
        customer_details: {
          customer_id: params.userId,
          customer_name: params.customerName || 'Gourmet Lover',
          customer_email: params.customerEmail || 'customer@olivepizza.app',
          customer_phone: params.customerPhone || '9876543210',
        },
        order_meta: {
          return_url: `https://olivepizza.app/#/checkout?cf_order_id={order_id}`,
          notify_url: `https://olivepizza.app/api/payment/webhook/cashfree`,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cashfree Order Creation Error ${response.status}: ${errText}`);
    }

    const cfOrder: any = await response.json();

    return {
      provider: 'cashfree',
      providerPaymentId: cfOrder.order_id,
      amount: params.amount,
      currency: params.currency || 'INR',
      sdkPayload: {
        paymentSessionId: cfOrder.payment_session_id,
        orderId: cfOrder.order_id,
      },
      checkoutUrl: cfOrder.payment_link || `https://payments.cashfree.com/order/#${cfOrder.payment_session_id}`,
    };
  }

  public verifySignature(payload: string | object, signature: string): boolean {
    const config = getPaymentConfig();
    const secret = config.cashfreeWebhookSecret || config.cashfreeSecretKey;
    if (!secret || !signature) return false;

    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expectedSignature = crypto.createHmac('sha256', secret).update(data).digest('base64');
    return signature === expectedSignature;
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    const config = getPaymentConfig();
    const baseUrl = config.sandboxMode
      ? `https://sandbox.cashfree.com/pg/orders/${params.providerPaymentId}`
      : `https://api.cashfree.com/pg/orders/${params.providerPaymentId}`;

    if (!params.providerPaymentId || typeof params.providerPaymentId !== 'string') {
      return {
        verified: false,
        providerPaymentId: params.providerPaymentId || '',
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: 'Missing or invalid Cashfree providerPaymentId for verification',
      };
    }

    try {
      const response = await fetch(baseUrl, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (response.ok) {
        const cfOrder: any = await response.json();
        const isPaid = cfOrder.order_status === 'PAID';
        const isPending = cfOrder.order_status === 'ACTIVE';
        return {
          verified: isPaid,
          providerPaymentId: cfOrder.order_id,
          providerTransactionId: String(cfOrder.cf_order_id || cfOrder.order_id),
          status: isPaid ? 'captured' : (isPending ? 'pending' : 'failed'),
          amount: Number(cfOrder.order_amount) || 0,
          currency: cfOrder.order_currency || 'INR',
          errorReason: isPaid ? undefined : `Cashfree order status is '${cfOrder.order_status}', not PAID`,
          rawResponse: cfOrder,
        };
      } else {
        const errText = await response.text().catch(() => '');
        return {
          verified: false,
          providerPaymentId: params.providerPaymentId,
          status: 'failed',
          amount: 0,
          currency: 'INR',
          errorReason: `Cashfree API returned HTTP ${response.status}: ${errText.slice(0, 180)}`,
        };
      }
    } catch (err: any) {
      return {
        verified: false,
        providerPaymentId: params.providerPaymentId,
        status: 'failed',
        amount: 0,
        currency: 'INR',
        errorReason: `Cashfree verification network exception: ${err?.message || 'Connection error'}`,
      };
    }
  }

  public async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    const config = getPaymentConfig();
    const refundId = `cf_ref_${Date.now()}`;
    const baseUrl = config.sandboxMode
      ? `https://sandbox.cashfree.com/pg/orders/${params.providerTransactionId}/refunds`
      : `https://api.cashfree.com/pg/orders/${params.providerTransactionId}/refunds`;

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        refund_id: refundId,
        refund_amount: params.refundAmount,
        refund_note: params.reason,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cashfree Refund Error ${response.status}: ${errText}`);
    }

    const cfRefund: any = await response.json();

    return {
      success: cfRefund.refund_status === 'SUCCESS' || cfRefund.refund_status === 'PENDING',
      refundTransactionId: cfRefund.refund_id || refundId,
      amountRefunded: Number(cfRefund.refund_amount || params.refundAmount),
      status: cfRefund.refund_status === 'SUCCESS' ? 'processed' : 'pending',
      rawResponse: cfRefund,
    };
  }

  public async getHealthStatus(): Promise<ProviderHealthResult> {
    const start = Date.now();
    return {
      provider: 'cashfree',
      healthy: true,
      latencyMs: Date.now() - start,
      message: 'Cashfree Provider Operational',
    };
  }
}

export const cashfreeProvider = new CashfreeProvider();
