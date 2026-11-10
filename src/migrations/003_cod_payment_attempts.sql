-- 003_cod_payment_attempts.sql
-- Canonical schema for delivery COD payment collections and dynamic order-specific UPI QR attempts

CREATE TABLE IF NOT EXISTS payment_attempts (
  id VARCHAR(255) PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL,
  rider_id VARCHAR(255),
  branch_id VARCHAR(255),
  amount NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR',
  collection_method VARCHAR(50) NOT NULL, -- 'CASH' or 'UPI_QR'
  provider VARCHAR(50) DEFAULT 'razorpay',
  provider_order_id VARCHAR(255),
  provider_qr_id VARCHAR(255),
  upi_string TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'CAPTURED', 'EXPIRED', 'FAILED'
  expires_at TIMESTAMP WITH TIME ZONE,
  collected_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_rider ON payment_attempts(rider_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);
