/**
 * Ecosystem Verification: Authorization Matrix & Redis Engine
 */
import dotenv from 'dotenv';
dotenv.config();

import { redisService } from '../src/services/redis/RedisService.js';
import { FranchiseAccessService } from '../src/services/franchise/FranchiseAccessService.js';
import { adminDb } from '../src/config/firebase.js';

interface TestResult {
  suite: string;
  test: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(suite: string, test: string, passed: boolean, details?: string) {
  results.push({ suite, test, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} [${suite}] ${test}${details ? ` - ${details}` : ''}`);
}

async function runTests() {
  console.log('====================================================');
  console.log('OLIVE PIZZA — ECOSYSTEM AUTHORIZATION & REDIS AUDIT');
  console.log('====================================================\n');

  // ─── SUITE 1: REDIS RESILIENCE & CACHING ───────────────────────────
  console.log('--- Testing Redis Service ---');
  try {
    await redisService.waitForReady(4000);
    const isConn = redisService.isAvailable();
    record('Redis', 'Connection Check', isConn, `Connected: ${isConn}`);

    if (isConn) {
      // 1. Key normalization and set/get
      const testKey = 'test_eco_' + Date.now();
      await redisService.set(testKey, 'olive_audit_verified', 60);
      const val = await redisService.get(testKey);
      record('Redis', 'Set and Get with TTL', val === 'olive_audit_verified', `Expected 'olive_audit_verified', got '${val}'`);

      // 2. Namespace check
      const normalized = redisService.normalizeKey(testKey);
      record('Redis', 'Key Namespace Isolation', normalized.startsWith('olive:'), `Normalized key: ${normalized}`);

      // 3. Distributed Idempotency Lock
      const idempKey = 'test_idemp_' + Date.now();
      const firstAcquire = await redisService.checkAndSetIdempotency(idempKey, 30);
      const secondAcquire = await redisService.checkAndSetIdempotency(idempKey, 30);
      record('Redis', 'Idempotency First Acquire (allowed)', firstAcquire === true, `First lock: ${firstAcquire}`);
      record('Redis', 'Idempotency Second Acquire (blocked/fail-closed)', secondAcquire === false, `Second lock blocked: ${!secondAcquire}`);

      // 4. Rate Limiting Check
      const rateLimitKey = 'test_ratelimit_' + Date.now();
      const r1 = await redisService.checkRateLimit(rateLimitKey, 3, 60);
      const r2 = await redisService.checkRateLimit(rateLimitKey, 3, 60);
      const r3 = await redisService.checkRateLimit(rateLimitKey, 3, 60);
      const r4 = await redisService.checkRateLimit(rateLimitKey, 3, 60);
      record('Redis', 'Rate Limiter Under Limit', r1.allowed && r2.allowed && r3.allowed, `Allowed 3 requests: ${r1.allowed && r2.allowed && r3.allowed}`);
      record('Redis', 'Rate Limiter Over Limit Blocked', r4.allowed === false, `Blocked 4th request: ${!r4.allowed}`);

      // Cleanup
      await redisService.del(testKey);
    }
  } catch (err: any) {
    record('Redis', 'Redis Test Execution', false, err.message);
  }

  // ─── SUITE 2: MULTI-APP AUTHORIZATION RESOLUTION ─────────────────────
  console.log('\n--- Testing FranchiseAccessService Authorization Matrix ---');
  try {
    // Test 1: Platform Owner Access
    const ownerAuth = await FranchiseAccessService.resolveAuthorization({
      uid: 'owner_master_001',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'RESTAURANT_MANAGER'
    });
    record('Authorization', 'Platform Owner -> Restaurant Manager App', ownerAuth.authorized === true, `Role: ${ownerAuth.user?.role}`);

    const ownerPosAuth = await FranchiseAccessService.resolveAuthorization({
      uid: 'owner_master_001',
      email: 'olivepizzarjn@gmail.com',
      targetApp: 'POS'
    });
    record('Authorization', 'Platform Owner -> POS App', ownerPosAuth.authorized === true, `Role: ${ownerPosAuth.user?.role}`);

    // Test 2: Mock Owner-Approved Restaurant Manager
    const rmUid = 'test_rm_approved_' + Date.now();
    const rmEmail = `manager_${Date.now()}@olivepizza.in`;
    
    // Save approved manager to users collection
    await adminDb.collection('users').doc(rmUid).set({
      uid: rmUid,
      email: rmEmail,
      name: 'Approved Test Manager',
      role: 'restaurant_manager',
      status: 'APPROVED',
      isActive: true,
      branchId: 'main_branch',
      franchiseId: 'fra_rajnandgaon',
      allowedApps: ['RESTAURANT_MANAGER'],
      applicationAccess: { app_restaurant_management: true }
    });

    const rmAuthAllowed = await FranchiseAccessService.resolveAuthorization({
      uid: rmUid,
      email: rmEmail,
      targetApp: 'RESTAURANT_MANAGER'
    });
    record('Authorization', 'Owner-Approved Manager -> Restaurant Manager App (ALLOW)', rmAuthAllowed.authorized === true, `Authorized: ${rmAuthAllowed.authorized}, PIN Required: ${rmAuthAllowed.requiresPin}`);
    record('Authorization', 'Owner-Approved Manager PIN is NOT forced without pinHash', rmAuthAllowed.requiresPin === false, `requiresPin: ${rmAuthAllowed.requiresPin}`);

    const rmAuthFranchiseDenied = await FranchiseAccessService.resolveAuthorization({
      uid: rmUid,
      email: rmEmail,
      targetApp: 'FRANCHISE_MANAGER'
    });
    record('Authorization', 'Restaurant Manager -> Franchise App (DENY)', rmAuthFranchiseDenied.authorized === false, `Denied as expected: ${!rmAuthFranchiseDenied.authorized}`);

    const rmAuthDeliveryDenied = await FranchiseAccessService.resolveAuthorization({
      uid: rmUid,
      email: rmEmail,
      targetApp: 'DELIVERY'
    });
    record('Authorization', 'Restaurant Manager -> Delivery App (DENY)', rmAuthDeliveryDenied.authorized === false, `Denied as expected: ${!rmAuthDeliveryDenied.authorized}`);

    // Test 3: Mock Owner-Approved POS Operator
    const posUid = 'test_pos_approved_' + Date.now();
    const posEmail = `cashier_${Date.now()}@olivepizza.in`;

    await adminDb.collection('users').doc(posUid).set({
      uid: posUid,
      email: posEmail,
      name: 'Approved POS Cashier',
      role: 'pos_operator',
      status: 'APPROVED',
      isActive: true,
      branchId: 'main_branch',
      franchiseId: 'fra_rajnandgaon',
      allowedApps: ['POS'],
      applicationAccess: { app_pos: true }
    });

    const posAuthAllowed = await FranchiseAccessService.resolveAuthorization({
      uid: posUid,
      email: posEmail,
      targetApp: 'POS'
    });
    record('Authorization', 'Owner-Approved POS -> POS App (ALLOW)', posAuthAllowed.authorized === true, `Authorized: ${posAuthAllowed.authorized}`);
    record('Authorization', 'POS fallback franchise & branch assigned', posAuthAllowed.user?.franchiseId === 'fra_rajnandgaon' && posAuthAllowed.user?.branchId === 'main_branch', `Franchise: ${posAuthAllowed.user?.franchiseId}, Branch: ${posAuthAllowed.user?.branchId}`);

    const posAuthRestaurantDenied = await FranchiseAccessService.resolveAuthorization({
      uid: posUid,
      email: posEmail,
      targetApp: 'RESTAURANT_MANAGER'
    });
    record('Authorization', 'POS Operator -> Restaurant Manager App (DENY)', posAuthRestaurantDenied.authorized === false, `Denied as expected: ${!posAuthRestaurantDenied.authorized}`);

    // Test 4: Mock Owner-Approved Delivery Partner
    const delUid = 'test_del_approved_' + Date.now();
    const delEmail = `rider_${Date.now()}@olivepizza.in`;

    await adminDb.collection('users').doc(delUid).set({
      uid: delUid,
      email: delEmail,
      name: 'Approved Delivery Partner',
      role: 'delivery_partner',
      status: 'APPROVED',
      isActive: true,
      branchId: 'main_branch',
      franchiseId: 'fra_rajnandgaon',
      allowedApps: ['DELIVERY'],
      applicationAccess: { app_delivery: true }
    });

    const delAuthAllowed = await FranchiseAccessService.resolveAuthorization({
      uid: delUid,
      email: delEmail,
      targetApp: 'DELIVERY'
    });
    record('Authorization', 'Owner-Approved Delivery -> Delivery App (ALLOW)', delAuthAllowed.authorized === true, `Authorized: ${delAuthAllowed.authorized}`);

    const delAuthPosDenied = await FranchiseAccessService.resolveAuthorization({
      uid: delUid,
      email: delEmail,
      targetApp: 'POS'
    });
    record('Authorization', 'Delivery Partner -> POS App (DENY)', delAuthPosDenied.authorized === false, `Denied as expected: ${!delAuthPosDenied.authorized}`);

    // Test 5: Revoked Account Check (Must be rejected across all apps)
    const revokedUid = 'test_revoked_' + Date.now();
    await adminDb.collection('users').doc(revokedUid).set({
      uid: revokedUid,
      email: `revoked_${Date.now()}@test.com`,
      role: 'restaurant_manager',
      status: 'REVOKED',
      isActive: false
    });

    const revokedAuth = await FranchiseAccessService.resolveAuthorization({
      uid: revokedUid,
      email: `revoked_${Date.now()}@test.com`,
      targetApp: 'RESTAURANT_MANAGER'
    });
    record('Authorization', 'Revoked Account Blocked from Login', revokedAuth.authorized === false && revokedAuth.code === 'ACCOUNT_DEACTIVATED', `Blocked: ${!revokedAuth.authorized}, Code: ${revokedAuth.code}`);

    // Cleanup test fixtures
    await adminDb.collection('users').doc(rmUid).delete().catch(() => {});
    await adminDb.collection('restaurant_managers').doc(rmUid).delete().catch(() => {});
    await adminDb.collection('users').doc(posUid).delete().catch(() => {});
    await adminDb.collection('pos_accounts').doc(posUid).delete().catch(() => {});
    await adminDb.collection('users').doc(delUid).delete().catch(() => {});
    await adminDb.collection('delivery_partners').doc(delUid).delete().catch(() => {});
    await adminDb.collection('users').doc(revokedUid).delete().catch(() => {});

  } catch (err: any) {
    record('Authorization', 'Authorization Matrix Execution', false, err.message);
  }

  // Summary
  console.log('\n====================================================');
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;
  console.log(`TOTAL: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All Authorization & Redis Verification Checks Succeeded! 🎉');
    process.exit(0);
  }
}

runTests();
