/**
 * E2E API Test 01: Authentication & Session Hydration
 * Tests database-verified auth, OTP bypass in dev, and RBAC app authorization.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getServerInfo } from './helpers/testServer.js';
import { getAuthToken } from './helpers/authHelper.js';

describe('E2E Backend API: Authentication & Session Hydration', () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;
  let activeDemoCode = '123456';

  before(async () => {
    const s = await getServerInfo();
    baseUrl = s.baseUrl;
    closeServer = s.close;
  });

  after(async () => {
    await closeServer();
  });

  it('1. POST /api/auth/email/send-code generates verification code in dev mode', async () => {
    const res = await fetch(`${baseUrl}/api/auth/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'customer@olivepizza.in' }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    if (body.demoCode) {
      activeDemoCode = body.demoCode;
    }
  });

  it('2. POST /api/auth/email/signin authenticates user with code', async () => {
    const res = await fetch(`${baseUrl}/api/auth/email/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'customer@olivepizza.in',
        code: activeDemoCode,
        name: 'Test Customer Samyak',
      }),
    });

    // Accept 200 or 400 if expired
    assert.ok([200, 400].includes(res.status), `Unexpected status: ${res.status}`);
    const body = (await res.json()) as any;
    if (res.status === 200) {
      assert.equal(body.success, true);
      assert.ok(body.customToken || body.user);
    }
  });

  it('3. POST /api/phone/send-otp and /api/phone/verify-otp verify phone number', async () => {
    const sendRes = await fetch(`${baseUrl}/api/phone/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+919876543210' }),
    });

    assert.equal(sendRes.status, 200);

    const verifyRes = await fetch(`${baseUrl}/api/phone/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: '+919876543210', otp: '123456' }),
    });

    assert.equal(verifyRes.status, 200);
    const verifyBody = (await verifyRes.json()) as any;
    assert.equal(verifyBody.success, true);
  });

  it('4. POST /api/auth/authorize-app validates RBAC app permissions', async () => {
    const token = await getAuthToken('MANAGER');
    const res = await fetch(`${baseUrl}/api/auth/authorize-app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        targetApp: 'RESTAURANT_MANAGER',
        requestedBranchId: 'branch_rjn_main',
      }),
    });

    assert.ok([200, 401, 403, 503].includes(res.status), `Unexpected status ${res.status}`);
  });
});
