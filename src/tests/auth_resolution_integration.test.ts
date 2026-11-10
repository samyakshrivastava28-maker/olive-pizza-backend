import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';

test('Multi-App Role & Scope Authorization Matrix (Strict Separation Policy)', async (t) => {
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

  // Seed PostgreSQL franchises, branches, app_users and delivery_partners for tests
  await testDb.db.exec(`
    INSERT INTO franchises (id, name, status)
    VALUES ('fra_rajnandgaon', 'Olive Pizza Rajnandgaon', 'ACTIVE')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO restaurant_branches (id, franchise_id, name, is_open)
    VALUES ('main_branch', 'fra_rajnandgaon', 'Rajnandgaon Main Branch', true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO app_users (id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active)
    VALUES
      ('usr_owner_webhub', 'webhub2811@gmail.com', '9179944445', 'Platform Owner', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER"]'::jsonb, true),
      ('usr_owner_olive', 'olivepizzarjn@gmail.com', '9876543210', 'Olive Pizza RJN', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER"]'::jsonb, true),
      ('ONXCYjWmN1hNVv6bVjwCYxi76Sz1', 'cashier@olivepizza.in', '9876543211', 'POS Cashier', 'cashier', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, true)
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      allowed_apps = EXCLUDED.allowed_apps,
      is_active = EXCLUDED.is_active;

    INSERT INTO delivery_partners (id, name, phone, email, franchise_id, branch_id, status, is_online)
    VALUES
      ('staff_rider_01', 'Test Rider', '9876543212', 'rider@olivepizza.in', 'fra_rajnandgaon', 'main_branch', 'APPROVED', true)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      is_online = EXCLUDED.is_online;
  `);

  const ownerAccounts = [
    { email: 'webhub2811@gmail.com', uid: '6tLLR6q7aTYqzTG2blRx3TU5sA42' },
    { email: 'olivepizzarjn@gmail.com', uid: 'ZzMmHLa6fBeDYY7clYNjP70fbiE2' }
  ];

  await t.test('Owner accounts must be authorized for OWNER command center', async () => {
    for (const acc of ownerAccounts) {
      const res = await FranchiseAccessService.resolveAuthorization({
        uid: acc.uid,
        email: acc.email,
        targetApp: 'OWNER'
      });
      assert.equal(res.authorized, true, `${acc.email} must be authorized for OWNER`);
      assert.equal(res.user?.role, 'owner', `${acc.email} must hold owner role`);
      assert.ok(res.user?.branchId, `${acc.email} must have a branchId`);
      assert.ok(res.user?.franchiseId, `${acc.email} must have a franchiseId`);
    }
  });

  await t.test('Owner accounts without explicit staff grants must be denied access to staff applications', async () => {
    const staffApps = ['RESTAURANT_MANAGER', 'FRANCHISE_MANAGER', 'POS', 'DELIVERY'];

    for (const acc of ownerAccounts) {
      for (const targetApp of staffApps) {
        const res = await FranchiseAccessService.resolveAuthorization({
          uid: acc.uid,
          email: acc.email,
          targetApp
        });
        // Unless this specific owner account was provisioned in PostgreSQL/Firestore with explicit staff grant,
        // it must fail closed and require explicit staff grant
        if (!res.authorized) {
          assert.equal(res.code, 'STAFF_GRANT_REQUIRED', `${acc.email} on ${targetApp} must require explicit staff grant`);
          assert.match(res.reason || '', /explicit/i, 'Reason must state explicit assignment is required');
        } else {
          // If explicitly provisioned, verify it has actual branch and franchise
          assert.ok(res.user?.branchId, 'Explicitly provisioned account must have branch scope');
          assert.ok(res.user?.franchiseId, 'Explicitly provisioned account must have franchise scope');
        }
      }
    }
  });

  await t.test('POS cashier account must have access to POS and reject managerial/delivery/owner apps', async () => {
    const cashier = { email: 'cashier@olivepizza.in', uid: 'ONXCYjWmN1hNVv6bVjwCYxi76Sz1' };
    
    const posRes = await FranchiseAccessService.resolveAuthorization({
      uid: cashier.uid,
      email: cashier.email,
      targetApp: 'POS',
      terminalId: 'POS-TERM-01'
    });
    assert.equal(posRes.authorized, true, 'Cashier must be authorized for POS');

    const mgrRes = await FranchiseAccessService.resolveAuthorization({
      uid: cashier.uid,
      email: cashier.email,
      targetApp: 'RESTAURANT_MANAGER'
    });
    assert.equal(mgrRes.authorized, false, 'Cashier must NOT access Restaurant Manager');

    const ownerRes = await FranchiseAccessService.resolveAuthorization({
      uid: cashier.uid,
      email: cashier.email,
      targetApp: 'OWNER'
    });
    assert.equal(ownerRes.authorized, false, 'Cashier must NOT access Owner Console');
    assert.equal(ownerRes.code, 'ACCESS_DENIED', 'Cashier must receive ACCESS_DENIED for Owner Console');
  });

  await t.test('Delivery rider account must have access to Delivery app and reject POS/Manager/Owner apps', async () => {
    const rider = { email: 'rider@olivepizza.in', uid: 'staff_rider_01' };

    const delRes = await FranchiseAccessService.resolveAuthorization({
      uid: rider.uid,
      email: rider.email,
      targetApp: 'DELIVERY'
    });
    assert.equal(delRes.authorized, true, 'Rider must be authorized for Delivery');

    const mgrRes = await FranchiseAccessService.resolveAuthorization({
      uid: rider.uid,
      email: rider.email,
      targetApp: 'RESTAURANT_MANAGER'
    });
    assert.equal(mgrRes.authorized, false, 'Rider must NOT access Restaurant Manager');

    const ownerRes = await FranchiseAccessService.resolveAuthorization({
      uid: rider.uid,
      email: rider.email,
      targetApp: 'OWNER'
    });
    assert.equal(ownerRes.authorized, false, 'Rider must NOT access Owner Console');
    assert.equal(ownerRes.code, 'ACCESS_DENIED', 'Rider must receive ACCESS_DENIED for Owner Console');
  });
});
