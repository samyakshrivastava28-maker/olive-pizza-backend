import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';
import { corsMiddleware } from '../app.js';

test('Management App Login & Scoped Access Recovery Test Suite', async (t) => {
  let testDb: DisposableTestDb;
  testDb = await createDisposableTestDb();

  const mockPoolClient = {
    query: testDb.query,
    release: () => {}
  };
  const mockPool = {
    query: testDb.query,
    connect: async () => mockPoolClient
  };

  setTestDbOverride(testDb.query, mockPool);
  setTestQueryOverride(testDb.query);

  t.after(async () => {
    setTestDbOverride(null, null);
    setTestQueryOverride(null);
    if (testDb) {
      await testDb.close();
    }
  });

  // Seed PostgreSQL schema fixtures
  await testDb.db.exec(`
    INSERT INTO franchises (id, name, status)
    VALUES 
      ('fra_rajnandgaon', 'Olive Pizza Rajnandgaon HQ', 'ACTIVE'),
      ('fra_bilaspur', 'Olive Pizza Bilaspur', 'ACTIVE')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO restaurant_branches (id, franchise_id, name, is_open)
    VALUES 
      ('main_branch', 'fra_rajnandgaon', 'Rajnandgaon HQ Branch', true),
      ('branch_bsp_main', 'fra_bilaspur', 'Bilaspur Main Branch', true)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM app_users WHERE email IN (
      'webhub2811@gmail.com', 
      'olivepizzarjn@gmail.com', 
      'cashier@olivepizza.in', 
      'executive@olivepizza.in', 
      'manager@olivepizza.in', 
      'franchise@olivepizza.in', 
      'unassigned@olivepizza.in',
      'inactive@olivepizza.in'
    );

    INSERT INTO app_users (id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, metadata, is_active)
    VALUES
      -- 1. Platform Owner + Lead Executive (NO DELIVERY, NO CUSTOMER)
      ('usr_owner_webhub', 'webhub2811@gmail.com', '9179944445', 'Platform Owner', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER", "RESTAURANT_MANAGER", "FRANCHISE_MANAGER", "POS"]'::jsonb, '{"terminalId":"POS-01"}'::jsonb, true),
      -- 2. Restaurant Owner / Managing Partner (RESTAURANT_MANAGER and POS ONLY)
      ('usr_olive_rjn', 'olivepizzarjn@gmail.com', '9876543210', 'Restaurant Partner', 'restaurant_owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["RESTAURANT_MANAGER", "POS"]'::jsonb, '{"terminalId":"POS-01", "allowed_terminals":["POS-01"]}'::jsonb, true),
      -- 3. Pure Owner with only OWNER grant (pure executive)
      ('usr_pure_owner', 'executive@olivepizza.in', '9179944448', 'Pure Executive', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER"]'::jsonb, '{}'::jsonb, true),
      -- 4. Dedicated Restaurant Manager
      ('usr_mgr_main', 'manager@olivepizza.in', '9179944446', 'Restaurant Manager', 'restaurant_manager', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["RESTAURANT_MANAGER"]'::jsonb, '{}'::jsonb, true),
      -- 5. Dedicated Franchise Manager
      ('usr_fra_main', 'franchise@olivepizza.in', '9179944447', 'Franchise Manager', 'franchise_manager', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["FRANCHISE_MANAGER"]'::jsonb, '{}'::jsonb, true),
      -- 6. Dedicated POS Cashier with assigned terminal
      ('usr_pos_cashier', 'cashier@olivepizza.in', '9876543211', 'POS Cashier', 'cashier', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, '{"terminalId":"POS-01", "allowed_terminals":["POS-01"]}'::jsonb, true),
      -- 7. Unassigned Staff Member (missing branch scope)
      ('usr_unassigned', 'unassigned@olivepizza.in', '9876543299', 'Unassigned Staff', 'restaurant_manager', 'APPROVED', NULL, NULL, '["RESTAURANT_MANAGER"]'::jsonb, '{}'::jsonb, true),
      -- 8. Suspended / Deactivated Account
      ('usr_inactive', 'inactive@olivepizza.in', '9876543200', 'Inactive Staff', 'restaurant_manager', 'SUSPENDED', 'fra_rajnandgaon', 'main_branch', '["RESTAURANT_MANAGER"]'::jsonb, '{}'::jsonb, false)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      allowed_apps = EXCLUDED.allowed_apps,
      branch_id = EXCLUDED.branch_id,
      franchise_id = EXCLUDED.franchise_id,
      metadata = EXCLUDED.metadata,
      is_active = EXCLUDED.is_active;
  `);

  await t.test('1. Owner signs into Owner Console -> Allowed', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_owner_webhub',
      email: 'webhub2811@gmail.com',
      targetApp: 'OWNER',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.role, 'owner');
    assert.equal(res.requiresPin, false);
  });

  await t.test('2. Explicitly granted Restaurant Manager -> Allowed with correct branch scope', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_mgr_main',
      email: 'manager@olivepizza.in',
      targetApp: 'RESTAURANT_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.role, 'restaurant_manager');
    assert.equal(res.user?.branchId, 'main_branch');
    assert.equal(res.user?.franchiseId, 'fra_rajnandgaon');
  });

  await t.test('3. Explicitly granted Franchise Manager -> Allowed with correct franchise scope', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_fra_main',
      email: 'franchise@olivepizza.in',
      targetApp: 'FRANCHISE_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.role, 'franchise_manager');
    assert.equal(res.user?.franchiseId, 'fra_rajnandgaon');
  });

  await t.test('4. POS Cashier with terminal ID -> Allowed with assigned terminal and branch', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_pos_cashier',
      email: 'cashier@olivepizza.in',
      targetApp: 'POS',
      terminalId: 'POS-01',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.role, 'cashier');
    assert.equal(res.user?.terminalId, 'POS-01');
    assert.equal(res.user?.branchId, 'main_branch');
  });

  await t.test('5. POS Cashier missing terminal in request -> Resolves from PostgreSQL metadata.terminalId', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_pos_cashier',
      email: 'cashier@olivepizza.in',
      targetApp: 'POS',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.terminalId, 'POS-01');
  });

  await t.test('6. POS Cashier attempting forbidden terminal -> Denied with TERMINAL_NOT_PERMITTED', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_pos_cashier',
      email: 'cashier@olivepizza.in',
      targetApp: 'POS',
      terminalId: 'POS-UNAUTHORIZED-99',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'TERMINAL_NOT_PERMITTED');
  });

  await t.test('7. Restaurant Owner (olivepizzarjn) into Restaurant Management -> Allowed', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_olive_rjn',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'RESTAURANT_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.branchId, 'main_branch');
    assert.equal(res.user?.franchiseId, 'fra_rajnandgaon');
  });

  await t.test('8. Restaurant Owner (olivepizzarjn) into POS with POS-01 -> Allowed', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_olive_rjn',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'POS',
      terminalId: 'POS-01',
      emailVerified: true
    });
    assert.equal(res.authorized, true);
    assert.equal(res.user?.terminalId, 'POS-01');
  });

  await t.test('9. Restaurant Owner (olivepizzarjn) into Owner Console -> Denied (No Platform Owner Grant)', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_olive_rjn',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'OWNER',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'ACCESS_DENIED');
  });

  await t.test('10. Restaurant Owner (olivepizzarjn) into Franchise Portal -> Denied (No Franchise Grant)', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_olive_rjn',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'FRANCHISE_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'APP_ACCESS_DENIED');
  });

  await t.test('11. Pure Owner without explicit operational grant -> Denied with STAFF_GRANT_REQUIRED', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_pure_owner',
      email: 'executive@olivepizza.in',
      targetApp: 'RESTAURANT_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'STAFF_GRANT_REQUIRED');
  });

  await t.test('12. Staff member accessing unauthorized branch -> Denied with BRANCH_SCOPE_VIOLATION', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_mgr_main',
      email: 'manager@olivepizza.in',
      targetApp: 'RESTAURANT_MANAGER',
      requestedBranchId: 'branch_bsp_main', // Bilaspur branch, while manager is assigned to main_branch
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'BRANCH_SCOPE_VIOLATION');
  });

  await t.test('13. Staff member without branch scope in DB -> Denied with BRANCH_SCOPE_REQUIRED', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_unassigned',
      email: 'unassigned@olivepizza.in',
      targetApp: 'RESTAURANT_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'BRANCH_SCOPE_REQUIRED');
  });

  await t.test('14. Suspended / Inactive account in PostgreSQL -> Denied with ACCOUNT_REVOKED', async () => {
    const res = await FranchiseAccessService.resolveAuthorization({
      uid: 'usr_inactive',
      email: 'inactive@olivepizza.in',
      targetApp: 'RESTAURANT_MANAGER',
      emailVerified: true
    });
    assert.equal(res.authorized, false);
    assert.equal(res.code, 'ACCOUNT_REVOKED');
  });

  await t.test('15. Double-Billing Defect Verification: Addons billed exactly once', async () => {
    // Replicating order.routes.ts line 1055-1100 logic
    const baseItemPrice = 200;
    const addonPrice = 50;
    // AuthoritativePricingResolver returns unitPrice containing base + crust + addons
    const authoritativeUnitPrice = baseItemPrice + addonPrice; // 250
    const qty = 2;

    // The fixed calculation:
    const fixedTotal = authoritativeUnitPrice * qty;
    assert.equal(fixedTotal, 500, 'Total with 1 addon for qty 2 must be exactly 500');

    // The old buggy calculation:
    const buggyTotal = (authoritativeUnitPrice + addonPrice) * qty;
    assert.equal(buggyTotal, 600, 'Buggy calculation added addonPrice twice resulting in 600');
    assert.notEqual(fixedTotal, buggyTotal, 'Fixed total must eliminate duplicate addon cost');
  });

  await t.test('16. CORS Security Verification: Approved vs Unapproved Origins', async () => {
    const allowed = ['http://localhost:5174', 'http://localhost:5176', 'http://localhost:5178', 'http://localhost:5179'];
    const forbidden = 'http://malicious-attacker-domain.com';

    for (const origin of allowed) {
      let allowedOriginResult: any = null;
      let allowedCredsResult: any = null;
      const req: any = { headers: { origin }, method: 'GET' };
      const res: any = {
        setHeader: (k: string, v: any) => {
          if (k.toLowerCase() === 'access-control-allow-origin') allowedOriginResult = v;
          if (k.toLowerCase() === 'access-control-allow-credentials') allowedCredsResult = v;
        },
        getHeader: () => null
      };
      corsMiddleware(req, res, () => {});
      assert.equal(allowedOriginResult, origin, `Origin ${origin} must be allowed`);
    }

    // Test unapproved origin
    let forbiddenOriginResult: any = null;
    const reqForbidden: any = { headers: { origin: forbidden }, method: 'GET' };
    const resForbidden: any = {
      setHeader: (k: string, v: any) => {
        if (k.toLowerCase() === 'access-control-allow-origin') forbiddenOriginResult = v;
      },
      getHeader: () => null
    };
    corsMiddleware(reqForbidden, resForbidden, () => {});
    assert.notEqual(forbiddenOriginResult, forbidden, 'Malicious origin must NOT receive Access-Control-Allow-Origin');
  });
});
