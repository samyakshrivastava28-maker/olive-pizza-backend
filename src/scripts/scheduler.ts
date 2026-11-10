import cron from 'node-cron';
import { DataExpiryJob } from '../jobs/DataExpiryJob.js';
import { OrderTimeoutWorker } from '../services/order/OrderTimeoutWorker.js';
import { DailySheetsSyncJob } from '../jobs/DailySheetsSyncJob.js';
import { AbandonedCartJob } from '../jobs/AbandonedCartJob.js';
import { MonthlyReportJob } from '../jobs/MonthlyReportJob.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { RiderWorkScheduleService } from '../services/delivery/RiderWorkScheduleService.js';

export function initScheduler() {
  RiderWorkScheduleService.init();
  // Initialize 10-minute unaccepted order auto-cancellation worker
  OrderTimeoutWorker.init();

  // Initialize durable order archival reconciliation worker (Phase 1.F)
  OrderPersistenceArchiveService.initWorker();

  // Initialize expiry engine
  DataExpiryJob.schedule();

  // Initialize 1st of month 00:05 AM report job
  MonthlyReportJob.init();

  // Initialize daily 00:00 AM Google Sheets sync job
  DailySheetsSyncJob.init();

  // Initialize hourly 8-hour abandoned cart push reminder
  AbandonedCartJob.init();

  // Daily cleanup of old GPS tracking data (older than 24 hours) at 3:00 AM via Supabase
  cron.schedule('0 3 * * *', async () => {
    console.log('[Scheduler] Running daily location cleanup...');
    try {
      const { SupabaseGpsService } = await import('../services/gps/SupabaseGpsService.js');
      const pruned = await SupabaseGpsService.pruneStaleNavigationPoints(1440); // 24 hours
      console.log(`[Scheduler] Supabase GPS location cleanup completed (${pruned} points pruned).`);
    } catch (error: any) {
      console.error('[Scheduler] Location cleanup error:', error.message);
    }
  });

  console.log('🗓️ [Scheduler] Automated background schedulers initialized.');
}
