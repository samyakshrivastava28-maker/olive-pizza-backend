-- Migration: 019_link_riders_to_app_users.sql
-- Description: Establishes deterministic PostgreSQL identity for delivery riders, onboarding approval, and replacement saga.

-- 1. Ensure user_id column on delivery_partners
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'delivery_partners' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE delivery_partners ADD COLUMN user_id VARCHAR(128);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'app_users' AND column_name = 'firebase_uid'
  ) THEN
    ALTER TABLE app_users ADD COLUMN firebase_uid VARCHAR(128);
  END IF;
END $$;

-- 2. Create rider_onboarding_requests table
CREATE TABLE IF NOT EXISTS rider_onboarding_requests (
  id VARCHAR(100) PRIMARY KEY,
  requested_by_uid VARCHAR(100) NOT NULL,
  requested_by_role VARCHAR(50) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  franchise_id VARCHAR(100) NOT NULL,
  rider_name VARCHAR(150) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(150),
  vehicle_type VARCHAR(50) DEFAULT 'Motorcycle',
  vehicle_number VARCHAR(50),
  status VARCHAR(50) DEFAULT 'PENDING_APPROVAL',
  reviewed_by_uid VARCHAR(100),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rider_onboarding_status ON rider_onboarding_requests(status, branch_id);

-- 3. Create rider_replacement_operations table (Saga state management)
CREATE TABLE IF NOT EXISTS rider_replacement_operations (
  id VARCHAR(100) PRIMARY KEY,
  old_rider_id VARCHAR(100) NOT NULL,
  new_rider_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  franchise_id VARCHAR(100) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'IN_PROGRESS',
  initiated_by_uid VARCHAR(100) NOT NULL,
  initiated_by_role VARCHAR(50) NOT NULL,
  orders_transferred_count INTEGER DEFAULT 0,
  old_rider_deactivated BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rider_replacement_status ON rider_replacement_operations(status);

-- 4. Create delivery_handover_audit table (Chain-of-custody transfer tracking)
CREATE TABLE IF NOT EXISTS delivery_handover_audit (
  id VARCHAR(100) PRIMARY KEY,
  order_id VARCHAR(100) NOT NULL,
  from_rider_id VARCHAR(100) NOT NULL,
  to_rider_id VARCHAR(100) NOT NULL,
  replacement_operation_id VARCHAR(100),
  handover_type VARCHAR(50) NOT NULL,
  handover_status VARCHAR(50) DEFAULT 'PENDING',
  notes TEXT,
  confirmed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_handover_order ON delivery_handover_audit(order_id);

-- 5. Seed canonical app_users for existing delivery partners idempotently
INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active, created_at, updated_at)
VALUES 
  ('rider_01', 'Rahul Sharma', '+91 98271 22334', 'rahul.rider@olivepizza.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'main_branch', '["DELIVERY"]'::jsonb, true, NOW(), NOW()),
  ('rider_02', 'Amit Verma', '+91 98272 55667', 'amit.rider@olivepizza.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'main_branch', '["DELIVERY"]'::jsonb, true, NOW(), NOW()),
  ('rider_03', 'Vikram Singh', '+91 98273 88990', 'vikram.rider@olivepizza.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'main_branch', '["DELIVERY"]'::jsonb, true, NOW(), NOW()),
  ('usr_test_rider', 'Test Rider 2', '9876543213', 'rider2@olivepizza.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'main_branch', '["DELIVERY"]'::jsonb, true, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  role = 'delivery_partner',
  status = 'APPROVED',
  allowed_apps = '["DELIVERY"]'::jsonb,
  is_active = true,
  updated_at = NOW();

-- 6. Link delivery_partners to canonical app_users
UPDATE delivery_partners SET user_id = id WHERE user_id IS NULL AND id IN ('rider_01', 'rider_02', 'rider_03', 'usr_test_rider');
