import { query } from '../../lib/db.js';
import crypto from 'crypto';

export interface AuditLogEntry {
  paymentId?: string;
  orderId?: string;
  action: string;
  actorId?: string;
  actorRole?: string;
  details?: Record<string, any>;
  ipAddress?: string;
}

export class PaymentAuditLogger {
  public static async log(entry: AuditLogEntry): Promise<void> {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    console.log(`[PaymentAudit] [${entry.action}] PaymentID=${entry.paymentId || 'N/A'} Actor=${entry.actorId || 'system'}`);

    try {
      await query(`
        INSERT INTO payment_audit_logs (id, payment_id, order_id, action, actor_id, actor_role, details, ip_address, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        id,
        entry.paymentId || null,
        entry.orderId || null,
        entry.action,
        entry.actorId || 'system',
        entry.actorRole || 'system',
        JSON.stringify(entry.details || {}),
        entry.ipAddress || null,
        timestamp,
      ]);
    } catch (err: any) {
      console.warn('[PaymentAuditLogger] DB write skipped (DB table initializing or optional):', err.message);
    }
  }
}
