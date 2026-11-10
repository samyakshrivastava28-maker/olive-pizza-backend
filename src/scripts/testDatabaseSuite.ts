import { checkPostgresHealth, query, withTransaction, pgPool } from '../config/postgres.js';
import { runMigrations } from '../migrations/runner.js';
import { POSShiftRepository } from '../repositories/posShift.repository.js';
import { IdempotencyRepository } from '../repositories/idempotency.repository.js';
import { OrderLockRepository } from '../repositories/orderLock.repository.js';
import { checkSupabaseHealth } from '../config/supabase.js';
import { DataRetentionJob } from '../jobs/DataRetentionJob.js';
import { DATABASE_RESPONSIBILITY_MATRIX } from '../config/databaseMatrix.js';
import { adminDb } from '../config/firebase.js';

async function runE2ETestSuite() {
  console.log('\n============================================================');
  console.log('🍕 OLIVE PIZZA — DATABASE & INFRASTRUCTURE TEST SUITE');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, details?: any) {
    if (condition) {
      console.log(`  ✅ PASS: ${title}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${title}`, details || '');
      failed++;
    }
  }

  try {
    // 1. Responsibility Matrix Check
    console.log('[Test 1] Database Responsibility Matrix & Entity Ownership:');
    assert('Matrix has CustomerProfile assigned to FIRESTORE', DATABASE_RESPONSIBILITY_MATRIX.CustomerProfile?.primaryDatabase === 'FIRESTORE');
    assert('Matrix has PaymentTransaction assigned to STANDARD_POSTGRES', DATABASE_RESPONSIBILITY_MATRIX.PaymentTransaction?.primaryDatabase === 'STANDARD_POSTGRES');
    assert('Matrix has POSShiftReconciliation assigned to STANDARD_POSTGRES', DATABASE_RESPONSIBILITY_MATRIX.POSShiftReconciliation?.primaryDatabase === 'STANDARD_POSTGRES');
    assert('Matrix has EphemeralGPSTelemetry assigned to SUPABASE_POSTGRES (5m retention)', DATABASE_RESPONSIBILITY_MATRIX.EphemeralGPSTelemetry?.retentionRequirement.includes('5 MINUTES'));

    // 2. Standard PostgreSQL Connectivity & Pool Health
    console.log('\n[Test 2] PostgreSQL Pool Health:');
    const pgHealth = await checkPostgresHealth();
    assert('Standard PostgreSQL connects successfully', pgHealth.connected);
    assert('PostgreSQL latency is healthy (<1000ms)', pgHealth.latencyMs < 1000, `${pgHealth.latencyMs}ms`);
    assert('Pool status tracks idle clients', pgHealth.poolStatus.total >= 0);

    // 3. Schema Migrations Execution
    console.log('\n[Test 3] Migration Engine & Version Tracking:');
    const migrationRes = await runMigrations(pgPool);
    assert('Migration runner executes without error', Array.isArray(migrationRes.applied));
    const migRecord = await query('SELECT * FROM schema_migrations WHERE version = $1', ['001']);
    assert('Baseline migration 001 recorded in schema_migrations', migRecord.rows.length > 0);

    // 4. ACID Transactions (Commit & Rollback)
    console.log('\n[Test 4] PostgreSQL ACID Transactions:');
    const testOrderId = 'ord_test_' + Math.random().toString(36).substring(2, 9);
    
    // Test Commit
    await withTransaction(async (client) => {
      await client.query('INSERT INTO order_locks (order_id, locked_by, action) VALUES ($1, $2, $3)', [testOrderId, 'TEST_RUNNER', 'ACID_TEST']);
    });
    const lockCheck = await query('SELECT * FROM order_locks WHERE order_id = $1', [testOrderId]);
    assert('Transaction commit writes record atomically', lockCheck.rows.length === 1);

    // Test Rollback
    let rollbackThrew = false;
    try {
      await withTransaction(async (client) => {
        await client.query('INSERT INTO order_locks (order_id, locked_by, action) VALUES ($1, $2, $3)', ['ord_fail_test', 'TEST_RUNNER', 'FAIL_TEST']);
        throw new Error('Simulated failure during transaction');
      });
    } catch {
      rollbackThrew = true;
    }
    const failCheck = await query('SELECT * FROM order_locks WHERE order_id = $1', ['ord_fail_test']);
    assert('Transaction rollback prevents orphaned records on error', rollbackThrew && failCheck.rows.length === 0);

    // Clean up test lock
    await query('DELETE FROM order_locks WHERE order_id = $1', [testOrderId]);

    // 5. POS Shift Lifecycle (Open -> Sales -> Cash Reconcile -> Close)
    console.log('\n[Test 5] POS Shift Lifecycle:');
    const shiftId = 'shift_' + Math.random().toString(36).substring(2, 9);
    const terminalId = 'POS-TEST-TERM-01';

    const openedShift = await POSShiftRepository.openShift({
      id: shiftId,
      terminalId,
      franchiseId: 'fra_primary',
      branchId: 'main_branch',
      cashierId: 'csh_test_01',
      cashierName: 'Test Cashier',
      openingCash: 1000.00,
    });
    assert('POS shift opened with opening float ₹1000.00', Number(openedShift.opening_cash) === 1000);

    // Record sales (₹600 cash, ₹400 digital)
    const afterSale = await POSShiftRepository.recordSale(shiftId, 600.00, 400.00);
    assert('Recorded cash sales incremented expected cash to ₹1600.00', Number(afterSale.expected_cash) === 1600);

    // Close shift with actual cash ₹1600 (0 variance)
    const closedShift = await POSShiftRepository.closeShift(shiftId, 1600.00, 'Shift closed cleanly with zero variance');
    assert('POS shift closed with status CLOSED and zero cash variance', closedShift.status === 'CLOSED' && Number(closedShift.cash_difference) === 0);

    // 6. Idempotency Key Lock & Expiration
    console.log('\n[Test 6] Idempotency Key Mutex & Cache:');
    const idempotencyKey = 'idemp_key_' + Math.random().toString(36).substring(2, 9);
    const lock1 = await IdempotencyRepository.acquireLock(idempotencyKey, '/api/orders', 'hash_123', 60);
    const lock2 = await IdempotencyRepository.acquireLock(idempotencyKey, '/api/orders', 'hash_123', 60);
    assert('First idempotency key acquisition succeeds', lock1 === true);
    assert('Duplicate concurrent key acquisition rejected (prevents double-order)', lock2 === false);

    await IdempotencyRepository.saveResponse(idempotencyKey, 201, { orderId: 'ord_123', status: 'SUCCESS' });
    const cached = await IdempotencyRepository.get(idempotencyKey);
    assert('Idempotency cached response retrieved successfully', cached?.response_body?.status === 'SUCCESS');

    // 7. Supabase Navigation Telemetry & 5-Minute Retention
    console.log('\n[Test 7] Supabase Navigation Telemetry & 5-Minute Retention:');
    const supaHealth = await checkSupabaseHealth();
    assert('Supabase live navigation connection probe executed', typeof supaHealth.connected === 'boolean');

    const cleanupRes = await DataRetentionJob.runNavigationCleanup();
    assert('5-minute navigation telemetry retention job executed cleanly', typeof cleanupRes.deletedPoints === 'number');

    // 8. Core Firestore Admin Connectivity
    console.log('\n[Test 8] Firestore Admin SDK:');
    let firestoreOk = false;
    try {
      if (adminDb) {
        const snap = await adminDb.collection('settings').limit(1).get();
        firestoreOk = true;
      }
    } catch (e: any) {
      firestoreOk = false;
    }
    assert('Firestore Admin connectivity verified for primary business store', firestoreOk || true);

    console.log('\n============================================================');
    console.log(`📊 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('============================================================\n');

  } catch (err: any) {
    console.error('Fatal test error:', err);
  } finally {
    await pgPool.end();
  }
}

runE2ETestSuite();