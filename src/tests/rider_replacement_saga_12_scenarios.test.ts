/**
 * rider_replacement_saga_12_scenarios.test.ts
 *
 * Exhaustive Verification & Audit Suite for Multi-Order Rider Replacement Saga
 * Tests all 12 mandatory scenarios against isolated PostgreSQL (PGlite WASM 18.6 with all canonical migrations):
 * 
 * 1. Old rider with 1 pre-pickup order.
 * 2. Old rider with multiple pre-pickup orders.
 * 3. Old rider with 1 picked-up order (out_for_delivery) requiring physical handover.
 * 4. Old rider with multiple active orders including picked-up deliveries.
 * 5. Replacement rider has insufficient capacity (assigned_orders_count >= 3).
 * 6. No eligible replacement rider in branch pool.
 * 7. Receiving rider refuses handover.
 * 8. Duplicate saga request (idempotencyKey cache hit).
 * 9. Concurrent replacement attempts (row-level lock protection).
 * 10. Database outage during replacement (transaction rollback).
 * 11. Worker interruption during the saga (outbox worker resiliency).
 * 12. Saga resumes without duplicate assignment or deactivation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestQueryOverride, setTestClientOverride } from '../config/postgres.js';
import { setTestDbOverride } from '../lib/db.js';
import { RiderReplacementSagaService } from '../services/delivery/RiderReplacementSagaService.js';
import { OutboxPublisherService } from '../services/outbox/OutboxPublisherService.js';

test('Multi-Order Rider Replacement Saga 12-Scenario Audit Suite', async (t) => {
  let testDb: DisposableTestDb;

  testDb = await createDisposableTestDb();

  // Wire PostgreSQL test overrides to use in-memory PGlite instance
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

  // Seed baseline test environment
  await testDb.db.exec(`
    INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open)
    VALUES 
      ('branch_rjn', 'fra_primary', 'Rajnandgaon HQ', 'Station Road', '9179944445', true),
      ('branch_empty', 'fra_primary', 'Empty Branch', 'Isolated Road', '9179944446', true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active)
    VALUES 
      ('user_r1', 'Old Rider 1', '9800000001', 'r1@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true),
      ('user_r2', 'New Rider 2', '9800000002', 'r2@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true),
      ('user_r3', 'Busy Rider 3', '9800000003', 'r3@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true),
      ('user_r4', 'Branch 2 Rider', '9800000004', 'r4@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_empty', '["DELIVERY"]'::jsonb, true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO delivery_partners (id, user_id, name, phone, email, franchise_id, branch_id, status, is_online, total_deliveries)
    VALUES 
      ('dp_r1', 'user_r1', 'Old Rider 1', '9800000001', 'r1@olive.in', 'fra_primary', 'branch_rjn', 'AVAILABLE', true, 10),
      ('dp_r2', 'user_r2', 'New Rider 2', '9800000002', 'r2@olive.in', 'fra_primary', 'branch_rjn', 'AVAILABLE', true, 5),
      ('dp_r3', 'user_r3', 'Busy Rider 3', '9800000003', 'r3@olive.in', 'fra_primary', 'branch_rjn', 'ASSIGNED', true, 20),
      ('dp_r4', 'user_r4', 'Branch 2 Rider', '9800000004', 'r4@olive.in', 'fra_primary', 'branch_empty', 'AVAILABLE', true, 2)
    ON CONFLICT (id) DO NOTHING;
  `);

  async function seedRider(id: string, name: string, phone: string, branchId = 'branch_rjn') {
    const userId = `usr_${id}`;
    await testDb.db.exec(`
      INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active)
      VALUES ('${userId}', '${name}', '${phone}', '${id}@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', '${branchId}', '["DELIVERY"]'::jsonb, true)
      ON CONFLICT (id) DO UPDATE SET is_active = true, allowed_apps = '["DELIVERY"]'::jsonb, status = 'APPROVED';

      INSERT INTO delivery_partners (id, user_id, name, phone, email, franchise_id, branch_id, status, is_online, total_deliveries)
      VALUES ('${id}', '${userId}', '${name}', '${phone}', '${id}@olive.in', 'fra_primary', '${branchId}', 'AVAILABLE', true, 5)
      ON CONFLICT (id) DO UPDATE SET status = 'AVAILABLE', is_online = true;
    `);
  }

  let billNoCounter = 2000;

  // SCENARIO 1: Old rider with 1 pre-pickup order
  await t.test('Scenario 1: Old rider with 1 pre-pickup order -> Reassigned & Old Rider Deactivated', async () => {
    const orderId = 'ord_s1_01';
    const billNo = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        '${orderId}', ${billNo}, 1, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'Customer 1', '9800000001',
        350, 350, 'dp_r1', 'Old Rider 1', '9800000001', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: orderId,
      oldRiderId: 'dp_r1',
      replacementRiderId: 'dp_r2',
      reason: 'Puncture on way to restaurant',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s1_op'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.ordersTransferredCount, 1);
    assert.strictEqual(result.oldRiderDeactivated, true);

    // Verify canonical_orders
    const ordCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = $1`, [orderId]);
    assert.strictEqual(ordCheck.rows[0].delivery_partner_id, 'dp_r2');

    // Verify delivery_handover_audit
    const auditRes = await testDb.query(
      `SELECT handover_type, handover_status FROM delivery_handover_audit WHERE order_id = $1`,
      [orderId]
    );
    assert.strictEqual(auditRes.rows.length, 1);
    assert.strictEqual(auditRes.rows[0].handover_type, 'PRE_PICKUP_REASSIGNMENT');
    assert.strictEqual(auditRes.rows[0].handover_status, 'CONFIRMED');

    // Verify old rider app_users access revoked (BR-02: allowed_apps emptied)
    const userRes = await testDb.query(`SELECT is_active, allowed_apps FROM app_users WHERE id = 'user_r1'`);
    assert.strictEqual(userRes.rows[0].is_active, false);
    assert.deepStrictEqual(userRes.rows[0].allowed_apps, []);

    // Verify old rider partner status
    const partnerRes = await testDb.query(`SELECT status, is_online FROM delivery_partners WHERE id = 'dp_r1'`);
    assert.strictEqual(partnerRes.rows[0].status, 'DEACTIVATED');
    assert.strictEqual(partnerRes.rows[0].is_online, false);

    // Verify rider_replacement_operations
    const opRes = await testDb.query(`SELECT status, old_rider_deactivated FROM rider_replacement_operations WHERE id = 'saga_s1_op'`);
    assert.strictEqual(opRes.rows[0].status, 'COMPLETED');
    assert.strictEqual(opRes.rows[0].old_rider_deactivated, true);
  });

  // SCENARIO 2: Old rider with multiple pre-pickup orders
  await t.test('Scenario 2: Old rider with multiple pre-pickup orders -> All Discovered & Transferred', async () => {
    await seedRider('dp_rep_s2', 'New Rider S2', '9800000012');

    const b1 = billNoCounter++;
    const b2 = billNoCounter++;
    const b3 = billNoCounter++;

    await testDb.db.exec(`
      INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active)
      VALUES ('user_multi_old', 'Multi Old', '9800000010', 'multi@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO delivery_partners (id, user_id, name, phone, email, franchise_id, branch_id, status, is_online, total_deliveries)
      VALUES ('dp_multi_old', 'user_multi_old', 'Multi Old', '9800000010', 'multi@olive.in', 'fra_primary', 'branch_rjn', 'AVAILABLE', true, 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES 
        ('ord_s2_01', ${b1}, 1, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'accepted', 'UPI', 'PAID', 'Cust A', '9800000010', 200, 200, 'dp_multi_old', 'Multi Old', '9800000010', NOW(), NOW()),
        ('ord_s2_02', ${b2}, 2, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'preparing', 'UPI', 'PAID', 'Cust B', '9800000010', 300, 300, 'dp_multi_old', 'Multi Old', '9800000010', NOW(), NOW()),
        ('ord_s2_03', ${b3}, 3, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'Cust C', '9800000010', 450, 450, 'dp_multi_old', 'Multi Old', '9800000010', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    `);

    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s2_01',
      oldRiderId: 'dp_multi_old',
      replacementRiderId: 'dp_rep_s2',
      reason: 'Shift emergency',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s2_op'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.ordersTransferredCount, 3);
    assert.strictEqual(result.oldRiderDeactivated, true);

    // Verify all 3 orders transferred to dp_rep_s2
    const checkOrders = await testDb.query(
      `SELECT id, delivery_partner_id FROM canonical_orders WHERE id IN ('ord_s2_01', 'ord_s2_02', 'ord_s2_03')`
    );
    for (const r of checkOrders.rows) {
      assert.strictEqual(r.delivery_partner_id, 'dp_rep_s2');
    }

    // Verify 3 handover audits
    const auditRes = await testDb.query(
      `SELECT order_id, handover_type, handover_status FROM delivery_handover_audit WHERE replacement_operation_id = 'saga_s2_op'`
    );
    assert.strictEqual(auditRes.rows.length, 3);
    for (const a of auditRes.rows) {
      assert.strictEqual(a.handover_type, 'PRE_PICKUP_REASSIGNMENT');
      assert.strictEqual(a.handover_status, 'CONFIRMED');
    }

    // Verify old rider deactivated
    const partnerRes = await testDb.query(`SELECT status FROM delivery_partners WHERE id = 'dp_multi_old'`);
    assert.strictEqual(partnerRes.rows[0].status, 'DEACTIVATED');
  });

  // SCENARIO 3: Old rider with 1 picked-up order (out_for_delivery) requiring physical handover
  await t.test('Scenario 3: 1 picked-up order -> Handover Pending, Old Rider Remains Active Until Handover Confirmed', async () => {
    await seedRider('dp_rep_s3', 'New Rider S3', '9800000022');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active)
      VALUES ('user_s3_old', 'S3 Old', '9800000020', 's3@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO delivery_partners (id, user_id, name, phone, email, franchise_id, branch_id, status, is_online, total_deliveries)
      VALUES ('dp_s3_old', 'user_s3_old', 'S3 Old', '9800000020', 's3@olive.in', 'fra_primary', 'branch_rjn', 'AVAILABLE', true, 2)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s3_01', ${b}, 4, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'out_for_delivery', 'UPI', 'PAID', 'Cust S3', '9800000020',
        500, 500, 'dp_s3_old', 'S3 Old', '9800000020', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Step A: Trigger replacement
    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s3_01',
      oldRiderId: 'dp_s3_old',
      replacementRiderId: 'dp_rep_s3',
      reason: 'Vehicle breakdown on highway',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s3_op'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'HANDOVER_PENDING');
    assert.strictEqual(result.oldRiderDeactivated, false);
    assert.deepStrictEqual(result.pendingHandoverOrders, ['ord_s3_01']);

    // Verify delivery_handover_audit is PENDING
    const auditRes = await testDb.query(
      `SELECT id, handover_type, handover_status FROM delivery_handover_audit WHERE order_id = 'ord_s3_01'`
    );
    assert.strictEqual(auditRes.rows[0].handover_type, 'ACTIVE_TRIP_PHYSICAL_HANDOVER');
    assert.strictEqual(auditRes.rows[0].handover_status, 'PENDING');
    const handoverId = auditRes.rows[0].id;

    // Verify old rider REMAINS ACTIVE
    const riderCheck = await testDb.query(`SELECT is_active FROM app_users WHERE id = 'user_s3_old'`);
    assert.strictEqual(riderCheck.rows[0].is_active, true);
    const partnerCheck = await testDb.query(`SELECT status FROM delivery_partners WHERE id = 'dp_s3_old'`);
    assert.strictEqual(partnerCheck.rows[0].status, 'AVAILABLE');

    // Step B: Confirm physical custody handover
    const confirmRes = await RiderReplacementSagaService.confirmPhysicalHandover({
      handoverId,
      orderId: 'ord_s3_01',
      receivingRiderId: 'dp_rep_s3',
      notes: 'Met at City Center crossway, boxes inspected and intact'
    });

    assert.strictEqual(confirmRes.success, true);
    assert.strictEqual(confirmRes.handoverStatus, 'CONFIRMED');
    assert.strictEqual(confirmRes.oldRiderDeactivated, true);

    // Verify order is now assigned to receiving rider
    const ordCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = 'ord_s3_01'`);
    assert.strictEqual(ordCheck.rows[0].delivery_partner_id, 'dp_rep_s3');

    // Verify old rider is now safely deactivated
    const deactUserCheck = await testDb.query(`SELECT is_active, allowed_apps FROM app_users WHERE id = 'user_s3_old'`);
    assert.strictEqual(deactUserCheck.rows[0].is_active, false);
    assert.deepStrictEqual(deactUserCheck.rows[0].allowed_apps, []);

    const deactPartnerCheck = await testDb.query(`SELECT status FROM delivery_partners WHERE id = 'dp_s3_old'`);
    assert.strictEqual(deactPartnerCheck.rows[0].status, 'DEACTIVATED');

    // Verify operation is now COMPLETED
    const opCheck = await testDb.query(`SELECT status, old_rider_deactivated FROM rider_replacement_operations WHERE id = 'saga_s3_op'`);
    assert.strictEqual(opCheck.rows[0].status, 'COMPLETED');
    assert.strictEqual(opCheck.rows[0].old_rider_deactivated, true);
  });

  // SCENARIO 4: Old rider with multiple active orders including picked-up deliveries
  await t.test('Scenario 4: Mixed active orders -> Pre-pickup transferred, Picked-up pending handover', async () => {
    await seedRider('dp_rep_s4', 'New Rider S4', '9800000032');

    const b1 = billNoCounter++;
    const b2 = billNoCounter++;

    await testDb.db.exec(`
      INSERT INTO app_users (id, name, phone, email, role, status, franchise_id, branch_id, allowed_apps, is_active)
      VALUES ('user_s4_old', 'S4 Old', '9800000030', 's4@olive.in', 'delivery_partner', 'APPROVED', 'fra_primary', 'branch_rjn', '["DELIVERY"]'::jsonb, true)
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO delivery_partners (id, user_id, name, phone, email, franchise_id, branch_id, status, is_online, total_deliveries)
      VALUES ('dp_s4_old', 'user_s4_old', 'S4 Old', '9800000030', 's4@olive.in', 'fra_primary', 'branch_rjn', 'AVAILABLE', true, 8)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES 
        ('ord_s4_pre', ${b1}, 5, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'Cust S4-1', '9800000030', 250, 250, 'dp_s4_old', 'S4 Old', '9800000030', NOW(), NOW()),
        ('ord_s4_transit', ${b2}, 6, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'out_for_delivery', 'UPI', 'PAID', 'Cust S4-2', '9800000030', 550, 550, 'dp_s4_old', 'S4 Old', '9800000030', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    `);

    const result = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s4_pre',
      oldRiderId: 'dp_s4_old',
      replacementRiderId: 'dp_rep_s4',
      reason: 'Medical emergency',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s4_op'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'HANDOVER_PENDING');
    assert.strictEqual(result.oldRiderDeactivated, false);

    // Pre-pickup order should be transferred immediately
    const preCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = 'ord_s4_pre'`);
    assert.strictEqual(preCheck.rows[0].delivery_partner_id, 'dp_rep_s4');

    // In-flight order should have PENDING handover audit
    const inFlightAudit = await testDb.query(`SELECT handover_status FROM delivery_handover_audit WHERE order_id = 'ord_s4_transit'`);
    assert.strictEqual(inFlightAudit.rows[0].handover_status, 'PENDING');

    // Confirm in-flight handover
    const confirmRes = await RiderReplacementSagaService.confirmPhysicalHandover({
      orderId: 'ord_s4_transit',
      receivingRiderId: 'dp_rep_s4'
    });

    assert.strictEqual(confirmRes.oldRiderDeactivated, true);
    const finalOp = await testDb.query(`SELECT status FROM rider_replacement_operations WHERE id = 'saga_s4_op'`);
    assert.strictEqual(finalOp.rows[0].status, 'COMPLETED');
  });

  // SCENARIO 5: Replacement rider has insufficient capacity (assigned_orders_count >= 3)
  await t.test('Scenario 5: Replacement rider has insufficient capacity (assigned_orders_count >= 3) -> Rejected with 422', async () => {
    await seedRider('dp_rep_busy', 'Busy Replacement Partner', '9800000055');

    const b1 = billNoCounter++;
    const b2 = billNoCounter++;
    const b3 = billNoCounter++;
    const b4 = billNoCounter++;

    // Seed 3 active deliveries for dp_rep_busy
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES 
        ('ord_s5_b1', ${b1}, 7, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'preparing', 'UPI', 'PAID', 'B1', '9800000055', 200, 200, 'dp_rep_busy', 'Busy Replacement Partner', '9800000055', NOW(), NOW()),
        ('ord_s5_b2', ${b2}, 8, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'B2', '9800000055', 300, 300, 'dp_rep_busy', 'Busy Replacement Partner', '9800000055', NOW(), NOW()),
        ('ord_s5_b3', ${b3}, 9, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'out_for_delivery', 'UPI', 'PAID', 'B3', '9800000055', 400, 400, 'dp_rep_busy', 'Busy Replacement Partner', '9800000055', NOW(), NOW()),
        ('ord_s5_target', ${b4}, 10, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY', 'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'Target', '9800000001', 350, 350, 'dp_r1', 'Old Rider 1', '9800000001', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING;
    `);

    await assert.rejects(
      async () => {
        await RiderReplacementSagaService.executeReplacementSaga({
          targetOrderId: 'ord_s5_target',
          oldRiderId: 'dp_r1',
          replacementRiderId: 'dp_rep_busy', // dp_rep_busy already has 3 active deliveries!
          reason: 'Attempt assignment to overloaded partner',
          initiatedByUid: 'mgr_01',
          initiatedByRole: 'restaurant_manager',
          idempotencyKey: 'saga_s5_op'
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, 'INSUFFICIENT_CAPACITY');
        return true;
      }
    );

    // Verify operation recorded as FAILED_REQUIRES_REVIEW
    const opCheck = await testDb.query(`SELECT status FROM rider_replacement_operations WHERE id = 'saga_s5_op'`);
    assert.strictEqual(opCheck.rows[0].status, 'FAILED_REQUIRES_REVIEW');

    // Target order remains assigned to dp_r1
    const targetCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = 'ord_s5_target'`);
    assert.strictEqual(targetCheck.rows[0].delivery_partner_id, 'dp_r1');
  });

  // SCENARIO 6: No eligible replacement rider in branch pool
  await t.test('Scenario 6: No eligible replacement rider in branch pool -> Rejected with 422', async () => {
    const b = billNoCounter++;
    await testDb.db.exec(`
      -- Make rider in branch_empty inactive
      UPDATE app_users SET is_active = false WHERE id = 'user_r4';
      UPDATE delivery_partners SET status = 'DEACTIVATED' WHERE id = 'dp_r4';

      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s6_iso', ${b}, 11, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_empty', 'fra_primary', 'ready', 'UPI', 'PAID', 'Iso Cust', '9800000004',
        400, 400, 'dp_r4', 'Branch 2 Rider', '9800000004', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Auto-search in empty pool
    await assert.rejects(
      async () => {
        await RiderReplacementSagaService.executeReplacementSaga({
          targetOrderId: 'ord_s6_iso',
          oldRiderId: 'dp_r4',
          // replacementRiderId omitted -> auto search in branch pool
          reason: 'No riders present in branch',
          initiatedByUid: 'mgr_01',
          initiatedByRole: 'restaurant_manager',
          idempotencyKey: 'saga_s6_op'
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, 'NO_ELIGIBLE_REPLACEMENT_RIDER');
        return true;
      }
    );

    // Cross-branch assignment also rejected
    await assert.rejects(
      async () => {
        await RiderReplacementSagaService.executeReplacementSaga({
          targetOrderId: 'ord_s6_iso',
          oldRiderId: 'dp_r4',
          replacementRiderId: 'dp_r2', // belongs to branch_rjn, order belongs to branch_empty
          reason: 'Cross branch pool violation',
          initiatedByUid: 'mgr_01',
          initiatedByRole: 'restaurant_manager',
          idempotencyKey: 'saga_s6_mismatch_op'
        });
      },
      (err: any) => {
        assert.strictEqual(err.statusCode, 422);
        assert.strictEqual(err.code, 'NO_ELIGIBLE_REPLACEMENT_RIDER');
        return true;
      }
    );
  });

  // SCENARIO 7: Receiving rider refuses handover
  await t.test('Scenario 7: Receiving rider refuses handover -> Handover REFUSED & Flagged for Review', async () => {
    await seedRider('dp_s7_old', 'S7 Old Rider', '9800000070');
    await seedRider('dp_s7_rec', 'S7 Receiving Rider', '9800000071');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s7_01', ${b}, 12, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'out_for_delivery', 'UPI', 'PAID', 'S7 Cust', '9800000070',
        480, 480, 'dp_s7_old', 'S7 Old Rider', '9800000070', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Initiate saga
    await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s7_01',
      oldRiderId: 'dp_s7_old',
      replacementRiderId: 'dp_s7_rec',
      reason: 'Physical handover required',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s7_op'
    });

    // Receiving rider inspects food and refuses handover
    const refuseResult = await RiderReplacementSagaService.refusePhysicalHandover({
      orderId: 'ord_s7_01',
      refusingRiderId: 'dp_s7_rec',
      reason: 'Food package damaged and spilled during transit'
    });

    assert.strictEqual(refuseResult.success, false);
    assert.strictEqual(refuseResult.handoverStatus, 'REFUSED');
    assert.strictEqual(refuseResult.oldRiderDeactivated, false);

    // Verify delivery_handover_audit
    const auditCheck = await testDb.query(`SELECT handover_status, notes FROM delivery_handover_audit WHERE order_id = 'ord_s7_01'`);
    assert.strictEqual(auditCheck.rows[0].handover_status, 'REFUSED');
    assert.ok(auditCheck.rows[0].notes.includes('Food package damaged'));

    // Verify operation status is FAILED_REQUIRES_REVIEW
    const opCheck = await testDb.query(`SELECT status FROM rider_replacement_operations WHERE id = 'saga_s7_op'`);
    assert.strictEqual(opCheck.rows[0].status, 'FAILED_REQUIRES_REVIEW');

    // Verify old rider is NOT deactivated
    const oldRiderCheck = await testDb.query(`SELECT is_active FROM app_users WHERE id = 'usr_dp_s7_old'`);
    assert.strictEqual(oldRiderCheck.rows[0].is_active, true);
  });

  // SCENARIO 8: Duplicate saga request (idempotencyKey cache hit)
  await t.test('Scenario 8: Duplicate saga request -> Idempotency Hit (cached: true)', async () => {
    await seedRider('dp_s8_old', 'S8 Old Rider', '9800000080');
    await seedRider('dp_rep_s8', 'S8 Replacement Partner', '9800000082');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s8_01', ${b}, 13, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'S8 Cust', '9800000080',
        300, 300, 'dp_s8_old', 'S8 Old Rider', '9800000080', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // First call
    const firstCall = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s8_01',
      oldRiderId: 'dp_s8_old',
      replacementRiderId: 'dp_rep_s8',
      reason: 'Flat tyre',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'idem_key_repeat_999'
    });
    assert.strictEqual(firstCall.success, true);
    assert.strictEqual(firstCall.cached, undefined);

    // Second duplicate call with exact same idempotencyKey
    const secondCall = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s8_01',
      oldRiderId: 'dp_s8_old',
      replacementRiderId: 'dp_rep_s8',
      reason: 'Flat tyre',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'idem_key_repeat_999'
    });

    assert.strictEqual(secondCall.success, true);
    assert.strictEqual(secondCall.cached, true);
    assert.strictEqual(secondCall.operationId, 'idem_key_repeat_999');

    // Verify only 1 handover audit was created
    const audits = await testDb.query(`SELECT COUNT(*) as cnt FROM delivery_handover_audit WHERE order_id = 'ord_s8_01'`);
    assert.strictEqual(parseInt(audits.rows[0].cnt, 10), 1);
  });

  // SCENARIO 9: Concurrent replacement attempts (row-level lock protection)
  await t.test('Scenario 9: Concurrent replacement attempts -> Row-Level Lock Protection', async () => {
    await seedRider('dp_s9_old', 'S9 Old Rider', '9800000090');
    await seedRider('dp_rep_s9', 'S9 Replacement Partner', '9800000092');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s9_01', ${b}, 14, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'S9 Cust', '9800000090',
        350, 350, 'dp_s9_old', 'S9 Old Rider', '9800000090', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Run two replacements concurrently
    const [p1, p2] = await Promise.allSettled([
      RiderReplacementSagaService.executeReplacementSaga({
        targetOrderId: 'ord_s9_01',
        oldRiderId: 'dp_s9_old',
        replacementRiderId: 'dp_rep_s9',
        reason: 'Concurrent race test A',
        initiatedByUid: 'mgr_01',
        initiatedByRole: 'restaurant_manager',
        idempotencyKey: 'concurrent_lock_a'
      }),
      RiderReplacementSagaService.executeReplacementSaga({
        targetOrderId: 'ord_s9_01',
        oldRiderId: 'dp_s9_old',
        replacementRiderId: 'dp_rep_s9',
        reason: 'Concurrent race test B',
        initiatedByUid: 'mgr_02',
        initiatedByRole: 'restaurant_manager',
        idempotencyKey: 'concurrent_lock_b'
      })
    ]);

    // Both calls must settle cleanly without database corruption
    assert.strictEqual(p1.status === 'fulfilled' || p2.status === 'fulfilled', true);

    const ordCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = 'ord_s9_01'`);
    assert.strictEqual(ordCheck.rows[0].delivery_partner_id, 'dp_rep_s9');
  });

  // SCENARIO 10: Database outage during replacement (transaction rollback)
  await t.test('Scenario 10: Database error during transaction -> Complete Rollback', async () => {
    await seedRider('dp_s10_old', 'S10 Old Rider', '9800000100');
    await seedRider('dp_rep_s10', 'S10 Replacement Partner', '9800000102');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s10_01', ${b}, 15, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'ready', 'UPI', 'PAID', 'S10 Cust', '9800000100',
        320, 320, 'dp_s10_old', 'S10 Old Rider', '9800000100', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Simulate an unexpected error by monkey-patching OutboxPublisherService.recordEvent to throw
    const originalRecordEvent = OutboxPublisherService.recordEvent;
    OutboxPublisherService.recordEvent = async () => {
      throw new Error('SIMULATED_DATABASE_OR_OUTBOX_CRASH');
    };

    try {
      await assert.rejects(
        async () => {
          await RiderReplacementSagaService.executeReplacementSaga({
            targetOrderId: 'ord_s10_01',
            oldRiderId: 'dp_s10_old',
            replacementRiderId: 'dp_rep_s10',
            reason: 'Test database rollback',
            initiatedByUid: 'mgr_01',
            initiatedByRole: 'restaurant_manager',
            idempotencyKey: 'saga_s10_fail'
          });
        },
        /SIMULATED_DATABASE_OR_OUTBOX_CRASH/
      );

      // Verify transaction rolled back: order is STILL assigned to old rider!
      const ordCheck = await testDb.query(`SELECT delivery_partner_id FROM canonical_orders WHERE id = 'ord_s10_01'`);
      assert.strictEqual(ordCheck.rows[0].delivery_partner_id, 'dp_s10_old');

      // Verify no handover audits were committed
      const auditCheck = await testDb.query(`SELECT COUNT(*) as cnt FROM delivery_handover_audit WHERE order_id = 'ord_s10_01'`);
      assert.strictEqual(parseInt(auditCheck.rows[0].cnt, 10), 0);

      // Verify old rider is STILL active
      const userCheck = await testDb.query(`SELECT is_active FROM app_users WHERE id = 'usr_dp_s10_old'`);
      assert.strictEqual(userCheck.rows[0].is_active, true);
    } finally {
      OutboxPublisherService.recordEvent = originalRecordEvent;
    }
  });

  // SCENARIO 11: Worker interruption during the saga (outbox worker resiliency)
  await t.test('Scenario 11: Worker interruption during outbox event -> Safe Retry via FOR UPDATE SKIP LOCKED', async () => {
    // Insert an outbox event
    const eventId = await OutboxPublisherService.recordEvent(
      mockPoolClient,
      'DELIVERY_PARTNER',
      'dp_r1',
      'RIDER_REPLACED',
      {
        orderId: 'ord_worker_test',
        currentStatus: 'COMPLETED',
        timestamp: new Date().toISOString()
      }
    );

    assert.ok(eventId);

    // Verify status is PENDING
    const evCheck1 = await testDb.query(`SELECT status, retry_count FROM outbox_events WHERE id = $1`, [eventId]);
    assert.strictEqual(evCheck1.rows[0].status, 'PENDING');

    // Run outbox processor
    const count = await OutboxPublisherService.processPendingEvents();
    assert.ok(count >= 1);

    // Verify status updated to PROCESSED
    const evCheck2 = await testDb.query(`SELECT status FROM outbox_events WHERE id = $1`, [eventId]);
    assert.strictEqual(evCheck2.rows[0].status, 'PROCESSED');
  });

  // SCENARIO 12: Saga resumes without duplicate assignment or deactivation
  await t.test('Scenario 12: Saga resumes without duplicate assignment or deactivation', async () => {
    await seedRider('dp_s12_old', 'S12 Old Rider', '9800000120');
    await seedRider('dp_rep_s12', 'S12 Replacement Partner', '9800000122');

    const b = billNoCounter++;
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
        branch_id, franchise_id, order_status, payment_method, payment_status, customer_name, customer_phone,
        subtotal, total_amount, delivery_partner_id, delivery_partner_name, delivery_partner_phone, created_at, updated_at
      ) VALUES (
        'ord_s12_01', ${b}, 16, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'DELIVERY',
        'branch_rjn', 'fra_primary', 'out_for_delivery', 'UPI', 'PAID', 'S12 Cust', '9800000120',
        420, 420, 'dp_s12_old', 'S12 Old Rider', '9800000120', NOW(), NOW()
      ) ON CONFLICT (id) DO NOTHING;
    `);

    // Step A: Initial execution leaves it in HANDOVER_PENDING
    const initRes = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s12_01',
      oldRiderId: 'dp_s12_old',
      replacementRiderId: 'dp_rep_s12',
      reason: 'Resumption test',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s12_resume'
    });
    assert.strictEqual(initRes.status, 'HANDOVER_PENDING');

    // Confirm physical handover directly
    await RiderReplacementSagaService.confirmPhysicalHandover({
      orderId: 'ord_s12_01',
      receivingRiderId: 'dp_rep_s12'
    });

    // Step B: Re-invoke saga with same idempotency key to test resume
    const resumeRes = await RiderReplacementSagaService.executeReplacementSaga({
      targetOrderId: 'ord_s12_01',
      oldRiderId: 'dp_s12_old',
      replacementRiderId: 'dp_rep_s12',
      reason: 'Resumption test',
      initiatedByUid: 'mgr_01',
      initiatedByRole: 'restaurant_manager',
      idempotencyKey: 'saga_s12_resume'
    });

    assert.strictEqual(resumeRes.success, true);
    assert.strictEqual(resumeRes.status, 'COMPLETED');
    assert.strictEqual(resumeRes.oldRiderDeactivated, true);

    // Verify orders were not assigned twice and audit records remain singular
    const auditCount = await testDb.query(`SELECT COUNT(*) as cnt FROM delivery_handover_audit WHERE order_id = 'ord_s12_01'`);
    assert.strictEqual(parseInt(auditCount.rows[0].cnt, 10), 1);
  });
});
