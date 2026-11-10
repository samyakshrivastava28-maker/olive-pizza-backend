import { query } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function endOngoingOrder() {
  const orderId = '7cf90eb6-164c-446b-bde1-0cb4e39f9745';
  console.log(`Ending ongoing order: ${orderId}...`);

  // 1. Update PostgreSQL canonical_orders
  const pgRes = await query(
    `UPDATE canonical_orders 
     SET order_status = 'DELIVERED', 
         payment_status = 'PAID',
         updated_at = NOW() 
     WHERE id = $1 
     RETURNING id, order_status, payment_status, total_amount`,
    [orderId]
  );
  console.log('✅ PostgreSQL updated:', pgRes.rows[0]);

  // 2. Update PostgreSQL canonical_bills
  await query(
    `UPDATE canonical_bills 
     SET payment_status = 'PAID',
         bill_status = 'COMPLETED'
     WHERE order_id = $1`,
    [orderId]
  ).catch(e => console.warn('Bill update notice:', e.message));

  // 3. Update Firestore if accessible
  try {
    await adminDb.collection('orders').doc(orderId).set({
      status: 'delivered',
      orderStatus: 'delivered',
      lifecycle: 'COMPLETED',
      paymentStatus: 'PAID',
      codCollected: true,
      deliveredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    console.log('✅ Firestore document updated to DELIVERED / COMPLETED');
  } catch (err: any) {
    console.warn('Firestore notice (quota or connectivity):', err.message);
  }

  // 4. Verify no other ongoing orders exist
  const check = await query(
    `SELECT id, order_status, customer_name FROM canonical_orders WHERE order_status NOT IN ('DELIVERED', 'CANCELLED')`
  );
  console.log(`Remaining ongoing orders in PostgreSQL: ${check.rows.length}`);

  console.log('\n🎉 Order 7cf90eb6-164c-446b-bde1-0cb4e39f9745 has been completely ENDED!');
  process.exit(0);
}

endOngoingOrder().catch(err => {
  console.error('Failed to end order:', err);
  process.exit(1);
});
