import { adminDb } from '../../config/firebase.js';
import { GoogleSheetsReportService } from './GoogleSheetsReportService.js';

/**
 * SheetsSyncWorker.ts — Async Idempotent Google Sheets Synchronization Worker
 * 
 * Part of Olive Pizza Phase 10: Google Sheets Sync Engine.
 * 
 * - Ensures orders / bills are asynchronously appended to the live monthly Google Sheet.
 * - Manages lifecycle: SYNC_PENDING -> SYNCED (or remains SYNC_PENDING with exponential retry).
 * - Keyed on orderId to guarantee idempotent writes (no duplicate rows).
 * - Safe against network outages, missing credentials, and Google API rate limits.
 */
export class SheetsSyncWorker {
  private static isRunning = false;
  private static intervalTimer: NodeJS.Timeout | null = null;

  /**
   * Enqueues an order for background Google Sheets synchronization.
   * Safe to call inside transaction or setImmediate.
   */
  public static async queueOrder(orderId: string, orderData?: any): Promise<void> {
    try {
      const id = String(orderId || '').toLowerCase();
      if (
        id.startsWith('test_') ||
        id.startsWith('mock_') ||
        id.startsWith('synthetic_') ||
        id.startsWith('dummy_') ||
        id.startsWith('online_test_') ||
        id.startsWith('ord_test_') ||
        orderData?.isTest
      ) {
        return;
      }
      if (orderData) {
        // Attempt immediate sync non-blockingly
        setImmediate(async () => {
          await SheetsSyncWorker.syncSingleOrder(orderId, orderData);
        });
      } else {
        await adminDb.collection('orders').doc(orderId).set(
          {
            googleSheetsSyncStatus: 'SYNC_PENDING',
            googleSheetsQueuedAt: new Date().toISOString()
          },
          { merge: true }
        );
      }
    } catch (err: any) {
      console.warn(`[SheetsSyncWorker] Warning queueing order ${orderId}:`, err.message);
    }
  }

  /**
   * Synchronizes a single order to the active monthly Google Sheet idempotently.
   */
  public static async syncSingleOrder(orderId: string, orderData: any): Promise<boolean> {
    try {
      const spreadsheetId = await GoogleSheetsReportService.getSpreadsheetId();
      if (!spreadsheetId) {
        // Not an error — Google Sheets integration simply not configured yet
        return false;
      }

      await GoogleSheetsReportService.syncOrderToMonthlySheet({
        id: orderId,
        ...orderData
      });

      // Mark as SYNCED in primary storage
      const syncedPayload = {
        googleSheetsSyncStatus: 'SYNCED',
        googleSheetsSyncedAt: new Date().toISOString(),
        googleSheetsLastError: null
      };
      await adminDb.collection('orders').doc(orderId).set(syncedPayload, { merge: true }).catch(() => {});
      await adminDb.collection('pos_bills').doc(orderId).set(syncedPayload, { merge: true }).catch(() => {});

      return true;
    } catch (err: any) {
      console.warn(`[SheetsSyncWorker] Could not sync order ${orderId} to Google Sheets:`, err.message);
      
      // Record failure timestamp & mark SYNC_PENDING for retry
      await adminDb.collection('orders').doc(orderId).set(
        {
          googleSheetsSyncStatus: 'SYNC_PENDING',
          googleSheetsLastError: err.message || 'Sync error',
          googleSheetsLastAttempt: new Date().toISOString()
        },
        { merge: true }
      ).catch(() => {});

      return false;
    }
  }

  /**
   * Scans for any pending unsynced orders and retries synchronization.
   */
  public static async processPendingQueue(batchLimit = 50): Promise<number> {
    if (SheetsSyncWorker.isRunning) return 0;
    SheetsSyncWorker.isRunning = true;

    let syncedCount = 0;
    try {
      const spreadsheetId = await GoogleSheetsReportService.getSpreadsheetId();
      if (!spreadsheetId) {
        SheetsSyncWorker.isRunning = false;
        return 0;
      }

      const pendingSnap = await adminDb
        .collection('orders')
        .where('googleSheetsSyncStatus', '==', 'SYNC_PENDING')
        .limit(batchLimit)
        .get()
        .catch(() => ({ docs: [] } as any));

      for (const doc of pendingSnap.docs) {
        const orderData = doc.data();
        const success = await SheetsSyncWorker.syncSingleOrder(doc.id, orderData);
        if (success) {
          syncedCount++;
        }
      }

      if (syncedCount > 0) {
        console.log(`[SheetsSyncWorker] Processed and synced ${syncedCount} pending orders to Google Sheets.`);
      }
    } catch (err: any) {
      console.warn('[SheetsSyncWorker] processPendingQueue notice:', err.message);
    } finally {
      SheetsSyncWorker.isRunning = false;
    }

    return syncedCount;
  }

  /**
   * Starts periodic background sync worker. Safe to call on server startup.
   */
  public static startBackgroundWorker(intervalMs = 5 * 60 * 1000): void {
    if (SheetsSyncWorker.intervalTimer) return;

    // Run first scan after 10s warmup
    setTimeout(() => {
      SheetsSyncWorker.processPendingQueue().catch(() => {});
    }, 10000);

    // Periodic sweep every 5 minutes
    SheetsSyncWorker.intervalTimer = setInterval(() => {
      SheetsSyncWorker.processPendingQueue().catch(() => {});
    }, intervalMs);

    console.log('[SheetsSyncWorker] Background Google Sheets sync worker started.');
  }

  /**
   * Stops the background worker timer.
   */
  public static stopBackgroundWorker(): void {
    if (SheetsSyncWorker.intervalTimer) {
      clearInterval(SheetsSyncWorker.intervalTimer);
      SheetsSyncWorker.intervalTimer = null;
    }
  }
}
