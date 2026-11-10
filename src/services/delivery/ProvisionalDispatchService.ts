/**
 * Provisional Dispatch Intent & Canonical Reconciliation Service
 * 
 * Implements restricted Firestore-first dispatch fallback:
 * - Case A: Canonical PostgreSQL order exists (authoritative dispatch).
 * - Case B: PostgreSQL is healthy, canonical order not yet synced, Firestore order exists.
 *   Enforces:
 *   - Active franchise and branch verification in PostgreSQL (Firestore branchId alone never grants authority).
 *   - Rider status, online state, and branch scoping verification in PostgreSQL.
 *   - Strict staleness (< 2h) and non-terminal state checking.
 *   - Idempotent, atomic double-assignment prevention.
 *   - Restriction: Provisional orders cannot complete delivery or settle payments until reconciled.
 * - Case C: PostgreSQL unavailable -> Fails closed with DATABASE_UNAVAILABLE.
 * - Reconciliation: Commits canonical assignment in PostgreSQL when canonical order arrives.
 */

import { getClient, query } from '../../lib/db.js';
import { adminDb } from '../../config/firebase.js';

export interface ProvisionalDispatchResult {
  success: boolean;
  isProvisional?: boolean;
  provisionalDispatchId?: string;
  rider?: any;
  reason?: string;
  code?: string;
}

export interface ReconciliationResult {
  reconciled: boolean;
  success?: boolean;
  reason?: string;
  code?: string;
  canonicalOrderId?: string;
}

export class ProvisionalDispatchService {
  public static readonly PROVISIONAL_TTL_MINUTES = 15;
  public static readonly ORDER_MAX_AGE_HOURS = 2;

  /**
   * Attempt provisional dispatch for an order that exists in Firestore but has not yet synced to PostgreSQL.
   */
  public static async createProvisionalIntent(params: {
    orderId: string;
    rider: {
      uid: string;
      name: string;
      phone: string;
      branchId?: string;
      franchiseId?: string;
    };
    idempotencyKey?: string;
    orderData?: any;
  }): Promise<ProvisionalDispatchResult> {
    const { orderId, rider, idempotencyKey = `prov_key_${orderId}_${rider.uid}` } = params;

    if (!orderId || !orderId.trim()) {
      return { success: false, reason: 'Invalid order ID', code: 'INVALID_ORDER_ID' };
    }

    // 1. Fetch Firestore order document
    let orderData = params.orderData;
    const orderRef = adminDb.collection('orders').doc(orderId);
    if (!orderData) {
      try {
        const orderSnap = await orderRef.get();
        if (!orderSnap.exists) {
          return { success: false, reason: `Order ${orderId} not found in Firestore or PostgreSQL`, code: 'ORDER_NOT_FOUND' };
        }
        orderData = orderSnap.data() || {};
      } catch (err: any) {
        return { success: false, reason: `Firestore lookup error: ${err.message}`, code: 'FIRESTORE_ERROR' };
      }
    }

    // 2. Validate Order Staleness (< 2 hours old)
    const rawCreatedAt = orderData.createdAt || orderData.created_at;
    const createdAtMs = rawCreatedAt ? (typeof rawCreatedAt.toMillis === 'function' ? rawCreatedAt.toMillis() : new Date(rawCreatedAt).getTime()) : 0;
    const maxAgeMs = this.ORDER_MAX_AGE_HOURS * 60 * 60 * 1000;
    if (createdAtMs > 0 && (Date.now() - createdAtMs) > maxAgeMs) {
      return { success: false, reason: 'Order is stale (> 2 hours old)', code: 'ORDER_STALE' };
    }

    // 3. Validate Order Lifecycle State (Must not be terminal or cancelled)
    const currentStatus = String(orderData.status || orderData.order_status || '').toLowerCase();
    if (['cancelled', 'rejected', 'delivered', 'completed', 'voided'].includes(currentStatus)) {
      return { success: false, reason: `Cannot dispatch rider for terminal/cancelled order with status: ${currentStatus}`, code: 'ORDER_TERMINAL_OR_CANCELLED' };
    }

    // 4. Validate Delivery Fulfillment Requirement
    const fulfillmentType = String(orderData.deliveryType || orderData.fulfillmentType || orderData.orderType || 'delivery').toLowerCase();
    if (fulfillmentType !== 'delivery') {
      return { success: false, reason: `Fulfillment type '${fulfillmentType}' does not require rider dispatch`, code: 'INVALID_FULFILLMENT_TYPE' };
    }

    // 5. Extract and Validate Branch & Franchise IDs
    const branchId = String(orderData.branchId || orderData.branch_id || '').trim();
    const franchiseId = String(orderData.franchiseId || orderData.franchise_id || '').trim();

    if (!branchId) {
      return { success: false, reason: `Order ${orderId} lacks branchId in Firestore document`, code: 'MISSING_BRANCH_ID' };
    }

    // 6. CRITICAL SECURITY GATE: Verify Branch & Franchise Existence and Active Status in PostgreSQL
    // A Firestore document's branchId alone NEVER grants authority!
    try {
      const branchRes = await query(
        `SELECT id, franchise_id, is_open, accepting_orders 
         FROM restaurant_branches 
         WHERE id = $1`,
        [branchId]
      );

      if (branchRes.rows.length === 0) {
        return { success: false, reason: `Branch '${branchId}' is not recognized in canonical PostgreSQL authority`, code: 'BRANCH_NOT_FOUND' };
      }

      const branchRow = branchRes.rows[0];
      if (branchRow.is_open === false || branchRow.accepting_orders === false) {
        return { success: false, reason: `Branch '${branchId}' is currently inactive or closed in canonical PostgreSQL authority`, code: 'BRANCH_INACTIVE' };
      }

      if (franchiseId && branchRow.franchise_id && branchRow.franchise_id !== franchiseId) {
        return { success: false, reason: `Branch '${branchId}' does not belong to franchise '${franchiseId}' in canonical authority`, code: 'FRANCHISE_MISMATCH' };
      }
    } catch (pgErr: any) {
      // PostgreSQL query failure must fail closed with DATABASE_UNAVAILABLE, never treat as order-not-found
      return { success: false, reason: `PostgreSQL authority verification failed: ${pgErr.message}`, code: 'DATABASE_UNAVAILABLE' };
    }

    // 7. Verify Rider Eligibility in Canonical Authority (delivery_partners table in PostgreSQL)
    try {
      const riderRes = await query(
        `SELECT id, name, phone, status, is_online, branch_id, franchise_id, active_order_id
         FROM delivery_partners
         WHERE id = $1`,
        [rider.uid]
      );

      if (riderRes.rows.length === 0) {
        return { success: false, reason: `Rider '${rider.uid}' is not registered in delivery_partners authority`, code: 'RIDER_NOT_FOUND' };
      }

      const riderRow = riderRes.rows[0];
      if (riderRow.status !== 'APPROVED') {
        return { success: false, reason: `Rider '${rider.uid}' is not approved (status: ${riderRow.status})`, code: 'RIDER_NOT_APPROVED' };
      }

      if (!riderRow.is_online) {
        return { success: false, reason: `Rider '${rider.uid}' is currently offline`, code: 'RIDER_OFFLINE' };
      }

      if (riderRow.branch_id && riderRow.branch_id !== branchId) {
        return { success: false, reason: `Rider branch '${riderRow.branch_id}' does not match order branch '${branchId}'`, code: 'RIDER_BRANCH_MISMATCH' };
      }

      if (riderRow.active_order_id && riderRow.active_order_id !== orderId) {
        return { success: false, reason: `Rider '${rider.uid}' is already assigned to active order '${riderRow.active_order_id}'`, code: 'RIDER_BUSY' };
      }
    } catch (pgErr: any) {
      return { success: false, reason: `PostgreSQL rider check failed: ${pgErr.message}`, code: 'DATABASE_UNAVAILABLE' };
    }

    // 8. Atomic Conditional Assignment in Firestore to Prevent Concurrent Double-Assignment
    const intentId = `prov_disp_${orderId}_${rider.uid}`;
    const expiresAt = new Date(Date.now() + this.PROVISIONAL_TTL_MINUTES * 60 * 1000);
    const resolvedFranchiseId = franchiseId || rider.franchiseId || 'fra_rajnandgaon';

    try {
      await adminDb.runTransaction(async (txn) => {
        const freshSnap = await txn.get(orderRef);
        if (!freshSnap.exists) {
          throw new Error('ORDER_NOT_FOUND');
        }
        const freshData = freshSnap.data() || {};

        // If already assigned to another rider, abort atomically
        if (freshData.deliveryPartnerId && freshData.deliveryPartnerId !== rider.uid) {
          throw new Error('ALREADY_ASSIGNED');
        }

        txn.set(orderRef, {
          deliveryPartnerId: rider.uid,
          deliveryPartnerName: rider.name,
          deliveryPartnerPhone: rider.phone,
          isProvisionalDispatch: true,
          provisionalDispatchId: intentId,
          provisionalStatus: 'PENDING_RECONCILIATION',
          provisionalAssignedAt: new Date().toISOString(),
          provisionalExpiresAt: expiresAt.toISOString(),
          status: 'partner_assigned',
          riderAssignedAt: new Date().toISOString(),
          updatedAt: new Date()
        }, { merge: true });

        // Update rider's activeOrderId in Firestore
        txn.set(adminDb.collection('users').doc(rider.uid), {
          activeOrderId: orderId,
          isBusy: true,
          updatedAt: new Date()
        }, { merge: true });

        txn.set(adminDb.collection('delivery_partners').doc(rider.uid), {
          activeOrderId: orderId,
          isBusy: true,
          updatedAt: new Date()
        }, { merge: true });
      });
    } catch (txnErr: any) {
      if (txnErr.message === 'ALREADY_ASSIGNED') {
        return { success: false, reason: 'Order has already been assigned to another partner', code: 'ALREADY_ASSIGNED' };
      }
      return { success: false, reason: `Firestore transaction failed: ${txnErr.message}`, code: 'TRANSACTION_FAILED' };
    }

    // 9. Record Provisional Intent in PostgreSQL
    try {
      await query(`
        INSERT INTO provisional_dispatch_intents (
          id, order_id, idempotency_key, franchise_id, branch_id,
          rider_id, rider_name, rider_phone, status, reconciliation_status,
          created_at, expires_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING_RECONCILIATION', 'UNRECONCILED', NOW(), $9, $10)
        ON CONFLICT (order_id) DO UPDATE SET
          idempotency_key = EXCLUDED.idempotency_key,
          rider_id = EXCLUDED.rider_id,
          rider_name = EXCLUDED.rider_name,
          rider_phone = EXCLUDED.rider_phone,
          status = 'PENDING_RECONCILIATION',
          reconciliation_status = 'UNRECONCILED',
          expires_at = EXCLUDED.expires_at,
          metadata = EXCLUDED.metadata
        WHERE provisional_dispatch_intents.status != 'RECONCILED'
      `, [
        intentId,
        orderId,
        idempotencyKey,
        resolvedFranchiseId,
        branchId,
        rider.uid,
        rider.name,
        rider.phone,
        expiresAt,
        JSON.stringify({
          source: 'firestore_fallback',
          provisionalExpiresAt: expiresAt.toISOString()
        })
      ]);
    } catch (pgInsertErr: any) {
      console.warn(`[ProvisionalDispatch] Intent record notice for ${intentId}:`, pgInsertErr.message);
    }

    return {
      success: true,
      isProvisional: true,
      provisionalDispatchId: intentId,
      rider: {
        uid: rider.uid,
        name: rider.name,
        phone: rider.phone,
        branchId,
        franchiseId: resolvedFranchiseId
      }
    };
  }

  /**
   * Reconciles a provisional dispatch intent once the canonical PostgreSQL order record arrives.
   */
  public static async reconcileProvisionalDispatch(orderId: string): Promise<ReconciliationResult> {
    if (!orderId) {
      return { reconciled: false, reason: 'Missing order ID', code: 'INVALID_ORDER_ID' };
    }

    let client: any = null;
    try {
      client = await getClient();
      await client.query('BEGIN');

      // 1. Fetch provisional intent from PostgreSQL
      const intentRes = await client.query(
        `SELECT id, order_id, rider_id, rider_name, rider_phone, franchise_id, branch_id, status, reconciliation_status, expires_at
         FROM provisional_dispatch_intents
         WHERE order_id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (intentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { reconciled: true, success: true, reason: 'No provisional intent pending for order' };
      }

      const intent = intentRes.rows[0];
      if (intent.reconciliation_status === 'RECONCILED') {
        await client.query('COMMIT');
        return { reconciled: true, success: true, reason: 'Intent already reconciled' };
      }

      // 2. Fetch canonical order from canonical_orders table
      const orderRes = await client.query(
        `SELECT id, franchise_id, branch_id, order_status, delivery_partner_id, delivery_partner_name, delivery_partner_phone
         FROM canonical_orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          reconciled: false,
          reason: `Canonical PostgreSQL order ${orderId} not found yet. Awaiting synchronization.`,
          code: 'CANONICAL_ORDER_MISSING'
        };
      }

      const canonicalOrder = orderRes.rows[0];

      // 3. Verify Franchise & Branch Ownership
      if (canonicalOrder.franchise_id && intent.franchise_id && canonicalOrder.franchise_id !== intent.franchise_id) {
        await client.query('ROLLBACK');
        return {
          reconciled: false,
          reason: `Franchise mismatch between provisional intent (${intent.franchise_id}) and canonical order (${canonicalOrder.franchise_id})`,
          code: 'FRANCHISE_MISMATCH'
        };
      }

      if (canonicalOrder.branch_id && intent.branch_id && canonicalOrder.branch_id !== intent.branch_id) {
        await client.query('ROLLBACK');
        return {
          reconciled: false,
          reason: `Branch mismatch between provisional intent (${intent.branch_id}) and canonical order (${canonicalOrder.branch_id})`,
          code: 'BRANCH_MISMATCH'
        };
      }

      // 4. Verify Canonical Order Status (If cancelled, abort reconciliation and cancel intent)
      if (String(canonicalOrder.order_status).toUpperCase() === 'CANCELLED') {
        await client.query(
          `UPDATE provisional_dispatch_intents 
           SET status = 'CANCELLED', reconciliation_status = 'CANCELLED', updated_at = NOW() 
           WHERE id = $1`,
          [intent.id]
        ).catch(() => {});
        await client.query('COMMIT');

        // Conditionally release rider in PostgreSQL only if still bound to this cancelled order
        await client.query(
          `UPDATE delivery_partners 
           SET active_order_id = NULL, updated_at = NOW() 
           WHERE id = $1 AND active_order_id = $2`,
          [intent.rider_id, orderId]
        ).catch(() => {});

        // Unassign rider in Firestore
        await adminDb.collection('orders').doc(orderId).set({
          isProvisionalDispatch: false,
          provisionalStatus: 'CANCELLED',
          deliveryPartnerId: null,
          updatedAt: new Date()
        }, { merge: true }).catch(() => {});

        return {
          reconciled: false,
          reason: 'Canonical order was cancelled before reconciliation',
          code: 'ORDER_CANCELLED'
        };
      }

      // 5. Verify Rider Authorization is Still Active
      const riderCheck = await client.query(
        `SELECT id, status, is_online FROM delivery_partners WHERE id = $1`,
        [intent.rider_id]
      );
      if (riderCheck.rows.length === 0 || riderCheck.rows[0].status !== 'APPROVED') {
        await client.query(
          `UPDATE provisional_dispatch_intents 
           SET status = 'FAILED_RIDER_REVOKED', reconciliation_status = 'FAILED', updated_at = NOW() 
           WHERE id = $1`,
          [intent.id]
        );
        await client.query('COMMIT');

        await adminDb.collection('orders').doc(orderId).set({
          isProvisionalDispatch: false,
          provisionalStatus: 'FAILED_RIDER_REVOKED',
          deliveryPartnerId: null,
          updatedAt: new Date()
        }, { merge: true }).catch(() => {});

        return {
          reconciled: false,
          reason: `Rider ${intent.rider_id} authorization was revoked before reconciliation`,
          code: 'RIDER_REVOKED'
        };
      }

      // 6. Check Existing Assignments
      if (canonicalOrder.delivery_partner_id && canonicalOrder.delivery_partner_id !== intent.rider_id) {
        await client.query(
          `UPDATE provisional_dispatch_intents 
           SET status = 'SUPERSEDED', reconciliation_status = 'SUPERSEDED', updated_at = NOW() 
           WHERE id = $1`,
          [intent.id]
        );
        await client.query('COMMIT');
        return {
          reconciled: false,
          reason: `Order already canonically assigned to different rider ${canonicalOrder.delivery_partner_id}`,
          code: 'ALREADY_ASSIGNED'
        };
      }

      // 7. Commit Canonical Assignment in PostgreSQL
      await client.query(
        `UPDATE canonical_orders
         SET delivery_partner_id = $2,
             delivery_partner_name = $3,
             delivery_partner_phone = $4,
             partner_assigned_at = COALESCE(partner_assigned_at, NOW()),
             order_status = CASE WHEN order_status IN ('CREATED', 'PLACED', 'ACCEPTED', 'PREPARING', 'READY') THEN 'PARTNER_ASSIGNED' ELSE order_status END,
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, intent.rider_id, intent.rider_name, intent.rider_phone]
      );

      await client.query(
        `UPDATE delivery_partners
         SET active_order_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [orderId, intent.rider_id]
      );

      await client.query(
        `UPDATE provisional_dispatch_intents
         SET status = 'RECONCILED',
             reconciliation_status = 'RECONCILED',
             reconciled_at = NOW()
         WHERE id = $1`,
        [intent.id]
      );

      await client.query('COMMIT');

      // 8. Update Firestore Document with Confirmed Reconciliation
      await adminDb.collection('orders').doc(orderId).set({
        isProvisionalDispatch: false,
        provisionalStatus: 'RECONCILED',
        reconciledAt: new Date().toISOString(),
        deliveryPartnerId: intent.rider_id,
        deliveryPartnerName: intent.rider_name,
        deliveryPartnerPhone: intent.rider_phone,
        updatedAt: new Date()
      }, { merge: true }).catch(() => {});

      return {
        reconciled: true,
        success: true,
        canonicalOrderId: orderId
      };
    } catch (err: any) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error(`[ProvisionalDispatch] Reconciliation failed for ${orderId}:`, err.message);
      return {
        reconciled: false,
        reason: err.message,
        code: 'RECONCILIATION_ERROR'
      };
    } finally {
      if (client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  /**
   * Sweeper to detect and expire abandoned provisional assignments (> 15 mins).
   * Atomically claims rows using FOR UPDATE SKIP LOCKED to prevent duplicate execution across workers.
   */
  public static async cleanupExpiredIntents(): Promise<{ expiredCount: number }> {
    try {
      const expiredRes = await query(`
        UPDATE provisional_dispatch_intents
        SET status = 'EXPIRED', reconciliation_status = 'EXPIRED', updated_at = NOW()
        WHERE id IN (
          SELECT id
          FROM provisional_dispatch_intents
          WHERE status = 'PENDING_RECONCILIATION'
            AND expires_at < NOW()
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, order_id, rider_id
      `);

      if (expiredRes.rows.length === 0) {
        return { expiredCount: 0 };
      }

      let expiredCount = 0;
      for (const row of expiredRes.rows) {
        // Conditionally release rider in PostgreSQL only if still bound to this expired order
        await query(
          `UPDATE delivery_partners 
           SET active_order_id = NULL, updated_at = NOW() 
           WHERE id = $1 AND active_order_id = $2`,
          [row.rider_id, row.order_id]
        ).catch(() => {});

        // Release Firestore lock
        await adminDb.collection('orders').doc(row.order_id).set({
          isProvisionalDispatch: false,
          provisionalStatus: 'EXPIRED',
          deliveryPartnerId: null,
          updatedAt: new Date()
        }, { merge: true }).catch(() => {});

        expiredCount++;
      }

      return { expiredCount };
    } catch (err: any) {
      console.warn('[ProvisionalDispatch] Cleanup expired intents notice:', err.message);
      return { expiredCount: 0 };
    }
  }
}
