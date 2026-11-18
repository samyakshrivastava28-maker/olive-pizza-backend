import { pgPool } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function main() {
  console.log('--- Setting Durg Rider Online ---');
  await pgPool.query(`UPDATE delivery_partners SET is_online = true, status = 'APPROVED' WHERE id = 'dp_durg_ssamyak_01'`);
  const riderRes = await pgPool.query(`SELECT id, name, is_online, status, franchise_id, branch_id FROM delivery_partners WHERE id = 'dp_durg_ssamyak_01'`);
  console.log('Rider:', riderRes.rows[0]);

  console.log('--- Checking Canonical Orders ---');
  const orders = await pgPool.query(`
    SELECT * 
    FROM canonical_orders 
    ORDER BY created_at DESC 
    LIMIT 3
  `);
  console.log('Recent Orders in Postgres:');
  for (const o of orders.rows) {
    console.log(`Order: id=${o.id}, status=${o.status || o.order_status}, branch_id=${o.branch_id}, franchise_id=${o.franchise_id}, customer_id=${o.customer_id}, rider=${o.delivery_partner_id || o.assigned_delivery_partner_id}`);
  }

  console.log('--- Checking Firestore Orders for Durg Branch ---');
  const snap = await adminDb.collection('orders').orderBy('createdAt', 'desc').limit(5).get();
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`Firestore Order ${doc.id}: status=${d.status || d.orderStatus}, branchId=${d.branchId}, franchiseId=${d.franchiseId}, bill=${d.billNumber || d.bill_number}, rider=${d.assignedDeliveryPartnerId || d.deliveryPartnerId}`);
  });

  process.exit(0);
}

main().catch(err => {
  console.error('Error in script:', err);
  process.exit(1);
});
