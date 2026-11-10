-- 007_checkout_locks_and_notification_queue.sql
-- Harmonizes ACID checkout_locks schema for user-concurrency guards
-- and provisions notification_queue, fcm_tokens, and notification_inbox tables.

-- 1. Harmonize checkout_locks for user-level atomicity
ALTER TABLE checkout_locks ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
ALTER TABLE checkout_locks ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE checkout_locks ALTER COLUMN lock_key SET DEFAULT gen_random_uuid()::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'checkout_locks_user_id_key'
  ) THEN
    ALTER TABLE checkout_locks ADD CONSTRAINT checkout_locks_user_id_key UNIQUE (user_id);
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_checkout_locks_expires ON checkout_locks(expires_at);

-- 2. Provision notification_queue
CREATE TABLE IF NOT EXISTS notification_queue (
  id SERIAL PRIMARY KEY,
  target_user_id VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  priority VARCHAR(50) DEFAULT 'normal',
  status VARCHAR(50) DEFAULT 'queued',
  tag VARCHAR(255),
  order_id VARCHAR(255),
  notification_id VARCHAR(255),
  version INTEGER DEFAULT 1,
  category VARCHAR(100),
  scheduled_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_queue_status_sched ON notification_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notif_queue_target_user ON notification_queue(target_user_id);
CREATE INDEX IF NOT EXISTS idx_notif_queue_tag ON notification_queue(tag);

-- 3. Provision notification_inbox
CREATE TABLE IF NOT EXISTS notification_inbox (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  payload JSONB NOT NULL,
  tag VARCHAR(255),
  order_id VARCHAR(255),
  category VARCHAR(100),
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_inbox_user_tag_unique'
  ) THEN
    ALTER TABLE notification_inbox ADD CONSTRAINT notification_inbox_user_tag_unique UNIQUE (user_id, tag);
  END IF;
EXCEPTION
  WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_notif_inbox_user_read ON notification_inbox(user_id, is_read);

-- 4. Provision fcm_tokens
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  token TEXT NOT NULL UNIQUE,
  device_id VARCHAR(255),
  device_name VARCHAR(255),
  platform VARCHAR(50),
  app_name VARCHAR(50),
  role VARCHAR(50),
  branch_id VARCHAR(100),
  franchise_id VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_active ON fcm_tokens(user_id, is_active);

-- 5. Provision notification_analytics
CREATE TABLE IF NOT EXISTS notification_analytics (
  id SERIAL PRIMARY KEY,
  category VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,
  count INTEGER DEFAULT 1,
  total_delivery_time_ms BIGINT DEFAULT 0,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
