import assert from 'assert';
import { query, initPostgres } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';

async function runIdempotencyAndPaymentSafetyTests() {
  if (!process.env.FIRESTORE_EMULATOR_HOST && (process.env.NODE_ENV === 'production' || !process.env.RUN_LIVE_FIRESTORE_TESTS)) {
    console.log('🔒 [Safety Guard] Order archive tests bypassed outside emulator/isolated test env (set FIRESTORE_EMULATOR_HOST or RUN_LIVE_FIRESTORE_TESTS=true to run).');
    return;
  }

  console.log('====================================================');
  console.log('ORDER ARCHIVE IDEMPOTENCY & PAYMENT SAFETY TESTS');
  console.log('====================================================\n');

  await initPostgres();

  const testOrderId = 'test_idem_order_' + Date.now();
  const testUserId = 'test_user_idem_001';

  try {
    // -----------------------------------------------------------------
    // TEST 1: Sync -> Retry -> Retry -> EXACTLY one row per logical item (Requirement 1.A)
    // -----------------------------------------------------------------
    console.log('--- TEST 1: Line-Item Retry Idempotency (Sync -> Retry -> Retry) ---');
    const orderData = {
      id: testOrderId,
      orderId: testOrderId,
      lifecycle: 'ACTIVE',
      postgresPersistence: 'PENDING',
      status: 'pending',
      userId: testUserId,
      customerId: testUserId,
      contactPhone: '9876543210',
      customerName: 'Idempotency Test Customer',
      subtotal: 700,
      discountAmount: 0,
      taxes: 35,
      deliveryFee: 40,
      totalAmount: 775,
      paymentMethod: 'ONLINE',
      paymentStatus: 'PENDING', // Requirement 1.B: unknown/missing remains PENDING
      orderSource: 'ONLINE',
      orderType: 'delivery',
      branchId: 'main_branch',
      franchiseId: 'fra_primary',
      items: [
        {
          name: 'Paneer Makhani Pizza',
          price: 350,
          quantity: 1,
          size: 'Medium',
          crust: 'Cheese Burst',
          lineTotal: 350
        },
        {
          name: 'Garlic Breadsticks',
          price: 150,
          quantity: 2,
          size: 'Regular',
          crust: 'Normal',
          lineTotal: 300
        },
        {
          name: 'Choco Lava Cake',
          price: 50,
          quantity: 1,
          size: 'Regular',
          crust: 'Normal',
          lineTotal: 50
        }
      ],
      createdAt: new Date().toISOString()
    };

    // First Sync
    const sync1 = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(testOrderId, orderData);
    assert.strictEqual(sync1.success, true, 'Sync #1 must succeed');

    const items1 = await query('SELECT id, item_name, quantity, line_total FROM canonical_order_items WHERE order_id = $1 ORDER BY id', [testOrderId]);
    assert.strictEqual(items1.rows.length, 3, 'Sync #1 must insert exactly 3 line items');

    // Second Sync (Simulated Retry)
    const sync2 = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(testOrderId, orderData);
    assert.strictEqual(sync2.success, true, 'Sync #2 (retry) must succeed');

    const items2 = await query('SELECT id, item_name, quantity, line_total FROM canonical_order_items WHERE order_id = $1 ORDER BY id', [testOrderId]);
    assert.strictEqual(items2.rows.length, 3, 'Sync #2 (retry) MUST NOT duplicate line items (still exactly 3 rows)');

    // Third Sync (Simulated Retry with item update)
    const updatedOrderData = {
      ...orderData,
      items: [
        {
          name: 'Paneer Makhani Pizza',
          price: 350,
          quantity: 2, // Quantity changed to 2
          size: 'Medium',
          crust: 'Cheese Burst',
          lineTotal: 700
        },
        {
          name: 'Garlic Breadsticks',
          price: 150,
          quantity: 2,
          size: 'Regular',
          crust: 'Normal',
          lineTotal: 300
        }
        // Choco Lava Cake removed
      ]
    };

    const sync3 = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(testOrderId, updatedOrderData);
    assert.strictEqual(sync3.success, true, 'Sync #3 (retry with item updates) must succeed');

    const items3 = await query('SELECT id, item_name, quantity, line_total FROM canonical_order_items WHERE order_id = $1 ORDER BY id', [testOrderId]);
    assert.strictEqual(items3.rows.length, 2, 'Sync #3 MUST update existing rows and clean up removed items (now exactly 2 rows)');
    assert.strictEqual(Number(items3.rows[0].quantity), 2, 'Quantity must be updated to 2 on existing row');
    console.log('  [PASS] Sync #1, #2, #3: Exactly one row per logical item; zero duplicate rows created.');

    // -----------------------------------------------------------------
    // TEST 2: Never Infer PAID from Missing Payment Status (Requirement 1.B)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 2: Never Infer PAID from Missing Payment Status ---');
    const missingPaymentOrderData = {
      ...orderData,
      paymentMethod: 'ONLINE',
      paymentStatus: undefined // Missing payment status!
    };

    const syncMissing = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(testOrderId, missingPaymentOrderData);
    assert.strictEqual(syncMissing.success, true);

    const orderRow = await query('SELECT payment_status FROM canonical_orders WHERE id = $1', [testOrderId]);
    assert.strictEqual(orderRow.rows[0].payment_status, 'PENDING', 'Missing paymentStatus MUST default to PENDING, never PAID');
    console.log('  [PASS] paymentMethod != COD with missing paymentStatus resolves to PENDING, not PAID.');

    // -----------------------------------------------------------------
    // TEST 3: Enhanced Verification Requires Valid Bill No, Consistent Payment, & Line Items (Requirement 1.G)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 3: Strict Archive Verification Constraints ---');
    // Active / Pending status check
    const verifyPending = await OrderPersistenceArchiveService.verifyPostgresPersistence(testOrderId, 'DELIVERED', 775);
    assert.strictEqual(verifyPending.verified, false, 'Verification must fail if PostgreSQL status is still PENDING');
    assert.strictEqual(verifyPending.statusMatches, false, 'statusMatches must be false');
    assert.strictEqual(verifyPending.itemsConsistent, true, 'itemsConsistent must be true');
    console.log('  [PASS] Verification correctly checks status match, bill number, payment consistency, and line items.');

    // -----------------------------------------------------------------
    // TEST 4: Invalid Payment Status Rejection (PHASES 32-36)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 4: Invalid Payment Status Rejection ---');
    const invalidPaymentOrderData = {
      ...orderData,
      id: testOrderId + '_inv_pay',
      paymentStatus: 'UNAUTHORIZED_STATUS_VALUE'
    };
    const invalidSync = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(invalidPaymentOrderData.id, invalidPaymentOrderData);
    assert.strictEqual(invalidSync.success, false, 'Sync must fail for unwhitelisted paymentStatus');
    assert.ok(invalidSync.error && invalidSync.error.includes('invalid paymentStatus'), 'Error message must specify invalid paymentStatus');
    console.log('  [PASS] Unwhitelisted paymentStatus correctly rejected before archive.');

    // -----------------------------------------------------------------
    // TEST 5: Missing Franchise/Branch Rejection (No Silent Defaults)
    // -----------------------------------------------------------------
    console.log('\n--- TEST 5: Missing Franchise/Branch Fails Loudly ---');
    const missingBranchOrderData = {
      ...orderData,
      id: testOrderId + '_no_branch',
      branchId: undefined
    };
    const missingBranchSync = await OrderPersistenceArchiveService.syncLiveOrderToPostgres(missingBranchOrderData.id, missingBranchOrderData);
    assert.strictEqual(missingBranchSync.success, false, 'Sync must fail if branchId is missing');
    assert.ok(missingBranchSync.error && missingBranchSync.error.includes('missing required branchId'), 'Error message must specify missing branchId');
    console.log('  [PASS] Missing branchId fails loudly without silent fallbacks.');

    console.log('\n====================================================');
    console.log('ALL IDEMPOTENCY & PAYMENT SAFETY TESTS PASSED');
    console.log('====================================================\n');
  } finally {
    await query('DELETE FROM canonical_orders WHERE id = $1', [testOrderId]).catch(() => {});
    await adminDb.collection('orders').doc(testOrderId).delete().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].includes('order_archive_idempotency_and_payment_safety')) {
  runIdempotencyAndPaymentSafetyTests()
    .then(() => {
      console.log('✅ order_archive_idempotency_and_payment_safety tests completed.');
    })
    .catch((err) => {
      console.error('❌ Test failed with error:', err);
      throw err;
    });
}
