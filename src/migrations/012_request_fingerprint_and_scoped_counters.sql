-- 012_request_fingerprint_and_scoped_counters.sql
-- Request fingerprint idempotency and franchise+branch scoped daily order counters

-- 1. Add request_fingerprint to canonical_orders
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);
CREATE INDEX IF NOT EXISTS idx_canonical_orders_fingerprint ON canonical_orders(request_fingerprint);

-- 2. Add franchise_id and branch_id to daily_order_counters
ALTER TABLE daily_order_counters ADD COLUMN IF NOT EXISTS franchise_id VARCHAR(100) NOT NULL DEFAULT 'fra_primary';
ALTER TABLE daily_order_counters ADD COLUMN IF NOT EXISTS branch_id VARCHAR(100) NOT NULL DEFAULT 'main_branch';

-- 3. Update primary key of daily_order_counters to (counter_date, franchise_id, branch_id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'daily_order_counters' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE daily_order_counters DROP CONSTRAINT IF EXISTS daily_order_counters_pkey;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'daily_order_counters' AND constraint_name = 'pk_daily_order_counters'
  ) THEN
    ALTER TABLE daily_order_counters ADD CONSTRAINT pk_daily_order_counters PRIMARY KEY (counter_date, franchise_id, branch_id);
  END IF;
END $$;

-- 4. Create scoped daily order number allocator function
CREATE OR REPLACE FUNCTION get_next_daily_order_number(p_date DATE, p_franchise_id VARCHAR, p_branch_id VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  v_next_val INTEGER;
  v_fra VARCHAR := COALESCE(p_franchise_id, 'fra_primary');
  v_br VARCHAR := COALESCE(p_branch_id, 'main_branch');
BEGIN
  INSERT INTO daily_order_counters (counter_date, franchise_id, branch_id, current_number, updated_at)
  VALUES (p_date, v_fra, v_br, 1, CURRENT_TIMESTAMP)
  ON CONFLICT (counter_date, franchise_id, branch_id) DO UPDATE
    SET current_number = daily_order_counters.current_number + 1,
        updated_at = CURRENT_TIMESTAMP
  RETURNING current_number INTO v_next_val;

  RETURN v_next_val;
END;
$$ LANGUAGE plpgsql;

-- 5. Backwards-compatible 1-argument overload
CREATE OR REPLACE FUNCTION get_next_daily_order_number(p_date DATE)
RETURNS INTEGER AS $$
BEGIN
  RETURN get_next_daily_order_number(p_date, 'fra_primary', 'main_branch');
END;
$$ LANGUAGE plpgsql;
