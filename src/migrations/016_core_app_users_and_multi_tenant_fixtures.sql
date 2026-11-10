-- Migration 016: Core App Users, Multi-Tenant Branches & Delivery Partners Fixtures

-- 1. Ensure all canonical franchises exist
INSERT INTO franchises (id, name, status)
VALUES 
    ('fra_primary', 'Olive Pizza Primary Franchise', 'ACTIVE'),
    ('fra_rajnandgaon', 'Olive Pizza Rajnandgaon', 'ACTIVE'),
    ('fra_bilaspur', 'Olive Pizza Bilaspur', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- 2. Ensure canonical branches exist with correct franchise associations
INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open)
VALUES 
    ('main_branch', 'fra_rajnandgaon', 'Rajnandgaon Main Branch', 'Station Road, Rajnandgaon, Chhattisgarh 491441', '9179944445', TRUE),
    ('branch_rjn_main', 'fra_rajnandgaon', 'Rajnandgaon Main Branch', 'Station Road, Rajnandgaon, Chhattisgarh 491441', '9179944445', TRUE),
    ('branch_bsp_link', 'fra_bilaspur', 'Bilaspur Link Road Branch', 'Link Road, Bilaspur, Chhattisgarh 495001', '9179944446', TRUE),
    ('branch_bsp_main', 'fra_bilaspur', 'Bilaspur Main Branch', 'Vyapar Vihar, Bilaspur, Chhattisgarh 495001', '9179944447', TRUE)
ON CONFLICT (id) DO UPDATE SET
    franchise_id = EXCLUDED.franchise_id,
    is_open = TRUE;

-- 3. Canonical system and staff app_users for access control & testing
INSERT INTO app_users (id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active)
VALUES
    ('usr_owner_webhub', 'webhub2811@gmail.com', '9179944445', 'Platform Owner', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER", "CUSTOMER"]'::jsonb, TRUE),
    ('usr_owner_olive', 'olivepizzarjn@gmail.com', '9876543210', 'Olive Pizza RJN', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER", "CUSTOMER"]'::jsonb, TRUE),
    ('6tLLR6q7aTYqzTG2blRx3TU5sA42', 'webhub2811@gmail.com', '9179944445', 'Platform Owner (UID)', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER"]'::jsonb, TRUE),
    ('staff_cashier_01', 'cashier@olivepizza.in', '9876543211', 'POS Cashier', 'cashier', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, TRUE),
    ('ONXCYjWmN1hNVv6bVjwCYxi76Sz1', 'cashier@olivepizza.in', '9876543211', 'POS Cashier (UID)', 'cashier', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, TRUE)
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    allowed_apps = EXCLUDED.allowed_apps,
    is_active = EXCLUDED.is_active;

-- 4. Canonical delivery partners
INSERT INTO delivery_partners (id, name, phone, email, franchise_id, branch_id, status, is_online)
VALUES
    ('staff_rider_01', 'Test Rider', '9876543212', 'rider@olivepizza.in', 'fra_rajnandgaon', 'main_branch', 'APPROVED', TRUE),
    ('usr_test_rider', 'Test Rider 2', '9876543213', 'rider2@olivepizza.in', 'fra_rajnandgaon', 'main_branch', 'APPROVED', TRUE)
ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    is_online = EXCLUDED.is_online;
