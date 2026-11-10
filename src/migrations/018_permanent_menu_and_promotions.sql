-- 018_permanent_menu_and_promotions.sql
-- Master Menu Catalog, Combos, Coupons & Promotional Banners
-- Permanent relational source of truth in PostgreSQL 18.6

-- 1. Master Categories
CREATE TABLE IF NOT EXISTS menu_categories (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  emoji VARCHAR(20) DEFAULT '🍕',
  image_url TEXT,
  subcategories JSONB DEFAULT '[]'::jsonb,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Master Products Catalog
CREATE TABLE IF NOT EXISTS menu_products (
  id VARCHAR(255) PRIMARY KEY,
  category_id VARCHAR(100) REFERENCES menu_categories(id) ON DELETE SET NULL,
  category_name VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  base_price NUMERIC(10, 2) NOT NULL,
  image_url TEXT,
  is_vegetarian BOOLEAN DEFAULT TRUE,
  is_featured BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  variants JSONB DEFAULT '[]'::jsonb,
  crusts JSONB DEFAULT '[]'::jsonb,
  addons JSONB DEFAULT '[]'::jsonb,
  channel_availability JSONB DEFAULT '{"online": true, "dineIn": true, "takeaway": true, "posDelivery": true}'::jsonb,
  rating NUMERIC(3, 2) DEFAULT 4.80,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Master Combos
CREATE TABLE IF NOT EXISTS menu_combos (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL,
  original_price NUMERIC(10, 2),
  image_url TEXT,
  items JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Authoritative Coupons & Deals
CREATE TABLE IF NOT EXISTS menu_coupons (
  id VARCHAR(100) PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(255),
  description TEXT,
  discount_type VARCHAR(50) DEFAULT 'percentage',
  discount_value NUMERIC(10, 2) NOT NULL,
  min_order_amount NUMERIC(10, 2) DEFAULT 0.00,
  max_discount_amount NUMERIC(10, 2),
  usage_limit INTEGER,
  usage_count INTEGER DEFAULT 0,
  starts_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Promotional Banners & Ads
CREATE TABLE IF NOT EXISTS promotional_ads (
  id VARCHAR(100) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  subtitle TEXT,
  image_url TEXT,
  action_type VARCHAR(50) DEFAULT 'CATEGORY',
  action_target TEXT,
  badge VARCHAR(50),
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Sub-Millisecond Filtering
CREATE INDEX IF NOT EXISTS idx_menu_products_category ON menu_products(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_products_active ON menu_products(is_active);
CREATE INDEX IF NOT EXISTS idx_menu_coupons_code ON menu_coupons(code);
CREATE INDEX IF NOT EXISTS idx_menu_coupons_active ON menu_coupons(is_active);
