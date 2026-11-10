/**
 * DailySheetsSyncJob.ts — Daily Idempotent Google Sheets Synchronization Worker
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. SCHEDULE: Runs every day at 00:00 AM IST (Asia/Kolkata).
 * 2. SCOPE: Synchronizes the PREVIOUS DAY'S finalized orders (e.g. at 01 Oct 00:00, syncs 30 Sep orders).
 * 3. FRANCHISE ISOLATION: Orders are grouped by franchise and synced to dedicated franchise spreadsheets.
 * 4. STRICT IDEMPOTENCY: Powered by sheets_sync_audit in Firestore so reruns/retries never duplicate rows.
 * 5. RETRYABLE: Exposes syncDate(dateStr) for safe manual re-triggering.
 */

import cron from 'node-cron';
import { query } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';
import { FranchiseGoogleSheetsService } from '../services/reports/FranchiseGoogleSheetsService.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { distributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';

export interface DailySyncResult {
  date: string;
  franchiseId: string;
  totalOrders: number;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
  status: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED';
  error?: string;
}

export class DailySheetsSyncJob {
  private static isRunning = false;

  public static init() {
    // Cron: 00:00 AM every day (Asia/Kolkata timezone) coordinated across cluster
    cron.schedule('0 0 * * *', async () => {
      await distributedJobCoordinator.runScheduledSingleton('daily_sheets_sync_ist', 600, async () => {
        console.log('⏰ [DailySheetsSyncJob] Automated 00:00 AM IST daily Google Sheets sync triggered.');
        try {
          await DailySheetsSyncJob.syncPreviousDay();
          console.log('✅ [DailySheetsSyncJob] Daily Google Sheets sync completed successfully.');
        } catch (err: any) {
          console.error('❌ [DailySheetsSyncJob] Daily Google Sheets sync failed:', err.message);
        }
      });
    }, {
      timezone: 'Asia/Kolkata'
    });

    console.log('⏰ [DailySheetsSyncJob] Scheduled to run daily at 00:00 AM IST for previous day orders (distributed).');
  }

  /**
   * Synchronizes the previous calendar day's finalized orders in IST.
   */
  public static async syncPreviousDay(): Promise<DailySyncResult[]> {
    const now = new Date();
    // Calculate yesterday's date in IST
    const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const yesterday = new Date(istNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDateStr = BillingNumberService.getLocalDateString(yesterday);

    console.log(`[DailySheetsSyncJob] Synchronizing finalized orders for date: ${targetDateStr}`);
    return await this.syncDate(targetDateStr);
  }

  /**
   * Synchronizes orders for a specified date (YYYY-MM-DD) idempotently.
   */
  public static async syncDate(dateStr: string, specificFranchiseId?: string): Promise<DailySyncResult[]> {
    if (this.isRunning) {
      console.warn('[DailySheetsSyncJob] Job already running. Skipping concurrent run.');
      return [];
    }

    this.isRunning = true;
    const results: DailySyncResult[] = [];

    try {
      // 1. Fetch finalized orders for this date from PostgreSQL
      let orders: any[] = [];
      try {
        const pgRes = await query(
          `SELECT co.*, cb.permanent_bill_no, cb.bill_number, cb.daily_order_no
           FROM canonical_orders co
           LEFT JOIN canonical_bills cb ON cb.order_id = co.id
           WHERE co.order_date = $1::date
           ORDER BY co.permanent_bill_no ASC, co.created_at ASC;`,
          [dateStr]
        );
        orders = pgRes.rows;
      } catch (pgErr: any) {
        console.warn('[DailySheetsSyncJob] PostgreSQL lookup fallback to Firestore:', pgErr.message);
      }

      // Fallback to Firestore if PostgreSQL had no records
      if (orders.length === 0) {
        const fireSnap = await adminDb.collection('orders')
          .where('orderDateLocal', '==', dateStr)
          .get()
          .catch(() => ({ docs: [] } as any));

        orders = fireSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      }

      if (orders.length === 0) {
        console.log(`[DailySheetsSyncJob] No orders found for date: ${dateStr}. Sync complete.`);
        this.isRunning = false;
        return [{
          date: dateStr,
          franchiseId: specificFranchiseId || 'all',
          totalOrders: 0,
          syncedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          status: 'SUCCESS'
        }];
      }

      // 2. Group orders by franchiseId
      const franchiseBuckets = new Map<string, any[]>();
      for (const ord of orders) {
        const fId = ord.franchise_id || ord.franchiseId;
        if (!fId) {
          console.warn(`[DailySheetsSyncJob] Skipping unassigned order ${ord.id} - missing authoritative franchiseId`);
          continue;
        }
        if (specificFranchiseId && fId !== specificFranchiseId) continue;
        if (!franchiseBuckets.has(fId)) franchiseBuckets.set(fId, []);
        franchiseBuckets.get(fId)!.push(ord);
      }

      // 3. Process each franchise sheet idempotently
      for (const [fId, franchiseOrders] of franchiseBuckets.entries()) {
        let syncedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const rawOrder of franchiseOrders) {
          const orderId = rawOrder.id;
          const assignedBranchId = rawOrder.branch_id || rawOrder.branchId;
          if (!assignedBranchId) {
            console.warn(`[DailySheetsSyncJob] Skipping order ${orderId} - missing authoritative branchId`);
            failedCount++;
            continue;
          }
          const auditKey = `${fId}_${orderId}`;

          // Check if already synced in Firestore audit
          const auditDoc = await adminDb.collection('sheets_sync_audit').doc(auditKey).get();
          if (auditDoc.exists && auditDoc.data()?.synced) {
            skippedCount++;
            continue;
          }

          const orderPayload = {
            id: orderId,
            dailyOrderNumber: rawOrder.daily_order_no || rawOrder.dailyOrderNumber,
            orderNumber: rawOrder.order_number || rawOrder.orderNumber,
            permanentBillNo: rawOrder.permanent_bill_no || rawOrder.permanentBillNo,
            billNumber: rawOrder.bill_number || rawOrder.billNumber,
            createdAt: rawOrder.created_at || rawOrder.createdAt,
            orderSource: rawOrder.order_source || rawOrder.orderSource,
            fulfillmentType: rawOrder.order_type || rawOrder.fulfillmentType,
            tableNumber: rawOrder.table_number || rawOrder.tableNumber,
            customerName: rawOrder.customer_name || rawOrder.customerName,
            customerPhone: rawOrder.customer_phone || rawOrder.contactPhone || rawOrder.customerPhone,
            items: typeof rawOrder.items === 'string' ? JSON.parse(rawOrder.items) : (rawOrder.items || []),
            subtotal: Number(rawOrder.subtotal || 0),
            discountAmount: Number(rawOrder.discount_amount || rawOrder.discountAmount || 0),
            couponCode: rawOrder.coupon_code || rawOrder.couponCode,
            taxes: Number(rawOrder.tax_amount || rawOrder.taxes || 0),
            cgst: Number(rawOrder.cgst || 0),
            sgst: Number(rawOrder.sgst || 0),
            deliveryFee: Number(rawOrder.delivery_fee || rawOrder.deliveryFee || 0),
            totalAmount: Number(rawOrder.total_amount || rawOrder.totalAmount || 0),
            paymentMethod: rawOrder.payment_method || rawOrder.paymentMethod,
            paymentStatus: rawOrder.payment_status || rawOrder.paymentStatus,
            status: rawOrder.order_status || rawOrder.status,
            cashierName: rawOrder.cashier_name || rawOrder.cashierName,
            terminalId: rawOrder.terminal_id || rawOrder.terminalId,
            franchiseId: fId,
            branchId: assignedBranchId
          };

          const success = await FranchiseGoogleSheetsService.syncOrderToFranchise(orderPayload);
          if (success) {
            syncedCount++;
          } else {
            failedCount++;
          }
        }

        const syncResult: DailySyncResult = {
          date: dateStr,
          franchiseId: fId,
          totalOrders: franchiseOrders.length,
          syncedCount,
          skippedCount,
          failedCount,
          status: failedCount === 0 ? 'SUCCESS' : (syncedCount > 0 ? 'PARTIAL_SUCCESS' : 'FAILED')
        };

        // Record history log
        const historyId = `${dateStr}_${fId}`;
        await adminDb.collection('daily_sheets_sync_history').doc(historyId).set({
          ...syncResult,
          lastSyncedAt: new Date().toISOString()
        }, { merge: true });

        results.push(syncResult);
      }

      return results;
    } catch (err: any) {
      console.error(`[DailySheetsSyncJob] Critical error syncing date ${dateStr}:`, err.message);
      return [{
        date: dateStr,
        franchiseId: specificFranchiseId || 'all',
        totalOrders: 0,
        syncedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        status: 'FAILED',
        error: err.message
      }];
    } finally {
      this.isRunning = false;
    }
  }
}
