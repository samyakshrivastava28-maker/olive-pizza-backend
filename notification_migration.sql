-- =============================================================================
-- ENTERPRISE NOTIFICATION SYSTEM — MIGRATION
-- Run this migration on your Postgres database to enable all enterprise features
-- =============================================================================

-- ─── 1. Extend notification_queue ────────────────────────────────────────────
ALTER TABLE notification_queue
  ADD COLUMN IF NOT EXISTS tag VARCHAR(255),
  ADD COLUMN IF NOT EXISTS notification_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS order_id UUID,
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS group_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- Index for tag-based lookup (Live Order Card deduplication)
CREATE INDEX IF NOT EXISTS idx_nqueue_tag ON notification_queue(tag)
  WHERE tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nqueue_order ON notification_queue(order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nqueue_status ON notification_queue(status);
CREATE INDEX IF NOT EXISTS idx_nqueue_expires ON notification_queue(expires_at)
  WHERE expires_at IS NOT NULL;

-- ─── 2. Extend notification_history ──────────────────────────────────────────
ALTER TABLE notification_history
  ADD COLUMN IF NOT EXISTS tag VARCHAR(255),
  ADD COLUMN IF NOT EXISTS order_id UUID,
  ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS action_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS action_taken VARCHAR(100),
  ADD COLUMN IF NOT EXISTS delivery_time_ms INTEGER,
  ADD COLUMN IF NOT EXISTS open_time_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_nhist_user ON notification_history(target_user_id);
CREATE INDEX IF NOT EXISTS idx_nhist_created ON notification_history(created_at);
CREATE INDEX IF NOT EXISTS idx_nhist_tag ON notification_history(tag)
  WHERE tag IS NOT NULL;

-- ─── 3. Notification Inbox (permanent store per user) ────────────────────────
CREATE TABLE IF NOT EXISTS notification_inbox (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  tag VARCHAR(255),
  order_id UUID,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  category VARCHAR(50) DEFAULT 'general',
  icon VARCHAR(500),
  url VARCHAR(500),
  data JSONB,
  is_read BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_inbox_user ON notification_inbox(user_id);
CREATE INDEX IF NOT EXISTS idx_inbox_user_read ON notification_inbox(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_inbox_tag ON notification_inbox(tag)
  WHERE tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbox_created ON notification_inbox(created_at);

-- ─── 4. Notification Analytics (per-notification tracking) ───────────────────
CREATE TABLE IF NOT EXISTS notification_analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_date DATE NOT NULL,
  category VARCHAR(50) DEFAULT 'general',
  role VARCHAR(50) DEFAULT 'all',
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  total_delivery_time_ms BIGINT DEFAULT 0,
  total_open_time_ms BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_date, category, role)
);

CREATE INDEX IF NOT EXISTS idx_analytics_date ON notification_analytics(period_date DESC);

-- ─── 5. FCM Token Registry (separate from user doc for dedup control) ─────────
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  device_name VARCHAR(255),
  platform VARCHAR(100),
  browser VARCHAR(100),
  app_version VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_fcm_user ON fcm_tokens(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fcm_token ON fcm_tokens(token);
CREATE INDEX IF NOT EXISTS idx_fcm_last_used ON fcm_tokens(last_used_at);

-- ─── 6. DND Preferences ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mute_marketing BOOLEAN DEFAULT FALSE,
  mute_low_priority BOOLEAN DEFAULT FALSE,
  always_receive_orders BOOLEAN DEFAULT TRUE,
  always_receive_alerts BOOLEAN DEFAULT TRUE,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ─── 7. Order Locking (prevent race conditions) ───────────────────────────────
CREATE TABLE IF NOT EXISTS order_locks (
  order_id UUID PRIMARY KEY,
  locked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  action VARCHAR(100)
);

-- ─── 8. Auto Cleanup Function ─────────────────────────────────────────────────
-- Runs via pg_cron or backend scheduler

CREATE OR REPLACE FUNCTION cleanup_notifications()
RETURNS void AS $$
BEGIN
  -- Delete inbox items older than 2 days (keep today + yesterday)
  DELETE FROM notification_inbox
  WHERE created_at < NOW() - INTERVAL '2 days'
    AND (expires_at IS NULL OR expires_at < NOW());

  -- Delete inbox marketing items older than 24 hours
  DELETE FROM notification_inbox
  WHERE category IN ('marketing', 'announcement')
    AND created_at < NOW() - INTERVAL '24 hours';

  -- Delete notification history older than 2 days
  DELETE FROM notification_history
  WHERE created_at < NOW() - INTERVAL '2 days';

  -- Delete completed/failed queue items older than 1 hour
  DELETE FROM notification_queue
  WHERE status IN ('sent', 'failed', 'delivered', 'opened', 'action_performed')
    AND updated_at < NOW() - INTERVAL '1 hour';

  -- Delete expired queue items
  DELETE FROM notification_queue
  WHERE expires_at IS NOT NULL AND expires_at < NOW();

  -- Deactivate FCM tokens not used in 60 days
  UPDATE fcm_tokens
  SET is_active = FALSE
  WHERE last_used_at < NOW() - INTERVAL '60 days'
    AND is_active = TRUE;

  -- Delete stale heartbeats older than 24 hours
  DELETE FROM device_heartbeats
  WHERE last_seen < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;
