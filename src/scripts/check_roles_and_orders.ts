import '../config/env.js';
import { pgPool } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function run() {
  console.log('--- Inspecting app_users in PostgreSQL ---');
  try {
    const users = await pgPool.query(`
      SELECT id, email, role, phone, name, is_active 
      FROM app_users 
      ORDER BY role, email
    `);
    console.table(users.rows);
  } catch (err: any) {
    console.error('Error fetching app_users:', err.message);
  }

  console.log('\n--- Checking distinct statuses in canonical_orders ---');
  try {
    const statuses = await pgPool.query(`
      SELECT order_status, count(*) as count 
      FROM canonical_orders 
      GROUP BY order_status
    `);
    console.table(statuses.rows);
  } catch (err: any) {
    console.error('Error fetching statuses from canonical_orders:', err.message);
  }

  console.log('\n--- Checking non-delivered and non-cancelled orders in canonical_orders ---');
  try {
    const active = await pgPool.query(`
      SELECT id, order_status, franchise_id, branch_id, total_amount, created_at 
      FROM canonical_orders 
      WHERE UPPER(order_status) NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED')
      ORDER BY created_at DESC
    `);
    console.log(`Active count: ${active.rows.length}`);
    if (active.rows.length > 0) {
      console.table(active.rows);
    }
  } catch (err: any) {
    console.error('Error fetching active canonical_orders:', err.message);
  }

  console.log('\n--- Checking Firestore orders for active orders ---');
  try {
    if (adminDb) {
      const snap = await adminDb.collection('orders').get();
      console.log(`Total Firestore orders: ${snap.size}`);
      const activeFirestore: any[] = [];
      snap.forEach(doc => {
        const d = doc.data();
        const st = (d.orderStatus || d.status || '').toUpperCase();
        if (!['DELIVERED', 'CANCELLED', 'REJECTED'].includes(st)) {
          activeFirestore.push({
            id: doc.id,
            status: d.orderStatus || d.status,
            total: d.totalAmount || d.finalTotal,
            paymentStatus: d.paymentStatus,
            franchiseId: d.franchiseId,
            createdAt: d.createdAt
          });
        }
      });
      console.log(`Ongoing/active orders in Firestore: ${activeFirestore.length}`);
      if (activeFirestore.length > 0) {
        console.table(activeFirestore.slice(0, 10));
      }
    }
  } catch (err: any) {
    console.error('Error checking Firestore orders:', err.message);
  }

  await pgPool.end();
  process.exit(0);
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
