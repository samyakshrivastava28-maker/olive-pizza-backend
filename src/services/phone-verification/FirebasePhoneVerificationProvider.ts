import { PhoneVerificationProvider, OTPRequestResult, VerificationResult } from './PhoneVerificationProvider.js';
import { adminAuth, adminDb } from '../../config/firebase.js';
import { DevOtpBypassService } from './DevOtpBypassService.js';

export class FirebasePhoneVerificationProvider implements PhoneVerificationProvider {
  private isDevelopment: boolean;

  constructor() {
    this.isDevelopment = process.env.NODE_ENV !== 'production' || process.env.PHONE_AUTH_MODE === 'development';
  }

  public normalizePhone(phone: string): { valid: boolean; formattedPhone: string; error?: string } {
    if (!phone) {
      return { valid: false, formattedPhone: '', error: 'Phone number is required' };
    }
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return { valid: true, formattedPhone: `+91${cleaned}` };
    }
    if (cleaned.length === 12 && cleaned.startsWith('91')) {
      return { valid: true, formattedPhone: `+${cleaned}` };
    }
    if (phone.startsWith('+') && cleaned.length >= 10 && cleaned.length <= 15) {
      return { valid: true, formattedPhone: `+${cleaned}` };
    }
    return { valid: false, formattedPhone: '', error: 'Invalid phone number format. Please provide a 10-digit mobile number.' };
  }

  /**
   * Health check for Firebase Authentication service
   */
  public async getHealthStatus(): Promise<{ ok: boolean; provider: string; configured: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      // Light check to ensure Firebase Admin Auth is reachable
      await adminAuth.listUsers(1);
      return {
        ok: true,
        provider: 'firebase_auth',
        configured: true,
        latencyMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        ok: false,
        provider: 'firebase_auth',
        configured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_PROJECT_ID),
        latencyMs: Date.now() - start,
        error: err.message
      };
    }
  }

  /**
   * Instructs client to execute client-side Firebase Phone Auth via reCAPTCHA + SMS
   */
  public async sendOtp(phone: string, userId: string, _ipAddress?: string): Promise<OTPRequestResult> {
    const norm = this.normalizePhone(phone);
    if (!norm.valid) {
      return { success: false, error: norm.error };
    }

    return {
      success: true,
      message: 'Firebase Phone OTP initiated. Please complete the reCAPTCHA verification on your device.',
      provider: 'firebase',
      expiresInSeconds: 300,
      cooldownSeconds: 60
    };
  }

  /**
   * Verifies Firebase Phone Authentication
   * Supports verifying Firebase ID Tokens directly, development-only OTP bypass, as well as test environment PINs
   */
  public async verifyOtp(phone: string, code: string, userId: string, pinId?: string): Promise<VerificationResult> {
    // 1. Mandatory non-empty OTP validation
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { success: false, error: 'OTP code cannot be empty.' };
    }

    // 2. Mandatory phone number format validation
    const norm = this.normalizePhone(phone);
    if (!norm.valid) {
      return { success: false, error: norm.error };
    }

    // 3. If code or pinId is a Firebase ID Token (JWT format)
    const tokenCandidate = (code && code.split('.').length === 3) ? code : (pinId && pinId.split('.').length === 3 ? pinId : null);
    if (tokenCandidate) {
      try {
        const decoded = await adminAuth.verifyIdToken(tokenCandidate);
        const verifiedPhone = decoded.phone_number ? this.normalizePhone(decoded.phone_number).formattedPhone : norm.formattedPhone;

        if (decoded.phone_number && verifiedPhone !== norm.formattedPhone) {
          return {
            success: false,
            error: `Verified token phone (${verifiedPhone}) does not match submitted phone (${norm.formattedPhone})`
          };
        }

        const now = Date.now();
        // Sync to Firestore
        if (userId && !userId.startsWith('anon_')) {
          await this.syncVerifiedPhone(userId, verifiedPhone);
        }

        return {
          success: true,
          phone: verifiedPhone,
          provider: 'firebase',
          verifiedAt: now
        };
      } catch (err: any) {
        console.error('[FirebasePhoneProvider] ID Token verification failed:', err.message);
        return { success: false, error: 'Invalid or expired Firebase authentication token.' };
      }
    }

    // 4. Strict Development-Only OTP Bypass
    // Allows any non-empty OTP code to pass during local development/testing without requiring real SMS delivery
    if (DevOtpBypassService.isDevOtpBypassActive()) {
      const now = Date.now();
      if (userId && !userId.startsWith('anon_')) {
        await this.syncVerifiedPhone(userId, norm.formattedPhone);
      }
      return {
        success: true,
        phone: norm.formattedPhone,
        provider: 'dev_bypass',
        verifiedAt: now
      };
    }

    // 5. Test / Sandbox phone numbers in development mode
    if (this.isDevelopment) {
      const isTestPhone = norm.formattedPhone === '+919999999999' || norm.formattedPhone === '+918305500767' || norm.formattedPhone.endsWith('123456');
      if (isTestPhone && (code === '123456' || code === '000000')) {
        const now = Date.now();
        if (userId && !userId.startsWith('anon_')) {
          await this.syncVerifiedPhone(userId, norm.formattedPhone);
        }
        return {
          success: true,
          phone: norm.formattedPhone,
          provider: 'firebase_sandbox',
          verifiedAt: now
        };
      }
    }

    // 6. If passed numeric OTP without ID token in production, require client Firebase Auth confirmation
    return {
      success: false,
      error: 'Please verify the phone OTP using Firebase Phone Auth on your device.'
    };
  }

  /**
   * Syncs verified phone identity to Firestore collections
   */
  public async syncVerifiedPhone(uid: string, phone: string): Promise<void> {
    if (!uid || uid.startsWith('anon_') || uid.startsWith('test_') || process.env.NODE_ENV === 'test') {
      return;
    }
    try {
      const now = Date.now();
      const syncPromise = Promise.all([
        adminDb.collection('users').doc(uid).set({
          phone,
          phoneVerified: true,
          verificationMethod: 'firebase',
          verifiedAt: now,
          phoneSetupCompleted: true
        }, { merge: true }),
        adminDb.collection('customer_identities').doc(phone).set({
          primaryUid: uid,
          verifiedAt: now
        }, { merge: true })
      ]);

      // Protect against hanging Firestore network calls (timeout after 3s)
      await Promise.race([
        syncPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore sync timeout')), 3000))
      ]);
    } catch (e: any) {
      console.warn('[FirebasePhoneProvider] Firestore sync notice:', e.message);
    }
  }
}
