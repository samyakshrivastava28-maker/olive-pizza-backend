/**
 * DevOtpBypassService
 *
 * Strict development-only helper to permit bypassing SMS OTP delivery during local testing.
 *
 * SECURITY POLICY:
 * - Fail-closed: NEVER permits bypass in production environments under any circumstance.
 * - Requires explicit DEV_OTP_BYPASS=true or DEV_OTP_BYPASS=1.
 * - Does not store fake OTPs or log OTP values.
 */
export class DevOtpBypassService {
  /**
   * Evaluates strictly whether development OTP bypass is permissible in the current runtime environment.
   * Fail-closed: Returns false immediately if NODE_ENV is production or any production deployment flag is set.
   */
  public static isDevOtpBypassActive(): boolean {
    const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase().trim();

    // 1. Strict production environment guards — Fail Closed
    if (nodeEnv === 'production') {
      return false;
    }

    if (process.env.VERCEL_ENV && process.env.VERCEL_ENV.toLowerCase().trim() === 'production') {
      return false;
    }

    if (process.env.ENVIRONMENT && process.env.ENVIRONMENT.toLowerCase().trim() === 'production') {
      return false;
    }

    if (process.env.APP_ENV && process.env.APP_ENV.toLowerCase().trim() === 'production') {
      return false;
    }

    // 2. Explicit opt-in flag check
    const bypassFlag = (process.env.DEV_OTP_BYPASS || '').toLowerCase().trim();
    return bypassFlag === 'true' || bypassFlag === '1';
  }

  /**
   * Diagnostic status representation for UI display and health checks.
   */
  public static getStatus(): {
    devOtpBypass: boolean;
    environment: string;
    message: string;
  } {
    const active = this.isDevOtpBypassActive();
    const env = process.env.NODE_ENV || 'development';

    return {
      devOtpBypass: active,
      environment: env,
      message: active
        ? '⚡ DEV OTP BYPASS ACTIVE: Any non-empty OTP will pass in development mode.'
        : '🔒 Production OTP Verification Active.'
    };
  }
}
