/**
 * DevAuditService — Immutable Developer Action Audit Logger
 *
 * Captures EVERY state-altering developer action with:
 *  - Who (developer email)
 *  - What (action_type, target_module)
 *  - Before & After state JSON
 *  - IP Address
 *  - Timestamp & Execution Status
 */

import { pgPool } from '../../config/postgres.js';

export interface AuditLogEntry {
  developerEmail: string;
  actionType: string;
  targetModule: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string;
  userAgent?: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  errorDetails?: string;
}

export class DevAuditService {
  private static tableInitialized = false;

  public static async initTable() {
    if (this.tableInitialized) return;
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS developer_audit_logs (
          id SERIAL PRIMARY KEY,
          developer_email VARCHAR(255) NOT NULL,
          action_type VARCHAR(100) NOT NULL,
          target_module VARCHAR(100) NOT NULL,
          before_state JSONB,
          after_state JSONB,
          ip_address VARCHAR(45),
          user_agent TEXT,
          status VARCHAR(20) DEFAULT 'SUCCESS',
          error_details TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_dev_audit_email ON developer_audit_logs(developer_email);
        CREATE INDEX IF NOT EXISTS idx_dev_audit_created ON developer_audit_logs(created_at DESC);
      `);
      this.tableInitialized = true;
      console.log('✅ PostgreSQL developer_audit_logs table verified.');
    } catch (err: any) {
      console.error('[DevAuditService] Failed to init developer_audit_logs table:', err.message);
    }
  }

  public static async logAction(entry: AuditLogEntry): Promise<number> {
    await this.initTable();
    try {
      const res = await pgPool.query(`
        INSERT INTO developer_audit_logs 
          (developer_email, action_type, target_module, before_state, after_state, ip_address, user_agent, status, error_details)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [
        entry.developerEmail,
        entry.actionType,
        entry.targetModule,
        entry.beforeState ? JSON.stringify(entry.beforeState) : null,
        entry.afterState ? JSON.stringify(entry.afterState) : null,
        entry.ipAddress || '127.0.0.1',
        entry.userAgent || 'Developer Console',
        entry.status,
        entry.errorDetails || null,
      ]);

      const logId = res.rows[0]?.id;
      console.log(`[DevAuditService] 📝 Action logged (ID: ${logId}): ${entry.developerEmail} -> ${entry.actionType} (${entry.targetModule})`);
      return logId;
    } catch (err: any) {
      console.error('[DevAuditService] Log write failed:', err.message);
      return -1;
    }
  }

  public static async getLogs(limit = 100, offset = 0, search = '') {
    await this.initTable();
    try {
      let query = `SELECT * FROM developer_audit_logs WHERE 1=1`;
      const params: any[] = [];
      let paramIndex = 1;

      if (search) {
        query += ` AND (action_type ILIKE $${paramIndex} OR target_module ILIKE $${paramIndex} OR developer_email ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const res = await pgPool.query(query, params);
      const countRes = await pgPool.query(`SELECT COUNT(*) FROM developer_audit_logs`);

      return {
        logs: res.rows,
        total: parseInt(countRes.rows[0]?.count || '0', 10)
      };
    } catch (err: any) {
      console.error('[DevAuditService] Get logs failed:', err.message);
      return { logs: [], total: 0 };
    }
  }
}
