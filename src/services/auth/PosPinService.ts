import crypto from 'crypto';
import { adminDb } from '../../config/firebase.js';
import { AuthAuditService } from './AuthAuditService.js';

export interface PinVerifyResult {
  success: boolean;
  message: string;
  locked?: boolean;
  lockedUntil?: number;
  remainingAttempts?: number;
}

export class PosPinService {
  private static readonly COLLECTION = 'pos_pins';
  private static readonly MAX_FAILED_ATTEMPTS = 3;
  private static readonly LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout

  private static hashPin(pin: string, salt: string): string {
    return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
  }

  /**
   * Check if a 4-digit PIN is configured for the given POS user.
   */
  public static async checkPinStatus(posId: string): Promise<{ configured: boolean; locked: boolean; lockedUntil?: number }> {
    if (!adminDb || !posId) return { configured: false, locked: false };

    const ref = adminDb.collection(this.COLLECTION).doc(posId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { configured: false, locked: false };
    }

    const data = snap.data()!;
    const now = Date.now();
    const lockedUntil = data.lockedUntil || 0;
    const isLocked = now < lockedUntil;

    return {
      configured: true,
      locked: isLocked,
      lockedUntil: isLocked ? lockedUntil : undefined,
    };
  }

  /**
   * Set up or reset a 4-digit PIN for a POS account.
   */
  public static async setupPin(posId: string, pin: string): Promise<{ success: boolean; message: string }> {
    if (!posId) return { success: false, message: 'POS User ID is required.' };

    const cleanPin = pin ? pin.toString().trim() : '';
    if (!/^\d{4}$/.test(cleanPin)) {
      return { success: false, message: 'Operational PIN must be exactly 4 numeric digits.' };
    }

    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const salt = crypto.randomBytes(16).toString('hex');
    const pinHash = this.hashPin(cleanPin, salt);
    const now = new Date().toISOString();

    await adminDb.collection(this.COLLECTION).doc(posId).set({
      posId,
      pinHash,
      salt,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: now,
      createdAt: now,
    });

    // Update pos_accounts record flag
    try {
      await adminDb.collection('pos_accounts').doc(posId).update({
        pinConfigured: true,
        updatedAt: now,
      });
    } catch (err) {
      // It's okay if pos_accounts doesn't have it or doc ID differs
    }

    await AuthAuditService.logEvent({
      eventType: 'POS_PIN_SETUP',
      userId: posId,
      status: 'SUCCESS',
    });

    return { success: true, message: '4-digit operational PIN has been securely configured.' };
  }

  /**
   * Verify the 4-digit operational PIN entered by the operator.
   */
  public static async verifyPin(posId: string, pin: string, ipAddress: string = '127.0.0.1'): Promise<PinVerifyResult> {
    if (!posId || !pin) {
      return { success: false, message: 'POS User ID and PIN are required.' };
    }

    const cleanPin = pin.toString().trim();
    if (!/^\d{4}$/.test(cleanPin)) {
      return { success: false, message: 'PIN must be exactly 4 numeric digits.' };
    }

    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const ref = adminDb.collection(this.COLLECTION).doc(posId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'PIN not configured. Please set up your 4-digit PIN first.' };
    }

    const data = snap.data()!;
    const now = Date.now();

    // Check if account is locked out
    if (data.lockedUntil && now < data.lockedUntil) {
      const waitMinutes = Math.ceil((data.lockedUntil - now) / (60 * 1000));
      return {
        success: false,
        message: `Too many failed PIN attempts. PIN is locked for ${waitMinutes} more minutes.`,
        locked: true,
        lockedUntil: data.lockedUntil,
        remainingAttempts: 0,
      };
    }

    // Compare PIN hash
    const expectedHash = this.hashPin(cleanPin, data.salt);
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(expectedHash, 'utf8'),
      Buffer.from(data.pinHash, 'utf8')
    );

    if (!isMatch) {
      const currentFails = (data.failedAttempts || 0) + 1;
      const remaining = Math.max(0, this.MAX_FAILED_ATTEMPTS - currentFails);

      if (currentFails >= this.MAX_FAILED_ATTEMPTS) {
        const lockedUntil = now + this.LOCKOUT_DURATION_MS;
        await ref.update({
          failedAttempts: currentFails,
          lockedUntil,
          lastFailedAt: now,
        });

        await AuthAuditService.logEvent({
          eventType: 'POS_PIN_LOCKED',
          userId: posId,
          ipAddress,
          status: 'BLOCKED',
          metadata: { failedAttempts: currentFails, lockoutMinutes: 15 },
        });

        return {
          success: false,
          message: 'Too many failed attempts. PIN access is locked for 15 minutes.',
          locked: true,
          lockedUntil,
          remainingAttempts: 0,
        };
      }

      await ref.update({
        failedAttempts: currentFails,
        lastFailedAt: now,
      });

      await AuthAuditService.logEvent({
        eventType: 'POS_PIN_FAILED',
        userId: posId,
        ipAddress,
        status: 'FAILED',
        metadata: { remainingAttempts: remaining },
      });

      return {
        success: false,
        message: `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before lockout.`,
        remainingAttempts: remaining,
      };
    }

    // Successful match - reset failed attempts and unlock
    await ref.update({
      failedAttempts: 0,
      lockedUntil: null,
      lastVerifiedAt: now,
    });

    await AuthAuditService.logEvent({
      eventType: 'POS_PIN_VERIFIED',
      userId: posId,
      ipAddress,
      status: 'SUCCESS',
    });

    return {
      success: true,
      message: 'PIN verified successfully.',
      remainingAttempts: this.MAX_FAILED_ATTEMPTS,
    };
  }
}
