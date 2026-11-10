import dotenv from 'dotenv';
dotenv.config();

export interface PaymentConfig {
  // Active Provider Configuration
  activeProvider: 'razorpay' | 'phonepe' | 'cashfree' | 'mock';
  sandboxMode: boolean;
  maintenanceMode: boolean;
  disableOnlinePayments: boolean;
  enableCodOnly: boolean;

  // Razorpay Credentials
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;

  // PhonePe Credentials
  phonepeMerchantId: string;
  phonepeSaltKey: string;
  phonepeSaltIndex: string;
  phonepeWebhookSecret: string;

  // Cashfree Credentials
  cashfreeAppId: string;
  cashfreeSecretKey: string;
  cashfreeWebhookSecret: string;

  // Merchant & Settlement Bank Info
  merchantUpiId: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankIfscCode: string;
  businessName: string;
  supportEmail: string;
  supportPhone: string;
  gstNumber: string;

  // Fraud & Limits
  currency: string;
  maxOrderAmount: number;
  maxPaymentAttemptsPerMinute: number;
  circuitBreakerThreshold: number; // 5 consecutive failures opens circuit
}

let currentConfig: PaymentConfig = {
  activeProvider: (process.env.PAYMENT_PROVIDER as any) || 'mock',
  sandboxMode: process.env.PAYMENT_SANDBOX_MODE !== 'false',
  maintenanceMode: process.env.PAYMENT_MAINTENANCE_MODE === 'true',
  disableOnlinePayments: process.env.PAYMENT_DISABLE_ONLINE === 'true',
  enableCodOnly: process.env.PAYMENT_COD_ONLY === 'true',

  razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  phonepeMerchantId: process.env.PHONEPE_MERCHANT_ID || '',
  phonepeSaltKey: process.env.PHONEPE_SALT_KEY || '',
  phonepeSaltIndex: process.env.PHONEPE_SALT_INDEX || '1',
  phonepeWebhookSecret: process.env.PHONEPE_WEBHOOK_SECRET || '',

  cashfreeAppId: process.env.CASHFREE_APP_ID || '',
  cashfreeSecretKey: process.env.CASHFREE_SECRET_KEY || '',
  cashfreeWebhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || '',

  merchantUpiId: process.env.MERCHANT_UPI_ID || 'olivepizza@upi',
  bankAccountName: process.env.BANK_ACCOUNT_NAME || 'Olive Pizza Private Limited',
  bankAccountNumber: process.env.BANK_ACCOUNT_NUMBER || '918000000000',
  bankIfscCode: process.env.BANK_IFSC || 'HDFC0001234',
  businessName: process.env.BUSINESS_NAME || 'Olive Pizza (Rajnandgaon)',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@olivepizza.app',
  supportPhone: process.env.SUPPORT_PHONE || '+91 9876543210',
  gstNumber: process.env.GST_NUMBER || '22AAAAA0000A1Z5',

  currency: process.env.PAYMENT_CURRENCY || 'INR',
  maxOrderAmount: Number(process.env.MAX_ORDER_AMOUNT || 25000),
  maxPaymentAttemptsPerMinute: Number(process.env.MAX_ATTEMPTS_PER_MIN || 5),
  circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD || 5),
};

export function getPaymentConfig(): PaymentConfig {
  return { ...currentConfig };
}

export function updatePaymentConfig(newPartialConfig: Partial<PaymentConfig>): PaymentConfig {
  currentConfig = {
    ...currentConfig,
    ...newPartialConfig,
  };
  console.log('[PaymentConfig] Live configuration updated:', {
    activeProvider: currentConfig.activeProvider,
    sandboxMode: currentConfig.sandboxMode,
    maintenanceMode: currentConfig.maintenanceMode,
    enableCodOnly: currentConfig.enableCodOnly,
  });
  return getPaymentConfig();
}
