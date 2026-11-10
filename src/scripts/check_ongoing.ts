import { query } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function main() {
  console.log('=== Checking PostgreSQL Ongoing Orders ===');
  const res = await query(
    `SELECT id, customer_name, customer_phone, order_status, total_amount, branch_id, created_at 
     FROM canonical_orders 
     WHERE order_status NOT IN ('DELIVERED', 'CANCELLED')`
  );
  console.log(`Found ${res.rows.length} ongoing orders in PostgreSQL:`);
  console.table(res.rows);

  console.log('\n=== Checking Firestore for ongoing orders ===');
  try {
    const snap = await adminDb.collection('orders')
      .where('status', 'in', ['pending', 'accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery'])
      .get();
    console.log(`Found ${snap.size} ongoing orders in Firestore:`);
    snap.forEach(d => {
      const data = d.data();
      console.log(`ID: ${d.id} | Status: ${data.status} | User: ${data.userId || data.customerName} | Total: ${data.totalAmount}`);
    });
  } catch (err: any) {
    console.warn('Firestore query notice:', err.message);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
