-- 011_delivery_tracking_and_reports.sql
-- Phase 7: Delivery Tracking Consolidation, Spatial Indexing, and Report Storage

-- 1. Ensure columns exist on canonical_orders and restaurant_branches
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS delivery_partner_id VARCHAR(255);
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS delivery_partner_name VARCHAR(255);
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS delivery_partner_phone VARCHAR(50);
ALTER TABLE canonical_orders ADD COLUMN IF NOT EXISTS partner_assigned_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 7);
ALTER TABLE restaurant_branches ADD COLUMN IF NOT EXISTS longitude NUMERIC(10, 7);

CREATE INDEX IF NOT EXISTS idx_canonical_orders_delivery_partner ON canonical_orders(delivery_partner_id);

-- 2. Performance & Spatial Indexing for delivery_locations
CREATE INDEX IF NOT EXISTS idx_delivery_locations_partner ON delivery_locations(delivery_partner_id);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_order ON delivery_locations(active_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_status_updated ON delivery_locations(online_status, last_updated);
CREATE INDEX IF NOT EXISTS idx_delivery_locations_lat_lng ON delivery_locations(latitude, longitude);

-- 3. Performance & Spatial Indexing for delivery_partners
CREATE INDEX IF NOT EXISTS idx_delivery_partners_dispatch ON delivery_partners(branch_id, franchise_id, is_online, status);
CREATE INDEX IF NOT EXISTS idx_delivery_partners_active_order ON delivery_partners(active_order_id);

-- 4. Metadata table for Generated CSV Reports stored in Firebase Storage
CREATE TABLE IF NOT EXISTS generated_reports (
  id VARCHAR(255) PRIMARY KEY,
  report_type VARCHAR(100) NOT NULL,
  order_source VARCHAR(50) NOT NULL DEFAULT 'ALL',
  franchise_id VARCHAR(100) NOT NULL,
  branch_id VARCHAR(100) NOT NULL,
  period_label VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 VARCHAR(64) NOT NULL,
  storage_provider VARCHAR(50) NOT NULL DEFAULT 'FIREBASE_STORAGE',
  generated_by_uid VARCHAR(255),
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generated_reports_scope ON generated_reports(franchise_id, branch_id, report_type, start_date, end_date);

-- 5. Audit log for Encrypted Database Backups in Firebase Storage
CREATE TABLE IF NOT EXISTS database_backups (
  id VARCHAR(255) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum_sha256 VARCHAR(64) NOT NULL,
  encryption_algorithm VARCHAR(50) NOT NULL DEFAULT 'AES-256-GCM',
  status VARCHAR(50) NOT NULL DEFAULT 'COMPLETED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
