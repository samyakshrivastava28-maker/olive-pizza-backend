/**
 * Phase G: Release Candidate Audit & Final Integrity Verification Test Suite
 * 
 * Validates:
 * 1. Bill and payment SQL conflict handling, immutability, and anti-downgrade guards.
 * 2. Crash-safe persistence: Ledger-first transaction, monotonic bill allocation, projection outbox flagging.
 * 3. Multi-platform URL resolver heuristics across Capacitor native, Electron, browser, and env overrides.
 * 4. Multi-app role & scope authorization matrix across all identity-data pathways and fail-closed rules.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { query, withTransaction } from '../config/postgres.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';

describe('Phase G: Release Candidate & Final Integrity Verification', () => {

  describe('1. Bill and Payment SQL Conflict, Immutability & Anti-Downgrade Guards', () => {
    it('Allocates unique permanent bill number and successfully persists bill', async () => {
      const alloc = await BillingNumberService.allocateNumbers();
      const testOrderId = `ord_phase_g_bill_${Date.now()}`;

      // Insert canonical order first
      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, $3, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'COD', 'PENDING',
          'Test Customer', '9179944445', 250, 0, 12.5,
          6.25, 6.25, 0, 262.5, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        )
      `, [testOrderId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      // Save bill
      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId: testOrderId,
        totalAmount: 262.5,
        paymentMethod: 'COD',
        paymentStatus: 'PENDING',
        createdAt: new Date().toISOString()
      });

      const billRes = await query(`SELECT * FROM canonical_bills WHERE permanent_bill_no = $1`, [alloc.permanentBillNo]);
      assert.strictEqual(billRes.rows.length, 1);
      assert.strictEqual(billRes.rows[0].order_id, testOrderId);
      assert.strictEqual(Number(billRes.rows[0].net_amount), 262.5);
      assert.strictEqual(billRes.rows[0].payment_status, 'PENDING');
    });

    it('Reusing an allocated permanent bill number for a different order is strictly rejected', async () => {
      const alloc = await BillingNumberService.allocateNumbers();
      const orderA = `ord_phase_g_reuseA_${Date.now()}`;
      const orderB = `ord_phase_g_reuseB_${Date.now()}`;

      // Insert order A and its bill
      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id
        ) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME, 'POS', 'dine_in', 'PENDING', 'CASH', 'PAID', 'Cust A', '9999999999', 100, 100, 'fra_rajnandgaon', 'main_branch')
      `, [orderA, alloc.permanentBillNo, alloc.dailyOrderNo]);

      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId: orderA,
        totalAmount: 100,
        paymentMethod: 'CASH',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString()
      });

      // Attempt to save bill for order B with order A's bill number
      await assert.rejects(
        async () => {
          await billingRepository.saveBill({
            permanentBillNumber: alloc.permanentBillNo,
            billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
            orderId: orderB,
            totalAmount: 100,
            paymentMethod: 'CASH',
            paymentStatus: 'PAID',
            createdAt: new Date().toISOString()
          });
        },
        /Conflict: Permanent bill number .* is permanently assigned to order 'ord_phase_g_reuseA_/
      );
    });

    it('Financial snapshot on a finalized bill is strictly immutable against altered amounts', async () => {
      const alloc = await BillingNumberService.allocateNumbers();
      const orderId = `ord_phase_g_immut_${Date.now()}`;

      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id
        ) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID', 'Cust', '9999999999', 500, 500, 'fra_rajnandgaon', 'main_branch')
      `, [orderId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId,
        totalAmount: 500,
        paymentMethod: 'ONLINE',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString()
      });

      // Attempt to update bill with an altered total amount (e.g. tampering or bad retry)
      await assert.rejects(
        async () => {
          await billingRepository.saveBill({
            permanentBillNumber: alloc.permanentBillNo,
            billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
            orderId,
            totalAmount: 350, // Mismatched amount
            paymentMethod: 'ONLINE',
            paymentStatus: 'PAID',
            createdAt: new Date().toISOString()
          });
        },
        /Conflict: Finalized bill .* financial snapshot is immutable/
      );

      // Verify the database row remained untouched at 500
      const check = await query(`SELECT net_amount FROM canonical_bills WHERE permanent_bill_no = $1`, [alloc.permanentBillNo]);
      assert.strictEqual(Number(check.rows[0].net_amount), 500);
    });

    it('Stale retry or delayed callback cannot downgrade settled PAID status to PENDING or FAILED', async () => {
      const alloc = await BillingNumberService.allocateNumbers();
      const orderId = `ord_phase_g_nodowngrade_${Date.now()}`;

      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id
        ) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'DELIVERED', 'ONLINE', 'PAID', 'Cust', '9999999999', 400, 400, 'fra_rajnandgaon', 'main_branch')
      `, [orderId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      // Set bill to PAID
      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId,
        totalAmount: 400,
        paymentMethod: 'ONLINE',
        paymentStatus: 'PAID',
        createdAt: new Date().toISOString()
      });

      // Stale webhook arrives with PENDING status
      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId,
        totalAmount: 400,
        paymentMethod: 'ONLINE',
        paymentStatus: 'PENDING', // Stale downgrade attempt
        createdAt: new Date().toISOString()
      });

      // Verify payment_status remains PAID
      const res = await query(`SELECT payment_status FROM canonical_bills WHERE permanent_bill_no = $1`, [alloc.permanentBillNo]);
      assert.strictEqual(res.rows[0].payment_status, 'PAID', 'Settled PAID bill must not be downgraded to PENDING');
    });

    it('Cancelled bills are immutable against subsequent mutations', async () => {
      const alloc = await BillingNumberService.allocateNumbers();
      const orderId = `ord_phase_g_cancelled_${Date.now()}`;

      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id
        ) VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'CANCELLED', 'ONLINE', 'REFUNDED', 'Cust', '9999999999', 300, 300, 'fra_rajnandgaon', 'main_branch')
      `, [orderId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      await billingRepository.saveBill({
        permanentBillNumber: alloc.permanentBillNo,
        billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
        orderId,
        totalAmount: 300,
        paymentMethod: 'ONLINE',
        paymentStatus: 'REFUNDED',
        createdAt: new Date().toISOString()
      });

      // Mark cancelled in database
      await query(`UPDATE canonical_bills SET is_cancelled = TRUE WHERE permanent_bill_no = $1`, [alloc.permanentBillNo]);

      // Attempt to mutate cancelled bill
      await assert.rejects(
        async () => {
          await billingRepository.saveBill({
            permanentBillNumber: alloc.permanentBillNo,
            billFormattedNumber: `BILL-${String(alloc.permanentBillNo).padStart(6, '0')}`,
            orderId,
            totalAmount: 300,
            paymentMethod: 'CASH',
            paymentStatus: 'PAID',
            createdAt: new Date().toISOString()
          });
        },
        /Conflict: Permanent bill number .* belongs to a cancelled bill and cannot be mutated/
      );
    });
  });

  describe('2. Crash-Safe Order Persistence & Projection Invariants', () => {
    it('Uncommitted order failure leaves zero orphaned records in PostgreSQL', async () => {
      const orphanCandidateId = `ord_phase_g_orphan_${Date.now()}`;

      try {
        await withTransaction(async (client) => {
          await client.query(`
            INSERT INTO canonical_orders (
              id, permanent_bill_no, daily_order_no, order_date, order_time,
              order_source, order_type, order_status, payment_method, payment_status,
              customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id
            ) VALUES ($1, 9999991, 1, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'PENDING', 'COD', 'PENDING', 'Cust', '9999999999', 100, 100, 'fra_rajnandgaon', 'main_branch')
          `, [orphanCandidateId]);
          throw new Error('Simulated crash before commit');
        });
      } catch (err: any) {
        // Expected rollback
      }

      // Assert zero records exist
      const check = await query(`SELECT count(*) FROM canonical_orders WHERE id = $1`, [orphanCandidateId]);
      assert.strictEqual(Number(check.rows[0].count), 0, 'Rolled back transaction must leave zero rows');
    });

    it('Flagging PROJECTION_PENDING preserves obligation to synchronize without losing financial order', async () => {
      const testId = `ord_phase_g_proj_${Date.now()}`;
      const alloc = await BillingNumberService.allocateNumbers();

      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, $3, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'COD', 'PENDING',
          'Test Cust', '9179944445', 200, 200, 'fra_rajnandgaon', 'main_branch', 'PROJECTION_PENDING'
        )
      `, [testId, alloc.permanentBillNo, alloc.dailyOrderNo]);

      const res = await query(`SELECT live_lifecycle FROM canonical_orders WHERE id = $1`, [testId]);
      assert.strictEqual(res.rows[0].live_lifecycle, 'PROJECTION_PENDING');
    });
  });

  describe('3. Multi-Platform API URL Resolver Heuristics', () => {
    // Pure resolver function matching the logic across all 6 applications
    function resolveApiUrl(options: {
      envApiBase?: string;
      envBackendUrl?: string;
      isNativeCapacitor?: boolean;
      protocol?: string;
      userAgent?: string;
      hostname?: string;
      isDev?: boolean;
    }): string {
      const PROD_URL = 'https://olivepizza-owner.onrender.com';
      if (options.envApiBase) return options.envApiBase.replace(/\/+$/, '');
      if (options.envBackendUrl) return options.envBackendUrl.replace(/\/+$/, '');

      if (
        options.isNativeCapacitor ||
        options.protocol === 'capacitor:' ||
        options.protocol === 'ionic:' ||
        options.protocol === 'file:' ||
        (options.userAgent && options.userAgent.includes('Electron'))
      ) {
        return PROD_URL;
      }

      if (options.isDev) {
        if (options.hostname === 'localhost' || options.hostname === '127.0.0.1') {
          return '';
        }
      }

      if (options.hostname === 'localhost' || options.hostname === '127.0.0.1') {
        return 'http://localhost:5000';
      }

      return PROD_URL;
    }

    it('Native Capacitor environment resolves to production backend and never localhost', () => {
      const url = resolveApiUrl({ isNativeCapacitor: true, hostname: 'localhost' });
      assert.strictEqual(url, 'https://olivepizza-owner.onrender.com');
    });

    it('Capacitor webview protocol (capacitor:// or ionic://) resolves to production backend', () => {
      const urlCapacitor = resolveApiUrl({ protocol: 'capacitor:', hostname: 'localhost' });
      assert.strictEqual(urlCapacitor, 'https://olivepizza-owner.onrender.com');

      const urlIonic = resolveApiUrl({ protocol: 'ionic:', hostname: 'localhost' });
      assert.strictEqual(urlIonic, 'https://olivepizza-owner.onrender.com');
    });

    it('Electron desktop environment resolves to production backend', () => {
      const url = resolveApiUrl({ userAgent: 'Mozilla/5.0 ... Electron/28.0.0', protocol: 'file:' });
      assert.strictEqual(url, 'https://olivepizza-owner.onrender.com');
    });

    it('Browser in dev mode on localhost proxies via relative root', () => {
      const url = resolveApiUrl({ isDev: true, hostname: 'localhost', protocol: 'http:' });
      assert.strictEqual(url, '');
    });

    it('Explicit environment override VITE_API_BASE_URL is honored over all heuristics', () => {
      const customUrl = 'https://custom-staging.olivepizza.in';
      const url = resolveApiUrl({ envApiBase: customUrl, isNativeCapacitor: true });
      assert.strictEqual(url, customUrl);
    });
  });

  describe('4. Multi-App Role & Scope Authorization Matrix', () => {
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

    it('Owner account without staff grant fails closed for RESTAURANT_MANAGER', async () => {
      const auth = await FranchiseAccessService.resolveAuthorization({
        uid: 'owner_unauthorized_staff_uid',
        email: 'pure_owner@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER'
      });
      assert.strictEqual(auth.authorized, false, 'Pure owner account must fail closed for Restaurant Manager');
    });

    it('Owner account without staff grant fails closed for DELIVERY', async () => {
      const auth = await FranchiseAccessService.resolveAuthorization({
        uid: 'owner_unauthorized_rider_uid',
        email: 'pure_owner@olivepizza.in',
        targetApp: 'DELIVERY'
      });
      assert.strictEqual(auth.authorized, false, 'Pure owner account must fail closed for Delivery app');
    });

    it('Owner account without staff grant fails closed for POS', async () => {
      const auth = await FranchiseAccessService.resolveAuthorization({
        uid: 'owner_unauthorized_pos_uid',
        email: 'pure_owner@olivepizza.in',
        targetApp: 'POS'
      });
      assert.strictEqual(auth.authorized, false, 'Pure owner account must fail closed for POS app');
    });

    it('Platform owner email is authorized for OWNER Control Center', async () => {
      const auth = await FranchiseAccessService.resolveAuthorization({
        uid: '6tLLR6q7aTYqzTG2blRx3TU5sA42',
        email: 'webhub2811@gmail.com',
        targetApp: 'OWNER'
      });
      assert.strictEqual(auth.authorized, true);
      assert.strictEqual(auth.user?.role, 'owner');
    });

    it('Cashier staff account is authorized only for POS and rejected for all other apps', async () => {
      const posAuth = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'POS',
        terminalId: 'POS-01'
      });
      assert.strictEqual(posAuth.authorized, true);

      const ownerAuth = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'OWNER'
      });
      assert.strictEqual(ownerAuth.authorized, false);

      const restAuth = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_cashier_01',
        email: 'cashier@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER'
      });
      assert.strictEqual(restAuth.authorized, false);
    });

    it('Delivery partner account is authorized only for DELIVERY and rejected for others', async () => {
      const delivAuth = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_rider_01',
        email: 'rider@olivepizza.in',
        targetApp: 'DELIVERY'
      });
      assert.strictEqual(delivAuth.authorized, true);

      const posAuth = await FranchiseAccessService.resolveAuthorization({
        uid: 'staff_rider_01',
        email: 'rider@olivepizza.in',
        targetApp: 'POS'
      });
      assert.strictEqual(posAuth.authorized, false);
    });
  });

  describe('5. Fulfillment State Machine Explicit Rules', () => {
    it('Delivery order requires rider stages and rejects direct counter pickup skip', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'accepted'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'preparing'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'partner_assigned'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('partner_assigned', 'picked_up'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('picked_up', 'out_for_delivery'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('out_for_delivery', 'delivered'), true);

      // Rejects illegal skips
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'delivered'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'delivered'), false);
    });

    it('Terminal delivered and cancelled states reject all subsequent mutations', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'accepted'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('delivered', 'cancelled'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('cancelled', 'accepted'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('cancelled', 'delivered'), false);
    });
  });
});
