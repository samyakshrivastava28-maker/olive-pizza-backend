-- 005_performance_indexes.sql
-- Optimizes critical foreign keys and query lookups for high-throughput live operations

-- 1. Accelerate order billing joins and archiving lookups
CREATE INDEX IF NOT EXISTS idx_canonical_bills_order_id ON canonical_bills(order_id);
CREATE INDEX IF NOT EXISTS idx_canonical_bills_bill_date ON canonical_bills(bill_date);

-- 2. Accelerate canonical orders queries by status and creation time
CREATE INDEX IF NOT EXISTS idx_canonical_orders_status ON canonical_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_created_at ON canonical_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_branch_status ON canonical_orders(branch_id, order_status);

-- 3. Accelerate payments table lookups
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at DESC);
