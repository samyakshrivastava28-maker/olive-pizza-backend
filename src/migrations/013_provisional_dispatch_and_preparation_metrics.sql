-- Migration 013: Provisional dispatch intents and preparation-time metric columns

-- 1. Provisional Dispatch Intents Table
CREATE TABLE IF NOT EXISTS provisional_dispatch_intents (
    id VARCHAR(128) PRIMARY KEY,
    order_id VARCHAR(128) NOT NULL UNIQUE,
    idempotency_key VARCHAR(128) NOT NULL,
    franchise_id VARCHAR(64) NOT NULL,
    branch_id VARCHAR(64) NOT NULL,
    rider_id VARCHAR(64) NOT NULL,
    rider_name VARCHAR(128),
    rider_phone VARCHAR(32),
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_RECONCILIATION',
    reconciliation_status VARCHAR(32) NOT NULL DEFAULT 'UNRECONCILED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    reconciled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_provisional_dispatch_order_id ON provisional_dispatch_intents (order_id);
CREATE INDEX IF NOT EXISTS idx_provisional_dispatch_status ON provisional_dispatch_intents (status, reconciliation_status);
CREATE INDEX IF NOT EXISTS idx_provisional_dispatch_branch ON provisional_dispatch_intents (branch_id, franchise_id);

-- Ensure updated_at exists if table was previously created
ALTER TABLE provisional_dispatch_intents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

-- 2. Ensure canonical_orders has lifecycle timestamp columns for distinct preparation-time metrics
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS preparation_started_at TIMESTAMPTZ;
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS ready_at TIMESTAMPTZ;
