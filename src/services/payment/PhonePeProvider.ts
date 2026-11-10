import { PaymentProvider, CreateIntentParams, CreateIntentResult, VerifyPaymentParams, VerifyPaymentResult, CreateRefundParams, RefundResult, ProviderHealthResult } from './PaymentProvider.interface.js';
import { getPaymentConfig } from '../../config/payment.config.js';
import crypto from 'crypto';

export class PhonePeProvider implements PaymentProvider {
  public name: 'phonepe' = 'phonepe';

  private calculateXVerify(base64Body: string, apiPath: string, saltKey: string, saltIndex: string): string {
    const stringToHash = base64Body + apiPath + saltKey;
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
    return `${sha256}###${saltIndex}`;
  }

  public async createPaymentIntent(params: CreateIntentParams): Promise<CreateIntentResult> {
    const config = getPaymentConfig();
    if (!config.phonepeMerchantId || !config.phonepeSaltKey) {
      throw new Error('PhonePe Merchant ID or Salt Key not configured in payment.config.ts / process.env');
    }

    const transactionId = `TXN_${params.paymentId.replace(/-/g, '').slice(0, 20)}_${Date.now()}`;
    const payload = {
      merchantId: config.phonepeMerchantId,
      merchantTransactionId: transactionId,
      merchantUserId: params.userId,
      amount: Math.round(params.amount * 100),
      redirectUrl: `https://olivepizza.app/#/checkout?merchantTransactionId=${transactionId}`,
      redirectMode: 'POST',
      callbackUrl: `https://olivepizza.app/api/payment/webhook/phonepe`,
      mobileNumber: params.customerPhone || '9876543210',
      paymentInstrument: {
        type: 'PAY_PAGE',
      },
    };

    const base64Body = Buffer.from(JSON.stringify(payload)).toString('base64');
    const xVerify = this.calculateXVerify(base64Body, '/pg/v1/pay', config.phonepeSaltKey, config.phonepeSaltIndex);

    const baseUrl = config.sandboxMode
      ? 'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay'
      : 'https://api.phonepe.com/apis/hermes/pg/v1/pay';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      body: JSON.stringify({ request: base64Body }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PhonePe API Error ${response.status}: ${errText}`);
    }

    const resData: any = await response.json();
    const redirectUrl = resData.data?.instrumentResponse?.redirectInfo?.url || '';

    return {
      provider: 'phonepe',
      providerPaymentId: transactionId,
      amount: params.amount,
      currency: params.currency || 'INR',
      sdkPayload: resData,
      checkoutUrl: redirectUrl,
    };
  }

  public verifySignature(payload: string | object, signature: string): boolean {
    const config = getPaymentConfig();
    const secret = config.phonepeWebhookSecret || config.phonepeSaltKey;
    if (!secret || !signature) return false;

    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expectedChecksum = crypto.createHash('sha256').update(data + secret).digest('hex');
    return signature.includes(expectedChecksum) || signature === expectedChecksum;
  }

  public async verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult> {
    const config = getPaymentConfig();
    const transactionId = params.providerPaymentId;

    const apiPath = `/pg/v1/status/${config.phonepeMerchantId}/${transactionId}`;
    const xVerify = this.calculateXVerify('', apiPath, config.phonepeSaltKey, config.phonepeSaltIndex);

    const baseUrl = config.sandboxMode
      ? `https://api-preprod.phonepe.com/apis/pg-sandbox${apiPath}`
      : `https://api.phonepe.com/apis/hermes${apiPath}`;

    if (!transactionId || typeof transactionId !== 'string' || transactionId.trim().length === 0) {
      return {
        verified: false,
        providerPaymentId: transactionId || '',
        status: 'failed',
        errorReason: 'Missing or invalid PhonePe providerPaymentId for verification',
        amount: 0,
        currency: 'INR',
      };
    }

    try {
      const response = await fetch(baseUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerify,
          'X-MERCHANT-ID': config.phonepeMerchantId,
        },
      });

      if (response.ok) {
        const data: any = await response.json();
        const isSuccess = data.code === 'PAYMENT_SUCCESS' && (data.success === true);
        const isPending = data.code === 'PAYMENT_PENDING';
        const receivedAmount = (data.data?.amount || 0) / 100;
        const providerTxId = data.data?.transactionId || data.data?.providerReferenceId;

        if (isSuccess && providerTxId) {
          return {
            verified: true,
            providerPaymentId: transactionId,
            providerTransactionId: String(providerTxId),
            status: 'captured',
            amount: receivedAmount,
            currency: 'INR',
            rawResponse: data,
          };
        }

        return {
          verified: false,
          providerPaymentId: transactionId,
          providerTransactionId: providerTxId ? String(providerTxId) : undefined,
          status: isPending ? 'pending' : 'failed',
          errorReason: data.message || `PhonePe verification returned status code: ${data.code}`,
          amount: receivedAmount,
          currency: 'INR',
          rawResponse: data,
        };
      } else {
        const errorBody = await response.text().catch(() => '');
        return {
          verified: false,
          providerPaymentId: transactionId,
          status: 'failed',
          errorReason: `PhonePe API responded with HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
          amount: 0,
          currency: 'INR',
        };
      }
    } catch (err: any) {
      return {
        verified: false,
        providerPaymentId: transactionId,
        status: 'failed',
        errorReason: `PhonePe network/verification exception: ${err?.message || 'Unknown network error'}`,
        amount: 0,
        currency: 'INR',
      };
    }
  }

  public async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    const config = getPaymentConfig();
    const refundId = `REF_${params.paymentId.replace(/-/g, '').slice(0, 15)}_${Date.now()}`;
    const payload = {
      merchantId: config.phonepeMerchantId,
      merchantTransactionId: refundId,
      originalTransactionId: params.providerTransactionId,
      amount: Math.round(params.refundAmount * 100),
      callbackUrl: 'https://olivepizza.app/api/payment/webhook/phonepe',
    };

    const base64Body = Buffer.from(JSON.stringify(payload)).toString('base64');
    const xVerify = this.calculateXVerify(base64Body, '/pg/v1/refund', config.phonepeSaltKey, config.phonepeSaltIndex);

    const baseUrl = config.sandboxMode
      ? 'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/refund'
      : 'https://api.phonepe.com/apis/hermes/pg/v1/refund';

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      body: JSON.stringify({ request: base64Body }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`PhonePe Refund Error ${response.status}: ${errText}`);
    }

    const resData: any = await response.json();

    return {
      success: resData.code === 'PAYMENT_SUCCESS' || resData.success === true,
      refundTransactionId: refundId,
      amountRefunded: params.refundAmount,
      status: 'processed',
      rawResponse: resData,
    };
  }

  public async getHealthStatus(): Promise<ProviderHealthResult> {
    const start = Date.now();
    return {
      provider: 'phonepe',
      healthy: true,
      latencyMs: Date.now() - start,
      message: 'PhonePe Provider Operational',
    };
  }
}

export const phonePeProvider = new PhonePeProvider();
