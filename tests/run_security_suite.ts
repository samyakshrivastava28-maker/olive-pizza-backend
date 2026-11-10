/**
 * Olive Pizza — Comprehensive Security & Regression Test Runner
 * Verifies all security hardening invariants across Phases 1, 2, and 3.
 */

import express from 'express';
import { createServer } from 'http';
import paymentRouter from '../src/routes/payment.routes.js';
import notificationRouter from '../src/routes/notification.routes.js';
import posRouter from '../src/routes/pos.routes.js';
import franchiseRouter from '../src/routes/franchise.routes.js';
import authRouter from '../src/routes/auth.routes.js';
import restaurantRouter from '../src/routes/restaurant.routes.js';
import adminRouter from '../src/routes/admin.routes.js';
import orderRouter from '../src/routes/order.routes.js';
import menuRouter from '../src/routes/menu.routes.js';
import healthRouter from '../src/routes/health.routes.js';
import devopsRouter from '../src/routes/devops.routes.js';

const app = express();
app.use(express.json());

app.use('/api/payment', paymentRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/pos', posRouter);
app.use('/api/franchises', franchiseRouter);
app.use('/api/auth', authRouter);
app.use('/api/restaurant', restaurantRouter);
app.use('/api/admin', adminRouter);
app.use('/api/orders', orderRouter);
app.use('/api/menu', menuRouter);
app.use('/api/devops', devopsRouter);
app.use('/', healthRouter);

const server = createServer(app);

async function run() {
  const PORT = 3099;
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[TestRunner] Test server listening on ${baseUrl}`);

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name} — ${err.message}`);
      failed++;
    }
  }

  console.log('\n===============================================================');
  console.log('OLIVE PIZZA — SECURITY HARDENING SUITE (SPRINTS 1, 2, & 3)');
  console.log('===============================================================\n');

  // SPRINT 1 (IMMEDIATE 1-10)
  console.log('[1. Token Bypass Rejection (IMMEDIATE-1)]');
  await test('Reject Bearer test-owner with 401', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/debug`, {
      headers: { Authorization: 'Bearer test-owner' }
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject Bearer dev-admin with 401', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/analytics`, {
      headers: { Authorization: 'Bearer dev-admin' }
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject Bearer test-customer with 401', async () => {
    const res = await fetch(`${baseUrl}/api/payment/history`, {
      headers: { Authorization: 'Bearer test-customer' }
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[2. POS Activation & Franchise Security (IMMEDIATE-3 & 8)]');
  await test('Reject unauthenticated POS activation with 401', async () => {
    const res = await fetch(`${baseUrl}/api/pos/terminals/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activationCode: '741852', branchId: 'main_branch' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated GET pos-terminals with 401', async () => {
    const res = await fetch(`${baseUrl}/api/franchises/fra_primary/pos-terminals`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[3. Role Escalation Prevention (IMMEDIATE-4)]');
  await test('Reject unauthenticated staff role promotion with 401', async () => {
    const res = await fetch(`${baseUrl}/api/restaurant/staff/usr_target_123/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated admin role mutation with 401', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users/usr_target_123/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'platform_owner' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[4. Notification Route Security (IMMEDIATE-5)]');
  await test('Reject unauthenticated GET /debug with 401', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/debug`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated GET /diagnostics with 401', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/diagnostics`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated POST /send with 401', async () => {
    const res = await fetch(`${baseUrl}/api/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Spam', body: 'Blast' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[5. Invoice Endpoint Protection (IMMEDIATE-6)]');
  await test('Reject unauthenticated GET /invoice/:orderId with 401', async () => {
    const res = await fetch(`${baseUrl}/api/payment/invoice/order_private_123`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[6. reCAPTCHA Fail-Closed (IMMEDIATE-10)]');
  await test('Reject missing token with 400 and fail closed', async () => {
    const res = await fetch(`${baseUrl}/api/auth/verify-recaptcha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
    const data = await res.json() as any;
    if (data.success !== false) throw new Error(`Expected success: false, got ${data.success}`);
  });

  // SPRINT 2 (SHORT-TERM 11-25)
  console.log('\n[7. Orders & Live Status Role Gating (Items 11, 12, 13)]');
  await test('Reject unauthenticated GET /orders/live with 401', async () => {
    const res = await fetch(`${baseUrl}/api/orders/live`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated PATCH /orders/:id/status with 401', async () => {
    const res = await fetch(`${baseUrl}/api/orders/ord_123/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'delivered' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated POST /orders/:id/reorder with 401', async () => {
    const res = await fetch(`${baseUrl}/api/orders/ord_123/reorder`, {
      method: 'POST'
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[8. Franchise Gating (Item 14)]');
  await test('Reject unauthenticated GET /franchises/list with 401', async () => {
    const res = await fetch(`${baseUrl}/api/franchises/list`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated GET /franchises/:id/dashboard with 401', async () => {
    const res = await fetch(`${baseUrl}/api/franchises/fra_primary/dashboard`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject unauthenticated GET /franchises/:id/managers with 401', async () => {
    const res = await fetch(`${baseUrl}/api/franchises/fra_primary/managers`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[9. Menu Management Role Gating (Item 16)]');
  await test('Reject unauthenticated GET /menu/branch/:id/management with 401', async () => {
    const res = await fetch(`${baseUrl}/api/menu/branch/main_branch/management`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  console.log('\n[10. Information Disclosure Prevention (Items 19 & 20)]');
  await test('Verify GET /version does not leak git_commit or build_hash', async () => {
    const res = await fetch(`${baseUrl}/version`);
    if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    const data = await res.json() as any;
    if (data.git_commit) throw new Error('git_commit leaked in /version');
    if (data.build_hash) throw new Error('build_hash leaked in /version');
    if (data.api_version !== 'v2.1.0') throw new Error(`Unexpected version: ${data.api_version}`);
  });

  await test('Verify GET /ready returns clean status without internal topology', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    const data = await res.json() as any;
    if (data.core || data.subsystems || data.postgres) {
      throw new Error('Internal infrastructure topology leaked in /ready');
    }
    if (!['ready', 'unready'].includes(data.status)) {
      throw new Error(`Unexpected readiness status: ${data.status}`);
    }
  });

  console.log('\n[11. Payment Webhook Allowlist (Item 27)]');
  await test('Reject unknown webhook provider with 400', async () => {
    const res = await fetch(`${baseUrl}/api/payment/webhook/malicious_provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'payment.captured' })
    });
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`);
  });

  console.log('\n[12. Operational App Allowlist Security (Part 1)]');
  await test('Reject unauthenticated POST /api/auth/authorize-app with 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/authorize-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetApp: 'POS' })
    });
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await test('Reject authorize-app with invalid targetApp parameter with 401 (or 400 when authed)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/authorize-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetApp: 'HACKER_PANEL' })
    });
    // Unauthenticated request is caught by verifyToken middleware first (401)
    if (res.status !== 401 && res.status !== 400) throw new Error(`Expected 401 or 400, got ${res.status}`);
  });

  console.log('\n[13. Canonical Order Status Reconciliation]');
  await test('Reconcile legacy statuses into canonical OrderStatus enum', async () => {
    const { OrderStateMachine } = await import('../src/services/order/OrderStateMachine.js');
    if (OrderStateMachine.reconcileStatus('pending_acceptance') !== 'pending') throw new Error('Failed to reconcile pending_acceptance');
    if (OrderStateMachine.reconcileStatus('PENDING') !== 'pending') throw new Error('Failed to reconcile uppercase PENDING');
    if (OrderStateMachine.reconcileStatus('preparing') !== 'preparing') throw new Error('Failed to reconcile preparing');
    if (OrderStateMachine.reconcileStatus('ready') !== 'ready') throw new Error('Failed to reconcile ready');
    if (OrderStateMachine.reconcileStatus('picked_up') !== 'picked_up') throw new Error('Failed to reconcile picked_up');
    if (OrderStateMachine.reconcileStatus('out_for_delivery') !== 'out_for_delivery') throw new Error('Failed to reconcile out_for_delivery');
    if (OrderStateMachine.reconcileStatus('delivered') !== 'delivered') throw new Error('Failed to reconcile delivered');
    if (OrderStateMachine.reconcileStatus('cancelled') !== 'cancelled') throw new Error('Failed to reconcile cancelled');
    if (OrderStateMachine.reconcileStatus('garbage_status') !== 'pending') throw new Error('Failed fallback on unknown status');
  });

  console.log('\n===============================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('===============================================================\n');

  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('[TestRunner] Unhandled runner error:', e);
  process.exit(1);
});
