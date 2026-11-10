-- 017_homepage_configurations.sql
-- Durable PostgreSQL Master Schema for Homepage Layout Configurations & Draft/Publish Lifecycle

CREATE TABLE IF NOT EXISTS homepage_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchise_id VARCHAR(100) NOT NULL DEFAULT 'fra_primary',
  branch_id VARCHAR(100) NOT NULL DEFAULT 'main_branch',
  version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT', 'PUBLISHED', 'ARCHIVED'
  layout_json JSONB NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by VARCHAR(255) NOT NULL,
  published_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (franchise_id, branch_id, version)
);

CREATE INDEX IF NOT EXISTS idx_homepage_lookup 
ON homepage_configurations (franchise_id, branch_id, status);

CREATE INDEX IF NOT EXISTS idx_homepage_published 
ON homepage_configurations (franchise_id, branch_id) 
WHERE status = 'PUBLISHED';
