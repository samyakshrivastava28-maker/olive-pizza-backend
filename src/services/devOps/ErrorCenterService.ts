/**
 * ErrorCenterService — Centralized Exception & Failure Operations Center
 *
 * Automatically captures exceptions, failed jobs, queue failures, notification errors,
 * email errors, AI failures, and database pings.
 *
 * Features:
 *  - Stack trace viewer (restricted to developer)
 *  - Automated root cause classification & suggested fix recommendations
 *  - Retry trigger for failed items
 *  - Mark resolved status tracking
 */

import { pgPool } from '../../config/postgres.js';
import { DevAuditService } from './DevAuditService.js';

export interface PlatformErrorItem {
  id: number;
  module: string;
  action: string;
  errorMessage: string;
  stackTrace?: string;
  rootCauseCategory: string;
  suggestedFix: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'MUTED';
  retryCount: number;
  contextJson?: any;
  createdAt: string;
  resolvedAt?: string;
}

export class ErrorCenterService {
  private static tableInitialized = false;

  public static async initTable() {
    if (this.tableInitialized) return;
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS platform_error_logs (
          id SERIAL PRIMARY KEY,
          module VARCHAR(100) NOT NULL,
          action VARCHAR(100) NOT NULL,
          error_message TEXT NOT NULL,
          stack_trace TEXT,
          root_cause_category VARCHAR(100) DEFAULT 'UNKNOWN',
          suggested_fix TEXT,
          status VARCHAR(20) DEFAULT 'OPEN',
          retry_count INTEGER DEFAULT 0,
          context_json JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          resolved_at TIMESTAMP WITH TIME ZONE
        );

        CREATE INDEX IF NOT EXISTS idx_error_logs_module ON platform_error_logs(module);
        CREATE INDEX IF NOT EXISTS idx_error_logs_status ON platform_error_logs(status);
      `);
      this.tableInitialized = true;
    } catch (err: any) {
      console.error('[ErrorCenterService] Failed to init platform_error_logs:', err.message);
    }
  }

  public static async logException(module: string, action: string, error: Error | string, context?: any) {
    await this.initTable();
    try {
      const message = typeof error === 'string' ? error : error.message;
      const stack = typeof error === 'object' ? error.stack : undefined;

      const classification = this.classifyError(message);

      await pgPool.query(`
        INSERT INTO platform_error_logs 
          (module, action, error_message, stack_trace, root_cause_category, suggested_fix, context_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [module, action, message, stack || null, classification.category, classification.suggestedFix, context ? JSON.stringify(context) : null]);
    } catch (err: any) {
      console.error('[ErrorCenterService] Failed to log exception:', err.message);
    }
  }

  private static classifyError(message: string): { category: string; suggestedFix: string } {
    const msg = message.toLowerCase();
    if (msg.includes('smtp') || msg.includes('nodemailer') || msg.includes('connect etimedout')) {
      return {
        category: 'SMTP_NETWORK_TIMEOUT',
        suggestedFix: 'Verify SMTP credentials in env, check Gmail App Password validity, or reset Nodemailer transporter.'
      };
    }
    if (msg.includes('fcm') || msg.includes('messaging') || msg.includes('firebase-admin')) {
      return {
        category: 'FCM_PUSH_FAILURE',
        suggestedFix: 'Verify Firebase Admin Service Account credentials and clean expired device FCM tokens.'
      };
    }
    if (msg.includes('google drive') || msg.includes('drive')) {
      return {
        category: 'GOOGLE_DRIVE_API_ERROR',
        suggestedFix: 'Verify Google Drive OAuth refresh token or service account credentials in process.env.'
      };
    }
    if (msg.includes('postgres') || msg.includes('pool') || msg.includes('enetunreach')) {
      return {
        category: 'DATABASE_POOL_EXHAUSTION',
        suggestedFix: 'Check PostgreSQL connection pooler URL (use port 6543 for Supabase pooler on Render).'
      };
    }
    return {
      category: 'GENERAL_APPLICATION_ERROR',
      suggestedFix: 'Inspect the stack trace and check input parameters for null dereferences.'
    };
  }

  public static async listErrors(limit = 100, offset = 0, statusFilter = 'ALL'): Promise<{ errors: PlatformErrorItem[]; total: number }> {
    await this.initTable();
    try {
      let query = `SELECT * FROM platform_error_logs WHERE 1=1`;
      const params: any[] = [];
      let paramIdx = 1;

      if (statusFilter !== 'ALL') {
        query += ` AND status = $${paramIdx}`;
        params.push(statusFilter);
        paramIdx++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
      params.push(limit, offset);

      const res = await pgPool.query(query, params);
      const countRes = await pgPool.query(`SELECT COUNT(*) FROM platform_error_logs`);

      const errors: PlatformErrorItem[] = res.rows.map(r => ({
        id: r.id,
        module: r.module,
        action: r.action,
        errorMessage: r.error_message,
        stackTrace: r.stack_trace,
        rootCauseCategory: r.root_cause_category,
        suggestedFix: r.suggested_fix,
        status: r.status,
        retryCount: r.retry_count,
        contextJson: r.context_json,
        createdAt: new Date(r.created_at).toISOString(),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined
      }));

      return { errors, total: parseInt(countRes.rows[0]?.count || '0', 10) };
    } catch (err: any) {
      console.error('[ErrorCenterService] List errors failed:', err.message);
      return { errors: [], total: 0 };
    }
  }

  public static async resolveError(errorId: number, developerEmail: string): Promise<{ success: boolean; error?: string }> {
    await this.initTable();
    try {
      await pgPool.query(`
        UPDATE platform_error_logs 
        SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP 
        WHERE id = $1
      `, [errorId]);

      await DevAuditService.logAction({
        developerEmail,
        actionType: 'RESOLVE_ERROR',
        targetModule: `error:${errorId}`,
        status: 'SUCCESS'
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
