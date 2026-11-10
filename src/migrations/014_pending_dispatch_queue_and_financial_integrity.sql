-- ==============================================================================
-- Migration 014: Pending Dispatch Queue & Financial Integrity Enforcement
-- ==============================================================================

-- 1. Durable queue for orders awaiting rider discovery or retry
CREATE TABLE IF NOT EXISTS pending_dispatch_queue (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL UNIQUE,
  franchise_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempt_count INT NOT NULL DEFAULT 1,
  max_attempts INT NOT NULL DEFAULT 10,
  status VARCHAR(32) NOT NULL DEFAULT 'WAITING_FOR_RIDER',
  assigned_rider_id VARCHAR(64),
  resolved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pending_dispatch_retry ON pending_dispatch_queue (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_pending_dispatch_branch ON pending_dispatch_queue (branch_id, status);

ALTER TABLE pending_dispatch_queue ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- 2. Enforce exactly one canonical bill per order in PostgreSQL
CREATE UNIQUE INDEX IF NOT EXISTS uq_canonical_bills_order_id ON canonical_bills(order_id);

-- 3. Dedicated durable idempotency record registry
CREATE TABLE IF NOT EXISTS order_idempotency_records (
  idempotency_key VARCHAR(128) PRIMARY KEY,
  request_fingerprint VARCHAR(64) NOT NULL,
  order_id VARCHAR(64) NOT NULL,
  franchise_id VARCHAR(64) NOT NULL,
  branch_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'COMMITTED',
  response_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_order ON order_idempotency_records (order_id);
