CREATE TABLE IF NOT EXISTS franchise_prices (
  id VARCHAR(255) PRIMARY KEY,
  franchise_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  selling_price NUMERIC(10, 2) NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by VARCHAR(255),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (franchise_id, branch_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_franchise_prices_lookup ON franchise_prices (franchise_id, branch_id, is_available);
