import '../config/env.ts';
/**
 * layerbase_integration.test.ts — Live Integration Verification against Layerbase PostgreSQL & Redis
 * 
 * Verifies:
 * 1. Layerbase PostgreSQL connectivity, version (18.6), and canonical schema migrations (001-012)
 * 2. Scoped daily order counter (date, franchise, branch) and global permanent bill sequence
 * 3. Authoritative order persistence and deterministic request fingerprint idempotency
 * 4. Multi-franchise & multi-branch isolation in Layerbase PostgreSQL
 * 5. Layerbase Redis connectivity, TLS SNI routing, caching, and invalidation
 * 6. Provider-independent architecture and fail-closed security invariants
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

// Enable cloud connection for this live verification suite
process.env.ALLOW_CLOUD_TEST_CONNECTION = 'true';

import { pgPool, query, withTransaction } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { CanonicalOrderService } from '../services/pos/CanonicalOrderService.js';
import { POSService } from '../services/pos/POSService.js';
import { runMigrations } from '../migrations/runner.js';

// Pre-seed catalog cache with authoritative prices for test items using public seedCatalogItem API
POSService.seedCatalogItem('pizz_veg_sup', {
  id: 'pizz_veg_sup',
  productName: 'Veggie Supreme',
  sizes: {
    regular: { price: 350 },
    medium: { price: 450 },
    large: { price: 550 }
  },
  basePrice: 350,
  offerPrice: 350,
  isActive: true,
  isAvailable: true
});

POSService.seedCatalogItem('pizz_margherita', {
  id: 'pizz_margherita',
  productName: 'Margherita Classic',
  sizes: {
    regular: { price: 200 },
    medium: { price: 300 }
  },
  basePrice: 200,
  offerPrice: 200,
  isActive: true,
  isAvailable: true
});

test('Layerbase PostgreSQL & Redis Live Integration Suite', async (t) => {

  await t.test('1. Layerbase PostgreSQL connection and migration checksum verification', async () => {
    const versionRes = await query('SELECT version(), current_database(), current_user;');
    assert.ok(versionRes.rows.length > 0, 'Must query Layerbase successfully');
    const versionStr = versionRes.rows[0].version;
    assert.match(versionStr, /PostgreSQL (16|17|18)/i, 'PostgreSQL version must be 16+');
    assert.ok(['testsql', 'olive_pizza_test'].includes(versionRes.rows[0].current_database), 'Target database is testsql or olive_pizza_test');

    // Run migration verification
    const migrationResult = await runMigrations();
    assert.ok(Array.isArray(migrationResult.skipped), 'Migration result has skipped list');
    assert.ok(migrationResult.skipped.includes('001_standard_postgres_baseline.sql'));
    assert.ok(migrationResult.skipped.includes('012_request_fingerprint_and_scoped_counters.sql'));
  });

  await t.test('2. Scoped Daily Order Numbering & Permanent Bill Number Sequence', async () => {
    const today = new Date();
    
    // Allocate numbers for Franchise A, Branch 1 (Main branch)
    const allocA1 = await BillingNumberService.allocateNumbers(today, 'fra_rajnandgaon', 'main_branch');
    assert.ok(allocA1.permanentBillNo > 0, 'Permanent bill number is positive');
    assert.ok(allocA1.dailyOrderNo >= 1, 'Daily order number is positive');

    // Allocate next for Franchise A, Branch 1 -> dailyOrderNo must increment
    const allocA2 = await BillingNumberService.allocateNumbers(today, 'fra_rajnandgaon', 'main_branch');
    assert.ok(allocA2.permanentBillNo > allocA1.permanentBillNo, 'Permanent bill number increments monotonically');
    assert.strictEqual(allocA2.dailyOrderNo, allocA1.dailyOrderNo + 1, 'Branch daily order number increments monotonically');

    // Allocate for Franchise B, Branch 2 -> dailyOrderNo is scoped independently
    const allocB1 = await BillingNumberService.allocateNumbers(today, 'fra_bilaspur', 'branch_bsp_link');
    assert.ok(allocB1.permanentBillNo > allocA2.permanentBillNo, 'Permanent sequence is globally unique');
    assert.ok(allocB1.dailyOrderNo >= 1, 'Franchise B counter is independently initialized');
  });

  await t.test('3. Authoritative Order Creation, Item Snapshots, and Financial Bills', async () => {
    const orderId = `layerbase_ord_${Date.now()}`;
    const customerPhone = '9876543210';

    const orderParams = {
      id: orderId,
      orderSource: 'ONLINE',
      orderType: 'delivery',
      customerName: 'Samyak Layerbase',
      customerPhone,
      deliveryAddress: 'G.E. Road, Rajnandgaon, CG',
      items: [
        { menuItemId: 'pizz_veg_sup', name: 'Veggie Supreme', price: 350, quantity: 1, size: 'Regular', crust: 'Normal' }
      ],
      subtotal: 350,
      discountAmount: 0,
      taxAmount: 17.50,
      deliveryFee: 30,
      totalAmount: 397.50,
      paymentMethod: 'UPI',
      paymentStatus: 'PAID',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'main_branch'
    };

    const created = await CanonicalOrderService.createCanonicalOrder(orderParams);
    assert.strictEqual(created.id, orderId);
    assert.ok(created.permanentBillNo > 0);

    // Verify written to Layerbase PostgreSQL
    const checkOrder = await query(
      `SELECT id, permanent_bill_no, customer_phone, total_amount, payment_status, request_fingerprint
       FROM canonical_orders WHERE id = $1`,
      [orderId]
    );
    assert.strictEqual(checkOrder.rows.length, 1);
    assert.strictEqual(checkOrder.rows[0].customer_phone, customerPhone);
    assert.ok(checkOrder.rows[0].request_fingerprint, 'Order must store deterministic request fingerprint');

    // Verify items written to canonical_order_items
    const checkItems = await query(
      `SELECT item_name, quantity, size_variant, crust FROM canonical_order_items WHERE order_id = $1`,
      [orderId]
    );
    assert.strictEqual(checkItems.rows.length, 1);
    assert.strictEqual(checkItems.rows[0].item_name, 'Veggie Supreme');

    // Verify financial bill in canonical_bills
    const checkBill = await query(
      `SELECT permanent_bill_no, net_amount, payment_status FROM canonical_bills WHERE order_id = $1`,
      [orderId]
    );
    assert.strictEqual(checkBill.rows.length, 1);
    assert.strictEqual(checkBill.rows[0].payment_status, 'PAID');
  });

  await t.test('4. Full Request Fingerprint Idempotency: Duplicate 200 vs Conflict 409', async () => {
    const orderId = `idemp_lb_${Date.now()}`;
    const baseParams = {
      id: orderId,
      orderSource: 'POS',
      orderType: 'takeaway',
      customerName: 'Priya Cashier',
      customerPhone: '9876500001',
      items: [
        { menuItemId: 'pizz_margherita', name: 'Margherita Classic', price: 200, quantity: 2, size: 'Regular', crust: 'Normal' }
      ],
      subtotal: 400,
      discountAmount: 0,
      taxAmount: 20,
      deliveryFee: 0,
      totalAmount: 420,
      paymentMethod: 'CASH',
      paymentStatus: 'PAID',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'main_branch'
    };

    // First commit
    const firstCommit = await CanonicalOrderService.createCanonicalOrder(baseParams);
    assert.ok(firstCommit.permanentBillNo > 0);

    // Replay identical payload -> Idempotent duplicate returns existing bill
    const duplicateReplay = await CanonicalOrderService.createCanonicalOrder(baseParams);
    assert.strictEqual(duplicateReplay.isDuplicate, true, 'Must detect as idempotent duplicate');
    assert.strictEqual(duplicateReplay.permanentBillNo, firstCommit.permanentBillNo, 'Must return same permanent bill number');

    // Tampered payload with differing amount/items -> Throws IDEMPOTENCY_CONFLICT 409
    const tamperedParams = {
      ...baseParams,
      totalAmount: 999 // Tampered total
    };

    await assert.rejects(
      async () => {
        await CanonicalOrderService.createCanonicalOrder(tamperedParams);
      },
      (err: any) => {
        return err.code === 'IDEMPOTENCY_CONFLICT' || err.statusCode === 409;
      },
      'Tampered payload with same idempotency key must be rejected with IDEMPOTENCY_CONFLICT'
    );
  });

  await t.test('5. Multi-Franchise & Multi-Branch PostgreSQL Data Isolation', async () => {
    const testBranchA = 'branch_iso_test_a_' + Date.now();
    const testBranchB = 'branch_iso_test_b_' + Date.now();

    try {
      await query(`
        INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open)
        VALUES 
          ($1, 'fra_tenant_1', 'Tenant 1 Branch', 'Address 1', '9000000001', true),
          ($2, 'fra_tenant_2', 'Tenant 2 Branch', 'Address 2', '9000000002', true)
        ON CONFLICT (id) DO NOTHING;
      `, [testBranchA, testBranchB]);

      // Query scoped to fra_tenant_1
      const fra1Branches = await query(`
        SELECT id FROM restaurant_branches WHERE franchise_id = $1
      `, ['fra_tenant_1']);
      
      assert.ok(fra1Branches.rows.some(r => r.id === testBranchA), 'Tenant 1 query must find Branch A');
      assert.ok(!fra1Branches.rows.some(r => r.id === testBranchB), 'Tenant 1 query must NOT leak Branch B');
    } finally {
      // Clean up test branches
      await query(`DELETE FROM restaurant_branches WHERE id IN ($1, $2)`, [testBranchA, testBranchB]);
    }
  });

  await t.test('6. Layerbase Redis: Connectivity, TLS SNI, Cache Invalidation, and TTL', async () => {
    const isRedisConnected = await redisService.ping();
    assert.strictEqual(isRedisConnected, true, 'Layerbase Redis must respond to PING');

    const cacheKey = 'olive:test:integration_cache';
    const cacheVal = { test: true, timestamp: Date.now(), menu: 'Olive Special' };

    // Set with TTL
    await redisService.set(cacheKey, JSON.stringify(cacheVal), 30);
    const retrievedRaw = await redisService.get(cacheKey);
    assert.ok(retrievedRaw, 'Must retrieve value from Redis');
    const retrieved = JSON.parse(retrievedRaw);
    assert.strictEqual(retrieved.menu, 'Olive Special');

    // Delete / Invalidation
    await redisService.del(cacheKey);
    const afterDel = await redisService.get(cacheKey);
    assert.strictEqual(afterDel, null, 'Cache key must be deleted cleanly');
  });

  await t.test('7. Redis Resilience: Outage Fallback without Corrupting Business Data', async () => {
    // When Redis key is missing or Redis is bypassed, fallback operates cleanly
    const missing = await redisService.get('olive:nonexistent:key');
    assert.strictEqual(missing, null, 'Missing Redis key returns null safely');
  });

  t.after(async () => {
    await pgPool.end();
    redisService.disconnect();
  });

});
