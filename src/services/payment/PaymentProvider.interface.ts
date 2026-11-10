export interface CreateIntentParams {
  paymentId: string;
  sessionId: string;
  amount: number;
  currency: string;
  userId: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  orderNotes?: string;
}

export interface CreateIntentResult {
  provider: string;
  providerPaymentId: string; // Razorpay Order ID / PhonePe Transaction ID
  amount: number;
  currency: string;
  sdkPayload: Record<string, any>;
  checkoutUrl?: string;
}

export interface VerifyPaymentParams {
  paymentId: string;
  providerPaymentId: string;
  providerTransactionId?: string;
  providerSignature?: string;
  providerPaymentToken?: string;
  rawPayload?: any;
}

export interface VerifyPaymentResult {
  verified: boolean;
  providerPaymentId: string;
  providerTransactionId?: string;
  status: 'captured' | 'authorized' | 'failed' | 'pending';
  amount: number;
  currency: string;
  rawResponse?: any;
  errorReason?: string;
}

export interface CreateRefundParams {
  paymentId: string;
  providerTransactionId: string;
  refundAmount: number;
  reason: string;
  currency?: string;
}

export interface RefundResult {
  success: boolean;
  refundTransactionId: string;
  amountRefunded: number;
  status: 'processed' | 'pending' | 'failed';
  rawResponse?: any;
}

export interface ProviderHealthResult {
  provider: string;
  healthy: boolean;
  latencyMs: number;
  message?: string;
}

export interface PaymentProvider {
  name: 'razorpay' | 'phonepe' | 'cashfree' | 'mock';
  createPaymentIntent(params: CreateIntentParams): Promise<CreateIntentResult>;
  verifySignature(payload: string | object, signature: string, secret?: string): boolean;
  verifyPayment(params: VerifyPaymentParams): Promise<VerifyPaymentResult>;
  createRefund(params: CreateRefundParams): Promise<RefundResult>;
  getHealthStatus(): Promise<ProviderHealthResult>;
}
