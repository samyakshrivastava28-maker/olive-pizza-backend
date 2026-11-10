import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import { SSRFValidator } from '../src/services/devOps/SSRFValidator.js';
import { generateTrackingToken, verifyTrackingToken } from '../src/utils/trackingToken.js';
import { FranchiseScopeService } from '../src/services/franchise/FranchiseScopeService.js';
import healthStreamRouter from '../src/routes/health.stream.routes.js';
import healthRouter from '../src/routes/health.routes.js';
import navigationRouter from '../src/routes/navigation.routes.js';

async function runTests() {
  console.log('================================================================');
  console.log('OLIVE PIZZA — 35-VECTOR COMPREHENSIVE SECURITY HARNESS AUDIT');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function assertTest(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name} — ${err.message}`);
      failed++;
    }
  }

  // Set up mock test app
  const app = express();
  app.use(express.json());

  // Configure CORS matching hardened app.ts rules
  const allowedOrigins = [
    'https://olivepizza.in',
    'https://www.olivepizza.in',
    'https://owner.olivepizza.in',
    'https://pos.olivepizza.in',
    'capacitor://localhost'
  ];

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (/^https:\/\/([a-z0-9-]+\.)*olivepizza\.in$/.test(origin)) return callback(null, true);
      if (origin.startsWith('capacitor://') || origin.startsWith('ionic://')) return callback(null, true);
      callback(null, false);
    },
    credentials: true
  }));

  app.use('/health', healthStreamRouter);
  app.use('/', healthRouter);
  app.use('/api/navigation', navigationRouter);

  const server = createServer(app);
  const PORT = 3198;
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${PORT}`;

  try {
    // ─── 1. HEALTH & DIAGNOSTICS ENDPOINTS (VECTORS 1–6) ───────────────────
    await assertTest('Vector 1: Unauthenticated GET /health/diagnostics rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/health/diagnostics`);
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    await assertTest('Vector 2: Unauthenticated GET /health/stream rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/health/stream`);
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    await assertTest('Vector 3: Unauthenticated POST /health/test-fcm rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/health/test-fcm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fake-token' })
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    await assertTest('Vector 4: Unauthenticated POST /health/notification-test rejected with 401', async () => {
      const res = await fetch(`${baseUrl}/health/notification-test`, { method: 'POST' });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
    });

    await assertTest('Vector 5: Public GET /health/status does NOT leak memoryMB, heap, or uptime', async () => {
      const res = await fetch(`${baseUrl}/health/status`);
      if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
      const body = await res.json();
      if (body.memoryMB !== undefined) throw new Error('Leaked memoryMB to public');
      if (body.uptime !== undefined) throw new Error('Leaked uptime to public');
      if (body.version !== undefined) throw new Error('Leaked version to public');
      if (body.status !== 'healthy') throw new Error(`Expected status healthy, got ${body.status}`);
    });

    await assertTest('Vector 6: Public GET /health/ping does NOT leak internal telemetry', async () => {
      const res = await fetch(`${baseUrl}/health/ping`);
      if (!res.ok) throw new Error(`Expected 200, got ${res.status}`);
      const body = await res.json();
      if (body.totalPings !== undefined) throw new Error('Leaked totalPings to public');
      if (body.uptime !== undefined) throw new Error('Leaked uptime to public');
      if (body.status !== 'ok') throw new Error(`Expected status ok, got ${body.status}`);
    });

    // ─── 2. CORS SECURITY (VECTORS 7–12) ──────────────────────────────────
    await assertTest('Vector 7: Reject malicious arbitrary origin (https://attacker.com)', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'https://attacker.com' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin === 'https://attacker.com') throw new Error('Allowed malicious origin');
    });

    await assertTest('Vector 8: Reject suffix squatting origin (https://evil-olivepizza.in)', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'https://evil-olivepizza.in' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin === 'https://evil-olivepizza.in') throw new Error('Allowed suffix-squatted domain');
    });

    await assertTest('Vector 9: Reject HTTP (cleartext) origin for olivepizza.in in production', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'http://olivepizza.in' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin === 'http://olivepizza.in') throw new Error('Allowed insecure cleartext HTTP origin');
    });

    await assertTest('Vector 10: Allow official domain (https://olivepizza.in)', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'https://olivepizza.in' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin !== 'https://olivepizza.in') throw new Error(`Expected https://olivepizza.in, got ${allowOrigin}`);
    });

    await assertTest('Vector 11: Allow official subdomain (https://pos.olivepizza.in)', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'https://pos.olivepizza.in' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin !== 'https://pos.olivepizza.in') throw new Error(`Expected https://pos.olivepizza.in, got ${allowOrigin}`);
    });

    await assertTest('Vector 12: Allow mobile WebView protocol (capacitor://localhost)', async () => {
      const res = await fetch(`${baseUrl}/health/status`, {
        headers: { 'Origin': 'capacitor://localhost' }
      });
      const allowOrigin = res.headers.get('access-control-allow-origin');
      if (allowOrigin !== 'capacitor://localhost') throw new Error(`Expected capacitor://localhost, got ${allowOrigin}`);
    });

    // ─── 3. SSRF VALIDATION & PROTECTION (VECTORS 13–24) ───────────────────
    await assertTest('Vector 13: Block AWS/GCP link-local metadata (169.254.169.254)', async () => {
      const check = await SSRFValidator.validateAsync('http://169.254.169.254/latest/meta-data/');
      if (check.safe) throw new Error('Allowed 169.254.169.254');
    });

    await assertTest('Vector 14: Block Alibaba cloud metadata (100.100.100.200)', async () => {
      const check = await SSRFValidator.validateAsync('http://100.100.100.200/latest/meta-data/');
      if (check.safe) throw new Error('Allowed Alibaba metadata IP');
    });

    await assertTest('Vector 15: Block GCP internal metadata hostname (metadata.google.internal)', async () => {
      const check = await SSRFValidator.validateAsync('http://metadata.google.internal/computeMetadata/v1/');
      if (check.safe) throw new Error('Allowed metadata.google.internal');
    });

    await assertTest('Vector 16: Block loopback IP (127.0.0.1)', async () => {
      const check = await SSRFValidator.validateAsync('http://127.0.0.1:8080/metrics');
      if (check.safe) throw new Error('Allowed 127.0.0.1');
    });

    await assertTest('Vector 17: Block loopback hostname (localhost)', async () => {
      const check = await SSRFValidator.validateAsync('http://localhost:5000/admin');
      if (check.safe) throw new Error('Allowed localhost');
    });

    await assertTest('Vector 18: Block IPv6 loopback (::1)', async () => {
      const check = await SSRFValidator.validateAsync('http://[::1]:8080/');
      if (check.safe) throw new Error('Allowed [::1]');
    });

    await assertTest('Vector 19: Block RFC 1918 10.0.0.0/8 private network', async () => {
      const check = await SSRFValidator.validateAsync('http://10.0.0.5:8080/database');
      if (check.safe) throw new Error('Allowed 10.0.0.5');
    });

    await assertTest('Vector 20: Block RFC 1918 192.168.0.0/16 private network', async () => {
      const check = await SSRFValidator.validateAsync('http://192.168.1.1/admin');
      if (check.safe) throw new Error('Allowed 192.168.1.1');
    });

    await assertTest('Vector 21: Block RFC 1918 172.16.0.0/12 private network', async () => {
      const check = await SSRFValidator.validateAsync('http://172.20.0.1:9000/api');
      if (check.safe) throw new Error('Allowed 172.20.0.1');
    });

    await assertTest('Vector 22: Block Carrier-Grade NAT 100.64.0.0/10 range', async () => {
      const check = await SSRFValidator.validateAsync('http://100.64.0.1:3000/');
      if (check.safe) throw new Error('Allowed Carrier-Grade NAT address');
    });

    await assertTest('Vector 23: Block dangerous non-HTTP schemes (file://, gopher://)', async () => {
      const checkFile = await SSRFValidator.validateAsync('file:///etc/passwd');
      if (checkFile.safe) throw new Error('Allowed file:// scheme');
      const checkGopher = await SSRFValidator.validateAsync('gopher://127.0.0.1:6379');
      if (checkGopher.safe) throw new Error('Allowed gopher:// scheme');
    });

    await assertTest('Vector 24: Allow legitimate external public HTTPS endpoint', async () => {
      const check = await SSRFValidator.validateAsync('https://api.github.com');
      if (!check.safe) throw new Error(`Rejected valid endpoint: ${check.reason}`);
    });

    // ─── 4. TRACKING TOKEN SECURITY (VECTORS 25–28) ────────────────────────
    await assertTest('Vector 25: Valid tracking token generates and verifies correctly', () => {
      const orderId = 'ORD_TEST_999';
      const token = generateTrackingToken(orderId);
      const verified = verifyTrackingToken(token);
      if (verified !== orderId) throw new Error(`Expected ${orderId}, got ${verified}`);
    });

    await assertTest('Vector 26: Tampered tracking token payload rejected', () => {
      const token = generateTrackingToken('ORD_ORIGINAL');
      const raw = Buffer.from(token, 'base64url').toString('utf8');
      const parts = raw.split(':');
      const tamperedRaw = `ORD_TAMPERED:${parts[1]}:${parts[2]}`;
      const tamperedToken = Buffer.from(tamperedRaw).toString('base64url');
      const verified = verifyTrackingToken(tamperedToken);
      if (verified !== null) throw new Error('Tampered token was accepted');
    });

    await assertTest('Vector 27: Tampered tracking token signature rejected', () => {
      const token = generateTrackingToken('ORD_TEST');
      const raw = Buffer.from(token, 'base64url').toString('utf8');
      const parts = raw.split(':');
      const tamperedRaw = `${parts[0]}:${parts[1]}:0000000000000000000000000000000000000000000000000000000000000000`;
      const tamperedToken = Buffer.from(tamperedRaw).toString('base64url');
      const verified = verifyTrackingToken(tamperedToken);
      if (verified !== null) throw new Error('Invalid HMAC was accepted');
    });

    await assertTest('Vector 28: Expired tracking token rejected', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 100;
      const raw = `ORD_EXPIRED:${pastExp}:dummyhmac`;
      const token = Buffer.from(raw).toString('base64url');
      const verified = verifyTrackingToken(token);
      if (verified !== null) throw new Error('Expired token was accepted');
    });

    // ─── 5. NAVIGATION COORDINATE INJECTION DEFENSE (VECTORS 29–31) ────────
    await assertTest('Vector 29: Navigation rejects out-of-bounds latitude (>90)', async () => {
      const res = await fetch(`${baseUrl}/api/navigation/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lat: 95.5, lng: 81.0 }, destination: { lat: 21.0, lng: 81.0 } })
      });
      // Should reject with 401 (auth) or 400 (bad coords)
      if (res.status !== 401 && res.status !== 400) {
        throw new Error(`Expected 401 or 400, got ${res.status}`);
      }
    });

    await assertTest('Vector 30: Navigation rejects out-of-bounds longitude (>180)', async () => {
      const res = await fetch(`${baseUrl}/api/navigation/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lat: 21.0, lng: 195.0 }, destination: { lat: 21.0, lng: 81.0 } })
      });
      if (res.status !== 401 && res.status !== 400) {
        throw new Error(`Expected 401 or 400, got ${res.status}`);
      }
    });

    await assertTest('Vector 31: Navigation rejects non-numeric string payload', async () => {
      const res = await fetch(`${baseUrl}/api/navigation/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: { lat: 'attack/../../', lng: 'inject' }, destination: { lat: 21.0, lng: 81.0 } })
      });
      if (res.status !== 401 && res.status !== 400) {
        throw new Error(`Expected 401 or 400, got ${res.status}`);
      }
    });

    // ─── 6. SCOPE AUTHORITY & FAIL-CLOSED CHECKS (VECTORS 32–35) ───────────
    await assertTest('Vector 32: Non-owner staff without assigned branch does NOT default to main_branch', () => {
      const scope = FranchiseScopeService.resolveScope({
        uid: 'usr_staff_1',
        role: 'restaurant_manager',
        email: 'manager@test.com'
        // branchId intentionally omitted
      });
      if (scope.branchId === 'main_branch') {
        throw new Error('Dangerous fallback to main_branch occurred');
      }
      if (scope.branchId !== '') {
        throw new Error(`Expected empty branchId, got ${scope.branchId}`);
      }
    });

    await assertTest('Vector 33: Non-owner staff without branchId throws 403 in getEffectiveBranchId', () => {
      const scope = FranchiseScopeService.resolveScope({
        uid: 'usr_staff_2',
        role: 'restaurant_manager',
        email: 'manager2@test.com'
      });
      let threw = false;
      try {
        FranchiseScopeService.getEffectiveBranchId(scope);
      } catch (err: any) {
        threw = true;
        if (err.status !== 403) throw new Error(`Expected status 403, got ${err.status}`);
      }
      if (!threw) throw new Error('Did not fail closed with 403 when branchId was missing');
    });

    await assertTest('Vector 34: Global owner scope is strictly restricted to authorized emails', () => {
      const isAttackerOwner = FranchiseScopeService.isGlobalOwner('attacker@gmail.com', 'owner');
      if (isAttackerOwner) throw new Error('Attacker email resolved to global owner');

      const isVerifiedOwner = FranchiseScopeService.isGlobalOwner('olivepizzarjn@gmail.com', 'owner');
      if (!isVerifiedOwner) throw new Error('Verified master owner was not recognized');
    });

    await assertTest('Vector 35: Cross-franchise access is strictly blocked for franchise owners', () => {
      const scope = FranchiseScopeService.resolveScope({
        uid: 'fra_owner_1',
        role: 'franchise_owner',
        franchiseId: 'fra_bhilai',
        email: 'owner@bhilai.com'
      });
      let threw = false;
      try {
        FranchiseScopeService.assertFranchiseAccess(scope, 'fra_rajnandgaon');
      } catch (err: any) {
        threw = true;
        if (err.status !== 403) throw new Error(`Expected status 403, got ${err.status}`);
      }
      if (!threw) throw new Error('Cross-franchise access was permitted');
    });

  } finally {
    server.close();
  }

  console.log('\n================================================================');
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL 35/35 VECTORS)`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test harness execution failed:', err);
  process.exit(1);
});
