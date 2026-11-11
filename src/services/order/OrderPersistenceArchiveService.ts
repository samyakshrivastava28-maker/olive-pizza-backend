/**
 * OrderPersistenceArchiveService.ts — Firestore-First Operational LifeCycle & PostgreSQL Archive Engine
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. FIRESTORE LIVE OPERATIONAL SOURCE: While an order is ACTIVE, Firestore is the authoritative
 *    operational source for all customer, restaurant, owner, delivery, and realtime listeners.
 * 2. POSTGRESQL DURABLE COPY: PostgreSQL receives a synchronized copy of every order.
 * 3. TERMINAL ORDER FINALIZATION & PURGE:
 *    - An order is terminal ONLY when it reaches DELIVERED or CANCELLED.
 *    - Before live Firestore deletion, PostgreSQL persistence is strictly verified:
 *      * Order row exists in canonical_orders with terminal status.
 *      * Bill exists in canonical_bills with matching total amount.
 *      * Audit log is recorded in order_audit_logs.
 *    - Firestore orders are retained while ACTIVE and are deleted only after PostgreSQL finalization has been verified.
 * 4. TRANSPARENT HISTORICAL LOOKUP:
 *    - Once purged from Firestore, customer and staff queries seamlessly fall back to PostgreSQL.
 * 5. SAFEGUARD WORKER: Periodically reconciles any unfinalized or pending orders.
 */

import crypto from 'crypto';
import { adminDb } from '../../config/firebase.js';
import { query, withTransaction } from '../../config/postgres.js';
import { BillingNumberService } from '../pos/BillingNumberService.js';
import { billingRepository } from '../../repositories/billing.repository.js';

export interface SyncResult {
  success: boolean;
  orderId: string;
  permanentBillNo?: number;
  dailyOrderNo?: number;
  error?: string;
}

export interface VerificationResult {
  verified: boolean;
  orderId: string;
  orderRowExists: boolean;
  billRowExists: boolean;
  statusMatches: boolean;
  totalMatches: boolean;
  permanentBillNo?: number;
  paymentConsistent?: boolean;
  itemsConsistent?: boolean;
  reason?: string;
}

export interface ArchiveResult {
  success: boolean;
  orderId: string;
  alreadyArchived?: boolean;
  deletedFromFirestore?: boolean;
  permanentBillNo?: number;
  error?: string;
}

export class OrderPersistenceArchiveService {
  private static quotaBackoffUntil = 0;
  /**
   * Synchronizes a live order into PostgreSQL canonical tables idempotently.
   * If PostgreSQL persistence fails, records the pending status in Firestore without breaking live flow.
   */
  public static async syncLiveOrderToPostgres(orderId: string, preloadedData?: any): Promise<SyncResult> {
    let orderData: any = preloadedData;
    try {
      if (!orderData) {
        const docSnap = await adminDb.collection('orders').doc(orderId).get();
        if (!docSnap.exists) {
          return { success: false, orderId, error: `Firestore order document ${orderId} does not exist.` };
        }
        orderData = docSnap.data();
      }

      const userId = orderData.userId || orderData.customerId || 'walk-in-customer';
      const customerPhone = orderData.contactPhone || orderData.customerPhone || orderData.phone || 'N/A';
      const customerName = orderData.customerName || 'Gourmet Customer';
      const userAddress = typeof orderData.deliveryAddress === 'string'
        ? orderData.deliveryAddress
        : (orderData.deliveryAddress?.addressLine || orderData.deliveryAddress?.fullAddress || 'Pickup');
      const tableNumber = orderData.tableNumber || null;

      const orderSource = (orderData.orderSource || orderData.source || 'ONLINE').toUpperCase();
      const orderType = (orderData.orderType || orderData.deliveryType || 'delivery').toLowerCase();
      const rawStatus = (orderData.status || 'pending').toLowerCase();

      // Normalize status for PostgreSQL canonical_orders
      let pgOrderStatus = 'PENDING';
      if (rawStatus === 'accepted') pgOrderStatus = 'ACCEPTED';
      else if (rawStatus === 'preparing') pgOrderStatus = 'PREPARING';
      else if (rawStatus === 'partner_assigned') pgOrderStatus = 'PREPARING';
      else if (rawStatus === 'ready') pgOrderStatus = 'READY';
      else if (rawStatus === 'picked_up' || rawStatus === 'out_for_delivery') pgOrderStatus = 'OUT_FOR_DELIVERY';
      else if (rawStatus === 'delivered') pgOrderStatus = 'DELIVERED';
      else if (rawStatus === 'cancelled' || rawStatus === 'rejected') pgOrderStatus = 'CANCELLED';

      const paymentMethod = (orderData.paymentMethod || 'COD').toUpperCase();
      // Validate payment status against permitted enum whitelist
      const VALID_PAYMENT_STATUSES = ['paid', 'pending', 'failed', 'refunded', 'cod_pending', 'cod_collected', 'waived', 'free'];
      const rawPaymentStatusLower = orderData.paymentStatus ? String(orderData.paymentStatus).toLowerCase() : null;
      if (rawPaymentStatusLower && !VALID_PAYMENT_STATUSES.includes(rawPaymentStatusLower)) {
        throw new Error(`[Archive] Refusing archive: invalid paymentStatus=${rawPaymentStatusLower} for order ${orderId}`);
      }

      let paymentStatus = 'PENDING';
      const rawPaymentStatus = orderData.paymentStatus ? String(orderData.paymentStatus).toUpperCase() : null;
      if (rawPaymentStatus === 'PAID') {
        paymentStatus = 'PAID';
      } else if (rawPaymentStatus === 'REFUNDED') {
        paymentStatus = 'REFUNDED';
      } else if (rawPaymentStatus === 'FAILED') {
        paymentStatus = 'FAILED';
      } else if (rawStatus === 'delivered' && paymentMethod === 'COD' && orderData.codCollected === true) {
        paymentStatus = 'PAID';
      } else if (rawStatus === 'cancelled' && rawPaymentStatus === 'PAID') {
        paymentStatus = 'REFUNDED';
      } else {
        paymentStatus = rawPaymentStatus || 'PENDING';
      }

      const subtotal = Number(orderData.subtotal || 0);
      const discountAmount = Number(orderData.discountAmount || 0);
      const couponCode = orderData.appliedCouponCode || orderData.couponCode || null;
      const taxAmount = Number(orderData.taxes || orderData.taxAmount || 0);
      const cgst = Number(orderData.cgst || Math.round(taxAmount / 2));
      const sgst = Number(orderData.sgst || (taxAmount - cgst));
      const deliveryFee = Number(orderData.deliveryFee || 0);
      const packagingCharge = Number(orderData.packagingCharge || 0);
      const totalAmount = Number(orderData.totalAmount || orderData.finalTotal || (subtotal - discountAmount + taxAmount + deliveryFee + packagingCharge));

      // Robust franchise and branch resolution: support snake_case and infer primary franchise for legacy orders
      const franchiseId = orderData.franchiseId || orderData.franchise_id || 'fra_rajnandgaon';
      const branchId = orderData.branchId || orderData.branch_id || 'branch_rjn_main';
      const cashierName = orderData.cashierName || (orderSource.startsWith('POS') ? 'Cashier' : 'Online App');
      const terminalId = orderData.terminalId || (orderSource.startsWith('POS') ? 'POS-TERM-01' : 'ONLINE-APP');
      const notes = orderData.notes || orderData.deliveryInstructions || '';

      // Determine or allocate permanent bill number & daily order number
      let permanentBillNo: number = Number(orderData.permanentBillNo || 0);
      let dailyOrderNo: number = Number(orderData.dailyOrderNumber || 0);
      let rawOrderDate = orderData.orderDateLocal || orderData.orderDate || BillingNumberService.getLocalDateString();
      if (typeof rawOrderDate === 'object' && rawOrderDate !== null) {
        if (rawOrderDate._seconds) rawOrderDate = new Date(rawOrderDate._seconds * 1000).toISOString().slice(0, 10);
        else if (rawOrderDate.toDate) rawOrderDate = rawOrderDate.toDate().toISOString().slice(0, 10);
        else rawOrderDate = BillingNumberService.getLocalDateString();
      }
      let orderDate: string = String(rawOrderDate).slice(0, 10);
      let orderTime: string = BillingNumberService.getLocalTimeString();

      if (!permanentBillNo || permanentBillNo <= 0) {
        try {
          const allocated = await BillingNumberService.allocateNumbers();
          permanentBillNo = allocated.permanentBillNo;
          dailyOrderNo = allocated.dailyOrderNo;
          orderDate = allocated.orderDate;
          orderTime = allocated.orderTime;
        } catch (numErr) {
          console.warn('[OrderPersistence] Number allocation warning:', numErr);
        }
      }

      // Execute atomic PostgreSQL write
      await withTransaction(async (client) => {
        // 0. Ensure order preserves existing allocated bill and daily order number
        const existRes = await client.query(`
          SELECT permanent_bill_no, daily_order_no, order_date, order_time FROM canonical_orders WHERE id = $1
        `, [orderId]);

        if (existRes.rows.length > 0) {
          permanentBillNo = parseInt(existRes.rows[0].permanent_bill_no, 10);
          dailyOrderNo = parseInt(existRes.rows[0].daily_order_no, 10);
        } else if (!permanentBillNo || permanentBillNo <= 0) {
          await client.query(`
            SELECT setval('permanent_bill_seq', GREATEST(
              (SELECT COALESCE(MAX(permanent_bill_no), 0) FROM canonical_orders),
              (SELECT last_value FROM permanent_bill_seq)
            ));
          `).catch(() => {});

          const seqRes = await client.query(`SELECT nextval('permanent_bill_seq') AS bill_no;`);
          permanentBillNo = parseInt(seqRes.rows[0].bill_no, 10);

          const dailyRes = await client.query(
            `SELECT get_next_daily_order_number($1::date) AS daily_no;`,
            [orderDate]
          );
          dailyOrderNo = parseInt(dailyRes.rows[0].daily_no, 10);
        }

        // 1. Upsert canonical order
        const estPrepMins = orderData.estimatedPreparationMinutes != null ? Number(orderData.estimatedPreparationMinutes) : null;
        const expReadyAt = orderData.expectedReadyAt || orderData.estimatedReadyAt || null;

        await client.query(`
          INSERT INTO canonical_orders (
            id, permanent_bill_no, daily_order_no, order_date, order_time,
            order_source, order_type, order_status, payment_method, payment_status,
            customer_name, customer_phone, delivery_address, table_number,
            subtotal, discount_amount, coupon_code, tax_amount, cgst, sgst,
            delivery_fee, total_amount, franchise_id, branch_id, cashier_id,
            cashier_name, terminal_id, notes, customer_id, delivered_at, live_lifecycle,
            estimated_preparation_minutes, expected_ready_at
          ) VALUES (
            $1, $2, $3, $4::date, $5::time,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25,
            $26, $27, $28, $29, $30, $31,
            $32, $33
          ) ON CONFLICT (id) DO UPDATE SET
            order_status = EXCLUDED.order_status,
            payment_status = EXCLUDED.payment_status,
            total_amount = EXCLUDED.total_amount,
            delivery_address = COALESCE(EXCLUDED.delivery_address, canonical_orders.delivery_address),
            customer_id = COALESCE(EXCLUDED.customer_id, canonical_orders.customer_id),
            delivered_at = COALESCE(EXCLUDED.delivered_at, canonical_orders.delivered_at),
            live_lifecycle = EXCLUDED.live_lifecycle,
            estimated_preparation_minutes = COALESCE(EXCLUDED.estimated_preparation_minutes, canonical_orders.estimated_preparation_minutes),
            expected_ready_at = COALESCE(EXCLUDED.expected_ready_at, canonical_orders.expected_ready_at),
            updated_at = NOW();
        `, [
          orderId, permanentBillNo, dailyOrderNo, orderDate, orderTime,
          orderSource, orderType, pgOrderStatus, paymentMethod, paymentStatus,
          customerName, customerPhone, userAddress, tableNumber,
          subtotal, discountAmount, couponCode, taxAmount, cgst, sgst,
          deliveryFee, totalAmount, franchiseId, branchId, orderData.cashierId || null,
          orderData.cashierName || null, orderData.terminalId || null, orderData.notes || null, orderData.customerId || orderData.userId || null,
          (rawStatus.toLowerCase() === 'delivered' || pgOrderStatus === 'DELIVERED') ? new Date() : null,
          (rawStatus.toLowerCase() === 'delivered' || rawStatus.toLowerCase() === 'cancelled' || pgOrderStatus === 'DELIVERED' || pgOrderStatus === 'CANCELLED') ? 'TERMINAL' : (orderData.live_lifecycle || 'ACTIVE'),
          estPrepMins,
          expReadyAt
        ]);

        // 2. Insert or upsert line items deterministically
        const rawItems = Array.isArray(orderData.items) ? orderData.items : [];
        const currentItemIds: string[] = [];

        for (let idx = 0; idx < rawItems.length; idx++) {
          const it = rawItems[idx];
          // Deterministic identity derived from orderId + lineIndex
          const itemId = `item_${orderId}_${idx}`;
          currentItemIds.push(itemId);

          const itName = it.name || it.productName || 'Pizza';
          const itQty = Math.max(1, Number(it.quantity) || 1);
          const itPrice = Number(it.price || it.unitPrice || 0);
          const lineTotal = Number(it.lineTotal || (itQty * itPrice));

          await client.query(`
            INSERT INTO canonical_order_items (
              id, order_id, menu_item_id, item_name, size_variant,
              crust, quantity, unit_price, addons_json, line_total
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9::jsonb, $10
            ) ON CONFLICT (id) DO UPDATE SET
              item_name = EXCLUDED.item_name,
              size_variant = EXCLUDED.size_variant,
              crust = EXCLUDED.crust,
              quantity = EXCLUDED.quantity,
              unit_price = EXCLUDED.unit_price,
              addons_json = EXCLUDED.addons_json,
              line_total = EXCLUDED.line_total;
          `, [
            itemId, orderId, it.menuItemId || it.id || null, itName,
            it.size || 'Regular', it.crust || 'Normal', itQty, itPrice,
            JSON.stringify(it.addons || []), lineTotal
          ]);
        }

        // Clean up any stale items for this order not in current payload
        if (currentItemIds.length > 0) {
          await client.query(`
            DELETE FROM canonical_order_items 
            WHERE order_id = $1 AND id != ALL($2::text[])
          `, [orderId, currentItemIds]);
        }

        // 3. Upsert canonical financial bill
        const billId = 'bill_' + orderId;
        const isCancelled = rawStatus === 'cancelled';
        await client.query(`
          INSERT INTO canonical_bills (
            id, permanent_bill_no, order_id, bill_date, subtotal,
            discount, tax, net_amount, payment_method, payment_status,
            is_cancelled, cancellation_reason
          ) VALUES (
            $1, $2, $3, $4::date, $5,
            $6, $7, $8, $9, $10,
            $11, $12
          ) ON CONFLICT (id) DO UPDATE SET
            payment_status = CASE
              WHEN canonical_bills.payment_status = 'PAID' AND EXCLUDED.payment_status IN ('PENDING', 'FAILED') THEN canonical_bills.payment_status
              WHEN canonical_bills.payment_status = 'REFUNDED' THEN canonical_bills.payment_status
              ELSE EXCLUDED.payment_status
            END,
            is_cancelled = EXCLUDED.is_cancelled,
            cancellation_reason = COALESCE(EXCLUDED.cancellation_reason, canonical_bills.cancellation_reason)
          WHERE canonical_bills.order_id = EXCLUDED.order_id
            AND canonical_bills.net_amount = EXCLUDED.net_amount;
        `, [
          billId, permanentBillNo, orderId, orderDate, subtotal,
          discountAmount, taxAmount, totalAmount, paymentMethod, paymentStatus,
          isCancelled, isCancelled ? (orderData.cancellationReason || 'CANCELLED') : null
        ]);

        // 4. Upsert payments record
        const paymentId = 'pay_' + orderId;
        await client.query(`
          INSERT INTO payments (
            id, order_id, user_id, provider, amount, currency, status, payment_method
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
          ) ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            amount = EXCLUDED.amount,
            updated_at = NOW();
        `, [
          paymentId, orderId, userId, paymentMethod, totalAmount, 'INR',
          paymentStatus === 'PAID' ? 'PAYMENT_CAPTURED' : (paymentStatus === 'REFUNDED' ? 'REFUNDED' : 'PENDING'),
          paymentMethod
        ]);
      });

      // Update Firestore with synchronization success
      const firestoreUpdates: Record<string, any> = {
        postgresPersistence: 'COMPLETE',
        postgresSyncedAt: new Date().toISOString(),
        postgresSyncError: null,
      };
      if (permanentBillNo && !orderData.permanentBillNo) {
        firestoreUpdates.permanentBillNo = permanentBillNo;
        firestoreUpdates.billNumber = `#${permanentBillNo}`;
      }
      if (dailyOrderNo && !orderData.dailyOrderNumber) {
        firestoreUpdates.dailyOrderNumber = dailyOrderNo;
        firestoreUpdates.orderNumber = `#${dailyOrderNo}`;
      }

      adminDb.collection('orders').doc(orderId).set(firestoreUpdates, { merge: true }).catch(() => {});

      return {
        success: true,
        orderId,
        permanentBillNo,
        dailyOrderNo
      };
    } catch (err: any) {
      console.warn(`[OrderPersistence] Failed syncing order ${orderId} to PostgreSQL:`, err.message);

      // Record sync error in Firestore without breaking the live order
      const syncAttempts = (orderData?.postgresSyncRetryCount || 0) + 1;
      const isFatal = err.message.includes('missing required') || syncAttempts >= 5;
      adminDb.collection('orders').doc(orderId).set({
        postgresPersistence: isFatal ? 'FAILED_VALIDATION' : 'PENDING',
        postgresSyncError: err.message,
        postgresSyncRetryCount: syncAttempts,
        lastPostgresSyncAttempt: new Date().toISOString()
      }, { merge: true }).catch(() => {});

      return {
        success: false,
        orderId,
        error: err.message
      };
    }
  }

  /**
   * Verifies that the order exists in PostgreSQL with authoritative matching totals and terminal status.
   */
  public static async verifyPostgresPersistence(
    orderId: string,
    expectedStatus: string,
    expectedTotal: number
  ): Promise<VerificationResult> {
    try {
      const orderRes = await query(
        `SELECT id, order_status, total_amount, permanent_bill_no, payment_status FROM canonical_orders WHERE id = $1`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        return {
          verified: false,
          orderId,
          orderRowExists: false,
          billRowExists: false,
          statusMatches: false,
          totalMatches: false,
          reason: `No row in canonical_orders for order ID ${orderId}`
        };
      }

      const orderRow = orderRes.rows[0];
      const billRes = await query(
        `SELECT id, net_amount, payment_status, is_cancelled, permanent_bill_no FROM canonical_bills WHERE order_id = $1`,
        [orderId]
      );

      if (billRes.rows.length === 0) {
        return {
          verified: false,
          orderId,
          orderRowExists: true,
          billRowExists: false,
          statusMatches: false,
          totalMatches: false,
          reason: `No row in canonical_bills for order ID ${orderId}`
        };
      }

      const normalizedExpectedStatus = expectedStatus.toUpperCase();
      const pgStatus = (orderRow.order_status || '').toUpperCase();
      const statusMatches = (
        (normalizedExpectedStatus === 'DELIVERED' && pgStatus === 'DELIVERED') ||
        (normalizedExpectedStatus === 'CANCELLED' && pgStatus === 'CANCELLED')
      );

      const dbTotal = Number(orderRow.total_amount || 0);
      const totalMatches = Math.abs(dbTotal - Number(expectedTotal || 0)) <= 0.05;

      // 1. Permanent Bill Number check (must be a positive integer)
      const permBillNo = parseInt(orderRow.permanent_bill_no, 10);
      const hasValidBillNo = !isNaN(permBillNo) && permBillNo > 0;

      // 2. Payment State consistency check (canonical_bills vs canonical_orders)
      const billPaymentStatus = (billRes.rows[0].payment_status || '').toUpperCase();
      const orderPaymentStatus = (orderRow.payment_status || '').toUpperCase();
      const paymentStateConsistent = (
        billPaymentStatus === orderPaymentStatus ||
        (normalizedExpectedStatus === 'CANCELLED' && (billRes.rows[0].is_cancelled === true || billPaymentStatus === 'REFUNDED'))
      );

      // 3. Line items consistency check (at least 1 line item persisted)
      const itemRes = await query(
        `SELECT COUNT(*) AS count FROM canonical_order_items WHERE order_id = $1`,
        [orderId]
      );
      const itemCount = parseInt(itemRes.rows[0]?.count || '0', 10);
      const itemsConsistent = itemCount > 0;

      const isVerified = statusMatches && totalMatches && hasValidBillNo && paymentStateConsistent && itemsConsistent;

      let failureReason: string | undefined = undefined;
      if (!isVerified) {
        const issues: string[] = [];
        if (!statusMatches) issues.push(`statusMismatch (${pgStatus} vs ${normalizedExpectedStatus})`);
        if (!totalMatches) issues.push(`totalMismatch (PG: ${dbTotal} vs expected: ${expectedTotal})`);
        if (!hasValidBillNo) issues.push(`invalidBillNo (${orderRow.permanent_bill_no})`);
        if (!paymentStateConsistent) issues.push(`paymentStateInconsistent (order: ${orderPaymentStatus}, bill: ${billPaymentStatus})`);
        if (!itemsConsistent) issues.push(`missingLineItems (count: ${itemCount})`);
        failureReason = `Verification failed: ${issues.join(', ')}`;
      }

      return {
        verified: isVerified,
        orderId,
        orderRowExists: true,
        billRowExists: true,
        statusMatches,
        totalMatches,
        permanentBillNo: hasValidBillNo ? permBillNo : undefined,
        paymentConsistent: paymentStateConsistent,
        itemsConsistent,
        reason: failureReason
      };
    } catch (err: any) {
      return {
        verified: false,
        orderId,
        orderRowExists: false,
        billRowExists: false,
        statusMatches: false,
        totalMatches: false,
        reason: `PostgreSQL query error: ${err.message}`
      };
    }
  }

  /**
   * Finalizes and purges a terminal order from Firestore after strict PostgreSQL verification.
   * "Firestore orders are retained while ACTIVE and are deleted only after PostgreSQL finalization has been verified."
   */
  public static async finalizeAndArchiveTerminalOrder(orderId: string): Promise<ArchiveResult> {
    try {
      const orderRef = adminDb.collection('orders').doc(orderId);
      const docSnap = await orderRef.get();

      if (!docSnap.exists) {
        return { success: true, orderId, alreadyArchived: true };
      }

      const orderData = docSnap.data()!;
      const currentStatus = (orderData.status || '').toLowerCase();
      const isTerminal = currentStatus === 'delivered' || currentStatus === 'cancelled';

      if (!isTerminal) {
        return {
          success: false,
          orderId,
          error: `Order ${orderId} is currently '${currentStatus}', not in a terminal state (DELIVERED/CANCELLED). Active orders must never be purged.`
        };
      }

      // Short-circuit if order is already COMPLETED/FINALIZED to avoid redundant sync and duplicate audit logs
      if ((orderData.lifecycle === 'COMPLETED' || orderData.lifecycle === 'FINALIZED') && orderData.permanentBillNo) {
        return {
          success: true,
          orderId,
          alreadyArchived: true,
          deletedFromFirestore: false,
          permanentBillNo: Number(orderData.permanentBillNo)
        };
      }

      // Validate payment status against permitted enum whitelist before archiving
      const VALID_PAYMENT_STATUSES = ['paid', 'pending', 'failed', 'refunded', 'cod_pending', 'cod_collected', 'waived', 'free'];
      const rawPaymentStatusLower = orderData.paymentStatus ? String(orderData.paymentStatus).toLowerCase() : null;
      if (rawPaymentStatusLower && !VALID_PAYMENT_STATUSES.includes(rawPaymentStatusLower)) {
        throw new Error(`[Archive] Refusing archive: invalid paymentStatus=${rawPaymentStatusLower} for order ${orderId}`);
      }

      // Phase 1: Mark Firestore lifecycle as FINALIZING
      await orderRef.update({
        lifecycle: 'FINALIZING',
        finalizingStartedAt: new Date().toISOString()
      }).catch(() => {});

      // Phase 2: Execute final PostgreSQL synchronization
      const syncRes = await this.syncLiveOrderToPostgres(orderId, orderData);
      if (!syncRes.success) {
        await orderRef.update({
          lifecycle: 'ARCHIVE_SYNC_FAILED',
          archiveError: syncRes.error
        }).catch(() => {});
        return {
          success: false,
          orderId,
          error: `PostgreSQL final synchronization failed: ${syncRes.error}. Firestore document retained.`
        };
      }

      // Phase 3: Verify PostgreSQL persistence
      const verification = await this.verifyPostgresPersistence(
        orderId,
        currentStatus,
        orderData.totalAmount || 0
      );

      if (!verification.verified) {
        await orderRef.update({
          lifecycle: 'ARCHIVE_VERIFICATION_FAILED',
          archiveError: verification.reason
        }).catch(() => {});
        return {
          success: false,
          orderId,
          error: `PostgreSQL verification failed: ${verification.reason}. Firestore document retained.`
        };
      }

      // Phase 4: Mark Firestore lifecycle as FINALIZED
      await orderRef.update({
        lifecycle: 'FINALIZED',
        archivedAt: new Date().toISOString()
      }).catch(() => {});

      // Phase 5: Structured audit log for successful bill finalization
      await adminDb.collection('order_audit_logs').add({
        orderId,
        action: 'ORDER_STATUTORY_BILL_FINALIZED',
        reason: 'ORDER_TERMINAL_POSTGRES_ARCHIVED',
        permanentBillNo: verification.permanentBillNo,
        dailyOrderNumber: orderData.dailyOrderNumber || null,
        terminalStatus: currentStatus,
        totalAmount: orderData.totalAmount,
        userId: orderData.userId || null,
        archivedAt: new Date().toISOString(),
        verifiedBy: 'OrderPersistenceArchiveService'
      }).catch((auditErr) => {
        console.warn('[OrderPersistence] Audit log write warning:', auditErr);
      });

      // Phase 6: Retain order in Firestore as operational source of truth with COMPLETED lifecycle
      await orderRef.update({
        lifecycle: 'COMPLETED',
        permanentBillNo: verification.permanentBillNo,
        archivedAt: new Date().toISOString()
      }).catch(() => {});

      console.log(`[OrderArchive] ✅ Order ${orderId} statutory bill verified in PostgreSQL and preserved in Firestore as COMPLETED.`);

      return {
        success: true,
        orderId,
        deletedFromFirestore: false,
        permanentBillNo: verification.permanentBillNo
      };
    } catch (err: any) {
      console.error(`[OrderArchive] Error during order finalization for ${orderId}:`, err);
      return {
        success: false,
        orderId,
        error: err.message
      };
    }
  }

  /**
   * Reads a historical order from PostgreSQL canonical ledger.
   * Returns null if not found.
   */
  public static async getHistoricalOrder(orderId: string): Promise<any | null> {
    try {
      const sql = `
        SELECT
          o.id,
          o.permanent_bill_no,
          o.daily_order_no,
          TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
          TO_CHAR(o.order_time, 'HH24:MI:SS') AS order_time,
          o.order_source,
          o.order_type,
          o.order_status,
          o.payment_method,
          o.payment_status,
          o.customer_name,
          o.customer_phone,
          o.customer_id,
          o.delivery_address,
          o.table_number,
          o.subtotal,
          o.discount_amount,
          o.coupon_code,
          o.tax_amount,
          o.cgst,
          o.sgst,
          o.delivery_fee,
          o.total_amount,
          o.franchise_id,
          o.branch_id,
          o.cashier_name,
          o.terminal_id,
          o.cancellation_reason,
          o.delivery_partner_id,
          o.delivery_partner_name,
          o.delivery_partner_phone,
          o.partner_assigned_at,
          o.accepted_at,
          o.preparation_started_at,
          o.ready_at,
          o.estimated_preparation_minutes,
          o.expected_ready_at,
          o.delivered_at,
          o.created_at,
          o.updated_at,
          rb.name AS branch_name,
          COALESCE(
            json_agg(
              json_build_object(
                'id', i.id,
                'menuItemId', i.menu_item_id,
                'name', i.item_name,
                'size', i.size_variant,
                'crust', i.crust,
                'quantity', i.quantity,
                'unitPrice', i.unit_price,
                'price', i.unit_price,
                'lineTotal', i.line_total,
                'addons', i.addons_json
              )
            ) FILTER (WHERE i.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM canonical_orders o
        LEFT JOIN restaurant_branches rb ON rb.id = o.branch_id
        LEFT JOIN canonical_order_items i ON o.id = i.order_id
        WHERE o.id = $1
        GROUP BY o.id, rb.name;
      `;

      const res = await query(sql, [orderId]);
      if (res.rows.length === 0) return null;

      const r = res.rows[0];
      const statusLower = (r.order_status || 'pending').toLowerCase();
      return {
        id: r.id,
        orderId: r.id,
        userId: r.customer_id || null,
        customerId: r.customer_id || null,
        permanentBillNo: parseInt(r.permanent_bill_no, 10),
        billNumber: `#${r.permanent_bill_no}`,
        dailyOrderNumber: parseInt(r.daily_order_no, 10),
        orderNumber: `#${r.daily_order_no}`,
        orderDateLocal: r.order_date,
        orderTimeLocal: r.order_time,
        orderSource: r.order_source,
        deliveryType: r.order_type,
        orderType: r.order_type,
        status: statusLower,
        orderStatus: r.order_status,
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        customerName: r.customer_name,
        contactPhone: r.customer_phone,
        customerPhone: r.customer_phone,
        deliveryAddress: typeof r.delivery_address === 'string' ? { addressLine: r.delivery_address } : r.delivery_address,
        tableNumber: r.table_number,
        subtotal: parseFloat(r.subtotal),
        discountAmount: parseFloat(r.discount_amount),
        appliedCouponCode: r.coupon_code,
        couponCode: r.coupon_code,
        taxes: parseFloat(r.tax_amount),
        cgst: parseFloat(r.cgst || '0'),
        sgst: parseFloat(r.sgst || '0'),
        deliveryFee: parseFloat(r.delivery_fee),
        totalAmount: parseFloat(r.total_amount),
        franchiseId: r.franchise_id,
        branchId: r.branch_id,
        branchName: r.branch_name || 'Olive Pizza',
        cashierName: r.cashier_name,
        terminalId: r.terminal_id,
        cancellationReason: r.cancellation_reason,
        deliveryPartnerId: r.delivery_partner_id || null,
        riderId: r.delivery_partner_id || null,
        deliveryPartnerName: r.delivery_partner_name || null,
        deliveryPartnerPhone: r.delivery_partner_phone || null,
        partnerAssignedAt: r.partner_assigned_at || null,
        acceptedAt: r.accepted_at || null,
        preparationStartedAt: r.preparation_started_at || null,
        readyAt: r.ready_at || null,
        estimatedPreparationMinutes: r.estimated_preparation_minutes != null ? Number(r.estimated_preparation_minutes) : null,
        prepTimeMinutes: r.estimated_preparation_minutes != null ? Number(r.estimated_preparation_minutes) : null,
        expectedReadyAt: r.expected_ready_at || null,
        estimatedReadyAt: r.expected_ready_at || null,
        deliveredAt: r.delivered_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
        isArchived: ['delivered', 'cancelled'].includes(statusLower),
        items: r.items
      };
    } catch (err: any) {
      console.warn(`[OrderPersistence] Error fetching historical order ${orderId}:`, err.message);
      return null;
    }
  }

  /**
   * Retrieves past archived orders for a customer from PostgreSQL canonical ledger.
   */
  public static async getCustomerHistoricalOrders(
    userId: string,
    customerPhone?: string,
    limit: number = 50
  ): Promise<any[]> {
    try {
      const sql = `
        SELECT
          o.id,
          o.permanent_bill_no,
          o.daily_order_no,
          TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
          TO_CHAR(o.order_time, 'HH24:MI:SS') AS order_time,
          o.order_source,
          o.order_type,
          o.order_status,
          o.payment_method,
          o.payment_status,
          o.customer_name,
          o.customer_phone,
          o.delivery_address,
          o.subtotal,
          o.discount_amount,
          o.coupon_code,
          o.tax_amount,
          o.delivery_fee,
          o.total_amount,
          o.franchise_id,
          o.branch_id,
          rb.name AS branch_name,
          o.delivery_partner_id,
          o.delivery_partner_name,
          o.delivery_partner_phone,
          o.estimated_preparation_minutes,
          o.expected_ready_at,
          o.created_at,
          o.updated_at,
          COALESCE(
            json_agg(
              json_build_object(
                'name', i.item_name,
                'size', i.size_variant,
                'quantity', i.quantity,
                'unitPrice', i.unit_price,
                'price', i.unit_price,
                'lineTotal', i.line_total
              )
            ) FILTER (WHERE i.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM canonical_orders o
        LEFT JOIN restaurant_branches rb ON rb.id = o.branch_id
        LEFT JOIN canonical_order_items i ON o.id = i.order_id
        WHERE (o.customer_id = $1 OR ($2::text IS NOT NULL AND $2::text != 'N/A' AND o.customer_phone = $2::text))
        GROUP BY o.id, rb.name
        ORDER BY o.permanent_bill_no DESC
        LIMIT $3;
      `;

      const res = await query(sql, [userId, customerPhone || null, limit]);
      return res.rows.map(r => {
        const statusLower = (r.order_status || 'pending').toLowerCase();
        return {
          id: r.id,
          orderId: r.id,
          userId,
          customerId: userId,
          permanentBillNo: parseInt(r.permanent_bill_no, 10),
          billNumber: `#${r.permanent_bill_no}`,
          dailyOrderNumber: parseInt(r.daily_order_no, 10),
          orderNumber: `#${r.daily_order_no}`,
          orderDateLocal: r.order_date,
          deliveryType: r.order_type,
          orderType: r.order_type,
          status: statusLower,
          orderStatus: r.order_status,
          paymentMethod: r.payment_method,
          paymentStatus: r.payment_status,
          customerName: r.customer_name,
          contactPhone: r.customer_phone,
          deliveryAddress: typeof r.delivery_address === 'string' ? { addressLine: r.delivery_address } : r.delivery_address,
          subtotal: parseFloat(r.subtotal),
          discountAmount: parseFloat(r.discount_amount),
          taxes: parseFloat(r.tax_amount),
          deliveryFee: parseFloat(r.delivery_fee),
          totalAmount: parseFloat(r.total_amount),
          franchiseId: r.franchise_id,
          branchId: r.branch_id,
          branchName: r.branch_name || 'Olive Pizza',
          deliveryPartnerId: r.delivery_partner_id || null,
          deliveryPartnerName: r.delivery_partner_name || null,
          deliveryPartnerPhone: r.delivery_partner_phone || null,
          estimatedPreparationMinutes: r.estimated_preparation_minutes != null ? Number(r.estimated_preparation_minutes) : null,
          expectedReadyAt: r.expected_ready_at || null,
          createdAt: r.created_at,
          updatedAt: r.updated_at || r.created_at,
          isArchived: ['delivered', 'cancelled'].includes(statusLower),
          items: r.items
        };
      });
    } catch (err: any) {
      console.warn(`[OrderPersistence] Error fetching customer historical orders:`, err.message);
      return [];
    }
  }

  /**
   * Sweeps PostgreSQL canonical_orders for PROJECTION_PENDING and projects them to Firestore.
   * Guarantees crash recovery if process terminated after PostgreSQL transaction commit but before Firestore set().
   */
  public static async reconcilePendingProjections(): Promise<{ recovered: number; errors: number }> {
    let recovered = 0;
    let errors = 0;
    try {
      const res = await query(`
        SELECT id, permanent_bill_no, daily_order_no, order_date, order_time,
               order_source, order_type, order_status, payment_method, payment_status,
               customer_name, customer_phone, delivery_address, table_number,
               subtotal, discount_amount, coupon_code, tax_amount, cgst, sgst,
               delivery_fee, total_amount, franchise_id, branch_id, cashier_id,
               cashier_name, terminal_id, notes, customer_id
        FROM canonical_orders
        WHERE live_lifecycle = 'PROJECTION_PENDING'
        ORDER BY created_at ASC
        LIMIT 50;
      `);

      for (const row of res.rows) {
        try {
          const itemsRes = await query(`
            SELECT id, menu_item_id, item_name, size_variant, crust, quantity, unit_price, addons_json, line_total
            FROM canonical_order_items
            WHERE order_id = $1
          `, [row.id]);

          const items = itemsRes.rows.map((it: any) => ({
            id: it.menu_item_id || it.id,
            name: it.item_name,
            size: it.size_variant,
            crust: it.crust,
            quantity: it.quantity,
            price: Number(it.unit_price),
            lineTotal: Number(it.line_total),
            addons: typeof it.addons_json === 'string' ? JSON.parse(it.addons_json) : (it.addons_json || [])
          }));

          const firestoreDoc = {
            id: row.id,
            orderId: row.id,
            permanentBillNo: Number(row.permanent_bill_no),
            dailyOrderNumber: Number(row.daily_order_no),
            orderDateLocal: row.order_date,
            userId: row.customer_id,
            customerId: row.customer_id,
            items,
            totalAmount: Number(row.total_amount),
            subtotal: Number(row.subtotal),
            deliveryFee: Number(row.delivery_fee),
            taxes: Number(row.tax_amount),
            cgst: Number(row.cgst),
            sgst: Number(row.sgst),
            discountAmount: Number(row.discount_amount),
            appliedCouponCode: row.coupon_code,
            status: String(row.order_status).toLowerCase(),
            paymentMethod: row.payment_method,
            paymentStatus: String(row.payment_status).toLowerCase(),
            customerName: row.customer_name,
            customerPhone: row.customer_phone,
            deliveryAddress: { addressLine: row.delivery_address || 'Pickup' },
            tableNumber: row.table_number,
            franchiseId: row.franchise_id,
            branchId: row.branch_id,
            cashierId: row.cashier_id,
            cashierName: row.cashier_name,
            terminalId: row.terminal_id,
            notes: row.notes,
            live_lifecycle: 'ACTIVE',
            postgresPersistence: 'COMPLETE',
            postgresSyncedAt: new Date().toISOString(),
            updatedAt: new Date()
          };

          await adminDb.collection('orders').doc(row.id).set(firestoreDoc, { merge: true });
          await query("UPDATE canonical_orders SET live_lifecycle = 'ACTIVE' WHERE id = $1 AND live_lifecycle = 'PROJECTION_PENDING'", [row.id]);
          recovered++;
        } catch (recErr: any) {
          console.warn(`[OrderPersistence] Failed to recover projection for order ${row.id}:`, recErr.message);
          errors++;
        }
      }
    } catch (err: any) {
      console.warn('[OrderPersistence] Pending projection sweep notice:', err.message);
    }
    return { recovered, errors };
  }

  /**
   * Reconciliation worker: sweeps through orders to synchronize pending writes and archive completed terminal orders.
   */
  public static async reconcileArchivalWorker(): Promise<{
    synced: number;
    archived: number;
    errors: number;
  }> {
    let synced = 0;
    let archived = 0;
    let errors = 0;

    try {
      // 0. Sweep canonical PostgreSQL orders stuck in PROJECTION_PENDING (crash recovery)
      const projRes = await this.reconcilePendingProjections();
      synced += projRes.recovered;
      errors += projRes.errors;

      // 1. Check for terminal orders that are still unfinalized (lifecycle in ['ACTIVE', 'PENDING'])
      const unfinalizedSnap = await adminDb.collection('orders')
        .where('status', 'in', ['delivered', 'cancelled'])
        .where('lifecycle', 'in', ['ACTIVE', 'PENDING'])
        .limit(50)
        .get();

      for (const doc of unfinalizedSnap.docs) {
        try {
          const res = await this.finalizeAndArchiveTerminalOrder(doc.id);
          if (res.success) {
            archived++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }

      // 2. Check for orders stuck in transitional/failed archival lifecycle states
      const finalizingSnap = await adminDb.collection('orders')
        .where('lifecycle', 'in', ['FINALIZING', 'ARCHIVE_SYNC_FAILED', 'ARCHIVE_VERIFICATION_FAILED'])
        .limit(50)
        .get();

      for (const doc of finalizingSnap.docs) {
        try {
          const res = await this.finalizeAndArchiveTerminalOrder(doc.id);
          if (res.success) {
            archived++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }

      // 3. Fallback for legacy terminal orders where lifecycle property might be undefined
      const legacySnap = await adminDb.collection('orders')
        .where('status', 'in', ['delivered', 'cancelled'])
        .orderBy('createdAt', 'desc')
        .limit(25)
        .get()
        .catch(() => ({ docs: [] }));

      for (const doc of legacySnap.docs) {
        const data = doc.data();
        if (data.lifecycle !== 'COMPLETED' && data.lifecycle !== 'FINALIZED') {
          try {
            const res = await this.finalizeAndArchiveTerminalOrder(doc.id);
            if (res.success) {
              archived++;
            } else {
              errors++;
            }
          } catch {
            errors++;
          }
        }
      }

      // 3. Check for active orders where postgresPersistence is PENDING
      const pendingSnap = await adminDb.collection('orders')
        .where('postgresPersistence', '==', 'PENDING')
        .limit(25)
        .get();

      for (const doc of pendingSnap.docs) {
        try {
          const res = await this.syncLiveOrderToPostgres(doc.id, doc.data());
          if (res.success) {
            synced++;
          } else {
            errors++;
          }
        } catch {
          errors++;
        }
      }
    } catch (workerErr: any) {
      if (workerErr?.message?.includes('RESOURCE_EXHAUSTED')) {
        this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
        console.warn('[OrderPersistence] Firestore quota exceeded. Reconciliation backoff for 15 minutes.');
      } else {
        console.warn('[OrderPersistence] Reconciliation worker sweep notice:', workerErr.message);
      }
    }

    return { synced, archived, errors };
  }

  private static workerInterval: NodeJS.Timeout | null = null;

  /**
   * Initializes periodic archival reconciliation worker (runs every 2 minutes).
   */
  public static initWorker(intervalMs: number = 120000): void {
    if (this.workerInterval) return;

    // Initial sweep 10 seconds after server boot
    setTimeout(() => {
      this.reconcileArchivalWorker().catch(() => {});
    }, 10000);

    this.workerInterval = setInterval(() => {
      this.reconcileArchivalWorker().catch(() => {});
    }, intervalMs);

    console.log(`[OrderPersistence] Durable order archival reconciliation worker scheduled (every ${intervalMs / 1000}s).`);
  }

  public static stopWorker(): void {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }
}
