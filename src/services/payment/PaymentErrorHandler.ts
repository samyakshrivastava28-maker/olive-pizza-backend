import crypto from 'crypto';

export type PaymentErrorCode =
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_500'
  | 'INVALID_SIGNATURE'
  | 'PAYMENT_DECLINED'
  | 'WEBHOOK_FAILED'
  | 'REFUND_FAILED'
  | 'DATABASE_ERROR'
  | 'LOCK_TIMEOUT'
  | 'MAINTENANCE_MODE'
  | 'UNKNOWN_ERROR';

export interface StructuredPaymentError {
  errorId: string;
  code: PaymentErrorCode;
  message: string;
  userMessage: string;
  timestamp: string;
  userUid?: string;
  orderId?: string;
  paymentSessionId?: string;
  provider?: string;
  endpoint?: string;
  retryCount?: number;
  stack?: string;
}

export class PaymentErrorHandler {
  public static createError(
    code: PaymentErrorCode,
    message: string,
    context: Partial<StructuredPaymentError> = {}
  ): StructuredPaymentError {
    const errorId = crypto.randomUUID();
    const userMessage = this.getUserFriendlyMessage(code, message);

    const errorObj: StructuredPaymentError = {
      errorId,
      code,
      message,
      userMessage,
      timestamp: new Date().toISOString(),
      userUid: context.userUid,
      orderId: context.orderId,
      paymentSessionId: context.paymentSessionId,
      provider: context.provider,
      endpoint: context.endpoint,
      retryCount: context.retryCount || 0,
      stack: context.stack || new Error().stack,
    };

    console.error(`❌ [PaymentError] [${code}] [ID:${errorId}] ${message}`, errorObj);
    return errorObj;
  }

  private static getUserFriendlyMessage(code: PaymentErrorCode, rawMessage: string): string {
    switch (code) {
      case 'VALIDATION_ERROR':
        return 'Please review your order details or delivery address and try again.';
      case 'NETWORK_ERROR':
      case 'PROVIDER_TIMEOUT':
        return 'Connection with payment gateway timed out. Please check your network or try again.';
      case 'PROVIDER_500':
        return 'Payment provider is temporarily undergoing maintenance. Retrying via secondary gateway...';
      case 'INVALID_SIGNATURE':
        return 'Payment security verification failed. Please try placing your order again.';
      case 'PAYMENT_DECLINED':
        return 'Payment was declined by your bank or card issuer. Please try a different payment method.';
      case 'LOCK_TIMEOUT':
        return 'Another checkout process is currently active for your account. Please wait a moment.';
      case 'MAINTENANCE_MODE':
        return 'Online payments are temporarily paused for routine maintenance. Cash on Delivery is available!';
      default:
        return rawMessage || 'An unexpected payment error occurred. Please try again or contact support.';
    }
  }
}
