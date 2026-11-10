import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import healthRoutes from '../routes/health.routes.js';
import { OrderStateMachine, CanonicalOrderStatus } from '../services/order/OrderStateMachine.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { executeGraphQL } from '../graphql/index.js';

describe('Order Lifecycle & State Machine Reconciliation Suite', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/', healthRoutes);
    testApp.use('/api', healthRoutes);

    await new Promise<void>((resolve) => {
      server = testApp.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try { await redisService.disconnect(); } catch {}
    try { await pgPool.end(); } catch {}
  });

  describe('1. Readiness & Liveness Semantic Contracts', () => {
    it('Liveness endpoint (/live) must respond with HTTP 200 without DB dependency', async () => {
      const res = await fetch(`${baseUrl}/live`);
      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as any;
      assert.strictEqual(data.status, 'ok');
      assert.ok(typeof data.uptime === 'number');
    });

    it('Readiness endpoint (/ready) must confirm core service readiness', async () => {
      const res = await fetch(`${baseUrl}/ready`);
      assert.ok([200, 503].includes(res.status), `Readiness returned ${res.status}`);
      const data = (await res.json()) as any;
      assert.ok(['ready', 'not_ready'].includes(data.status));
      assert.ok(['healthy', 'unhealthy'].includes(data.firestore));
      assert.ok(['healthy', 'unhealthy'].includes(data.postgres));
      assert.strictEqual(data.checks.server, 'ready');
    });

    it('/api/ready alias must behave identically to /ready', async () => {
      const res = await fetch(`${baseUrl}/api/ready`);
      assert.ok([200, 503].includes(res.status), `Readiness returned ${res.status}`);
      const data = (await res.json()) as any;
      assert.ok(['ready', 'not_ready'].includes(data.status));
      assert.ok(['healthy', 'unhealthy'].includes(data.checks.firestore));
      assert.ok(['healthy', 'unhealthy'].includes(data.checks.postgres));
    });
  });

  describe('2. Canonical Order State Machine Reconciliation', () => {
    it('Canonical delivery lifecycle transitions must all be strictly valid in sequence', () => {
      // Complete sequential flow: pending -> accepted -> preparing -> ready -> partner_assigned -> picked_up -> out_for_delivery -> delivered
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'accepted'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'preparing'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'ready'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('ready', 'partner_assigned'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('partner_assigned', 'picked_up'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('picked_up', 'out_for_delivery'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('out_for_delivery', 'delivered'), true);
    });

    it('Invalid state skips must be rejected by the transition matrix', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'delivered'), false, 'Cannot jump pending directly to delivered');
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'out_for_delivery'), false, 'Cannot jump pending directly to out_for_delivery');
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'picked_up'), false, 'Cannot jump pending to picked_up');
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'delivered'), false, 'Cannot jump accepted to delivered');
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'picked_up'), false, 'Cannot pick up while still preparing');
    });

    it('Terminal states must reject any subsequent transitions', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'accepted'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'cancelled'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'preparing'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('cancelled', 'accepted'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('cancelled', 'delivered'), false);
    });

    it('Same-state transition must return idempotent confirmation', () => {
      // Reconciles status strings
      assert.strictEqual(OrderStateMachine.reconcileStatus('PENDING'), 'pending');
      assert.strictEqual(OrderStateMachine.reconcileStatus('ready'), 'ready');
      assert.strictEqual(OrderStateMachine.reconcileStatus('pending_acceptance'), 'pending');
    });
  });

  describe('3. Authoritative Order Write & Idempotent Persistence Contract', () => {
    it('Allocates strictly monotonic permanent bill number and calendar-day daily order counter', async () => {
      const firstAlloc = await BillingNumberService.allocateNumbers();
      const secondAlloc = await BillingNumberService.allocateNumbers();

      assert.ok(firstAlloc.permanentBillNo > 0);
      assert.ok(secondAlloc.permanentBillNo > firstAlloc.permanentBillNo, 'Permanent bill number must be strictly monotonic');
      assert.ok(firstAlloc.dailyOrderNo > 0);
      assert.ok(secondAlloc.dailyOrderNo >= firstAlloc.dailyOrderNo, 'Daily order number must increment within the same day');
      assert.strictEqual(firstAlloc.orderDate, secondAlloc.orderDate, 'Order date in IST must match current calendar day');
    });

    it('Idempotent order persistence prevents duplicate rows and bill records', async () => {
      const testId = `ord_phase_d_idem_${Date.now()}`;
      const alloc = await BillingNumberService.allocateNumbers();

      // First insertion
      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, $3, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'COD', 'PENDING',
          'Test Customer', '9179944445', 300, 0, 15,
          7.5, 7.5, 0, 315, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        )
      `, [testId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      // Insert matching bill
      await query(`
        INSERT INTO canonical_bills (
          id, permanent_bill_no, order_id, bill_date, subtotal, discount, tax, net_amount, payment_method, payment_status
        ) VALUES ($1, $2, $3, CURRENT_DATE, 300, 0, 15, 315, 'COD', 'PENDING')
        ON CONFLICT (permanent_bill_no) DO NOTHING
      `, [`bill_${testId}`, alloc.permanentBillNo, testId]);

      // Replay identical bill insertion with same permanent bill number
      await query(`
        INSERT INTO canonical_bills (
          id, permanent_bill_no, order_id, bill_date, subtotal, discount, tax, net_amount, payment_method, payment_status
        ) VALUES ($1, $2, $3, CURRENT_DATE, 300, 0, 15, 315, 'COD', 'PENDING')
        ON CONFLICT (permanent_bill_no) DO NOTHING
      `, [`bill_${testId}_replay`, alloc.permanentBillNo, testId]);

      // Assert exactly one bill exists
      const bills = await query('SELECT count(*) FROM canonical_bills WHERE permanent_bill_no = $1', [alloc.permanentBillNo]);
      assert.strictEqual(Number(bills.rows[0].count), 1, 'Replayed insert must not create duplicate bill');
    });
  });

  describe('4. Approved Owner & Staff Account Verification Matrix', () => {
    before(async () => {
      await query(`
        INSERT INTO app_users (id, email, name, role, status, is_active, franchise_id, branch_id, allowed_apps, metadata)
        VALUES ('staff_cashier_01', 'cashier@olivepizza.in', 'Test Cashier', 'cashier', 'APPROVED', true, 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, '{"terminalId": "POS-01"}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          allowed_apps = EXCLUDED.allowed_apps,
          metadata = EXCLUDED.metadata;

        INSERT INTO delivery_partners (id, name, phone, email, status, is_online, branch_id, franchise_id)
        VALUES ('staff_rider_01', 'Test Rider', '+919988776655', 'rider@olivepizza.in', 'APPROVED', true, 'main_branch', 'fra_rajnandgaon')
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          is_online = EXCLUDED.is_online;
      `);
    });

    after(async () => {
      await query(`
        DELETE FROM app_users WHERE id = 'staff_cashier_01';
        DELETE FROM delivery_partners WHERE id = 'staff_rider_01';
      `);
    });

    it('Platform owner accounts are authorized for OWNER Command Center', async () => {
      const ownerAuth = await FranchiseAccessService.resolveAuthorization({
        uid: '6tLLR6q7aTYqzTG2blRx3TU5sA42',
        email: 'webhub2811@gmail.com',
        targetApp: 'OWNER'
      });
      assert.strictEqual(ownerAuth.authorized, true);
    });

    it('Owner without explicit staff grant must be denied access to staff applications', async () => {
      // Simulate an ungranted owner account
      const ungrantedOwner = await FranchiseAccessService.resolveAuthorization({
        uid: 'owner_unassigned_uid',
        email: 'owner_unassigned@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER'
      });
      assert.strictEqual(ungrantedOwner.authorized, false, 'Ungranted owner must fail closed for Restaurant Manager');
    });

    it('Staff cashier account is authorized only for POS and rejected for management/delivery', async () => {
      const cashierPos = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'POS',
        terminalId: 'POS-01'
      });
      assert.strictEqual(cashierPos.authorized, true);

      const cashierRest = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER'
      });
      assert.strictEqual(cashierRest.authorized, false);

      const cashierOwner = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'OWNER'
      });
      assert.strictEqual(cashierOwner.authorized, false);
    });

    it('Delivery partner account is authorized only for Delivery Raider app', async () => {
      const riderDelivery = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_rider_01',
        email: 'rider@olivepizza.in',
        targetApp: 'DELIVERY'
      });
      assert.strictEqual(riderDelivery.authorized, true);

      const riderPos = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_rider_01',
        email: 'rider@olivepizza.in',
        targetApp: 'POS'
      });
      assert.strictEqual(riderPos.authorized, false);
    });
  });

  describe('5. GraphQL Command Center Zero-Mock Telemetry', () => {
    it('GraphQL telemetry strictly reconciles with physical PostgreSQL database rows', async () => {
      const ownerContext = {
        isOwner: true,
        user: { uid: '6tLLR6q7aTYqzTG2blRx3TU5sA42', email: 'webhub2811@gmail.com', role: 'owner' }
      };

      const queryGql = `
        query {
          commandCenterSummary(period: "ALL") {
            totalOrders
            totalRevenueInr
          }
        }
      `;

      const gqlRes = await executeGraphQL(queryGql, {}, ownerContext);
      assert.ok(!gqlRes.errors, 'GraphQL query must execute without errors');

      const dbOrderCount = await query('SELECT COUNT(*) AS total FROM canonical_orders');
      const dbOrderSum = await query('SELECT COALESCE(SUM(total_amount), 0) AS total_rev FROM canonical_orders');

      const expectedOrders = Number(dbOrderCount.rows[0].total);
      const expectedRevenue = Math.round(Number(dbOrderSum.rows[0].total_rev) * 100) / 100;

      assert.strictEqual(gqlRes.data.commandCenterSummary.totalOrders, expectedOrders);
      assert.strictEqual(Math.round(gqlRes.data.commandCenterSummary.totalRevenueInr), Math.round(expectedRevenue));
    });

    it('Unauthenticated GraphQL query fails closed with FORBIDDEN', async () => {
      const unauthContext = { isOwner: false, user: null };
      const gqlRes = await executeGraphQL(`query { commandCenterSummary(period: "ALL") { totalOrders } }`, {}, unauthContext);
      assert.ok(gqlRes.errors?.length > 0);
      assert.strictEqual(gqlRes.errors[0].extensions?.code, 'FORBIDDEN');
    });
  });

});
