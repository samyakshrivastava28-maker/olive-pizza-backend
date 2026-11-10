/**
 * SchedulerManagerService — Cron Job & Background Task Operations Center
 *
 * Manages every background scheduled job:
 *  - Monthly Business Reports Generation & Emailing
 *  - Daily Google Sheets Finalized Orders Sync (00:00 AM IST)
 *  - 8-Hour Inactive Cart Push Reminder
 *  - Notification Queue Drainer
 *  - Email Queue Drainer
 *  - FCM Token Cleanup & Storage Analytics
 *
 * Features:
 *  - Pause / Resume
 *  - Run Now manual trigger
 *  - View execution history & next run times
 */

import { pgPool } from '../../config/postgres.js';
import { DevAuditService } from './DevAuditService.js';

export interface ScheduledCronJob {
  id: string;
  name: string;
  schedulePattern: string;
  status: 'RUNNING' | 'PAUSED' | 'IDLE';
  lastRunAt?: string;
  nextRunAt?: string;
  lastRunStatus?: 'SUCCESS' | 'FAILED';
  lastRunDurationMs?: number;
  description: string;
}

export class SchedulerManagerService {
  private static tableInitialized = false;

  public static async initTable() {
    if (this.tableInitialized) return;
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS scheduled_cron_jobs (
          id VARCHAR(100) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          schedule_pattern VARCHAR(100) NOT NULL,
          status VARCHAR(20) DEFAULT 'RUNNING',
          last_run_at TIMESTAMP WITH TIME ZONE,
          next_run_at TIMESTAMP WITH TIME ZONE,
          last_run_status VARCHAR(20) DEFAULT 'SUCCESS',
          last_run_duration_ms INTEGER DEFAULT 0,
          description TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await this.seedDefaults();
      this.tableInitialized = true;
    } catch (err: any) {
      console.error('[SchedulerManagerService] Failed to init tables:', err.message);
    }
  }

  private static async seedDefaults() {
    const jobs = [
      {
        id: 'monthly_business_report',
        name: 'Monthly Executive Report & Cloudflare R2 Backup',
        schedulePattern: '1st of Every Month @ 00:05 AM IST',
        description: 'Generates executive PDF report, backs up to Cloudflare R2, syncs Google Sheets, and dispatches scoped notifications.'
      },
      {
        id: 'email_queue_worker',
        name: 'Email Queue Background Worker',
        schedulePattern: 'Every 5 Seconds',
        description: 'Drains PostgreSQL email_queue and handles exponential backoff retries & dead letter routing.'
      },
      {
        id: 'notification_queue_worker',
        name: 'FCM Notification Queue Drainer',
        schedulePattern: 'LISTEN/NOTIFY + 5s Fallback',
        description: 'Dispatches queued FCM native notifications with sub-second priority latency.'
      },
      {
        id: 'fcm_token_cleanup',
        name: 'FCM Token Cleanup & Storage Analytics',
        schedulePattern: 'Every 24 Hours',
        description: 'Prunes invalid or expired FCM tokens and logs storage metrics to storage_analytics_daily.'
      },
      {
        id: 'daily_sheets_sync',
        name: 'Daily Google Sheets Finalized Orders Sync',
        schedulePattern: 'Every Day @ 00:00 AM IST',
        description: 'Syncs previous day finalized orders to franchise-separated Google Spreadsheets idempotently.'
      },
      {
        id: 'abandoned_cart_reminder',
        name: '8-Hour Inactive Cart Push Reminder',
        schedulePattern: 'Hourly Check (0 * * * *)',
        description: 'Identifies inactive carts (~8 hours), queries valid active coupons, and sends single personalized reminder.'
      }
    ];

    for (const j of jobs) {
      await pgPool.query(`
        INSERT INTO scheduled_cron_jobs (id, name, schedule_pattern, description, status)
        VALUES ($1, $2, $3, $4, 'RUNNING')
        ON CONFLICT (id) DO NOTHING
      `, [j.id, j.name, j.schedulePattern, j.description]);
    }
  }

  public static async listJobs(): Promise<ScheduledCronJob[]> {
    await this.initTable();
    try {
      const res = await pgPool.query(`SELECT * FROM scheduled_cron_jobs ORDER BY id ASC`);
      return res.rows.map(r => ({
        id: r.id,
        name: r.name,
        schedulePattern: r.schedule_pattern,
        status: r.status,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : undefined,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : undefined,
        lastRunStatus: r.last_run_status,
        lastRunDurationMs: r.last_run_duration_ms,
        description: r.description
      }));
    } catch (err: any) {
      console.error('[SchedulerManagerService] List jobs failed:', err.message);
      return [];
    }
  }

  public static async triggerJobNow(jobId: string, developerEmail: string): Promise<{ success: boolean; message?: string; error?: string }> {
    await this.initTable();
    const start = Date.now();
    try {
      if (jobId === 'monthly_business_report') {
        const { MonthlyReportJob } = await import('../../jobs/MonthlyReportJob.js');
        await MonthlyReportJob.runMonthEndPipeline();
      } else if (jobId === 'email_queue_worker') {
        const { processEmailQueue } = await import('../email.service.js');
        await processEmailQueue();
      } else if (jobId === 'notification_queue_worker') {
        const { notificationQueue } = await import('../notification/NotificationQueueService.js');
        await notificationQueue.runCleanup();
      } else if (jobId === 'fcm_token_cleanup') {
        const { fcmTokenCache } = await import('../notification/FCMTokenCache.js');
        await fcmTokenCache.cleanup();
      }

      const duration = Date.now() - start;

      await pgPool.query(`
        UPDATE scheduled_cron_jobs 
        SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'SUCCESS', last_run_duration_ms = $2
        WHERE id = $1
      `, [jobId, duration]);

      await DevAuditService.logAction({
        developerEmail,
        actionType: 'TRIGGER_CRON_JOB_NOW',
        targetModule: `cron:${jobId}`,
        status: 'SUCCESS'
      });

      return { success: true, message: `Cron job '${jobId}' executed successfully in ${duration}ms` };
    } catch (err: any) {
      await pgPool.query(`
        UPDATE scheduled_cron_jobs 
        SET last_run_at = CURRENT_TIMESTAMP, last_run_status = 'FAILED'
        WHERE id = $1
      `, [jobId]);

      return { success: false, error: err.message };
    }
  }
}
