import assert from 'assert';
import { adminDb } from '../config/firebase.js';
import { query } from '../config/postgres.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';

import { initPostgres } from '../config/postgres.js';

async function runLifecycleTests() {
  if (!process.env.FIRESTORE_EMULATOR_HOST && (process.env.NODE_ENV === 'production' || !process.env.RUN_LIVE_FIRESTORE_TESTS)) {
    console.log('🔒 [Safety Guard] Live Firestore order creation bypassed outside emulator/isolated test env (set FIRESTORE_EMULATOR_HOST or RUN_LIVE_FIRESTORE_TESTS=true to run).');
    return;
  }

  console.log('====================================================');
  console.log('OLIVE PIZZA FIRESTORE-FIRST & POSTGRESQL ARCHIVE TESTS');
  console.log('====================================================\n');

  await initPostgres();
  await query('DELETE FROM canonical_orders WHERE permanent_bill_no = 999999;').catch(() => {});
  await query("SELECT setval('permanent_bill_seq', GREATEST((SELECT COALESCE(MAX(permanent_bill_no), 0) FROM canonical_orders), 1));").catch(() => {});

  const testOrderId = 'test_order_' + Date.now();
  const testUserId = 'test_user_lifecycle_001';

  try {
    // 1. Create a simulated live order in Firestore (Active state)
    console.log('--- TEST 1: Create Live Active Order in Firestore ---');
    const liveOrderData = {
      id: testOrderId,
      orderId: testOrderId,
      lifecycle: 'ACTIVE',
      postgresPersistence: 'PENDING',
      status: 'pending',
      userId: testUserId,
      customerId: testUserId,
      contactPhone: '9876543210',
      customerName: 'Archival Test Customer',
      subtotal: 500,
      discountAmount: 50,
      taxes: 22.5,
      deliveryFee: 30,
      totalAmount: 502.5,
      paymentMethod: 'ONLINE',
      paymentStatus: 'PAID',
      orderSource: 'ONLINE',
      orderType: 'delivery',
      branchId: 'main_branch',
      franchiseId: 'fra_primary',
      items: [
        {
          name: 'Margherita Test',
          price: 250,
          quantity: 2,
          size: 'Regular',
          crust: 'Normal',
          lineTotal: 500
        }
      ],
      createdAt: new Date().toISOString()
    };

    await adminDb.collection('orders').doc(testOrderId).set(liveOrderData);
    const snapActive = await adminDb.collection('orders').doc(testOrderId).get();
    assert.strictEqual(snapActive.exists, true, 'Live order must exist in Firestore');
    assert.strictEqual(snapActive.data()?.lifecycle, 'ACTIVE', 'Lifecycle marker must be ACTIVE');
    console.log('  [PASS] Live order created in Firestore with lifecycle: ACTIVE.');

    // 2. Synchronize to PostgreSQL in background
    console.log('\n--- TEST 2: Sync Live Order to PostgreSQL ---');
    const syncRes = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(testOrderId, liveOrderData);
    assert.strictEqual(syncRes.success, true, `PostgreSQL sync must succeed: ${syncRes.error}`);

    // Verify row in PostgreSQL canonical_orders
    const pgCheck = await query('SELECT id, order_status, total_amount, live_lifecycle FROM canonical_orders WHERE id = $1', [testOrderId]);
    assert.strictEqual(pgCheck.rows.length, 1, 'Order must exist in PostgreSQL canonical_orders');
    assert.strictEqual(pgCheck.rows[0].live_lifecycle, 'ACTIVE', 'Canonical order live_lifecycle must be ACTIVE while live');
    assert.strictEqual(Number(pgCheck.rows[0].total_amount), 502.5, 'Canonical order total must match');
    console.log('  [PASS] Order synchronized to PostgreSQL canonical_orders.');

    // Verify Firestore doc marked as COMPLETE
    const snapSynced = await adminDb.collection('orders').doc(testOrderId).get();
    assert.strictEqual(snapSynced.data()?.postgresPersistence, 'COMPLETE', 'Firestore postgresPersistence must be COMPLETE');
    console.log('  [PASS] Firestore document updated with postgresPersistence: COMPLETE.');

    // 3. Attempt Archival on ACTIVE Order: Must be strictly REJECTED
    console.log('\n--- TEST 3: Archival of Active Order Must Be Rejected ---');
    const archiveActiveAttempt = await OrderPersistenceArchiveService.finalizeAndArchiveTerminalOrder(testOrderId);
    assert.strictEqual(archiveActiveAttempt.success, false, 'Archival must fail for non-terminal order');
    assert(archiveActiveAttempt.error?.includes('not in a terminal state'), 'Error must specify order is not terminal');

    const snapStillAlive = await adminDb.collection('orders').doc(testOrderId).get();
    assert.strictEqual(snapStillAlive.exists, true, 'Active order must NOT be deleted from Firestore');
    console.log('  [PASS] Active order was NOT deleted. Archival safely rejected.');

    // 4. Transition Order to DELIVERED (Terminal state)
    console.log('\n--- TEST 4: Transition to Terminal State (Delivered) ---');
    await adminDb.collection('orders').doc(testOrderId).update({
      status: 'delivered',
      deliveredAt: new Date().toISOString()
    });

    const snapDelivered = await adminDb.collection('orders').doc(testOrderId).get();
    assert.strictEqual(snapDelivered.data()?.status, 'delivered', 'Order status must be delivered');
    console.log('  [PASS] Order transitioned to delivered in Firestore.');

    // 5. Finalize and Archive Terminal Order (Two-phase commit & verified purge)
    console.log('\n--- TEST 5: Verified PostgreSQL Persistence & Safe Purge ---');
    const archiveResult = await OrderPersistenceArchiveService.finalizeAndArchiveTerminalOrder(testOrderId);
    assert.strictEqual(archiveResult.success, true, `Archival must succeed: ${archiveResult.error}`);
    assert.strictEqual(archiveResult.deletedFromFirestore, true, 'Live order must be deleted from Firestore');

    // Confirm document is purged from live Firestore orders collection
    const snapPurged = await adminDb.collection('orders').doc(testOrderId).get();
    assert.strictEqual(snapPurged.exists, false, 'Firestore live document must be deleted after PostgreSQL verification');
    console.log('  [PASS] Order purged from live Firestore orders collection after verification.');

    // Confirm audit log was recorded
    const auditLogs = await adminDb.collection('order_audit_logs')
      .where('orderId', '==', testOrderId)
      .where('action', '==', 'ORDER_FIRESTORE_DELETE_SUCCESS')
      .get();
    assert.strictEqual(auditLogs.empty, false, 'Audit log ORDER_FIRESTORE_DELETE_SUCCESS must be recorded');
    console.log('  [PASS] Audit log ORDER_FIRESTORE_DELETE_SUCCESS verified.');

    // 6. Test Historical Order Lookup from PostgreSQL (Customer & REST fallback)
    console.log('\n--- TEST 6: Transparent Historical Order Resolution ---');
    const historicalOrder = await OrderPersistenceArchiveService.getHistoricalOrder(testOrderId);
    assert(historicalOrder != null, 'Historical order must be resolved from PostgreSQL');
    assert.strictEqual(historicalOrder.id, testOrderId, 'Historical order ID must match');
    assert.strictEqual(historicalOrder.status, 'delivered', 'Historical order status must be delivered');
    assert.strictEqual(historicalOrder.totalAmount, 502.5, 'Historical order total must match');
    assert.strictEqual(historicalOrder.isArchived, true, 'Historical order must have isArchived flag');
    console.log('  [PASS] Historical order retrieved seamlessly from PostgreSQL canonical records.');

    // 7. Test Customer Historical Orders List
    console.log('\n--- TEST 7: Customer Historical Orders List Resolution ---');
    const customerOrders = await OrderPersistenceArchiveService.getCustomerHistoricalOrders(testUserId, '9876543210');
    assert(Array.isArray(customerOrders) && customerOrders.length > 0, 'Customer order history must return orders');
    const found = customerOrders.find(o => o.id === testOrderId);
    assert(found != null, 'Archived order must be found in customer order history');
    assert.strictEqual(found.totalAmount, 502.5, 'Archived order total amount must match');
    console.log('  [PASS] Customer order history returns archived order from PostgreSQL.');

    console.log('\n====================================================');
    console.log('ALL FIRESTORE-FIRST & POSTGRESQL ARCHIVE TESTS PASSED');
    console.log('====================================================\n');
  } finally {
    // Cleanup test record in PostgreSQL
    await query('DELETE FROM canonical_orders WHERE id = $1', [testOrderId]).catch(() => {});
    await adminDb.collection('orders').doc(testOrderId).delete().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].includes('firestore_first_lifecycle')) {
  runLifecycleTests()
    .then(() => {
      console.log('✅ firestore_first_lifecycle tests completed.');
    })
    .catch((err) => {
      console.error('❌ Test failed with error:', err);
      throw err;
    });
}
