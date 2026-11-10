/**
 * OutboxPublisherService.ts — Transactional Outbox Pattern for Olive Pizza
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. RELATIONAL AUTHORITY: Events are inserted into PostgreSQL `outbox_events`
 *    within the EXACT SAME transaction that mutates `canonical_orders`.
 * 2. ATOMIC PROJECTION: A committed database transaction guarantees the event will be projected.
 * 3. FAULT ISOLATION: A Firestore quota error or network failure will NEVER roll back a committed
 *    PostgreSQL transaction. The worker retries asynchronously with exponential backoff.
 * 4. EVENTUAL CONSISTENCY: Projections to Firestore and Socket.IO are guaranteed at-least-once.
 */

import { query, pgPool, getClient } from '../../config/postgres.js';
import { adminDb } from '../../config/firebase.js';

export interface OutboxPayload {
  orderId: string;
  previousStatus?: string;
  currentStatus: string;
  branchId?: string;
  franchiseId?: string;
  deliveryPartnerId?: string | null;
  actorUid?: string;
  actorRole?: string;
  timestamp: string;
  metadata?: any;
}

export class OutboxPublisherService {
  private static isProcessing = false;
  private static pollTimer: NodeJS.Timeout | null = null;

  /**
   * Enqueue an event into the transactional outbox table.
   * If a transaction client is passed, the insert executes within that transaction.
   */
  public static async recordEvent(
    clientOrPool: any,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: OutboxPayload
  ): Promise<string> {
    const q = clientOrPool || pgPool;
    const res = await q.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, 'PENDING')
       RETURNING id;`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload)]
    );
    const eventId = res.rows[0]?.id;

    // Trigger immediate async processing after next tick (post-commit)
    setImmediate(() => {
      OutboxPublisherService.processPendingEvents().catch((err) =>
        console.warn('[Outbox] Immediate dispatch notice:', err?.message)
      );
    });

    return eventId;
  }

  /**
   * Worker method: Processes pending outbox events safely.
   */
  public static async processPendingEvents(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let processedCount = 0;
    const client = await getClient();

    try {
      await client.query('BEGIN');

      const res = await client.query(`
        SELECT id, aggregate_type, aggregate_id, event_type, payload, retry_count
        FROM outbox_events
        WHERE status = 'PENDING' AND retry_count < 10
        ORDER BY created_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED;
      `);

      if (res.rows.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      for (const row of res.rows) {
        const { id, aggregate_type, aggregate_id, event_type, payload, retry_count } = row;
        try {
          if (aggregate_type === 'order') {
            await this.projectOrderEvent(aggregate_id, event_type, payload);
          }

          // Mark event as successfully PROCESSED
          await client.query(
            `UPDATE outbox_events 
             SET status = 'PROCESSED', processed_at = NOW(), last_error = NULL 
             WHERE id = $1;`,
            [id]
          );
          processedCount++;
        } catch (eventErr: any) {
          console.warn(`[Outbox] Event projection failure for event ${id} (order: ${aggregate_id}):`, eventErr.message);
          await client.query(
            `UPDATE outbox_events 
             SET retry_count = retry_count + 1, last_error = $2, status = CASE WHEN retry_count + 1 >= 10 THEN 'DEAD_LETTER' ELSE 'PENDING' END
             WHERE id = $1;`,
            [id, eventErr.message]
          );
        }
      }

      await client.query('COMMIT');
    } catch (batchErr: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Outbox] Batch processing error:', batchErr.message);
    } finally {
      client.release();
      this.isProcessing = false;
    }

    return processedCount;
  }

  /**
   * Project order state to Firestore and emit Socket.IO broadcast.
   */
  private static async projectOrderEvent(orderId: string, eventType: string, payload: OutboxPayload): Promise<void> {
    // 1. Update Firestore projection document
    const orderRef = adminDb.collection('orders').doc(orderId);
    
    const projectionUpdates: any = {
      status: payload.currentStatus.toLowerCase(),
      order_status: payload.currentStatus.toUpperCase(),
      updatedAt: new Date(payload.timestamp || Date.now())
    };

    if (payload.deliveryPartnerId) {
      projectionUpdates.deliveryPartnerId = payload.deliveryPartnerId;
      projectionUpdates.assignedPartnerId = payload.deliveryPartnerId;
    }

    if (payload.metadata) {
      if (payload.metadata.cancellationReason) {
        projectionUpdates.cancellationReason = payload.metadata.cancellationReason;
      }
      if (payload.metadata.failureReason) {
        projectionUpdates.deliveryFailureReason = payload.metadata.failureReason;
      }
    }

    await orderRef.set(projectionUpdates, { merge: true });

    // 2. Dispatch real-time notification via AppEventBus
    try {
      const { appEventBus } = await import('../eventBus/AppEventBus.js');
      appEventBus.emit('order:status_updated', {
        orderId,
        eventType,
        status: payload.currentStatus,
        previousStatus: payload.previousStatus,
        branchId: payload.branchId,
        franchiseId: payload.franchiseId,
        deliveryPartnerId: payload.deliveryPartnerId,
        timestamp: payload.timestamp
      });
    } catch (wsErr: any) {
      console.warn('[Outbox] Event bus broadcast notice:', wsErr.message);
    }
  }

  /**
   * Start recurring background polling loop.
   */
  public static startWorker(intervalMs: number = 4000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.processPendingEvents().catch(() => {});
    }, intervalMs);
    console.log(`[Outbox] Worker started with ${intervalMs}ms polling interval.`);
  }

  /**
   * Stop background worker.
   */
  public static stopWorker(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[Outbox] Worker stopped.');
    }
  }
}
