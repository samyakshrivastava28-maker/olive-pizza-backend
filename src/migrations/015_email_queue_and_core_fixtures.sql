-- Migration 015: Email Queue, Campaigns, Dead Letter Queue & Core Seed Fixtures

-- 1. email_campaigns table
CREATE TABLE IF NOT EXISTS email_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    html_content TEXT NOT NULL,
    sent_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. email_queue table
CREATE TABLE IF NOT EXISTS email_queue (
    id SERIAL PRIMARY KEY,
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    html_content TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'transactional',
    campaign_id INTEGER REFERENCES email_campaigns(id),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    retry_timestamp TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(255) UNIQUE,
    last_error TEXT,
    smtp_response TEXT,
    attachments JSONB,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. dead_letter_queue table
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id SERIAL PRIMARY KEY,
    original_queue_id INTEGER,
    recipient VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    payload TEXT,
    final_error TEXT,
    failed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Indexes for fast queue polling and idempotency
CREATE INDEX IF NOT EXISTS idx_email_queue_status_retry ON email_queue(status, retry_count, retry_timestamp);
CREATE INDEX IF NOT EXISTS idx_email_queue_idempotency ON email_queue(idempotency_key);

-- 5. Canonical franchises table
CREATE TABLE IF NOT EXISTS franchises (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'ACTIVE',
    owner_email VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 6. Canonical baseline franchise, branch, user & partner seed fixtures
INSERT INTO franchises (id, name, status)
VALUES 
    ('fra_primary', 'Olive Pizza Primary Franchise', 'ACTIVE'),
    ('fra_rajnandgaon', 'Olive Pizza Rajnandgaon', 'ACTIVE'),
    ('fra_bilaspur', 'Olive Pizza Bilaspur', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open)
VALUES 
    ('main_branch', 'fra_primary', 'Rajnandgaon Main Branch', 'Station Road, Rajnandgaon, Chhattisgarh 491441', '9179944445', TRUE),
    ('branch_rjn_main', 'fra_rajnandgaon', 'Rajnandgaon Main Branch', 'Station Road, Rajnandgaon, Chhattisgarh 491441', '9179944445', TRUE),
    ('branch_bsp_link', 'fra_bilaspur', 'Bilaspur Link Road Branch', 'Link Road, Bilaspur, Chhattisgarh 495001', '9179944446', TRUE),
    ('branch_bsp_main', 'fra_bilaspur', 'Bilaspur Main Branch', 'Vyapar Vihar, Bilaspur, Chhattisgarh 495001', '9179944447', TRUE)
ON CONFLICT (id) DO UPDATE SET
    franchise_id = EXCLUDED.franchise_id,
    is_open = TRUE;

INSERT INTO app_users (id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active)
VALUES
    ('usr_owner_webhub', 'webhub2811@gmail.com', '9179944445', 'Platform Owner', 'owner', 'APPROVED', 'fra_primary', 'main_branch', '["OWNER", "CUSTOMER"]'::jsonb, TRUE),
    ('usr_owner_olive', 'olivepizzarjn@gmail.com', '9876543210', 'Olive Pizza RJN', 'owner', 'APPROVED', 'fra_primary', 'main_branch', '["OWNER", "CUSTOMER"]'::jsonb, TRUE),
    ('6tLLR6q7aTYqzTG2blRx3TU5sA42', 'webhub2811@gmail.com', '9179944445', 'Platform Owner (UID)', 'owner', 'APPROVED', 'fra_primary', 'main_branch', '["OWNER"]'::jsonb, TRUE),
    ('staff_cashier_01', 'cashier@olivepizza.in', '9876543211', 'POS Cashier', 'cashier', 'APPROVED', 'fra_primary', 'main_branch', '["POS"]'::jsonb, TRUE),
    ('ONXCYjWmN1hNVv6bVjwCYxi76Sz1', 'cashier@olivepizza.in', '9876543211', 'POS Cashier (UID)', 'cashier', 'APPROVED', 'fra_primary', 'main_branch', '["POS"]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    allowed_apps = EXCLUDED.allowed_apps,
    is_active = EXCLUDED.is_active;

INSERT INTO delivery_partners (id, name, phone, email, franchise_id, branch_id, status, is_online)
VALUES
    ('staff_rider_01', 'Test Rider', '9876543212', 'rider@olivepizza.in', 'fra_primary', 'main_branch', 'APPROVED', TRUE),
    ('usr_test_rider', 'Test Rider 2', '9876543213', 'rider2@olivepizza.in', 'fra_primary', 'main_branch', 'APPROVED', TRUE)
ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    is_online = EXCLUDED.is_online;
