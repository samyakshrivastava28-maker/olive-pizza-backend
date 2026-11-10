-- 🍕 Olive Pizza Canonical POS Billing & Relational Source of Truth (002)

-- 1. Permanent Bill Number Sequence
-- Permanent bill number starts at 1, continues forever, never resets, never contains date, concurrency-safe
CREATE SEQUENCE IF NOT EXISTS permanent_bill_seq START WITH 1 INCREMENT BY 1;

-- 2. Daily Order Counter (Atomic per-calendar-day counter in IST)
CREATE TABLE IF NOT EXISTS daily_order_counters (
  counter_date DATE PRIMARY KEY,
  current_number INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Function to atomically increment and return next daily order number for a specific date
CREATE OR REPLACE FUNCTION get_next_daily_order_number(p_date DATE)
RETURNS INTEGER AS $$
DECLARE
  v_next_val INTEGER;
BEGIN
  INSERT INTO daily_order_counters (counter_date, current_number, updated_at)
  VALUES (p_date, 1, CURRENT_TIMESTAMP)
  ON CONFLICT (counter_date) DO UPDATE
    SET current_number = daily_order_counters.current_number + 1,
        updated_at = CURRENT_TIMESTAMP
  RETURNING current_number INTO v_next_val;

  RETURN v_next_val;
END;
$$ LANGUAGE plpgsql;

-- 3. Canonical Orders Table (The Relational Source of Truth for all orders)
CREATE TABLE IF NOT EXISTS canonical_orders (
  id VARCHAR(255) PRIMARY KEY,
  permanent_bill_no BIGINT NOT NULL UNIQUE,
  daily_order_no INTEGER NOT NULL,
  order_date DATE NOT NULL,
  order_time TIME NOT NULL,
  order_source VARCHAR(50) NOT NULL, -- 'ONLINE', 'POS_DINE_IN', 'POS_TAKEAWAY', 'POS_DELIVERY'
  order_type VARCHAR(50) NOT NULL,   -- 'delivery', 'pickup', 'dine_in'
  order_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH', -- 'CASH', 'UPI', 'CARD', 'WALLET', 'COD'
  payment_status VARCHAR(50) NOT NULL DEFAULT 'PAID', -- 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'
  customer_name VARCHAR(255) NOT NULL DEFAULT 'Walk-in Customer',
  customer_phone VARCHAR(50) NOT NULL DEFAULT 'N/A',
  delivery_address TEXT,
  table_number VARCHAR(50),
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  coupon_code VARCHAR(100),
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  cgst NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  sgst NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  franchise_id VARCHAR(100) NOT NULL DEFAULT 'fra_primary',
  branch_id VARCHAR(100) NOT NULL DEFAULT 'main_branch',
  cashier_id VARCHAR(100),
  cashier_name VARCHAR(255),
  terminal_id VARCHAR(100),
  cancellation_reason TEXT,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  refund_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Canonical Order Items Table (Immutable Item Snapshot)
CREATE TABLE IF NOT EXISTS canonical_order_items (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL REFERENCES canonical_orders(id) ON DELETE CASCADE,
  menu_item_id VARCHAR(255),
  item_name VARCHAR(255) NOT NULL,
  size_variant VARCHAR(100),
  crust VARCHAR(100),
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  addons_json JSONB DEFAULT '[]'::jsonb,
  tax_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  line_total NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Canonical Bills Table (Permanent Financial Invoices)
CREATE TABLE IF NOT EXISTS canonical_bills (
  id VARCHAR(255) PRIMARY KEY,
  permanent_bill_no BIGINT NOT NULL UNIQUE,
  order_id VARCHAR(255) NOT NULL REFERENCES canonical_orders(id) ON DELETE CASCADE,
  bill_date DATE NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  tax NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  net_amount NUMERIC(12, 2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL,
  payment_status VARCHAR(50) NOT NULL,
  is_cancelled BOOLEAN DEFAULT FALSE,
  cancelled_at TIMESTAMP WITH TIME ZONE,
  cancellation_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Canonical Report Snapshots
CREATE TABLE IF NOT EXISTS canonical_report_snapshots (
  id VARCHAR(255) PRIMARY KEY,
  franchise_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  report_month VARCHAR(20) NOT NULL,
  report_year INTEGER NOT NULL,
  summary_json JSONB NOT NULL,
  pdf_cloudflare_path TEXT,
  pdf_url TEXT,
  sheets_url TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(franchise_id, branch_id, report_month, report_year)
);

-- 7. Multi-Terminal POS Held Bills
CREATE TABLE IF NOT EXISTS canonical_pos_held_bills (
  id VARCHAR(255) PRIMARY KEY,
  branch_id VARCHAR(100) NOT NULL,
  terminal_id VARCHAR(100) NOT NULL,
  cashier_id VARCHAR(100) NOT NULL,
  cashier_name VARCHAR(255),
  customer_name VARCHAR(255),
  customer_phone VARCHAR(50),
  order_type VARCHAR(50) NOT NULL DEFAULT 'DINE_IN',
  table_number VARCHAR(50),
  items_json JSONB NOT NULL,
  subtotal NUMERIC(12, 2) NOT NULL,
  discount_amount NUMERIC(12, 2) DEFAULT 0.00,
  taxes NUMERIC(12, 2) DEFAULT 0.00,
  final_total NUMERIC(12, 2) NOT NULL,
  held_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 8. High-Performance Deterministic Search and Aggregation Indexes
CREATE INDEX IF NOT EXISTS idx_canonical_orders_perm_bill ON canonical_orders(permanent_bill_no);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_daily_order ON canonical_orders(order_date, daily_order_no);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_branch_date ON canonical_orders(branch_id, order_date);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_franchise_date ON canonical_orders(franchise_id, order_date);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_customer_phone ON canonical_orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_payment_status ON canonical_orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_order_status ON canonical_orders(order_status);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_source ON canonical_orders(order_source);
CREATE INDEX IF NOT EXISTS idx_canonical_items_order_id ON canonical_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_canonical_items_name ON canonical_order_items(item_name);
CREATE INDEX IF NOT EXISTS idx_canonical_bills_perm_no ON canonical_bills(permanent_bill_no);
