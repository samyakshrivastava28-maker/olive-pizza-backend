import crypto from 'crypto';
import { adminDb } from '../../config/firebase.js';
import { AuthAuditService } from './AuthAuditService.js';

export interface RateLimitStatus {
  allowed: boolean;
  attempts: number;
  remainingAttempts: number;
  retryAfterSeconds: number;
  code?: string;
  message?: string;
  deviceId?: string;
}

export class LoginRateLimiterService {
  private static readonly COLLECTION = 'device_login_rate_limits';
  public static readonly MAX_DEVICE_ATTEMPTS = 5; // Allow 5 attempts before temporary lock
  public static readonly MAX_IP_ATTEMPTS = 30;     // Secondary IP flood protection
  public static readonly WINDOW_MS = 15 * 60 * 1000; // 15 minutes rolling window

  /**
   * Resolves a stable device ID from client-provided headers/body,
   * or computes a fallback deterministic fingerprint from IP + User Agent.
   */
  public static resolveDeviceId(rawDeviceId?: string, ip?: string, userAgent?: string): string {
    const trimmed = (rawDeviceId || '').trim();
    if (trimmed.length >= 4) {
      return trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
    }
    const cleanIp = (ip || '127.0.0.1').trim();
    const cleanUa = (userAgent || 'unknown_agent').trim();
    const hash = crypto.createHash('sha256').update(`${cleanIp}:::${cleanUa}`).digest('hex').substring(0, 24);
    return `fp_${hash}`;
  }

  /**
   * Atomic check-and-consume for device authentication attempts.
   * Primary key: Device ID (5 attempts per 15 min).
   * Secondary key: IP address (30 attempts per 15 min).
   * Uses Firestore transactions for concurrency safety.
   */
  public static async consumeAttempt(
    rawDeviceId?: string,
    ipAddress?: string,
    userAgent?: string,
    identifier?: string,
    targetApp?: string
  ): Promise<RateLimitStatus> {
    const clientIp = (ipAddress || '127.0.0.1').trim();
    const deviceId = this.resolveDeviceId(rawDeviceId, clientIp, userAgent);
    const cleanIp = clientIp.replace(/[^a-zA-Z0-9_]/g, '_');

    if (!adminDb) {
      return {
        allowed: true,
        attempts: 1,
        remainingAttempts: this.MAX_DEVICE_ATTEMPTS - 1,
        retryAfterSeconds: 0,
        deviceId
      };
    }


    const now = Date.now();
    const devDocRef = adminDb.collection(this.COLLECTION).doc(`dev_${deviceId}`);
    const ipDocRef = adminDb.collection(this.COLLECTION).doc(`ip_${cleanIp}`);

    try {
      return await adminDb.runTransaction(async (txn) => {
        const [devSnap, ipSnap] = await Promise.all([
          txn.get(devDocRef),
          txn.get(ipDocRef)
        ]);

        // 1. Check secondary IP rate limit (Flood/DDoS protection)
        if (ipSnap.exists) {
          const ipData = ipSnap.data() || {};
          const ipFirstAttempt = ipData.firstAttemptAt || 0;
          const ipAttempts = ipData.attempts || 0;
          if (now - ipFirstAttempt <= this.WINDOW_MS && ipAttempts >= this.MAX_IP_ATTEMPTS) {
            const retryAfterSeconds = Math.max(1, Math.ceil((ipFirstAttempt + this.WINDOW_MS - now) / 1000));
            return {
              allowed: false,
              attempts: ipAttempts,
              remainingAttempts: 0,
              retryAfterSeconds,
              code: 'AUTH_RATE_LIMITED',
              message: 'Too many requests from this network. Please try again later.',
              deviceId
            };
          }
        }

        // 2. Check primary Device rate limit (Max 2 attempts per 15 min)
        let devAttempts = 0;
        let firstAttemptAt = now;
        let isExpired = true;

        if (devSnap.exists) {
          const devData = devSnap.data() || {};
          firstAttemptAt = devData.firstAttemptAt || now;
          devAttempts = devData.attempts || 0;
          isExpired = (now - firstAttemptAt > this.WINDOW_MS);
        }

        if (isExpired) {
          devAttempts = 0;
          firstAttemptAt = now;
        }

        // If device has already reached MAX_DEVICE_ATTEMPTS, block subsequent attempts
        if (devAttempts >= this.MAX_DEVICE_ATTEMPTS) {
          const retryAfterSeconds = Math.max(1, Math.ceil((firstAttemptAt + this.WINDOW_MS - now) / 1000));
          
          await AuthAuditService.logEvent({
            eventType: 'LOGIN_RATE_LIMITED',
            identifier: identifier || 'unknown',
            ipAddress: clientIp,
            appTarget: targetApp,
            status: 'BLOCKED',
            metadata: { deviceId, attempts: devAttempts, retryAfterSeconds }
          }).catch(() => {});

          return {
            allowed: false,
            attempts: devAttempts,
            remainingAttempts: 0,
            retryAfterSeconds,
            code: 'AUTH_RATE_LIMITED',
            message: `Too many login attempts from this device. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
            deviceId
          };
        }

        // Increment device attempt count
        const newDevAttempts = devAttempts + 1;
        txn.set(devDocRef, {
          deviceId,
          ipAddress: clientIp,
          userAgent: (userAgent || 'unknown').substring(0, 200),
          lastIdentifier: identifier ? identifier.toLowerCase().trim() : null,
          lastApp: targetApp || null,
          attempts: newDevAttempts,
          firstAttemptAt,
          lastAttemptAt: now,
          updatedAt: now
        }, { merge: true });

        // Increment IP attempt count
        let newIpAttempts = 1;
        let ipFirstAttemptAt = now;
        if (ipSnap.exists) {
          const ipData = ipSnap.data() || {};
          const existingIpFirst = ipData.firstAttemptAt || 0;
          if (now - existingIpFirst <= this.WINDOW_MS) {
            newIpAttempts = (ipData.attempts || 0) + 1;
            ipFirstAttemptAt = existingIpFirst;
          }
        }
        txn.set(ipDocRef, {
          ipAddress: clientIp,
          attempts: newIpAttempts,
          firstAttemptAt: ipFirstAttemptAt,
          lastAttemptAt: now,
          updatedAt: now
        }, { merge: true });

        return {
          allowed: true,
          attempts: newDevAttempts,
          remainingAttempts: Math.max(0, this.MAX_DEVICE_ATTEMPTS - newDevAttempts),
          retryAfterSeconds: 0,
          deviceId
        };
      });
    } catch (err) {
      console.error('[LoginRateLimiterService] Transaction error:', err);
      return {
        allowed: true,
        attempts: 1,
        remainingAttempts: 1,
        retryAfterSeconds: 0,
        deviceId
      };
    }
  }

  /**
   * Compatibility method: read-only limit check.
   */
  public static async checkLimit(identifier: string, ipAddress: string, rawDeviceId?: string, userAgent?: string): Promise<RateLimitStatus> {
    const clientIp = (ipAddress || '127.0.0.1').trim();
    const deviceId = this.resolveDeviceId(rawDeviceId, clientIp, userAgent);

    if (!adminDb) {
      return { allowed: true, attempts: 0, remainingAttempts: this.MAX_DEVICE_ATTEMPTS, retryAfterSeconds: 0, deviceId };
    }

    try {
      const docRef = adminDb.collection(this.COLLECTION).doc(`dev_${deviceId}`);
      const snap: any = await Promise.race([
        docRef.get(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore rate check timeout')), 500))
      ]);
      if (!snap.exists) {
        return { allowed: true, attempts: 0, remainingAttempts: this.MAX_DEVICE_ATTEMPTS, retryAfterSeconds: 0, deviceId };
      }

      const data = snap.data() || {};
      const now = Date.now();
      const firstAttemptAt = data.firstAttemptAt || 0;
      const attempts = data.attempts || 0;

      if (now - firstAttemptAt > this.WINDOW_MS) {
        return { allowed: true, attempts: 0, remainingAttempts: this.MAX_DEVICE_ATTEMPTS, retryAfterSeconds: 0, deviceId };
      }

      if (attempts >= this.MAX_DEVICE_ATTEMPTS) {
        const retryAfterSeconds = Math.max(1, Math.ceil((firstAttemptAt + this.WINDOW_MS - now) / 1000));
        return {
          allowed: false,
          attempts,
          remainingAttempts: 0,
          retryAfterSeconds,
          code: 'AUTH_RATE_LIMITED',
          message: `Too many login attempts from this device. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
          deviceId
        };
      }

      return {
        allowed: true,
        attempts,
        remainingAttempts: Math.max(0, this.MAX_DEVICE_ATTEMPTS - attempts),
        retryAfterSeconds: 0,
        deviceId
      };
    } catch (err: any) {
      console.warn('[LoginRateLimiterService] checkLimit graceful fallback on Firestore notice:', err.message);
      return { allowed: true, attempts: 0, remainingAttempts: this.MAX_DEVICE_ATTEMPTS, retryAfterSeconds: 0, deviceId };
    }
  }

  /**
   * Compatibility method: record attempt.
   */
  public static async recordAttempt(identifier: string, ipAddress: string, rawDeviceId?: string, userAgent?: string): Promise<number> {
    const result = await this.consumeAttempt(rawDeviceId, ipAddress, userAgent, identifier);
    return result.attempts;
  }

  /**
   * Compatibility method: record success.
   */
  public static async recordSuccess(identifier: string, ipAddress: string, rawDeviceId?: string, userAgent?: string): Promise<void> {
    const clientIp = (ipAddress || '127.0.0.1').trim();
    const deviceId = this.resolveDeviceId(rawDeviceId, clientIp, userAgent);
    const cleanIp = clientIp.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!adminDb) return;
    try {
      await Promise.all([
        adminDb.collection(this.COLLECTION).doc(`dev_${deviceId}`).delete().catch(() => {}),
        adminDb.collection(this.COLLECTION).doc(`ip_${cleanIp}`).delete().catch(() => {})
      ]);
    } catch {
      // Non-critical
    }
  }
}
