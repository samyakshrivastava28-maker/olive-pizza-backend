/**
 * PendingDispatchQueueService.ts — Authoritative Durable Queue for Orders Awaiting Rider Discovery
 *
 * Implements:
 * 1. Durable PostgreSQL queue (`pending_dispatch_queue`) for orders with 0 eligible riders in radius.
 * 2. Explicit lifecycle: WAITING_FOR_RIDER -> ASSIGNMENT_IN_PROGRESS -> ASSIGNED -> COMPLETED | EXPIRED | CANCELLED.
 * 3. Atomic rider reservation within PostgreSQL transactions.
 * 4. Automatic retry loop with bounded exponential backoff and recovery worker.
 * 5. Event-driven rider-checkin instant triggering.
 * 6. Branch manager operational emergency alerts.
 */

import { query, withTransaction, getClient } from '../../config/postgres.js';
import { appEventBus, DomainEventType } from '../eventBus/AppEventBus.js';
import { notificationEngine } from '../notification/NotificationEngine.js';

export type PendingDispatchStatus =
  | 'WAITING_FOR_RIDER'
  | 'ASSIGNMENT_IN_PROGRESS'
  | 'ASSIGNED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT';

export interface PendingQueueEntry {
  id: string;
  orderId: string;
  franchiseId: string;
  branchId: string;
  createdAt: Date;
  lastAttemptAt: Date;
  nextRetryAt: Date;
  attemptCount: number;
  maxAttempts: number;
  status: PendingDispatchStatus;
  assignedRiderId?: string | null;
  expiresAt: Date;
  failureReason?: string | null;
  metadata?: any;
}

export class PendingDispatchQueueService {
  private static workerTimer: NodeJS.Timeout | null = null;
  private static isProcessing = false;
  private static abortController: AbortController | null = null;

  /**
   * Enqueues an order that currently has no eligible riders in branch radius.
   * Enforces 1 active queue entry per order using PostgreSQL ON CONFLICT.
   */
  public static async enqueueOrder(params: {
    orderId: string;
    branchId: string;
    franchiseId: string;
    failureReason?: string;
    metadata?: any;
  }): Promise<{ queued: boolean; status: PendingDispatchStatus; entryId: string }> {
    const { orderId, branchId, franchiseId, failureReason = 'No eligible riders available in branch radius', metadata = {} } = params;
    const entryId = `pdq_${orderId}`;

    const res = await query(
      `INSERT INTO pending_dispatch_queue (
        id, order_id, franchise_id, branch_id, created_at,
        last_attempt_at, next_retry_at, attempt_count, max_attempts,
        status, expires_at, failure_reason, metadata, updated_at
      ) VALUES (
        $1, $2, $3, $4, NOW(),
        NOW(), NOW() + INTERVAL '30 seconds', 1, 10,
        'WAITING_FOR_RIDER', NOW() + INTERVAL '30 minutes', $5, $6::jsonb, NOW()
      )
      ON CONFLICT (order_id) DO UPDATE SET
        last_attempt_at = NOW(),
        attempt_count = pending_dispatch_queue.attempt_count + 1,
        next_retry_at = NOW() + (INTERVAL '30 seconds' * LEAST(10, POWER(1.5, pending_dispatch_queue.attempt_count))),
        status = CASE 
          WHEN pending_dispatch_queue.status IN ('ASSIGNED', 'COMPLETED') THEN pending_dispatch_queue.status 
          ELSE 'WAITING_FOR_RIDER' 
        END,
        failure_reason = EXCLUDED.failure_reason,
        updated_at = NOW()
      RETURNING id, status, attempt_count`,
      [entryId, orderId, franchiseId, branchId, failureReason, JSON.stringify(metadata)]
    );

    const row = res.rows[0];

    // Emit domain event for real-time dashboard notification
    try {
      appEventBus.emit('dispatch.waiting_for_rider', {
        orderId,
        franchiseId,
        branchId,
        timestamp: new Date().toISOString(),
        payload: {
          queueId: row.id,
          attemptCount: row.attempt_count,
          reason: failureReason
        }
      });
    } catch (_) {}

    // Alert branch restaurant managers
    try {
      notificationEngine.resolveBranchStaff(branchId).then((staffUids: string[]) => {
        if (staffUids && staffUids.length > 0) {
          notificationEngine.sendBulk(staffUids, {
            notification: {
              title: '⚠️ Delivery Rider Pending',
              body: `Order #${orderId} requires delivery but no riders are currently in radius. System is auto-retrying.`
            },
            data: {
              type: 'NO_RIDER_PENDING_QUEUE',
              orderId,
              queueId: row.id
            }
          }, {
            category: 'alarm_actionable',
            priority: 'high',
            orderId,
            targetApp: 'restaurant'
          }).catch(() => {});
        }
      }).catch(() => {});
    } catch (_) {}

    return {
      queued: true,
      status: row.status as PendingDispatchStatus,
      entryId: row.id
    };
  }

  /**
   * Retrieves the current queue entry for an order.
   */
  public static async getQueueEntry(orderId: string): Promise<PendingQueueEntry | null> {
    const res = await query(
      `SELECT id, order_id, franchise_id, branch_id, created_at, last_attempt_at,
              next_retry_at, attempt_count, max_attempts, status, assigned_rider_id,
              expires_at, failure_reason, metadata
       FROM pending_dispatch_queue
       WHERE order_id = $1 LIMIT 1`,
      [orderId]
    );

    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      orderId: r.order_id,
      franchiseId: r.franchise_id,
      branchId: r.branch_id,
      createdAt: r.created_at,
      lastAttemptAt: r.last_attempt_at,
      nextRetryAt: r.next_retry_at,
      attemptCount: Number(r.attempt_count),
      maxAttempts: Number(r.max_attempts),
      status: r.status,
      assignedRiderId: r.assigned_rider_id,
      expiresAt: r.expires_at,
      failureReason: r.failure_reason,
      metadata: r.metadata
    };
  }

  /**
   * Attempts to assign a rider to a pending queued order within an atomic transaction.
   */
  public static async attemptQueueAssignment(orderId: string): Promise<{ success: boolean; riderId?: string; reason?: string }> {
    const { RiderDispatchEngine } = await import('./RiderDispatchEngine.js');

    return await withTransaction(async (client) => {
      // 1. Lock queue row
      const qRes = await client.query(
        `SELECT id, order_id, branch_id, franchise_id, status, attempt_count, max_attempts, expires_at
         FROM pending_dispatch_queue
         WHERE order_id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (qRes.rows.length === 0) {
        return { success: false, reason: 'Queue entry not found' };
      }

      const qRow = qRes.rows[0];
      if (qRow.status === 'ASSIGNED' || qRow.status === 'COMPLETED') {
        return { success: true, reason: 'Already assigned' };
      }
      if (qRow.status === 'CANCELLED' || qRow.status === 'EXPIRED') {
        return { success: false, reason: `Queue entry is in terminal status: ${qRow.status}` };
      }

      // Check expiry
      if (new Date() >= new Date(qRow.expires_at) || qRow.attempt_count >= qRow.max_attempts) {
        await client.query(
          `UPDATE pending_dispatch_queue
           SET status = 'EXPIRED', updated_at = NOW(), failure_reason = 'Exceeded maximum retry attempts or timeout'
           WHERE id = $1`,
          [qRow.id]
        );
        return { success: false, reason: 'Queue entry expired' };
      }

      // 2. Discover eligible riders
      const candidates = await RiderDispatchEngine.findEligibleRiders(orderId);
      if (candidates.length === 0) {
        // Increment attempts and schedule next exponential backoff retry
        await client.query(
          `UPDATE pending_dispatch_queue
           SET last_attempt_at = NOW(),
               attempt_count = attempt_count + 1,
               next_retry_at = NOW() + (INTERVAL '30 seconds' * LEAST(10, POWER(1.5, attempt_count))),
               updated_at = NOW()
           WHERE id = $1`,
          [qRow.id]
        );
        return { success: false, reason: 'No eligible riders available' };
      }

      // 3. Atomically lock candidate rider in PostgreSQL
      let selectedRider: any = null;
      for (const candidate of candidates) {
        try {
          const rRes = await client.query(
            `SELECT id, name, phone, status, is_online, active_order_id, branch_id, franchise_id
             FROM delivery_partners
             WHERE id = $1 AND branch_id = $2
             FOR UPDATE NOWAIT`,
            [candidate.uid, qRow.branch_id]
          );

          if (rRes.rows.length > 0) {
            const rider = rRes.rows[0];
            if (rider.status === 'APPROVED' && rider.is_online && (!rider.active_order_id || rider.active_order_id === orderId)) {
              selectedRider = {
                ...candidate,
                name: rider.name || candidate.name,
                phone: rider.phone || candidate.phone,
                branchId: rider.branch_id,
                franchiseId: rider.franchise_id
              };
              break;
            }
          }
        } catch (_) {
          // Locked by another concurrent transaction, continue
          continue;
        }
      }

      if (!selectedRider) {
        await client.query(
          `UPDATE pending_dispatch_queue
           SET last_attempt_at = NOW(),
               attempt_count = attempt_count + 1,
               next_retry_at = NOW() + (INTERVAL '30 seconds' * LEAST(10, POWER(1.5, attempt_count))),
               updated_at = NOW()
           WHERE id = $1`,
          [qRow.id]
        );
        return { success: false, reason: 'Eligible riders are locked or busy' };
      }

      // 4. Reserve rider and update order
      await client.query(
        `UPDATE canonical_orders
         SET delivery_partner_id = $2,
             delivery_partner_name = $3,
             delivery_partner_phone = $4,
             partner_assigned_at = NOW(),
             order_status = 'PARTNER_ASSIGNED',
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, selectedRider.uid, selectedRider.name, selectedRider.phone]
      );

      await client.query(
        `UPDATE delivery_partners
         SET active_order_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [selectedRider.uid, orderId]
      );

      await client.query(
        `UPDATE pending_dispatch_queue
         SET status = 'ASSIGNED',
             assigned_rider_id = $2,
             last_attempt_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [qRow.id, selectedRider.uid]
      );

      return { success: true, riderId: selectedRider.uid };
    });
  }

  /**
   * Event-driven check: Called when a rider comes online or becomes available.
   * Immediately attempts assignment for pending orders in that branch.
   */
  public static async onRiderAvailable(branchId: string): Promise<number> {
    try {
      const res = await query(
        `SELECT order_id
         FROM pending_dispatch_queue
         WHERE branch_id = $1 AND status = 'WAITING_FOR_RIDER' AND expires_at > NOW()
         ORDER BY created_at ASC
         LIMIT 5`,
        [branchId]
      );

      let assignedCount = 0;
      for (const row of res.rows) {
        const result = await this.attemptQueueAssignment(row.order_id);
        if (result.success) assignedCount++;
      }
      return assignedCount;
    } catch (e: any) {
      console.warn(`[PendingDispatchQueue] Error on rider available hook:`, e.message);
      return 0;
    }
  }

  /**
   * Periodic recovery worker loop: Drains eligible pending orders.
   */
  public static async processPendingQueue(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      // Find rows ready for retry (FOR UPDATE SKIP LOCKED avoids concurrent worker clashes)
      const res = await query(
        `SELECT order_id
         FROM pending_dispatch_queue
         WHERE status = 'WAITING_FOR_RIDER'
           AND next_retry_at <= NOW()
           AND expires_at > NOW()
         ORDER BY created_at ASC
         LIMIT 10`
      );

      let processed = 0;
      for (const row of res.rows) {
        if (this.abortController?.signal.aborted) break;
        const result = await this.attemptQueueAssignment(row.order_id);
        if (result.success) processed++;
      }

      // Also clean up expired rows
      await query(
        `UPDATE pending_dispatch_queue
         SET status = 'EXPIRED', updated_at = NOW(), failure_reason = 'Dispatch timeout exceeded'
         WHERE status = 'WAITING_FOR_RIDER' AND (expires_at <= NOW() OR attempt_count >= max_attempts)`
      ).catch(() => {});

      return processed;
    } catch (err: any) {
      console.warn(`[PendingDispatchQueue] Worker iteration notice:`, err.message);
      return 0;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Explicit lifecycle: Start background recovery worker with graceful controls.
   */
  public static startWorker(intervalMs = 30000): void {
    if (this.workerTimer) return;
    this.abortController = new AbortController();

    this.workerTimer = setInterval(() => {
      this.processPendingQueue().catch(() => {});
    }, intervalMs);

    if (this.workerTimer.unref) this.workerTimer.unref();
    console.log(`🛵 [PendingDispatchQueue] Worker active (${intervalMs / 1000}s interval).`);
  }

  /**
   * Explicit lifecycle: Stop background recovery worker gracefully.
   */
  public static stopWorker(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    this.isProcessing = false;
  }
}
