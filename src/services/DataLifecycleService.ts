import cron from 'node-cron';
import { pgPool } from '../config/postgres.js';
import { SupabaseGpsService } from './gps/SupabaseGpsService.js';

export class DataLifecycleService {
  constructor() {
    this.initCronJobs();
  }

  private initCronJobs() {
    // Run minutely for highly time-sensitive realtime tracking cleanup & job_run_details pruning
    cron.schedule('* * * * *', () => {
      this.runMinutelyCleanup();
    });

    // Run hourly for temporary queue cleanup
    cron.schedule('0 * * * *', () => {
      this.runHourlyCleanup();
    });

    // Run every night at 3 AM for aggressive history & pg_cron pruning
    cron.schedule('0 3 * * *', () => {
      this.runNightlyCleanup();
    });
  }

  /**
   * Cleans up GPS data, realtime tracking, and pg_cron job_run_details strictly every minute
   */
  public async runMinutelyCleanup() {
    let client: any = null;
    try {
      // 0. Prune authoritative Supabase GPS breadcrumbs older than 5 minutes (Section 24 & 25)
      await SupabaseGpsService.pruneStaleNavigationPoints(5).catch(() => {});

      client = await pgPool.connect();

      // 4. Prune pg_cron job_run_details older than 12 hours to prevent runaway disk usage
      await client.query(`
        DELETE FROM cron.job_run_details 
        WHERE start_time < NOW() - INTERVAL '12 hours'
      `).catch(() => {});

      await client.query(`
        DELETE FROM job_run_details 
        WHERE start_time < NOW() - INTERVAL '12 hours'
      `).catch(() => {});

    } catch (error: any) {
      console.warn('[DataLifecycle] Warning during minutely cleanup:', error.message);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Schedules permanent deletion of realtime tracking data exactly 5 minutes after successful delivery
   */
  public schedulePostDeliveryCleanup(orderId: string, delayMs: number = 5 * 60 * 1000) {
    console.log(`[DataLifecycle] ⏰ Scheduled 5-minute delayed tracking purge for order "${orderId}"`);
    setTimeout(async () => {
      await this.deleteOrderTrackingDataPermanently(orderId);
    }, delayMs);
  }

  /**
   * Permanently deletes all realtime tracking data for a specific order from PostgreSQL and Firestore
   */
  public async deleteOrderTrackingDataPermanently(orderId: string): Promise<boolean> {
    if (!orderId) return false;
    console.log(`[DataLifecycle] 🗑️ Executing 5-min post-delivery tracking purge for order "${orderId}"...`);
    
    // 0. Supabase Authoritative GPS Telemetry Cleanup
    try {
      await SupabaseGpsService.cleanupDeliveredGps(orderId);
    } catch (err: any) {
      console.warn(`[DataLifecycle] Supabase GPS purge notice for "${orderId}":`, err.message);
    }

    // 0. Authoritative Supabase GPS Cleanup (Single Source of Truth)
    await SupabaseGpsService.cleanupDeliveredGps(orderId).catch(() => {});

    // 1. Firestore Realtime Projection Cleanup

    // 2. Firestore Cleanup
    try {
      const { adminDb } = await import('../config/firebase.js');
      await adminDb.collection('active_deliveries').doc(orderId).delete().catch(() => {});
      await adminDb.collection('delivery_locations').doc(orderId).delete().catch(() => {});
      console.log(`[DataLifecycle] ✅ Permanently deleted all realtime tracking data for order "${orderId}".`);
      return true;
    } catch (err: any) {
      console.warn(`[DataLifecycle] Firestore tracking purge notice for "${orderId}":`, err.message);
      return false;
    }
  }

  /**
   * Cleans up temporary state & old tracking points (strictly 1-day expiration)
   */
  public async runHourlyCleanup() {
    let client: any = null;
    try {
      client = await pgPool.connect();
      // 1. Clear old heartbeats (older than 24 hours / 1 day)
      await client.query(`
        DELETE FROM device_heartbeats WHERE last_seen < NOW() - INTERVAL '24 hours'
      `).catch(() => {});
      
      // 2. Clear expired checkout locks
      await client.query(`
        DELETE FROM checkout_locks WHERE expires_at < NOW()
      `).catch(() => {});

      // 3. Clear sent / failed notification queue items older than 24 hours (1 day)
      await client.query(`
        DELETE FROM notification_queue WHERE created_at < NOW() - INTERVAL '24 hours'
      `).catch(() => {});

      // 4. Clear sent / failed email queue items older than 24 hours (1 day)
      await client.query(`
        DELETE FROM email_queue WHERE created_at < NOW() - INTERVAL '24 hours'
      `).catch(() => {});
      
    } catch (error: any) {
      console.warn('[DataLifecycle] Warning during hourly cleanup:', error.message);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Aggressively prunes history & executes pg_cron cleanup to keep storage compact (Strict 1-Day Data Lifecycle)
   */
  public async runNightlyCleanup() {
    let client: any = null;
    try {
      client = await pgPool.connect();
      // 1. Enforce 1-day expiration for notification history
      await client.query(`
        DELETE FROM notification_history WHERE created_at < NOW() - INTERVAL '24 hours'
      `).catch(() => {});

      // 2. Enforce 1-day expiration for sent/failed emails
      await client.query(`
        DELETE FROM email_queue WHERE created_at < NOW() - INTERVAL '24 hours'
      `).catch(() => {});

      // 3. Purge pg_cron job_run_details older than 6 hours
      await client.query(`
        DELETE FROM cron.job_run_details WHERE start_time < NOW() - INTERVAL '6 hours'
      `).catch(() => {});

      await client.query(`
        DELETE FROM job_run_details WHERE start_time < NOW() - INTERVAL '6 hours'
      `).catch(() => {});

      // 4. Delete old analytics older than 30 days
      await client.query(`
        DELETE FROM website_analytics WHERE timestamp < CURRENT_DATE - INTERVAL '30 days'
      `).catch(() => {});
      
      console.log('[DataLifecycle] Nightly 1-day lifecycle pruning completed.');
    } catch (error: any) {
      console.warn('[DataLifecycle] Warning during nightly cleanup:', error.message);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Manual Purge API: Permanently deletes all old pg_cron job_run_details & realtime tracking logs
   */
  public async purgePostgresLogsAndReclaimSpace(): Promise<{
    success: boolean;
    cronJobLogsDeleted: number;
    realtimeTrackingDeleted: number;
    sentEmailsDeleted: number;
    notificationsDeleted: number;
    message: string;
  }> {
    let client: any = null;
    let cronJobLogsDeleted = 0;
    let realtimeTrackingDeleted = 0;
    let sentEmailsDeleted = 0;
    let notificationsDeleted = 0;

    try {
      client = await pgPool.connect();
      // 1. Delete pg_cron job_run_details
      const resCron1 = await client.query(`DELETE FROM cron.job_run_details WHERE start_time < NOW() - INTERVAL '1 hour'`).catch(() => ({ rowCount: 0 }));
      const resCron2 = await client.query(`DELETE FROM job_run_details WHERE start_time < NOW() - INTERVAL '1 hour'`).catch(() => ({ rowCount: 0 }));
      cronJobLogsDeleted = (resCron1.rowCount || 0) + (resCron2.rowCount || 0);

      // 2. Prune live navigation points in Supabase (authoritative GPS transport)
      const resHist = await SupabaseGpsService.pruneStaleNavigationPoints(720).catch(() => 0);
      realtimeTrackingDeleted = resHist || 0;

      // 3. Delete sent email queue records
      const resEmail = await client.query(`DELETE FROM email_queue WHERE status = 'sent' AND created_at < NOW() - INTERVAL '1 day'`).catch(() => ({ rowCount: 0 }));
      sentEmailsDeleted = resEmail.rowCount || 0;

      // 4. Delete old notifications
      const resNotif = await client.query(`DELETE FROM notification_queue WHERE status = 'sent' AND created_at < NOW() - INTERVAL '1 day'`).catch(() => ({ rowCount: 0 }));
      notificationsDeleted = resNotif.rowCount || 0;

      return {
        success: true,
        cronJobLogsDeleted,
        realtimeTrackingDeleted,
        sentEmailsDeleted,
        notificationsDeleted,
        message: `Successfully purged ${cronJobLogsDeleted} job_run_details logs, ${realtimeTrackingDeleted} realtime tracking logs, ${sentEmailsDeleted} sent emails, and ${notificationsDeleted} notification records from PostgreSQL.`
      };
    } catch (err: any) {
      console.error('[DataLifecycle] Manual purge error:', err.message);
      return {
        success: false,
        cronJobLogsDeleted: 0,
        realtimeTrackingDeleted: 0,
        sentEmailsDeleted: 0,
        notificationsDeleted: 0,
        message: `Purge failed: ${err.message}`
      };
    } finally {
      if (client) client.release();
    }
  }
}

export const dataLifecycleService = new DataLifecycleService();
