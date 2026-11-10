/**
 * OLIVE PIZZA — SECURITY HARDENING TEST SUITE
 * Phase 2 Immediate Backlog Verification (Items 1 - 10)
 *
 * Runs exploit simulations and asserts fail-closed security invariants.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import paymentRouter from '../src/routes/payment.routes.js';
import notificationRouter from '../src/routes/notification.routes.js';
import posRouter from '../src/routes/pos.routes.js';
import franchiseRouter from '../src/routes/franchise.routes.js';
import authRouter from '../src/routes/auth.routes.js';
import restaurantRouter from '../src/routes/restaurant.routes.js';
import adminRouter from '../src/routes/admin.routes.js';

describe('Olive Pizza — Security Hardening Phase 2 (Immediate 1 - 10)', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    // Mount routes
    app.use('/api/payment', paymentRouter);
    app.use('/api/notifications', notificationRouter);
    app.use('/api/pos', posRouter);
    app.use('/api/franchises', franchiseRouter);
    app.use('/api/auth', authRouter);
    app.use('/api/restaurant', restaurantRouter);
    app.use('/api/admin', adminRouter);
  });

  // ===========================================================================
  // IMMEDIATE-1: Token Bypass Elimination
  // ===========================================================================
  describe('IMMEDIATE-1: Elimination of test-* and dev-* token bypasses', () => {
    it('MUST reject "Bearer test-owner" with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/notifications/debug')
        .set('Authorization', 'Bearer test-owner');
      
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/unauthorized|invalid token|missing or invalid/i);
    });

    it('MUST reject "Bearer dev-admin" with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/notifications/analytics')
        .set('Authorization', 'Bearer dev-admin');
      
      expect(res.status).toBe(401);
    });

    it('MUST reject "Bearer test-customer" with 401 Unauthorized', async () => {
      const res = await request(app)
        .get('/api/payment/history')
        .set('Authorization', 'Bearer test-customer');
      
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // IMMEDIATE-3 & IMMEDIATE-8: POS Activation Hardening & Mock PIN Elimination
  // ===========================================================================
  describe('IMMEDIATE-3 & 8: POS Activation Code Security', () => {
    it('MUST reject unauthenticated POST /api/pos/terminals/activate with 401', async () => {
      const res = await request(app)
        .post('/api/pos/terminals/activate')
        .send({ activationCode: '741852', branchId: 'main_branch' });
      
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated GET /api/franchises/:id/pos-terminals with 401', async () => {
      const res = await request(app)
        .get('/api/franchises/fra_primary/pos-terminals');
      
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // IMMEDIATE-4: Role Escalation Prevention
  // ===========================================================================
  describe('IMMEDIATE-4: Role Escalation & Hierarchy Enforcement', () => {
    it('MUST reject role assignment without authentication with 401', async () => {
      const res = await request(app)
        .put('/api/restaurant/staff/usr_target_123/role')
        .send({ role: 'owner' });
      
      expect(res.status).toBe(401);
    });

    it('MUST reject admin role change without authentication with 401', async () => {
      const res = await request(app)
        .put('/api/admin/users/usr_target_123/role')
        .send({ role: 'platform_owner' });
      
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // IMMEDIATE-5: Orphaned Notification Endpoints Protection
  // ===========================================================================
  describe('IMMEDIATE-5: Notification Diagnostics & Broadcast Protection', () => {
    it('MUST reject unauthenticated GET /api/notifications/debug with 401', async () => {
      const res = await request(app).get('/api/notifications/debug');
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated GET /api/notifications/diagnostics with 401', async () => {
      const res = await request(app).get('/api/notifications/diagnostics');
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated GET /api/notifications/history with 401', async () => {
      const res = await request(app).get('/api/notifications/history');
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated POST /api/notifications/send with 401', async () => {
      const res = await request(app)
        .post('/api/notifications/send')
        .send({ title: 'Hacked Broadcast', body: 'Spam push' });
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated POST /api/notifications/send-custom with 401', async () => {
      const res = await request(app)
        .post('/api/notifications/send-custom')
        .send({ title: 'Hacked Push', body: 'Malicious blast' });
      expect(res.status).toBe(401);
    });

    it('MUST reject unauthenticated POST /api/notifications/test-center with 401', async () => {
      const res = await request(app)
        .post('/api/notifications/test-center')
        .send({ action: 'owner' });
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // IMMEDIATE-6: Invoice IDOR & Anonymous PII Leak Prevention
  // ===========================================================================
  describe('IMMEDIATE-6: Invoice Endpoint Protection', () => {
    it('MUST reject unauthenticated GET /api/payment/invoice/:orderId with 401', async () => {
      const res = await request(app).get('/api/payment/invoice/order_secret_9999');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  // IMMEDIATE-10: reCAPTCHA Fail-Closed Verification
  // ===========================================================================
  describe('IMMEDIATE-10: reCAPTCHA Fail-Closed Behavior', () => {
    it('MUST reject request with missing token with 400', async () => {
      const res = await request(app)
        .post('/api/auth/verify-recaptcha')
        .send({});
      
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/token missing/i);
    });
  });
});
