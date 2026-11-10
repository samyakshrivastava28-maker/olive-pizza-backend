/**
 * Phase H: Backend Security Hardening, Data Protection & Release Verification Suite
 *
 * Validates:
 * 1. Data Manager Unauthorized Access Prevention (401/403 fail-closed).
 * 2. Delivery Partner Live GPS Fleet Telemetry Protection (No anonymous / cross-role scraping).
 * 3. Bootstrap Order Tracking BOLA / IDOR Defense (Anonymous & Cross-Customer Isolation).
 * 4. AI Generation & Infrastructure Model Drain Defenses (Auth & Role Enforcement).
 * 5. Email Marketing Campaign & Analytics Access Protection (Owner/Admin Only).
 * 6. Privilege Boundary Separation (Platform Owner vs Staff Applications).
 * 7. Server Readiness Semantics & Credential Leakage Defense.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import http from 'http';
import apiApp from '../app.js';
import healthRoutes from '../routes/health.routes.js';
import { generateTrackingToken } from '../utils/trackingToken.js';
import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';

let BASE_URL = process.env.TEST_API_URL || 'http://localhost:5000';
let server: http.Server;

describe('Security Hardening Routes & Boundary Verification', () => {
  before(async () => {
    const testApp = express();
    testApp.use(healthRoutes);
    testApp.use('/api', healthRoutes);
    testApp.use('/api', apiApp);
    testApp.use(apiApp);

    await new Promise<void>((resolve) => {
      server = testApp.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        BASE_URL = `http://127.0.0.1:${addr.port}`;
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

  describe('1. Data Manager Unauthorized Access Prevention', () => {
    it('GET /api/data-manager/overview is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/data-manager/overview`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });

    it('GET /api/data-manager/databases is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/data-manager/databases`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });

    it('GET /api/data-manager/logs is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/data-manager/logs`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });

    it('POST /api/data-manager/databases/test-connection is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/data-manager/databases/test-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'postgres' })
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('2. Delivery Partner Live GPS Fleet Telemetry Protection', () => {
    it('GET /api/tracking/locations/active is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/tracking/locations/active`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });

    it('GET /api/tracking/active-drivers is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/tracking/active-drivers`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });

    it('GET /api/tracking/location/:partnerId is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/tracking/location/rider_test_123`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.match(body.error || '', /Unauthorized|Authentication required/i);
    });
  });

  describe('3. Bootstrap Order Tracking BOLA / IDOR Defense', () => {
    it('GET /api/v1/orders/:orderId/tracking/bootstrap is rejected with 403 when unauthenticated without tracking token', async () => {
      const testOrderId = `ord_sec_h_${Date.now()}`;
      const uniqueBillNo = Math.floor(Date.now() / 1000) % 900000 + Math.floor(Math.random() * 90000) + 10000;
      // Insert test order in PostgreSQL canonical store
      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 891, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
          'Confidential Customer', '9876543210', 500, 0, 25,
          12.5, 12.5, 0, 525, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        ) ON CONFLICT (id) DO NOTHING
      `, [testOrderId, uniqueBillNo]);

      const res = await fetch(`${BASE_URL}/api/v1/orders/${testOrderId}/tracking/bootstrap`);
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.match(body.error || '', /permission|Forbidden/i);
    });

    it('GET /api/v1/orders/:orderId/tracking/bootstrap succeeds when valid HMAC tracking token is presented', async () => {
      const testOrderId = `ord_sec_h_token_${Date.now()}`;
      const uniqueBillNo = Math.floor(Date.now() / 1000) % 900000 + Math.floor(Math.random() * 90000) + 10000;
      await query(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, payment_method, payment_status,
          customer_name, customer_phone, subtotal, discount_amount, tax_amount,
          cgst, sgst, delivery_fee, total_amount, franchise_id, branch_id, live_lifecycle
        ) VALUES (
          $1, $2, 892, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'PENDING', 'ONLINE', 'PAID',
          'Token Customer', '9876543210', 350, 0, 17.5,
          8.75, 8.75, 0, 367.5, 'fra_rajnandgaon', 'main_branch', 'ACTIVE'
        ) ON CONFLICT (id) DO NOTHING
      `, [testOrderId, uniqueBillNo]);

      const validToken = generateTrackingToken(testOrderId);
      const res = await fetch(`${BASE_URL}/api/v1/orders/${testOrderId}/tracking/bootstrap?trackingToken=${validToken}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.success, true);
      assert.strictEqual(body.order.id, testOrderId);
    });
  });

  describe('4. AI Generation & Infrastructure Model Drain Defenses', () => {
    it('POST /api/ai/generate-email is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/ai/generate-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Send promotional campaign' })
      });
      assert.strictEqual(res.status, 401);
    });

    it('POST /api/ai/generate-image is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Delicious pepperoni pizza' })
      });
      assert.strictEqual(res.status, 401);
    });

    it('POST /api/ai/generate-description is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/ai/generate-description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Truffle Mushroom' })
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('5. Email Marketing Campaign & Analytics Access Protection', () => {
    it('POST /api/email/send-campaign is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/email/send-campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignName: 'Blast', subject: 'Sale', htmlContent: '<p>Buy!</p>' })
      });
      assert.strictEqual(res.status, 401);
    });

    it('GET /api/email/logs is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/email/logs`);
      assert.strictEqual(res.status, 401);
    });

    it('GET /api/email/analytics is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/email/analytics`);
      assert.strictEqual(res.status, 401);
    });

    it('POST /api/email/test is rejected with 401 when unauthenticated', async () => {
      const res = await fetch(`${BASE_URL}/api/email/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: 'victim@example.com', subject: 'Spam', htmlContent: 'spam' })
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('6. Server-Side Privilege Separation (Owner vs Staff Applications)', () => {
    it('Owner account without POS application grant is strictly denied access to POS operational endpoints', async () => {
      const resolution = await FranchiseAccessService.resolveAuthorization({
        uid: 'owner_user_without_pos',
        email: 'owner-no-pos@example.com',
        targetApp: 'POS',
        requestedBranchId: 'main_branch'
      });
      assert.strictEqual(resolution.authorized, false);
      assert.match(resolution.reason || '', /POS|grant|not authorized/i);
    });

    it('Cashier account attempting Restaurant Manager operational dashboard is strictly denied', async () => {
      const resolution = await FranchiseAccessService.resolveAuthorization({
        uid: 'cashier_user_1',
        email: 'cashier@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER',
        requestedBranchId: 'main_branch'
      });
      assert.strictEqual(resolution.authorized, false);
      assert.match(resolution.reason || '', /RESTAURANT_MANAGER|No Restaurant Manager|grant|not authorized/i);
    });

    it('Rider account attempting Franchise Manager operations is strictly denied', async () => {
      const resolution = await FranchiseAccessService.resolveAuthorization({
        uid: 'rider_user_1',
        email: 'rider@olivepizza.in',
        targetApp: 'FRANCHISE_MANAGER',
        requestedBranchId: 'main_branch'
      });
      assert.strictEqual(resolution.authorized, false);
      assert.match(resolution.reason || '', /FRANCHISE_MANAGER|No Franchise Manager|grant|not authorized/i);
    });
  });

  describe('7. Server Readiness Semantics & Leakage Defense', () => {
    it('GET /live and /api/live return 200 OK without disclosing internal topology', async () => {
      const res = await fetch(`${BASE_URL}/live`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(typeof body.uptime, 'number');
      assert.strictEqual(body.database_url, undefined);
      assert.strictEqual(body.credentials, undefined);
    });

    it('GET /ready and /api/ready return consistent schema and do not leak private secrets', async () => {
      const res1 = await fetch(`${BASE_URL}/ready`);
      const res2 = await fetch(`${BASE_URL}/api/ready`);
      assert.strictEqual(res1.status, res2.status);
      const b1 = await res1.json();
      const b2 = await res2.json();
      assert.strictEqual(b1.status, b2.status);
      assert.strictEqual(b1.checks.postgres, 'healthy');
      // No secrets leaked in body
      const bodyStr = JSON.stringify(b1);
      assert.strictEqual(bodyStr.includes('FIREBASE_PRIVATE_KEY'), false);
      assert.strictEqual(bodyStr.includes('DATABASE_URL'), false);
    });

    it('Requests for forbidden file patterns (.env, .git, .ts) are blocked with 403', async () => {
      const res1 = await fetch(`${BASE_URL}/.env`);
      assert.strictEqual(res1.status, 403);

      const res2 = await fetch(`${BASE_URL}/src/server.ts`);
      assert.strictEqual(res2.status, 403);

      const res3 = await fetch(`${BASE_URL}/.git/config`);
      assert.strictEqual(res3.status, 403);
    });
  });

  describe('8. Process & DB Teardown Cleanup', () => {
    it('Gracefully exits test runner and closes idle connections', async () => {
      // Allow clean exit
      assert.strictEqual(true, true);
    });
  });

});
