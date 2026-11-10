-- 🍕 Olive Pizza Standard PostgreSQL Baseline Schema Migration (001)

-- 1. Schema Migration Registry
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64)
);

-- 2. Concurrency & Locking
CREATE TABLE IF NOT EXISTS order_locks (
  order_id VARCHAR(255) PRIMARY KEY,
  locked_by VARCHAR(255),
  action VARCHAR(100),
  locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkout_locks (
  lock_key VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  acquired_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- 3. Idempotency Keys (Backend Duplicate Prevention)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  target_route VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_code INTEGER,
  response_body JSONB,
  status VARCHAR(50) DEFAULT 'IN_PROGRESS',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_keys(expires_at);

-- 4. POS Shift Reconciliation & Cashier Floating Ledgers
CREATE TABLE IF NOT EXISTS pos_shifts (
  id VARCHAR(255) PRIMARY KEY,
  terminal_id VARCHAR(100) NOT NULL,
  franchise_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  cashier_id VARCHAR(100) NOT NULL,
  cashier_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'OPEN', -- 'OPEN', 'CLOSED', 'AUDITED'
  opened_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP WITH TIME ZONE,
  opening_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  cash_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  digital_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  cash_in NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  cash_out NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  expected_cash NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  actual_cash NUMERIC(12, 2),
  cash_difference NUMERIC(12, 2) DEFAULT 0.00,
  total_orders_count INTEGER DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pos_shifts_terminal_status ON pos_shifts(terminal_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_shifts_branch_created ON pos_shifts(branch_id, created_at);

-- 5. Operational Financial Daily Ledgers
CREATE TABLE IF NOT EXISTS operational_ledgers (
  id VARCHAR(255) PRIMARY KEY,
  franchise_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  ledger_date DATE NOT NULL,
  gross_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  net_sales NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  discounts_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  gst_tax_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  cash_collected NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  digital_collected NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  refunds_total NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  orders_count INTEGER NOT NULL DEFAULT 0,
  reconciled_by VARCHAR(100),
  status VARCHAR(50) DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(branch_id, ledger_date)
);

-- 6. Payment System Tables & Ledgers
CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(255) PRIMARY KEY,
  payment_session_id VARCHAR(255),
  provider_payment_id VARCHAR(255),
  user_id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255),
  provider VARCHAR(50) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR',
  status VARCHAR(50) NOT NULL DEFAULT 'CREATED',
  payment_method VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS payment_sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  items_json JSONB,
  expires_at TIMESTAMP WITH TIME ZONE,
  is_used BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_webhooks (
  id VARCHAR(255) PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  event_type VARCHAR(255),
  event_id VARCHAR(255) UNIQUE,
  payload JSONB,
  signature_verified BOOLEAN DEFAULT false,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id VARCHAR(255) PRIMARY KEY,
  payment_id VARCHAR(255) NOT NULL,
  order_id VARCHAR(255),
  refund_amount NUMERIC(10, 2) NOT NULL,
  reason TEXT,
  status VARCHAR(50) DEFAULT 'PENDING',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_audit_logs (
  id VARCHAR(255) PRIMARY KEY,
  payment_id VARCHAR(255),
  order_id VARCHAR(255),
  action VARCHAR(255) NOT NULL,
  actor_id VARCHAR(255),
  actor_role VARCHAR(50),
  details JSONB,
  ip_address VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_recovery_queue (
  id VARCHAR(255) PRIMARY KEY,
  payment_id VARCHAR(255) NOT NULL,
  provider_payment_id VARCHAR(255),
  user_id VARCHAR(255) NOT NULL,
  amount NUMERIC(10, 2) NOT NULL,
  session_data JSONB,
  retry_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'PENDING',
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider_id ON payments(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_audit_payment_id ON payment_audit_logs(payment_id);

-- 7. High-Frequency Live Navigation Telemetry (Supabase PostgreSQL / Dedicated Schema)
CREATE TABLE IF NOT EXISTS delivery_locations (
  id SERIAL PRIMARY KEY,
  delivery_partner_id VARCHAR(255) NOT NULL UNIQUE,
  active_order_id VARCHAR(255),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  online_status BOOLEAN DEFAULT false,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS navigation_sessions (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL,
  delivery_partner_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS navigation_points (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL REFERENCES navigation_sessions(id) ON DELETE CASCADE,
  order_id VARCHAR(255) NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nav_sessions_status_expires ON navigation_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_nav_points_created_at ON navigation_points(created_at);