-- 006_financial_idempotency_records.sql
-- Persistent distributed idempotency store for payment capture, refunds, and reconciliation.
-- Replaces all ephemeral in-memory caches to guarantee cross-pod correctness and crash-safety.

CREATE TABLE IF NOT EXISTS financial_idempotency_records (
  key VARCHAR(255) PRIMARY KEY,
  target_route VARCHAR(255) NOT NULL,
  request_hash VARCHAR(128) NOT NULL,
  response_code INTEGER,
  response_body JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_financial_idemp_expires ON financial_idempotency_records(expires_at);
CREATE INDEX IF NOT EXISTS idx_financial_idemp_status ON financial_idempotency_records(status);
