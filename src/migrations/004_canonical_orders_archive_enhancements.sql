-- 004_canonical_orders_archive_enhancements.sql
-- Supports Live Order Lifecycle with PostgreSQL Final Archiving

ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS customer_id VARCHAR(255);
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS live_lifecycle VARCHAR(50) DEFAULT 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_canonical_orders_customer_id ON canonical_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_customer_phone ON canonical_orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_branch_id ON canonical_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_order_date ON canonical_orders(order_date);
