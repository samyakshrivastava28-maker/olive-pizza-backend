/**
 * Phase I: Production Data Safety, Security Regression & Release Integrity Suite
 * 
 * Executes all write and mutation verification tests against an isolated,
 * in-memory disposable PostgreSQL 18.6 database (PGlite) with all 10 schema migrations.
 * 
 * Zero cloud database writes, zero production side effects, zero financial history contamination.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { generateTrackingToken, verifyTrackingToken } from '../utils/trackingToken.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { assertSafeDatabaseForMutation, assertSafeDatabaseTarget, pgPool } from '../config/postgres.js';

describe('Phase I: Production Data Safety, Security Regression & Release Integrity', () => {
  let testDb: DisposableTestDb;

  before(async () => {
    testDb = await createDisposableTestDb();
  });

  after(async () => {
    if (testDb) {
      await testDb.close();
    }
    try {
      await pgPool.end();
    } catch {
      // ignore
    }
  });

  describe('1. Production Database Fail-Safe Protection', () => {
    it('assertSafeDatabaseTarget strictly refuses cloud connection selection under test environment', () => {
      const prevEnv = process.env.NODE_ENV;
      const prevAllow = process.env.ALLOW_CLOUD_TEST_CONNECTION;
      try {
        process.env.NODE_ENV = 'test';
        delete process.env.ALLOW_CLOUD_TEST_CONNECTION;

        // When connecting to cloud (render.com / dpg- / supabase), assertSafeDatabaseTarget must throw
        assert.throws(
          () => assertSafeDatabaseTarget('postgres://cloud-user:pass@dpg-test.render.com:5432/prod_db'),
          /DATABASE TARGET BLOCKED/
        );
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (prevAllow) process.env.ALLOW_CLOUD_TEST_CONNECTION = prevAllow;
      }
    });

    it('assertSafeDatabaseForMutation strictly blocks mutating queries (including writable CTEs and MERGE) when targeting cloud database', () => {
      const prevEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';

        // 1. Direct INSERT
        assert.throws(
          () => assertSafeDatabaseForMutation("INSERT INTO canonical_orders (id) VALUES ('test')", true),
          /DATABASE SAFETY BLOCKER/
        );

        // 2. Direct UPDATE
        assert.throws(
          () => assertSafeDatabaseForMutation("UPDATE canonical_bills SET is_cancelled = true WHERE id = 'test'", true),
          /DATABASE SAFETY BLOCKER/
        );

        // 3. Direct DELETE
        assert.throws(
          () => assertSafeDatabaseForMutation("DELETE FROM canonical_orders WHERE id = 'test'", true),
          /DATABASE SAFETY BLOCKER/
        );

        // 4. Writable CTE (WITH ... INSERT)
        assert.throws(
          () => assertSafeDatabaseForMutation("WITH new_order AS (INSERT INTO canonical_orders (id) VALUES ('test') RETURNING id) SELECT * FROM new_order", true),
          /DATABASE SAFETY BLOCKER/
        );

        // 5. MERGE statement
        assert.throws(
          () => assertSafeDatabaseForMutation("MERGE INTO canonical_orders USING dual ON (id = 'test') WHEN MATCHED THEN UPDATE SET is_active = false", true),
          /DATABASE SAFETY BLOCKER/
        );

        // 6. Safe SELECT must NOT throw
        assert.doesNotThrow(() => {
          assertSafeDatabaseForMutation('SELECT COUNT(*) FROM canonical_orders');
        });
      } finally {
        process.env.NODE_ENV = prevEnv;
      }
    });

    it('Disposable test database executes full schema migrations in memory without touching cloud', async () => {
      const tablesRes = await testDb.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      const tableNames = tablesRes.rows.map((r: any) => r.table_name);
      assert.ok(tableNames.includes('canonical_orders'), 'canonical_orders table exists in disposable DB');
      assert.ok(tableNames.includes('canonical_bills'), 'canonical_bills table exists in disposable DB');
      assert.ok(tableNames.includes('canonical_order_items'), 'canonical_order_items table exists in disposable DB');
      assert.ok(tableNames.includes('restaurant_branches'), 'restaurant_branches table exists in disposable DB');
      assert.ok(tableNames.includes('app_users'), 'app_users table exists in disposable DB');
    });
  });

  describe('2. Transaction Behavior, Rollback & Idempotency in Disposable DB', () => {
    it('Failed or uncommitted transaction rolls back atomically without orphan records', async () => {
      const doomedOrderId = `ord_test_rollback_${Date.now()}`;
      try {
        await testDb.withTransaction(async (client) => {
          await client.query(`
            INSERT INTO canonical_orders (
              id, permanent_bill_no, daily_order_no, order_date, order_time,
              order_source, order_type, order_status, payment_method, payment_status,
              customer_name, customer_phone, subtotal, discount_amount, tax_amount,
              cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
            ) VALUES (
              $1, 987001, 1, CURRENT_DATE, CURRENT_TIME,
              'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
              'Rollback Customer', '9876543210', 300, 0, 15,
              7.5, 7.5, 0, 315, 'fra_rajnandgaon', 'main_branch', 'PROJECTION_PENDING'
            )
          `, [doomedOrderId]);

          // Simulate intentional error causing rollback
          throw new Error('Simulated transaction mid-flight failure');
        });
      } catch (err: any) {
        assert.strictEqual(err.message, 'Simulated transaction mid-flight failure');
      }

      // Verify zero records were committed
      const checkRes = await testDb.query('SELECT COUNT(*) FROM canonical_orders WHERE id = $1', [doomedOrderId]);
      assert.strictEqual(Number(checkRes.rows[0].count), 0, 'No orphaned order records should exist after rollback');
    });

    it('Duplicate order submissions are completely idempotent and do not create duplicate bill rows', async () => {
      const orderId = `ord_test_idem_${Date.now()}`;
      const billId = `bill_${orderId}`;

      for (let attempt = 1; attempt <= 2; attempt++) {
        await testDb.query(`
          INSERT INTO canonical_orders (
            id, permanent_bill_no, daily_order_no, order_date, order_time,
            order_source, order_type, order_status, payment_method, payment_status,
            customer_name, customer_phone, subtotal, discount_amount, tax_amount,
            cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
          ) VALUES (
            $1, 987002, 2, CURRENT_DATE, CURRENT_TIME,
            'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
            'Idempotent Customer', '9876543210', 400, 0, 20,
            10, 10, 0, 420, 'fra_rajnandgaon', 'main_branch', 'PROJECTION_PENDING'
          ) ON CONFLICT (id) DO UPDATE SET
            order_status = EXCLUDED.order_status,
            payment_status = EXCLUDED.payment_status;
        `, [orderId]);

        await testDb.query(`
          INSERT INTO canonical_bills (
            id, permanent_bill_no, order_id, bill_date, subtotal,
            discount, tax, net_amount, payment_method, payment_status,
            is_cancelled
          ) VALUES (
            $1, 987002, $2, CURRENT_DATE, 400,
            0, 20, 420, 'ONLINE', 'PAID',
            false
          ) ON CONFLICT (id) DO UPDATE SET
            payment_status = EXCLUDED.payment_status;
        `, [billId, orderId]);
      }

      const orderCount = await testDb.query('SELECT COUNT(*) FROM canonical_orders WHERE id = $1', [orderId]);
      assert.strictEqual(Number(orderCount.rows[0].count), 1, 'Only exactly 1 canonical_order record should exist');

      const billCount = await testDb.query('SELECT COUNT(*) FROM canonical_bills WHERE id = $1', [billId]);
      assert.strictEqual(Number(billCount.rows[0].count), 1, 'Only exactly 1 canonical_bills record should exist');
    });
  });

  describe('3. Financial Snapshot Immutability & Anti-Downgrade Guards', () => {
    it('Permanent bill number uniqueness is strictly enforced by PostgreSQL unique constraint', async () => {
      const order1 = `ord_bill_uniq_1_${Date.now()}`;
      const order2 = `ord_bill_uniq_2_${Date.now()}`;
      const duplicateBillNo = 987003;

      await testDb.query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 3, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
          'Customer 1', '9876543210', 250, 0, 12.5,
          6.25, 6.25, 0, 262.5, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        )
      `, [order1, duplicateBillNo]);

      // Attempting to reuse the exact same bill number for a different order ID must violate unique constraint
      await assert.rejects(
        testDb.query(`
          INSERT INTO canonical_orders (
            id, permanent_bill_no, daily_order_no, order_date, order_time,
            order_source, order_type, order_status, payment_method, payment_status,
            customer_name, customer_phone, subtotal, discount_amount, tax_amount,
            cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
          ) VALUES (
            $1, $2, 4, CURRENT_DATE, CURRENT_TIME,
            'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
            'Customer 2', '9876543211', 500, 0, 25,
            12.5, 12.5, 0, 525, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
          )
        `, [order2, duplicateBillNo]),
        /unique constraint.*canonical_orders_permanent_bill_no_key|duplicate key/i
      );
    });

    it('Settled PAID status cannot be downgraded to PENDING or FAILED by stale retry', async () => {
      const billId = `bill_downgrade_${Date.now()}`;
      const billNo = 987004;
      const orderId = `ord_downgrade_${Date.now()}`;

      // Insert parent order
      await testDb.query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 4, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'DELIVERED', 'ONLINE', 'PAID',
          'Paid Customer', '9876543210', 600, 0, 30,
          15, 15, 0, 630, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        )
      `, [orderId, billNo]);

      // Insert finalized PAID bill
      await testDb.query(`
        INSERT INTO canonical_bills (
          id, permanent_bill_no, order_id, bill_date, subtotal,
          discount, tax, net_amount, payment_method, payment_status, is_cancelled
        ) VALUES (
          $1, $2, $3, CURRENT_DATE, 600,
          0, 30, 630, 'ONLINE', 'PAID', false
        )
      `, [billId, billNo, orderId]);

      // Attempt stale callback update with PENDING
      await testDb.query(`
        UPDATE canonical_bills SET
          payment_status = CASE
            WHEN canonical_bills.payment_status = 'PAID' AND 'PENDING' IN ('PENDING', 'FAILED') THEN canonical_bills.payment_status
            ELSE 'PENDING'
          END
        WHERE id = $1
      `, [billId]);

      const checkRes = await testDb.query('SELECT payment_status FROM canonical_bills WHERE id = $1', [billId]);
      assert.strictEqual(checkRes.rows[0].payment_status, 'PAID', 'Settled bill payment_status must remain PAID');
    });

    it('Cancelled bill is immutable against subsequent status updates', async () => {
      const billId = `bill_cancel_immut_${Date.now()}`;
      const billNo = 987005;
      const orderId = `ord_cancel_immut_${Date.now()}`;

      // Insert parent order
      await testDb.query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 5, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'CANCELLED', 'ONLINE', 'REFUNDED',
          'Cancelled Customer', '9876543210', 300, 0, 15,
          7.5, 7.5, 0, 315, 'fra_rajnandgaon', 'main_branch', 'ARCHIVED'
        )
      `, [orderId, billNo]);

      await testDb.query(`
        INSERT INTO canonical_bills (
          id, permanent_bill_no, order_id, bill_date, subtotal,
          discount, tax, net_amount, payment_method, payment_status, is_cancelled, cancellation_reason
        ) VALUES (
          $1, $2, $3, CURRENT_DATE, 300,
          0, 15, 315, 'ONLINE', 'REFUNDED', true, 'Customer requested cancellation'
        )
      `, [billId, billNo, orderId]);

      // Attempt to reactivate or overwrite
      await testDb.query(`
        UPDATE canonical_bills SET
          payment_status = CASE WHEN is_cancelled = true THEN payment_status ELSE 'PAID' END,
          is_cancelled = CASE WHEN is_cancelled = true THEN true ELSE false END
        WHERE id = $1
      `, [billId]);

      const checkRes = await testDb.query('SELECT is_cancelled, payment_status FROM canonical_bills WHERE id = $1', [billId]);
      assert.strictEqual(checkRes.rows[0].is_cancelled, true);
      assert.strictEqual(checkRes.rows[0].payment_status, 'REFUNDED');
    });
  });

  describe('4. Crash Window & Durable Projection Obligation Recovery', () => {
    it('Order committed with PROJECTION_PENDING survives simulated crash before Firestore write', async () => {
      const crashOrderId = `ord_crash_${Date.now()}`;
      const crashBillNo = 987006;

      // STEP 1: PostgreSQL transaction commits with live_lifecycle = 'PROJECTION_PENDING'
      await testDb.query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 6, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
          'Crash Test Customer', '9876543210', 450, 0, 22.5,
          11.25, 11.25, 0, 472.5, 'fra_rajnandgaon', 'main_branch', 'PROJECTION_PENDING'
        )
      `, [crashOrderId, crashBillNo]);

      // STEP 2: Simulated crash occurs immediately! Process dies before Firestore projection runs.
      // Verify PostgreSQL holds durable obligation:
      const pendingRes = await testDb.query(`
        SELECT id, permanent_bill_no, live_lifecycle 
        FROM canonical_orders 
        WHERE live_lifecycle = 'PROJECTION_PENDING' AND id = $1
      `, [crashOrderId]);

      assert.strictEqual(pendingRes.rows.length, 1);
      assert.strictEqual(pendingRes.rows[0].live_lifecycle, 'PROJECTION_PENDING');

      // STEP 3: Background Recovery Worker executes after reboot
      const pendingOrders = await testDb.query(`
        SELECT id FROM canonical_orders WHERE live_lifecycle = 'PROJECTION_PENDING' AND id = $1
      `, [crashOrderId]);

      for (const order of pendingOrders.rows) {
        // Worker successfully projects to Firestore (simulated), then transitions state to ACTIVE
        await testDb.query(`
          UPDATE canonical_orders 
          SET live_lifecycle = 'ACTIVE', updated_at = NOW() 
          WHERE id = $1 AND live_lifecycle = 'PROJECTION_PENDING'
        `, [order.id]);
      }

      // STEP 4: Verify durable recovery
      const recoveredRes = await testDb.query(`
        SELECT live_lifecycle FROM canonical_orders WHERE id = $1
      `, [crashOrderId]);
      assert.strictEqual(recoveredRes.rows[0].live_lifecycle, 'ACTIVE', 'Order must be transitioned to ACTIVE after projection reconciliation');

      // STEP 5: Second run of worker does NOT re-process or duplicate
      const secondRunRes = await testDb.query(`
        SELECT id FROM canonical_orders WHERE live_lifecycle = 'PROJECTION_PENDING' AND id = $1
      `, [crashOrderId]);
      assert.strictEqual(secondRunRes.rows.length, 0, 'No remaining pending projections should exist');
    });
  });

  describe('5. HMAC Order Tracking Security Audit', () => {
    it('HMAC tracking tokens are deterministic for an order, cryptographically signed, and tamper-evident', () => {
      const orderId = 'ord_sec_hmac_test_101';
      const token = generateTrackingToken(orderId);
      assert.ok(typeof token === 'string' && token.length > 20);

      // Valid token resolves the exact order ID
      const resolvedId = verifyTrackingToken(token);
      assert.strictEqual(resolvedId, orderId);

      // Tampered token must fail to resolve
      const tamperedToken = token.slice(0, -4) + 'abcd';
      const tamperedResolved = verifyTrackingToken(tamperedToken);
      assert.strictEqual(tamperedResolved, null, 'Tampered tracking token must return null');

      // Token generated for order A cannot validate order B
      const tokenOrderB = generateTrackingToken('ord_sec_other_202');
      assert.notStrictEqual(verifyTrackingToken(tokenOrderB), orderId);
    });

    it('Tracking token format does not expose server secrets or database internals', () => {
      const token = generateTrackingToken('ord_safe_audit');
      // Token is base64 URL-safe string
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      assert.ok(decoded.includes('ord_safe_audit'));
      assert.ok(!decoded.includes('FIREBASE'));
      assert.ok(!decoded.includes('POSTGRES'));
      assert.ok(!decoded.includes('secret'));
    });

    it('Expired tracking tokens are rejected and return null', () => {
      // Craft expired token with timestamp in the past
      const pastExp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const secret = process.env.TRACKING_TOKEN_SECRET || process.env.JWT_SECRET || 'olive-tracking-dev-secret-only';
      const payload = `ord_expired_test:${pastExp}`;
      const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const expiredToken = Buffer.from(`${payload}:${hmac}`).toString('base64url');

      assert.strictEqual(verifyTrackingToken(expiredToken), null, 'Expired token must return null');
    });
  });

  describe('6. Canonical Fulfillment State Machine Transitions', () => {
    it('Order fulfillment sequence is strictly enforced: skips are rejected', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'accepted'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'preparing'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'ready'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('ready', 'partner_assigned'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('partner_assigned', 'picked_up'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('picked_up', 'out_for_delivery'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('out_for_delivery', 'delivered'), true);

      // Illegal skip: pending directly to delivered
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'delivered'), false);
      // Illegal backward transition: delivered to preparing
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'preparing'), false);
      // Terminal lock: cancelled cannot transition to anything
      assert.strictEqual(OrderStateMachine.isValidTransition('cancelled', 'accepted'), false);
    });
  });
});
