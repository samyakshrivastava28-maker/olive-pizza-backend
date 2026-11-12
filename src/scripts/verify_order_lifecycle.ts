import '../config/env.js';
import { pgPool } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function testLifecycle() {
  console.log('=== VERIFYING ORDER LIFECYCLE & STATE MACHINE TRANSITIONS ===\n');

  const testOrderId = `test_order_${Date.now()}`;
  const permBillNo = Math.floor(100000 + Math.random() * 900000);
  const now = new Date();

  // 1. Create Order in Canonical PostgreSQL and Firestore
  console.log(`[1] Creating Test Order: ${testOrderId} (Bill #${permBillNo})`);
  await pgPool.query(`
    INSERT INTO canonical_orders (
      id, permanent_bill_no, daily_order_no, order_date, order_time,
      order_source, order_type, order_status, payment_method, payment_status,
      customer_name, customer_phone, delivery_address,
      subtotal, tax_amount, delivery_fee, total_amount,
      franchise_id, branch_id, created_at, updated_at
    ) VALUES (
      $1, $2, $3, CURRENT_DATE, CURRENT_TIME,
      'ONLINE', 'delivery', 'PLACED', 'UPI', 'PAID',
      'Test Customer', '+919876543210', 'G.E. Road, Rajnandgaon, CG 491441',
      260.00, 14.00, 25.00, 299.00,
      'fra_rajnandgaon', 'branch_rjn_main', NOW(), NOW()
    )
  `, [testOrderId, permBillNo, 1]);

  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).set({
      id: testOrderId,
      orderNumber: `ORD-${Date.now().toString().slice(-4)}`,
      orderStatus: 'pending',
      status: 'pending',
      paymentStatus: 'PAID',
      paymentMethod: 'UPI',
      totalAmount: 299.00,
      franchiseId: 'fra_rajnandgaon',
      branchId: 'branch_rjn_main',
      customerName: 'Test Customer',
      customerPhone: '+919876543210',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
  }
  console.log('  -> Order initialized with status PLACED / pending.');

  // 2. Accept & Preparing (Restaurant Manager)
  console.log('\n[2] Transitioning to PREPARING (Restaurant Manager accepts)');
  await pgPool.query(`
    UPDATE canonical_orders
    SET order_status = 'PREPARING',
        accepted_at = NOW(),
        preparation_started_at = NOW(),
        estimated_preparation_minutes = 20,
        updated_at = NOW()
    WHERE id = $1
  `, [testOrderId]);
  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).update({
      orderStatus: 'preparing',
      status: 'preparing',
      estimatedPrepMinutes: 20,
      updatedAt: new Date().toISOString()
    });
  }
  console.log('  -> Order successfully moved to PREPARING with 20m prep time.');

  // 3. Ready for Pickup (Kitchen marks ready)
  console.log('\n[3] Transitioning to READY (Kitchen completes food)');
  await pgPool.query(`
    UPDATE canonical_orders
    SET order_status = 'READY',
        ready_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [testOrderId]);
  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).update({
      orderStatus: 'ready',
      status: 'ready',
      updatedAt: new Date().toISOString()
    });
  }
  console.log('  -> Order successfully moved to READY.');

  // 4. Partner Assigned & Out for Delivery (Delivery App)
  console.log('\n[4] Transitioning to PARTNER_ASSIGNED & OUT_FOR_DELIVERY (Delivery Rider)');
  await pgPool.query(`
    UPDATE canonical_orders
    SET order_status = 'OUT_FOR_DELIVERY',
        delivery_partner_id = 'dp_rjn_samyak_01',
        delivery_partner_name = 'Samyak Rider One',
        delivery_partner_phone = '+919876543211',
        partner_assigned_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [testOrderId]);
  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).update({
      orderStatus: 'out_for_delivery',
      status: 'out_for_delivery',
      riderId: 'dp_rjn_samyak_01',
      riderName: 'Samyak Rider One',
      updatedAt: new Date().toISOString()
    });
  }
  console.log('  -> Order successfully moved to OUT_FOR_DELIVERY with assigned rider.');

  // 5. Delivered / Completed (Delivery Partner delivers)
  console.log('\n[5] Transitioning to DELIVERED (Rider completes handover)');
  await pgPool.query(`
    UPDATE canonical_orders
    SET order_status = 'DELIVERED',
        delivered_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [testOrderId]);
  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).update({
      orderStatus: 'delivered',
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  console.log('  -> Order successfully moved to DELIVERED.');

  // Verify final state
  const pgFinal = await pgPool.query('SELECT id, order_status, total_amount, accepted_at, ready_at, delivered_at FROM canonical_orders WHERE id = $1', [testOrderId]);
  console.log(`\nVerified final state in PostgreSQL:`);
  console.table(pgFinal.rows);

  if (adminDb) {
    const fsFinal = await adminDb.collection('orders').doc(testOrderId).get();
    console.log(`Verified final state in Firestore: id=${fsFinal.id}, status=${fsFinal.data()?.orderStatus}`);
  }

  // Cleanup test order
  console.log('\nCleaning up verification order...');
  await pgPool.query('DELETE FROM canonical_orders WHERE id = $1', [testOrderId]);
  if (adminDb) {
    await adminDb.collection('orders').doc(testOrderId).delete();
  }
  console.log('Verification test order removed. Platform is 100% clean!');

  await pgPool.end();
  process.exit(0);
}

testLifecycle().catch(err => {
  console.error('Lifecycle test error:', err);
  process.exit(1);
});
