import { pgPool } from '../config/postgres.js';
import { adminDb as db } from '../config/firebase.js';
import cron from 'node-cron';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';
import { distributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';

export class DataRetentionJob {
  public static async run(): Promise<void> {
    console.log('[DataRetentionJob] Starting cleanup...');
    const client = await pgPool.connect();
    
    try {
      // 1. Notification Cleanup: Keep only a week
      await client.query(`
        DELETE FROM notification_history 
        WHERE created_at < CURRENT_DATE - INTERVAL '7 days';
      `);
      
      // 2. Clear stuck notification queue items older than 6 hours
      await client.query(`
        DELETE FROM notification_queue 
        WHERE created_at < NOW() - INTERVAL '6 hours';
      `);
      
      // 3. Heartbeat Cleanup: Remove devices offline > 7 days
      await client.query(`
        DELETE FROM device_heartbeats
        WHERE last_seen < NOW() - INTERVAL '7 days';
      `);
      
      // 4. GPS Cleanup: Supabase is single source of truth for live GPS (handled via SupabaseGpsService)
      try {
        await SupabaseGpsService.pruneStaleNavigationPoints(5);
      } catch (gpsErr: any) {
        console.warn('[DataRetentionJob] Supabase GPS retention notice:', gpsErr.message);
      }
      
      // 5. Order Retention: Keep current and previous month only
      await client.query(`
        DELETE FROM background_tasks
        WHERE created_at < date_trunc('month', CURRENT_DATE) - INTERVAL '1 month';
      `);
      
      // Note: order_items deleted via CASCADE

      // 6. Firestore Reports & History Cleanup: Remove docs older than 2 months
      try {
        const twoMonthsAgo = Date.now() - (60 * 24 * 60 * 60 * 1000); // approx 60 days
        const batches = [];
        
        for (const collectionName of ['reports', 'monthly_reports']) {
          const snap = await db.collection(collectionName)
            .where('generatedAt', '<', twoMonthsAgo)
            .get();
            
          if (!snap.empty) {
            const batch = db.batch();
            snap.docs.forEach(doc => batch.delete(doc.ref));
            batches.push(batch.commit());
          }
        }
        await Promise.all(batches);
        console.log('[DataRetentionJob] Firestore reports & history cleaned up.');
      } catch (err) {
        console.error('[DataRetentionJob] Firestore cleanup failed:', err);
      }
      
      // 7. Navigation Telemetry Auto-Expiry Cleanup (5-minute retention after STOPPED / DELIVERED)
      // 7. Navigation Telemetry Auto-Expiry Cleanup (5-minute retention via Supabase)
      try {
        const pruned = await SupabaseGpsService.pruneStaleNavigationPoints(5);
        if (pruned > 0) {
          console.log(`[DataRetentionJob] Cleaned up ${pruned} expired navigation points in Supabase.`);
        }
      } catch (navErr: any) {
        console.warn('[DataRetentionJob] Navigation telemetry cleanup warning:', navErr.message);
      }

      console.log(`[DataRetentionJob] Cleanup completed successfully.`);
    } catch (err) {
      console.error('[DataRetentionJob] Failed:', err);
    } finally {
      client.release();
    }
  }

  /**
   * Enforces 5-Minute High-Frequency GPS Telemetry Retention Rule:
   * - Deletes raw GPS breadcrumb points in Supabase `navigation_points` older than 5 minutes.
   * - Supabase is the EXCLUSIVE database for live GPS telemetry and breadcrumbs.
   * - Permanent business records (`orders`, `delivery_history`, `payments`) in PostgreSQL are NEVER deleted.
   */
  public static async runNavigationCleanup(): Promise<{ deletedPoints: number; deletedSessions: number }> {
    let deletedPoints = 0;
    try {
      deletedPoints = await SupabaseGpsService.pruneStaleNavigationPoints(5);
      if (deletedPoints > 0) {
        console.log(`[DataRetentionJob] 5-min Supabase GPS retention: Purged ${deletedPoints} stale breadcrumbs.`);
      }
    } catch (e: any) {
      console.warn('[DataRetentionJob] Navigation telemetry cleanup warning:', e.message);
    }
    return { deletedPoints, deletedSessions: 0 };
  }

  public static schedule() {
    // Run daily at 2:00 AM for full retention scan (coordinated across cluster)
    cron.schedule('0 2 * * *', () => {
      distributedJobCoordinator.runScheduledSingleton('data_retention_daily', 600, async () => {
        await DataRetentionJob.run();
      });
    });

    // Run every minute to enforce 5-minute navigation telemetry expiry (coordinated across cluster)
    cron.schedule('* * * * *', () => {
      distributedJobCoordinator.runScheduledSingleton('navigation_cleanup_minutely', 50, async () => {
        await DataRetentionJob.runNavigationCleanup();
      });
    });
  }
}
