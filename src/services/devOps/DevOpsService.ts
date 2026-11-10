/**
 * DevOpsService — Backend logic for Developer Dashboard
 *
 * Provides real-time metrics, queue health, notification diagnostics trace,
 * error logs inspection, feature flags management, and security audit logs.
 */
import { pgPool } from '../../config/postgres.js';
import { adminAuth, adminDb } from '../../config/firebase.js';

export interface SystemHealthMetrics {
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  nodeVersion: string;
  postgresPool: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  activeFcmTokensCount: number;
  notificationQueueStatus: Record<string, number>;
  emailQueueStatus: Record<string, number>;
  deadLetterCount?: number;
  lastSentEmailAt?: string | null;
}

export class DevOpsService {
  /**
   * Get complete real-time system health metrics
   */
  static async getSystemHealth(): Promise<SystemHealthMetrics> {
    const memoryUsage = process.memoryUsage();
    const uptimeSeconds = process.uptime();
    const nodeVersion = process.version;

    // PostgreSQL Pool stats
    const postgresPool = {
      totalCount: pgPool.totalCount,
      idleCount: pgPool.idleCount,
      waitingCount: pgPool.waitingCount,
    };

    // Active FCM tokens count
    let activeFcmTokensCount = 0;
    try {
      const res = await pgPool.query(`SELECT COUNT(*) as count FROM fcm_tokens WHERE is_active = TRUE`);
      activeFcmTokensCount = parseInt(res.rows[0]?.count || '0', 10);
    } catch (err: any) {
      console.warn('[DevOpsService] Failed to fetch fcm_tokens count:', err.message);
    }

    // Notification Queue Status Breakdown
    const notificationQueueStatus: Record<string, number> = {};
    try {
      const res = await pgPool.query(`SELECT status, COUNT(*) as count FROM notification_queue GROUP BY status`);
      res.rows.forEach((r: any) => {
        notificationQueueStatus[r.status] = parseInt(r.count, 10);
      });
    } catch (err: any) {
      console.warn('[DevOpsService] Failed to fetch notification_queue status:', err.message);
    }

    // Email Queue Status Breakdown
    const emailQueueStatus: Record<string, number> = {};
    let deadLetterCount = 0;
    let lastSentEmailAt: string | null = null;
    try {
      const res = await pgPool.query(`SELECT status, COUNT(*) as count FROM email_queue GROUP BY status`);
      res.rows.forEach((r: any) => {
        emailQueueStatus[r.status] = parseInt(r.count, 10);
      });

      const dlRes = await pgPool.query(`SELECT COUNT(*) as count FROM dead_letter_queue`);
      deadLetterCount = parseInt(dlRes.rows[0]?.count || '0', 10);

      const lastSentRes = await pgPool.query(`SELECT sent_at FROM email_queue WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1`);
      if (lastSentRes.rows.length > 0 && lastSentRes.rows[0].sent_at) {
        lastSentEmailAt = new Date(lastSentRes.rows[0].sent_at).toISOString();
      }
    } catch (err: any) {
      console.warn('[DevOpsService] Failed to fetch email_queue status:', err.message);
    }

    return {
      uptimeSeconds,
      memoryUsage,
      nodeVersion,
      postgresPool,
      activeFcmTokensCount,
      notificationQueueStatus,
      emailQueueStatus,
      deadLetterCount,
      lastSentEmailAt,
    };
  }

  /**
   * Manually retry a failed email from Developer Dashboard
   */
  static async retryFailedEmail(emailId: number) {
    try {
      await pgPool.query(`
        UPDATE email_queue 
        SET status = 'pending', retry_count = 0, last_error = NULL, retry_timestamp = CURRENT_TIMESTAMP 
        WHERE id = $1
      `, [emailId]);
      
      // Trigger queue processor immediately
      const { processEmailQueue } = await import('../email.service.js');
      setImmediate(() => processEmailQueue().catch(() => {}));

      return { success: true, message: `Email ID ${emailId} reset to pending and enqueued for retry.` };
    } catch (err: any) {
      console.error(`[DevOpsService] Failed to retry email ${emailId}:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Send a test developer alert email to webhub2811@gmail.com
   */
  static async sendTestDevAlert() {
    try {
      const { DevAlertService } = await import('../email/DevAlertService.js');
      const sent = await DevAlertService.sendAlert({
        service: 'Developer Dashboard',
        action: 'Manual System Diagnostic Test',
        error: 'Manual test trigger initiated from Developer Dashboard by lead developer.',
        context: { timestamp: new Date().toISOString(), nodeVersion: process.version }
      });
      return { success: sent, message: sent ? 'Developer alert sent to webhub2811@gmail.com' : 'Alert suppressed by rate-limit' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Trace an order's notification lifecycle across all stages
   */
  static async getNotificationDiagnostics(orderId?: string, limit = 50) {
    const client = await pgPool.connect();
    try {
      let query = `
        SELECT id, target_user_id, status, priority, tag, order_id, version, category, retry_count, created_at, updated_at, scheduled_at
        FROM notification_queue
      `;
      const params: any[] = [];
      if (orderId) {
        query += ` WHERE order_id = $1`;
        params.push(orderId);
      }
      query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const queueRes = await client.query(query, params);

      // Fetch recent notification_inbox items for context
      let inboxQuery = `SELECT id, user_id, tag, order_id, title, body, category, is_read, created_at FROM notification_inbox`;
      const inboxParams: any[] = [];
      if (orderId) {
        inboxQuery += ` WHERE order_id = $1`;
        inboxParams.push(orderId);
      }
      inboxQuery += ` ORDER BY created_at DESC LIMIT $${inboxParams.length + 1}`;
      inboxParams.push(limit);

      const inboxRes = await client.query(inboxQuery, inboxParams);

      return {
        queuedItems: queueRes.rows,
        inboxItems: inboxRes.rows,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Fetch live pipeline monitor logs for Developer Dashboard
   */
  static async getNotificationPipelineMonitorData(limit = 100) {
    const { NotificationLogger } = await import('../notification/NotificationLogger.js');
    const logs = NotificationLogger.getRecentLogs(limit);
    
    // Also fetch current queue status summary from DB
    let queueSummary: Record<string, number> = {};
    try {
      const res = await pgPool.query(`SELECT status, COUNT(*) as count FROM notification_queue GROUP BY status`);
      res.rows.forEach((r: any) => {
        queueSummary[r.status] = parseInt(r.count, 10);
      });
    } catch (e: any) {
      console.error('[DevOpsService] Error fetching queue summary:', e.message);
    }

    return {
      logs,
      queueSummary,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Fetch recent security logs from Firestore
   */
  static async getSecurityLogs(limit = 100) {
    try {
      const snap = await adminDb.collection('security_logs').orderBy('timestamp', 'desc').limit(limit).get();
      return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err: any) {
      console.error('[DevOpsService] Error fetching security logs:', err.message);
      return [];
    }
  }

  /**
   * Set custom claim `developer: true` for webhub2811@gmail.com
   */
  static async ensureDeveloperClaim(email: string) {
    try {
      const user = await adminAuth.getUserByEmail(email);
      const currentClaims = user.customClaims || {};
      if (!currentClaims.developer) {
        await adminAuth.setCustomUserClaims(user.uid, {
          ...currentClaims,
          developer: true,
        });
        console.log(`[DevOpsService] ✅ Developer claim set for ${email} (${user.uid})`);
        return { success: true, uid: user.uid, message: 'Developer claim added successfully' };
      }
      return { success: true, uid: user.uid, message: 'Developer claim already active' };
    } catch (err: any) {
      console.error(`[DevOpsService] Failed to set claim for ${email}:`, err.message);
      return { success: false, error: err.message };
    }
  }
}
