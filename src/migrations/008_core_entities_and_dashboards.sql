-- 008_core_entities_and_dashboards.sql
-- Provisions relational storage for:
-- 1. App Users (Customers & Directory)
-- 2. Restaurant Branches & Operational Settings
-- 3. Delivery Partners / Riders

-- 1. App Users Table
CREATE TABLE IF NOT EXISTS app_users (
  id VARCHAR(255) PRIMARY KEY, -- Firebase UID
  email VARCHAR(255),
  phone VARCHAR(50),
  name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'customer',
  status VARCHAR(50) DEFAULT 'APPROVED',
  is_active BOOLEAN DEFAULT true,
  franchise_id VARCHAR(100),
  branch_id VARCHAR(100),
  allowed_apps JSONB DEFAULT '[]'::jsonb,
  total_orders INTEGER DEFAULT 0,
  total_spent NUMERIC(12, 2) DEFAULT 0.00,
  default_address TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role);
CREATE INDEX IF NOT EXISTS idx_app_users_phone ON app_users(phone);
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);

-- 2. Restaurant Branches & Operational Settings
CREATE TABLE IF NOT EXISTS restaurant_branches (
  id VARCHAR(100) PRIMARY KEY, -- branchId (e.g. main_branch)
  franchise_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  phone VARCHAR(50),
  is_open BOOLEAN DEFAULT true,
  accepting_orders BOOLEAN DEFAULT true,
  current_prep_time INTEGER DEFAULT 25,
  close_reason TEXT,
  operating_hours JSONB DEFAULT '{}'::jsonb,
  delivery_settings JSONB DEFAULT '{"radiusKm": 12, "minOrderAmount": 199, "baseDeliveryFee": 40, "freeDeliveryThreshold": 499}'::jsonb,
  tax_settings JSONB DEFAULT '{"gstPercentage": 5, "packagingCharge": 20}'::jsonb,
  payment_settings JSONB DEFAULT '{"cashOnDelivery": true, "upi": true, "cards": true, "onlineGateway": true}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Delivery Partners / Riders Table
CREATE TABLE IF NOT EXISTS delivery_partners (
  id VARCHAR(255) PRIMARY KEY, -- UID
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  franchise_id VARCHAR(100) DEFAULT 'fra_primary',
  branch_id VARCHAR(100) DEFAULT 'main_branch',
  vehicle_type VARCHAR(100) DEFAULT 'Motorcycle',
  vehicle_number VARCHAR(100),
  is_online BOOLEAN DEFAULT false,
  status VARCHAR(50) DEFAULT 'APPROVED',
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  last_location_time TIMESTAMP WITH TIME ZONE,
  active_order_id VARCHAR(255),
  total_deliveries INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_delivery_partners_online ON delivery_partners(is_online);
CREATE INDEX IF NOT EXISTS idx_delivery_partners_branch ON delivery_partners(branch_id);
