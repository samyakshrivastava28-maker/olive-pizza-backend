/**
 * rider_onboarding_and_routes.test.ts
 *
 * Verification suite for RiderOnboardingService (BR-01, BR-11):
 * 1. Branch Manager submits rider onboarding request.
 * 2. Scoped request listing by role/branch.
 * 3. Role-based security gate: non-owner review rejected with 403.
 * 4. Platform Owner approval: deterministic identity linking (app_users + delivery_partners).
 * 5. Outbox event recording on approval.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestQueryOverride, setTestClientOverride } from '../config/postgres.js';
import { setTestDbOverride } from '../lib/db.js';
import { RiderOnboardingService } from '../services/delivery/RiderOnboardingService.js';

test('Rider Onboarding & Deterministic Identity Architecture (BR-01, BR-11)', async (t) => {
  let testDb: DisposableTestDb;

  testDb = await createDisposableTestDb();

  const mockPoolClient: any = {
    query: async (text: string, params?: any[]) => testDb.query(text, params),
    release: () => {}
  };

  const mockPool: any = {
    query: async (text: string, params?: any[]) => testDb.query(text, params),
    connect: async () => mockPoolClient
  };

  setTestDbOverride(testDb.query, mockPool);
  setTestQueryOverride(async (text: string, params?: any[]) => testDb.query(text, params));
  setTestClientOverride(async () => mockPoolClient);

  t.after(async () => {
    setTestDbOverride(null, null);
    setTestQueryOverride(null);
    setTestClientOverride(null);
    if (testDb) {
      await testDb.close();
    }
  });

  let createdRequestId = '';

  await t.test('1. Restaurant Manager submits rider onboarding request', async () => {
    const res = await RiderOnboardingService.submitRequest({
      requestedByUid: 'mgr_test_01',
      requestedByRole: 'restaurant_manager',
      branchId: 'main_branch',
      franchiseId: 'fra_rajnandgaon',
      riderName: 'Vikash Netam',
      phone: '9827199999',
      email: 'vikash@olivepizza.in',
      vehicleType: 'Motorcycle',
      vehicleNumber: 'CG-08-AA-1234'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'PENDING_APPROVAL');
    assert.ok(res.requestId.startsWith('onb_'));
    createdRequestId = res.requestId;

    // Verify row in rider_onboarding_requests
    const reqRow = await testDb.query(`SELECT * FROM rider_onboarding_requests WHERE id = $1`, [createdRequestId]);
    assert.strictEqual(reqRow.rows.length, 1);
    assert.strictEqual(reqRow.rows[0].rider_name, 'Vikash Netam');
    assert.strictEqual(reqRow.rows[0].status, 'PENDING_APPROVAL');
  });

  await t.test('2. Scoped listing of onboarding requests by branch/role', async () => {
    const list = await RiderOnboardingService.listRequests({
      branchId: 'main_branch',
      franchiseId: 'fra_rajnandgaon',
      userRole: 'restaurant_manager'
    });

    assert.ok(list.length >= 1);
    const found = list.find(r => r.id === createdRequestId);
    assert.ok(found);
    assert.strictEqual(found.rider_name, 'Vikash Netam');
  });

  await t.test('3. Non-owner review attempt is rejected with 403 FORBIDDEN_REVIEW', async () => {
    await assert.rejects(
      async () => {
        await RiderOnboardingService.reviewRequest({
          requestId: createdRequestId,
          reviewerUid: 'cashier_01',
          reviewerRole: 'cashier',
          action: 'APPROVE'
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 403);
        assert.strictEqual(err.code, 'FORBIDDEN_REVIEW');
        return true;
      }
    );
  });

  await t.test('4. Platform Owner approves and activates rider with deterministic identity', async () => {
    const reviewRes = await RiderOnboardingService.reviewRequest({
      requestId: createdRequestId,
      reviewerUid: 'usr_owner_01',
      reviewerRole: 'owner',
      action: 'APPROVE'
    });

    assert.strictEqual(reviewRes.success, true);
    assert.strictEqual(reviewRes.status, 'APPROVED');
    assert.ok(reviewRes.userId);
    assert.ok(reviewRes.partnerId);

    // Verify canonical app_users record
    const userRes = await testDb.query(`SELECT * FROM app_users WHERE id = $1`, [reviewRes.userId]);
    assert.strictEqual(userRes.rows.length, 1);
    const u = userRes.rows[0];
    assert.strictEqual(u.role, 'delivery_partner');
    assert.strictEqual(u.status, 'APPROVED');
    assert.strictEqual(u.is_active, true);
    assert.deepStrictEqual(u.allowed_apps, ['DELIVERY']);

    // Verify linked delivery_partners record
    const partnerRes = await testDb.query(`SELECT * FROM delivery_partners WHERE id = $1`, [reviewRes.partnerId]);
    assert.strictEqual(partnerRes.rows.length, 1);
    const p = partnerRes.rows[0];
    assert.strictEqual(p.user_id, reviewRes.userId);
    assert.strictEqual(p.status, 'AVAILABLE');
    assert.strictEqual(p.is_online, false);

    // Verify onboarding request marked APPROVED
    const finalReq = await testDb.query(`SELECT status, reviewed_by_uid FROM rider_onboarding_requests WHERE id = $1`, [createdRequestId]);
    assert.strictEqual(finalReq.rows[0].status, 'APPROVED');
    assert.strictEqual(finalReq.rows[0].reviewed_by_uid, 'usr_owner_01');

    // Verify Outbox Event created
    const outboxCheck = await testDb.query(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'RIDER_ONBOARDED'`,
      [reviewRes.partnerId]
    );
    assert.strictEqual(outboxCheck.rows.length, 1);
    assert.strictEqual(outboxCheck.rows[0].status, 'PENDING');
  });
});
