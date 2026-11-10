import crypto from 'crypto';
import { adminDb, adminAuth } from '../../config/firebase.js';
import { queueEmail, sendEmailDirect } from '../email.service.js';
import { AuthAuditService } from './AuthAuditService.js';

export interface VerificationSendResult {
  success: boolean;
  message: string;
  expiresInSeconds?: number;
  retryAfterSeconds?: number;
  demoCode?: string;
  warning?: string;
}

export interface VerificationCheckResult {
  success: boolean;
  message: string;
}

export class EmailVerificationService {
  private static readonly COLLECTION = 'email_verification_codes';
  private static readonly CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes strict TTL
  private static readonly RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown
  private static readonly MAX_REQUESTS_15M = 3; // Max 3 code requests per 15 minutes
  private static readonly REQUEST_WINDOW_MS = 15 * 60 * 1000;
  private static readonly MAX_VERIFY_ATTEMPTS = 5; // Max 5 verification attempts per code

  private static getDocId(email: string): string {
    return email.toLowerCase().trim();
  }

  private static hashCode(code: string, salt: string): string {
    return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
  }

  /**
   * Alias for sendVerificationCode
   */
  public static async sendCode(email: string, purpose?: string, ipAddress: string = '127.0.0.1'): Promise<VerificationSendResult> {
    return this.sendVerificationCode(email, ipAddress);
  }

  /**
   * Request a 4-digit verification code sent to the specified email address.
   */
  public static async sendVerificationCode(email: string, ipAddress: string = '127.0.0.1'): Promise<VerificationSendResult> {
    if (!email || !email.includes('@')) {
      return { success: false, message: 'A valid email address is required.' };
    }

    const cleanEmail = email.toLowerCase().trim();
    const docId = this.getDocId(cleanEmail);
    const now = Date.now();

    if (!adminDb) {
      return { success: false, message: 'Database service unavailable.' };
    }

    const ref = adminDb.collection(this.COLLECTION).doc(docId);
    const snap = await ref.get();
    const existing = snap.data();

    // Check 60-second cooldown
    if (existing && existing.lastRequestedAt && (now - existing.lastRequestedAt < this.RESEND_COOLDOWN_MS)) {
      const waitSeconds = Math.ceil((this.RESEND_COOLDOWN_MS - (now - existing.lastRequestedAt)) / 1000);
      return {
        success: false,
        message: `Please wait ${waitSeconds} seconds before requesting a new code.`,
        retryAfterSeconds: waitSeconds,
      };
    }

    // Check 15-minute rate limit for code requests
    let requestCount = 1;
    let windowStart = now;
    if (existing && existing.windowStart && (now - existing.windowStart < this.REQUEST_WINDOW_MS)) {
      windowStart = existing.windowStart;
      requestCount = (existing.requestCount || 0) + 1;
      if (requestCount > this.MAX_REQUESTS_15M) {
        const waitSeconds = Math.ceil((windowStart + this.REQUEST_WINDOW_MS - now) / 1000);
        return {
          success: false,
          message: 'Too many verification requests. Please try again later.',
          retryAfterSeconds: waitSeconds,
        };
      }
    }

    // Generate cryptographically secure 4-digit code (1000 to 9999)
    const codeNumber = crypto.randomInt(1000, 10000);
    const code = codeNumber.toString();
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = this.hashCode(code, salt);
    const expiresAt = now + this.CODE_EXPIRY_MS;

    // Store salted hash at rest
    await ref.set({
      email: cleanEmail,
      codeHash,
      salt,
      expiresAt,
      lastRequestedAt: now,
      windowStart,
      requestCount,
      verifyAttempts: 0,
      attempts: 0,
      used: false,
      consumed: false,
      ipAddress,
    });

    // Send styled transactional email using existing direct transporter
    const emailHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #f0f0f0; box-shadow: 0 4px 20px rgba(0,0,0,0.05);">
        <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px 24px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px;">OLIVE PIZZA</h1>
          <p style="color: #d1fae5; margin: 6px 0 0 0; font-size: 14px; font-weight: 500;">Security Verification Code</p>
        </div>
        <div style="padding: 32px 28px;">
          <p style="color: #374151; font-size: 15px; line-height: 22px; margin: 0 0 20px 0;">
            Hello,
          </p>
          <p style="color: #374151; font-size: 15px; line-height: 22px; margin: 0 0 24px 0;">
            Use the following 4-digit security code to complete your verification with Olive Pizza. This code is confidential and valid for <strong>5 minutes</strong>.
          </p>
          <div style="background: #f3f4f6; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
            <span style="font-family: monospace; font-size: 38px; font-weight: 900; letter-spacing: 12px; color: #059669; display: inline-block; margin-left: 12px;">
              ${code}
            </span>
          </div>
          <div style="border-left: 4px solid #f59e0b; background: #fffbeb; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
            <p style="color: #92400e; font-size: 13px; margin: 0; line-height: 18px;">
              <strong>Security Notice:</strong> Never share this code with anyone. Olive Pizza staff will never ask you for your verification code.
            </p>
          </div>
          <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 18px; text-align: center;">
            If you did not request this verification, you can safely ignore this email.
          </p>
        </div>
        <div style="background: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #f3f4f6;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">
            © ${new Date().getFullYear()} Olive Pizza Ecosystem. All rights reserved.
          </p>
        </div>
      </div>
    `;

    // Dispatch email asynchronously using high-speed pooled SMTP queue (matching order emails)
    queueEmail(cleanEmail, 'Your Olive Pizza 4-Digit Verification Code', emailHtml, 'auth')
      .then((queueId) => {
        console.log(`[EmailVerificationService] ✅ Verification email queued for ${cleanEmail} (ID: ${queueId})`);
      })
      .catch((err: any) => {
        console.warn(`[EmailVerificationService] Queue error, using direct pooled SMTP send:`, err?.message);
        sendEmailDirect(cleanEmail, 'Your Olive Pizza 4-Digit Verification Code', emailHtml)
          .then(() => console.log(`[EmailVerificationService] ✅ Verification email delivered directly via SMTP to ${cleanEmail}`))
          .catch((directErr: any) => console.error('[EmailVerificationService] ❌ Failed to dispatch email via SMTP:', directErr?.message || directErr));
      });

    // Record audit event asynchronously
    AuthAuditService.logEvent({
      eventType: 'EMAIL_CODE_REQUESTED',
      identifier: cleanEmail,
      ipAddress,
      status: 'SUCCESS',
      metadata: { expiresInSeconds: 300, backgroundDispatched: true },
    }).catch(() => {});

    const isDevelopment = process.env.NODE_ENV !== 'production' || process.env.PHONE_AUTH_MODE === 'development';
    return {
      success: true,
      message: 'Verification code sent successfully. Valid for 5 minutes.',
      expiresInSeconds: 300,
      demoCode: isDevelopment ? code : undefined,
    };
  }

  /**
   * Verify the 4-digit code provided by the user.
   */
  public static async verifyCode(email: string, code: string, ipAddress: string = '127.0.0.1'): Promise<VerificationCheckResult> {
    if (!email || !code) {
      return { success: false, message: 'Email and 4-digit code are required.' };
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanCode = code.toString().trim();

    if (!/^\d{4}$/.test(cleanCode)) {
      return { success: false, message: 'Verification code must be exactly 4 digits.' };
    }

    if (!adminDb) {
      return { success: false, message: 'Database service unavailable.' };
    }

    const docId = this.getDocId(cleanEmail);
    const ref = adminDb.collection(this.COLLECTION).doc(docId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'No active verification code found for this email. Please request a code.' };
    }

    const data = snap.data()!;
    const now = Date.now();

    if (data.consumed || data.used) {
      return { success: false, message: 'This verification code has already been used. Please request a new code.' };
    }

    if (now > data.expiresAt) {
      return { success: false, message: 'Verification code has expired. Please request a new code.' };
    }

    const currentAttempts = (data.attempts !== undefined ? data.attempts : (data.verifyAttempts || 0)) + 1;
    if (currentAttempts > this.MAX_VERIFY_ATTEMPTS || (data.attempts !== undefined && data.attempts >= this.MAX_VERIFY_ATTEMPTS)) {
      // Invalidate code due to brute-force attempts
      await ref.update({ used: true, consumed: true, verifyAttempts: currentAttempts, attempts: currentAttempts });
      await AuthAuditService.logEvent({
        eventType: 'EMAIL_CODE_FAILED',
        identifier: cleanEmail,
        ipAddress,
        status: 'BLOCKED',
        metadata: { reason: 'MAX_ATTEMPTS_EXCEEDED' },
      });
      return { success: false, message: 'Maximum verification attempts exceeded. Please request a new code.' };
    }

    const expectedHash = this.hashCode(cleanCode, data.salt);
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(expectedHash, 'utf8'),
      Buffer.from(data.codeHash, 'utf8')
    );

    if (!isMatch) {
      await ref.update({ verifyAttempts: currentAttempts, attempts: currentAttempts });
      await AuthAuditService.logEvent({
        eventType: 'EMAIL_CODE_FAILED',
        identifier: cleanEmail,
        ipAddress,
        status: 'FAILED',
        metadata: { attempt: currentAttempts },
      });
      return { success: false, message: 'Incorrect verification code. Please check and try again.' };
    }

    // Mark code as used immediately (single-use)
    await ref.update({
      used: true,
      consumed: true,
      verifiedAt: now,
      verifyAttempts: currentAttempts,
      attempts: currentAttempts,
    });

    // Authoritatively mark user record as email verified in Firebase Auth and Firestore
    try {
      if (adminAuth) {
        const authUser = await adminAuth.getUserByEmail(cleanEmail).catch(() => null);
        if (authUser) {
          await adminAuth.updateUser(authUser.uid, { emailVerified: true }).catch(() => {});
        }
      }
      const userQuery = await adminDb.collection('users').where('email', '==', cleanEmail).limit(1).get();
      if (!userQuery.empty) {
        await userQuery.docs[0].ref.update({
          emailVerified: true,
          emailVerifiedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn('[EmailVerificationService] Notice: could not update auth/users collection flag:', err);
    }

    await AuthAuditService.logEvent({
      eventType: 'EMAIL_CODE_VERIFIED',
      identifier: cleanEmail,
      ipAddress,
      status: 'SUCCESS',
    });

    return { success: true, message: 'Email verified successfully.' };
  }
}
