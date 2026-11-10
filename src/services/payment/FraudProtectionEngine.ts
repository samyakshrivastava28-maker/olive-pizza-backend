import { getPaymentConfig } from '../../config/payment.config.js';

export interface FraudCheckParams {
  userId: string;
  userIp?: string;
  deviceId?: string;
  amount: number;
  currency: string;
  itemCount: number;
}

export interface FraudCheckResult {
  passed: boolean;
  reason?: string;
  riskScore: number; // 0 to 100
}

export class FraudProtectionEngine {
  private static attemptTracker = new Map<string, { count: number; firstAttempt: number }>();

  public static evaluateRisk(params: FraudCheckParams): FraudCheckResult {
    const config = getPaymentConfig();
    let riskScore = 0;

    // 1. Max Order Amount Check
    if (params.amount > config.maxOrderAmount) {
      return {
        passed: false,
        reason: `Order total (₹${params.amount}) exceeds max single transaction limit (₹${config.maxOrderAmount}).`,
        riskScore: 100,
      };
    }

    // 2. Minimum Transaction Amount Check
    if (params.amount <= 0) {
      return {
        passed: false,
        reason: 'Invalid transaction amount (<= 0).',
        riskScore: 100,
      };
    }

    // 3. Velocity & Rate Limit Check per User/Device
    const trackerKey = `${params.userId}:${params.deviceId || params.userIp || 'unknown'}`;
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window

    let tracker = this.attemptTracker.get(trackerKey);
    if (!tracker || now - tracker.firstAttempt > windowMs) {
      tracker = { count: 1, firstAttempt: now };
    } else {
      tracker.count++;
    }
    this.attemptTracker.set(trackerKey, tracker);

    if (tracker.count > config.maxPaymentAttemptsPerMinute) {
      riskScore += 80;
      return {
        passed: false,
        reason: `Too many payment creation attempts (${tracker.count}/min). Please wait 1 minute.`,
        riskScore,
      };
    }

    // 4. Large Amount Warning (High risk score but allowed)
    if (params.amount > 5000) {
      riskScore += 25;
    }

    return {
      passed: true,
      riskScore,
    };
  }
}
