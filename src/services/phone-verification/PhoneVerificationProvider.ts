export interface VerificationResult {
  success: boolean;
  phone?: string;
  provider?: string;
  name?: string;
  country?: string;
  pinId?: string;
  verifiedAt?: number;
  error?: string;
}

export interface OTPRequestResult {
  success: boolean;
  message?: string;
  pinId?: string;
  expiresInSeconds?: number;
  cooldownSeconds?: number;
  provider?: string;
  error?: string;
  blockedUntil?: number;
}

export interface PhoneVerificationProvider {
  /**
   * Generates and sends an OTP / 2FA PIN to the given phone number.
   * Returns a result indicating success, pinId reference, or rate-limit blocks.
   */
  sendOtp?(phone: string, userId: string, ipAddress?: string): Promise<OTPRequestResult>;
  
  /**
   * Verifies an OTP code / 2FA PIN for a phone number.
   */
  verifyOtp?(phone: string, code: string, userId: string, pinId?: string): Promise<VerificationResult>;

  /**
   * Verifies a payload natively from a 1-tap provider (like Truecaller).
   */
  verifyNativePayload?(payload: any, signature: string, signatureAlgorithm?: string): Promise<VerificationResult>;

  /**
   * Health check / ping provider connectivity
   */
  getHealthStatus?(): Promise<{ ok: boolean; provider: string; configured: boolean; latencyMs?: number; error?: string }>;
}
