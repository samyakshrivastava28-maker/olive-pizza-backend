import { adminDb } from '../../config/firebase.js';

export type AuthAuditEventType =
  | 'LOGIN_ATTEMPT'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGIN_RATE_LIMITED'
  | 'EMAIL_CODE_REQUESTED'
  | 'EMAIL_CODE_VERIFIED'
  | 'EMAIL_CODE_FAILED'
  | 'APP_AUTHORIZE_SUCCESS'
  | 'APP_AUTHORIZE_DENIED'
  | 'POS_ACCOUNT_CREATED'
  | 'POS_ACCOUNT_APPROVED'
  | 'POS_ACCOUNT_REJECTED'
  | 'POS_ACCOUNT_REVOKED'
  | 'POS_PIN_SETUP'
  | 'POS_PIN_VERIFIED'
  | 'POS_PIN_FAILED'
  | 'POS_PIN_LOCKED'
  | 'POS_ACCESS_REQUESTED'
  | 'POS_REQUEST_APPROVED'
  | 'POS_REQUEST_REJECTED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_APPROVED'
  | 'PASSWORD_RESET_REJECTED';

export interface AuthAuditLogEntry {
  eventType: AuthAuditEventType;
  userId?: string;
  identifier?: string; // email or phone, sanitized
  ipAddress?: string;
  userAgent?: string;
  appTarget?: string;
  franchiseId?: string;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  metadata?: Record<string, any>;
  timestamp?: number;
}

export class AuthAuditService {
  private static readonly COLLECTION = 'auth_audit_logs';

  /**
   * Log an authentication or authorization event securely.
   * Strips any potential sensitive keys (password, pin, code, secret, token).
   */
  public static async logEvent(entry: AuthAuditLogEntry): Promise<void> {
    try {
      if (!adminDb) return;

      const sanitizedMetadata = entry.metadata ? this.sanitize(entry.metadata) : {};

      const record = {
        eventType: entry.eventType,
        userId: entry.userId || null,
        identifier: entry.identifier ? entry.identifier.toLowerCase().trim() : null,
        ipAddress: entry.ipAddress || null,
        userAgent: entry.userAgent || null,
        appTarget: entry.appTarget || null,
        franchiseId: entry.franchiseId || null,
        status: entry.status,
        metadata: sanitizedMetadata,
        createdAt: new Date().toISOString(),
        timestamp: entry.timestamp || Date.now(),
      };

      await Promise.race([
        adminDb.collection(this.COLLECTION).add(record),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Audit write timeout')), 1000))
      ]);
    } catch (err) {
      console.warn('[AuthAuditService] ⚠️ Audit log write skipped (timeout or quota):', (err as any)?.message || err);
    }
  }

  private static sanitize(obj: Record<string, any>): Record<string, any> {
    const sensitiveKeys = ['password', 'pin', 'code', 'token', 'secret', 'key', 'credential'];
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk))) {
        clean[k] = '[REDACTED]';
      } else if (typeof v === 'object' && v !== null) {
        clean[k] = this.sanitize(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}
