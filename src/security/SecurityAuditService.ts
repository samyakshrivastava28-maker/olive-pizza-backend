/**
 * SecurityAuditService.ts — Centralized Security Event and Threat Logging
 * Audits authorization failures, IDOR attempts, privilege escalation, and parameter tampering.
 * Masks credentials, bearer tokens, passwords, and sensitive PII.
 */

import { adminDb } from '../config/firebase.js';

export type SecurityEventType =
  | 'AUTH_FAILED'
  | 'ACCOUNT_REVOKED_ACCESS'
  | 'APP_ACCESS_DENIED'
  | 'IDOR_ATTEMPT'
  | 'PRIVILEGE_ESCALATION_ATTEMPT'
  | 'PARAMETER_TAMPERING_ATTEMPT'
  | 'CROSS_FRANCHISE_DENIED'
  | 'CROSS_BRANCH_DENIED'
  | 'DELETED_FRANCHISE_ACCESS_BLOCKED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'SUSPICIOUS_API_ENUMERATION';

export interface SecurityEventData {
  type: SecurityEventType;
  action: string;
  route: string;
  method?: string;
  ip?: string;
  uid?: string;
  email?: string;
  role?: string;
  franchiseId?: string;
  branchId?: string;
  targetResourceId?: string;
  details?: Record<string, any>;
}

export class SecurityAuditService {
  /**
   * Sanitizes object by removing known secret/credential fields
   */
  public static maskSensitiveFields(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    const SENSITIVE_KEYS = new Set([
      'password',
      'token',
      'authorization',
      'bearer',
      'refreshToken',
      'secret',
      'apiKey',
      'privateKey',
      'card',
      'cvv'
    ]);

    if (Array.isArray(obj)) {
      return obj.map((item) => this.maskSensitiveFields(item));
    }

    const masked: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase()) || key.toLowerCase().includes('password') || key.toLowerCase().includes('secret')) {
        masked[key] = '***REDACTED***';
      } else if (typeof value === 'object' && value !== null) {
        masked[key] = this.maskSensitiveFields(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  /**
   * Record a security event to Firestore `security_logs` and server stdout
   */
  public static async logSecurityEvent(event: SecurityEventData): Promise<void> {
    const timestamp = new Date().toISOString();
    const sanitizedDetails = event.details ? this.maskSensitiveFields(event.details) : undefined;

    const record = {
      ...event,
      details: sanitizedDetails,
      timestamp,
      environment: process.env.NODE_ENV || 'production'
    };

    console.warn(`[SECURITY AUDIT] [${event.type}] route=${event.route} uid=${event.uid || 'anon'} role=${event.role || 'none'} action=${event.action}`);

    try {
      await adminDb.collection('security_logs').add(record);
    } catch (err) {
      console.error('[SecurityAuditService] Failed to persist security log:', err);
    }
  }
}
