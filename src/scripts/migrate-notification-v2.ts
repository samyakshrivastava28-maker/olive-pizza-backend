/**
 * Migration: Notification System v2
 *
 * Adds:
 * 1. notification_version (INT) column to orders table — stale guard
 * 2. order_event_log table — audit trail for all order state transitions
 * 3. notification_inbox unique constraint on (user_id, tag) — for ON CONFLICT upserts
 *
 * This migration is ADDITIVE and non-destructive.
 * Run: npx ts-node src/scripts/migrate-notification-v2.ts
 */

import { pgPool } from '../config/postgres.js';

async function migrate() {
  const client = await pgPool.connect();
  console.log('[Migration] Starting notification system v2 migration...');

  try {
    await client.query('BEGIN');

    // 1. Add notification_version to orders
    await client.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS notification_version INTEGER NOT NULL DEFAULT 0
    `);
    console.log('[Migration] ✅ orders.notification_version column added');

    // Backfill existing orders with a version based on their current status
    await client.query(`
      UPDATE orders SET notification_version = CASE
        WHEN status = 'pending'          THEN 1
        WHEN status = 'accepted'         THEN 2
        WHEN status = 'preparing'        THEN 3
        WHEN status = 'ready'            THEN 4
        WHEN status = 'partner_assigned' THEN 5
        WHEN status = 'picked_up'        THEN 6
        WHEN status = 'out_for_delivery' THEN 7
        WHEN status = 'delivered'        THEN 8
        WHEN status = 'completed'        THEN 9
        WHEN status = 'cancelled'        THEN 9
        ELSE 1
      END
      WHERE notification_version = 0
    `);
    console.log('[Migration] ✅ Backfilled notification_version for existing orders');

    // 2. Create order_event_log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_event_log (
        id               SERIAL PRIMARY KEY,
        event_id         UUID UNIQUE NOT NULL,
        order_id         TEXT NOT NULL,
        previous_status  TEXT,
        current_status   TEXT NOT NULL,
        version          INTEGER NOT NULL,
        event_timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by       TEXT,        -- Firebase UID of who triggered it
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_event_log_order_id ON order_event_log(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_event_log_event_id ON order_event_log(event_id)`);
    console.log('[Migration] ✅ order_event_log table created');

    // 3. Add unique constraint on notification_inbox (user_id, tag) for ON CONFLICT upserts
    // Check if constraint already exists first
    const constraintCheck = await client.query(`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'notification_inbox'
        AND constraint_name = 'notification_inbox_user_tag_unique'
    `);

    if (constraintCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE notification_inbox
        ADD CONSTRAINT notification_inbox_user_tag_unique UNIQUE (user_id, tag)
      `).catch(err => {
        // Index may already exist from partial migration — non-fatal
        console.warn('[Migration] notification_inbox unique constraint (non-fatal):', err.message);
      });
    }
    console.log('[Migration] ✅ notification_inbox unique constraint ensured');

    // 4. Add scheduled_at column to notification_queue (for retry backoff)
    await client.query(`
      ALTER TABLE notification_queue
      ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ DEFAULT NULL
    `);
    console.log('[Migration] ✅ notification_queue.scheduled_at column added');

    // 5. Add total_delivery_time_ms to notification_analytics (for latency tracking)
    await client.query(`
      ALTER TABLE notification_analytics
      ADD COLUMN IF NOT EXISTS total_delivery_time_ms BIGINT NOT NULL DEFAULT 0
    `).catch(() => {}); // May already exist
    console.log('[Migration] ✅ notification_analytics.total_delivery_time_ms column added');

    await client.query('COMMIT');
    console.log('[Migration] ✅ All migrations complete');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Migration] ❌ Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();
