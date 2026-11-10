/**
 * provisional_dispatch_flow.test.ts
 * 
 * Comprehensive verification suite for Section 4:
 * Correct Rider Dispatch Fallback & Canonical Reconciliation
 * 
 * Verifies all 16 required test scenarios:
 * 1. Valid PostgreSQL order (Case A authoritative dispatch)
 * 2. Legitimate Firestore-first order (Case B restricted provisional fallback)
 * 3. PostgreSQL order not found with no Firestore doc (fail-closed)
 * 4. Missing Firestore branch (fail-closed)
 * 5. Invalid branch (Firestore branch not present in PostgreSQL authority -> fail-closed)
 * 6. Inactive branch in PostgreSQL authority -> fail-closed
 * 7. Wrong franchise (branch franchise mismatch -> fail-closed)
 * 8. Stale order (> 2 hours old -> fail-closed)
 * 9. Cancelled order -> fail-closed
 * 10. Already assigned order (double assignment prevention)
 * 11. PostgreSQL connection failure (fail-closed with DATABASE_UNAVAILABLE, never order-not-found)
 * 12. Simultaneous double-acceptance gate (atomic concurrency)
 * 13. Canonical reconciliation after delayed PostgreSQL synchronization
 * 14. Canonical reconciliation after order cancellation
 * 15. Rider revocation during provisional processing
 * 16. Expired provisional intent cleanup releases rider locks
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';
import { RiderDispatchEngine } from '../services/delivery/RiderDispatchEngine.js';
import { ProvisionalDispatchService } from '../services/delivery/ProvisionalDispatchService.js';

test('Priority P0: Rider Dispatch Fallback & Canonical Reconciliation Flow', async (t) => {
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

  // Helper to ensure clean rider state before subtests
  const resetRiderPool = async () => {
    await testDb.db.exec(`
      UPDATE delivery_partners 
      SET active_order_id = NULL, status = 'APPROVED', is_online = true;
    `);
  };

  // Seed baseline authoritative test fixtures in PostgreSQL
  await testDb.db.exec(`
    INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open, accepting_orders)
    VALUES 
      ('branch_prov_main', 'fra_rajnandgaon', 'Provisional Main Branch', 'Station Road', '9179944445', true, true),
      ('branch_prov_inactive', 'fra_rajnandgaon', 'Inactive Branch', 'Closed St', '9876543210', false, false)
    ON CONFLICT (id) DO UPDATE SET is_open = EXCLUDED.is_open, accepting_orders = EXCLUDED.accepting_orders;

    INSERT INTO delivery_partners (id, name, phone, status, is_online, branch_id, franchise_id, active_order_id)
    VALUES 
      ('rider_prov_01', 'Active Rider 1', '+919876543201', 'APPROVED', true, 'branch_prov_main', 'fra_rajnandgaon', NULL),
      ('rider_prov_02', 'Active Rider 2', '+919876543202', 'APPROVED', true, 'branch_prov_main', 'fra_rajnandgaon', NULL),
      ('rider_prov_busy', 'Busy Rider', '+919876543203', 'APPROVED', true, 'branch_prov_main', 'fra_rajnandgaon', 'existing_order_999'),
      ('rider_prov_offline', 'Offline Rider', '+919876543204', 'APPROVED', false, 'branch_prov_main', 'fra_rajnandgaon', NULL),
      ('rider_prov_suspended', 'Suspended Rider', '+919876543205', 'SUSPENDED', true, 'branch_prov_main', 'fra_rajnandgaon', NULL)
    ON CONFLICT (id) DO NOTHING;
  `);

  await t.test('1. Case A: Canonical PostgreSQL order exists -> authoritative dispatch', async () => {
    await resetRiderPool();
    const orderId = 'ord_case_a_auth_01';
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, branch_id, franchise_id,
        total_amount, payment_method, payment_status, created_at, updated_at
      ) VALUES (
        '${orderId}', 88001, 1, CURRENT_DATE, CURRENT_TIME,
        'ONLINE', 'delivery', 'READY', 'branch_prov_main', 'fra_rajnandgaon',
        499.00, 'COD', 'PENDING', NOW(), NOW()
      );
    `);

    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await RiderDispatchEngine.autoDispatchRider(orderId);
    assert.strictEqual(result.success, true, 'Case A dispatch must succeed');
    assert.strictEqual(result.isProvisional, undefined, 'Case A must NOT be marked provisional');
    assert.ok(result.rider, 'Rider must be assigned');
    assert.strictEqual(result.rider.branchId, 'branch_prov_main');

    const checkOrder = await testDb.query(`SELECT order_status, delivery_partner_id FROM canonical_orders WHERE id = $1`, [orderId]);
    assert.strictEqual(checkOrder.rows[0].order_status, 'PARTNER_ASSIGNED');
    assert.strictEqual(checkOrder.rows[0].delivery_partner_id, result.rider.uid);
  });

  await t.test('2. Case B: Legitimate Firestore-first order -> provisional dispatch intent created', async () => {
    await resetRiderPool();
    const orderId = 'ord_case_b_prov_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await RiderDispatchEngine.autoDispatchRider(orderId);
    assert.strictEqual(result.success, true, 'Case B dispatch must succeed');
    assert.strictEqual(result.isProvisional, true, 'Case B dispatch MUST be marked provisional');
    assert.ok(result.provisionalDispatchId, 'Provisional dispatch ID must be generated');
    assert.ok(result.provisionalDispatchId.startsWith(`prov_disp_${orderId}_`));

    const checkIntent = await testDb.query(
      `SELECT status, reconciliation_status, branch_id FROM provisional_dispatch_intents WHERE order_id = $1`,
      [orderId]
    );
    assert.strictEqual(checkIntent.rows.length, 1);
    assert.strictEqual(checkIntent.rows[0].status, 'PENDING_RECONCILIATION');
    assert.strictEqual(checkIntent.rows[0].reconciliation_status, 'UNRECONCILED');
    assert.strictEqual(checkIntent.rows[0].branch_id, 'branch_prov_main');

    const fsDoc = await adminDb.collection('orders').doc(orderId).get();
    assert.strictEqual(fsDoc.data()?.isProvisionalDispatch, true);
    assert.strictEqual(fsDoc.data()?.provisionalStatus, 'PENDING_RECONCILIATION');
  });

  await t.test('3. Missing order: PostgreSQL order not found and no Firestore doc -> fails closed', async () => {
    const nonExistentOrderId = 'ord_completely_ghost_999';
    const result = await RiderDispatchEngine.autoDispatchRider(nonExistentOrderId);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'ORDER_NOT_FOUND');
  });

  await t.test('4. Missing Firestore branch -> fails closed with MISSING_BRANCH_ID', async () => {
    const orderId = 'ord_missing_branch_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await RiderDispatchEngine.autoDispatchRider(orderId);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'MISSING_BRANCH_ID');
  });

  await t.test('5. Invalid branch: Firestore branchId not in PostgreSQL authority -> fails closed', async () => {
    await resetRiderPool();
    const orderId = 'ord_invalid_branch_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_fake_rogue_999',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'BRANCH_NOT_FOUND', 'Firestore branchId alone must not grant authority');
  });

  await t.test('6. Inactive branch in PostgreSQL authority -> fails closed', async () => {
    await resetRiderPool();
    const orderId = 'ord_inactive_branch_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_inactive',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'BRANCH_INACTIVE');
  });

  await t.test('7. Wrong franchise: branch franchise mismatch -> fails closed', async () => {
    await resetRiderPool();
    const orderId = 'ord_wrong_franchise_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_different_unauthorized',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'FRANCHISE_MISMATCH');
  });

  await t.test('8. Stale order (> 2 hours old) -> fails closed with ORDER_STALE', async () => {
    await resetRiderPool();
    const orderId = 'ord_stale_01';
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: threeHoursAgo
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'ORDER_STALE');
  });

  await t.test('9. Cancelled order -> fails closed with ORDER_TERMINAL_OR_CANCELLED', async () => {
    await resetRiderPool();
    const orderId = 'ord_cancelled_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'cancelled',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'ORDER_TERMINAL_OR_CANCELLED');
  });

  await t.test('10. Already assigned order: concurrent/double assignment is prevented', async () => {
    await resetRiderPool();
    const orderId = 'ord_already_assigned_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      deliveryPartnerId: 'rider_prov_01',
      createdAt: new Date().toISOString()
    });

    const result = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_02', name: 'Rider 2', phone: '+919876543202' }
    });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'ALREADY_ASSIGNED');
  });

  await t.test('11. Case C: PostgreSQL unavailable -> returns DATABASE_UNAVAILABLE, never order-not-found', async () => {
    const orderId = 'ord_case_c_pg_down';

    // Simulate PostgreSQL connection outage on getClient and query
    const outageErr = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    (outageErr as any).code = 'ECONNREFUSED';
    const errorPool = {
      query: async () => { throw outageErr; },
      connect: async () => { throw outageErr; }
    };

    setTestDbOverride(errorPool.query, errorPool);
    setTestQueryOverride(errorPool.query);

    const result = await RiderDispatchEngine.autoDispatchRider(orderId);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.code, 'DATABASE_UNAVAILABLE');
    assert.notStrictEqual(result.code, 'ORDER_NOT_FOUND', 'Connection error must NEVER be treated as order not found');

    // Restore test db overrides
    setTestDbOverride(testDb.query, mockPool);
    setTestQueryOverride(testDb.query);
  });

  await t.test('12. Simultaneous double-acceptance gate (atomic concurrency)', async () => {
    await resetRiderPool();
    const orderId = 'ord_concurrent_accept_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const [res1, res2] = await Promise.all([
      ProvisionalDispatchService.createProvisionalIntent({
        orderId,
        rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
      }),
      ProvisionalDispatchService.createProvisionalIntent({
        orderId,
        rider: { uid: 'rider_prov_02', name: 'Rider 2', phone: '+919876543202' }
      })
    ]);

    const successCount = (res1.success ? 1 : 0) + (res2.success ? 1 : 0);
    assert.strictEqual(successCount, 1, 'Only one rider can accept concurrently');
    const failedRes = res1.success ? res2 : res1;
    assert.strictEqual(failedRes.code, 'ALREADY_ASSIGNED');
  });

  await t.test('13. Canonical reconciliation after delayed PostgreSQL synchronization', async () => {
    await resetRiderPool();
    const orderId = 'ord_reconcile_sync_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const provResult = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(provResult.success, true);
    assert.strictEqual(provResult.isProvisional, true);

    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, branch_id, franchise_id,
        total_amount, payment_method, payment_status, created_at, updated_at
      ) VALUES (
        '${orderId}', 88002, 2, CURRENT_DATE, CURRENT_TIME,
        'ONLINE', 'delivery', 'READY', 'branch_prov_main', 'fra_rajnandgaon',
        750.00, 'UPI', 'PAID', NOW(), NOW()
      );
    `);

    const recon = await ProvisionalDispatchService.reconcileProvisionalDispatch(orderId);
    assert.strictEqual(recon.reconciled, true);
    assert.strictEqual(recon.success, true);

    const checkOrder = await testDb.query(
      `SELECT order_status, delivery_partner_id, delivery_partner_name FROM canonical_orders WHERE id = $1`,
      [orderId]
    );
    assert.strictEqual(checkOrder.rows[0].delivery_partner_id, 'rider_prov_01');
    assert.strictEqual(checkOrder.rows[0].order_status, 'PARTNER_ASSIGNED');

    const checkIntent = await testDb.query(
      `SELECT status, reconciliation_status FROM provisional_dispatch_intents WHERE order_id = $1`,
      [orderId]
    );
    assert.strictEqual(checkIntent.rows[0].status, 'RECONCILED');
    assert.strictEqual(checkIntent.rows[0].reconciliation_status, 'RECONCILED');

    const fsDoc = await adminDb.collection('orders').doc(orderId).get();
    assert.strictEqual(fsDoc.data()?.isProvisionalDispatch, false);
    assert.strictEqual(fsDoc.data()?.provisionalStatus, 'RECONCILED');
  });

  await t.test('14. Canonical reconciliation after order cancellation', async () => {
    await resetRiderPool();
    const orderId = 'ord_reconcile_cancelled_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const provResult = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(provResult.success, true);

    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, branch_id, franchise_id,
        total_amount, payment_method, payment_status, created_at, updated_at
      ) VALUES (
        '${orderId}', 88003, 3, CURRENT_DATE, CURRENT_TIME,
        'ONLINE', 'delivery', 'CANCELLED', 'branch_prov_main', 'fra_rajnandgaon',
        250.00, 'COD', 'VOIDED', NOW(), NOW()
      );
    `);

    const recon = await ProvisionalDispatchService.reconcileProvisionalDispatch(orderId);
    assert.strictEqual(recon.reconciled, false);
    assert.strictEqual(recon.code, 'ORDER_CANCELLED');

    const fsDoc = await adminDb.collection('orders').doc(orderId).get();
    assert.strictEqual(fsDoc.data()?.deliveryPartnerId, null);
    assert.strictEqual(fsDoc.data()?.provisionalStatus, 'CANCELLED');
  });

  await t.test('15. Rider revocation during provisional processing blocks reconciliation', async () => {
    await resetRiderPool();
    const orderId = 'ord_reconcile_revoked_rider_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const provResult = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(provResult.success, true);

    // Revoke rider in PostgreSQL
    await testDb.db.exec(`
      UPDATE delivery_partners SET status = 'REVOKED' WHERE id = 'rider_prov_01';
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, branch_id, franchise_id,
        total_amount, payment_method, payment_status, created_at, updated_at
      ) VALUES (
        '${orderId}', 88004, 4, CURRENT_DATE, CURRENT_TIME,
        'ONLINE', 'delivery', 'READY', 'branch_prov_main', 'fra_rajnandgaon',
        400.00, 'COD', 'PENDING', NOW(), NOW()
      );
    `);

    const recon = await ProvisionalDispatchService.reconcileProvisionalDispatch(orderId);
    assert.strictEqual(recon.reconciled, false);
    assert.strictEqual(recon.code, 'RIDER_REVOKED');

    await resetRiderPool();
  });

  await t.test('16. Expired provisional intent cleanup releases rider locks', async () => {
    await resetRiderPool();
    const orderId = 'ord_expired_intent_01';
    await adminDb.collection('orders').doc(orderId).set({
      id: orderId,
      branchId: 'branch_prov_main',
      franchiseId: 'fra_rajnandgaon',
      status: 'ready',
      deliveryType: 'delivery',
      createdAt: new Date().toISOString()
    });

    const provResult = await ProvisionalDispatchService.createProvisionalIntent({
      orderId,
      rider: { uid: 'rider_prov_01', name: 'Rider 1', phone: '+919876543201' }
    });
    assert.strictEqual(provResult.success, true);

    await testDb.db.exec(`
      UPDATE provisional_dispatch_intents
      SET expires_at = NOW() - INTERVAL '20 minutes'
      WHERE order_id = '${orderId}';
    `);

    const cleanupRes = await ProvisionalDispatchService.cleanupExpiredIntents();
    assert.ok(cleanupRes.expiredCount >= 1);

    const fsDoc = await adminDb.collection('orders').doc(orderId).get();
    assert.strictEqual(fsDoc.data()?.deliveryPartnerId, null);
    assert.strictEqual(fsDoc.data()?.provisionalStatus, 'EXPIRED');
  });
});
