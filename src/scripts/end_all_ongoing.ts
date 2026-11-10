import { query } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function main() {
  console.log('=== Checking and Ending ALL Ongoing Orders ===');
  
  // 1. PostgreSQL canonical orders update
  const res = await query(
    `UPDATE canonical_orders 
     SET order_status = 'DELIVERED', 
         payment_status = 'PAID',
         updated_at = NOW() 
     WHERE order_status NOT IN ('DELIVERED', 'CANCELLED')
     RETURNING id, order_status, customer_name, total_amount`
  );
  
  console.log(`✅ Closed ${res.rows.length} ongoing orders in PostgreSQL:`);
  console.table(res.rows);

  // 2. Also close bills in canonical_bills
  await query(
    `UPDATE canonical_bills 
     SET payment_status = 'PAID'
     WHERE payment_status != 'PAID'`
  ).catch(e => console.warn('Bills update notice:', e.message));

  // 3. Update Firestore if accessible
  for (const row of res.rows) {
    try {
      await adminDb.collection('orders').doc(row.id).set({
        status: 'delivered',
        orderStatus: 'delivered',
        lifecycle: 'COMPLETED',
        paymentStatus: 'PAID',
        codCollected: true,
        deliveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }, { merge: true });
      console.log(`✅ Firestore doc ${row.id} marked as DELIVERED / COMPLETED`);
    } catch (err: any) {
      console.warn(`Firestore update notice for ${row.id}:`, err.message);
    }
  }

  // 4. Verify count of unfinished orders
  const countRes = await query(
    `SELECT count(*) FROM canonical_orders WHERE order_status NOT IN ('DELIVERED', 'CANCELLED')`
  );
  console.log(`\n🎉 Verification: There are now ${countRes.rows[0].count} ongoing orders in the system.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
