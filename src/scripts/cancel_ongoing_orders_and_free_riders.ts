import '../config/env.js';
import { pgPool } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';

async function main() {
  console.log('=== Step 1: Cancelling Ongoing Orders in PostgreSQL (canonical_orders) ===');
  const pgResult = await pgPool.query(`
    UPDATE canonical_orders
    SET order_status = 'CANCELLED',
        cancellation_reason = 'Cancelled for clean testing per user request',
        updated_at = NOW()
    WHERE UPPER(order_status) NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED')
    RETURNING id, order_status;
  `);
  console.log(`Cancelled ${pgResult.rowCount} ongoing orders in PostgreSQL:`);
  console.table(pgResult.rows);

  console.log('\n=== Step 2: Freeing Delivery Partners in PostgreSQL ===');
  const riderPgResult = await pgPool.query(`
    UPDATE delivery_partners
    SET active_order_id = NULL,
        updated_at = NOW()
    WHERE active_order_id IS NOT NULL
    RETURNING id, name, active_order_id;
  `);
  console.log(`Freed ${riderPgResult.rowCount} delivery partners in PostgreSQL:`);
  console.table(riderPgResult.rows);

  if (adminDb) {
    console.log('\n=== Step 3: Cancelling Ongoing Orders in Firestore ===');
    const ordersSnap = await adminDb.collection('orders').get();
    let fsCancelledCount = 0;
    const batch = adminDb.batch();
    let opCount = 0;
    const commits = [];

    ordersSnap.forEach(doc => {
      const data = doc.data();
      const st = (data.orderStatus || data.status || '').toUpperCase();
      if (!['DELIVERED', 'CANCELLED', 'REJECTED'].includes(st)) {
        batch.update(doc.ref, {
          status: 'cancelled',
          orderStatus: 'cancelled',
          cancellationReason: 'Cancelled for clean testing per user request',
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        fsCancelledCount++;
        opCount++;
        if (opCount >= 400) {
          commits.push(batch.commit());
          opCount = 0;
        }
      }
    });

    if (opCount > 0) {
      commits.push(batch.commit());
    }
    await Promise.all(commits);
    console.log(`Cancelled ${fsCancelledCount} ongoing orders in Firestore.`);

    console.log('\n=== Step 4: Freeing Delivery Partners in Firestore ===');
    const dpSnap = await adminDb.collection('delivery_partners').get();
    const dpBatch = adminDb.batch();
    let dpUpdated = 0;

    dpSnap.forEach(doc => {
      const d = doc.data();
      if (d.activeOrderId || d.deliveryStatus === 'busy' || d.isBusy) {
        dpBatch.update(doc.ref, {
          activeOrderId: null,
          isBusy: false,
          deliveryStatus: 'available',
          isAvailable: true,
          updatedAt: new Date().toISOString()
        });
        dpUpdated++;
      }
    });

    if (dpUpdated > 0) {
      await dpBatch.commit();
    }
    console.log(`Freed ${dpUpdated} delivery partners in Firestore.`);
  }

  console.log('\n=== Step 5: Verification ===');
  const remainingPg = await pgPool.query(`
    SELECT count(*) as active_count
    FROM canonical_orders
    WHERE UPPER(order_status) NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED')
  `);
  console.log(`Remaining ongoing orders in PostgreSQL: ${remainingPg.rows[0].active_count}`);

  if (adminDb) {
    const checkSnap = await adminDb.collection('orders').get();
    let fsActive = 0;
    checkSnap.forEach(d => {
      const st = (d.data().orderStatus || d.data().status || '').toUpperCase();
      if (!['DELIVERED', 'CANCELLED', 'REJECTED'].includes(st)) {
        fsActive++;
      }
    });
    console.log(`Remaining ongoing orders in Firestore: ${fsActive}`);
  }

  await pgPool.end();
  console.log('\nClean-up completed successfully!');
  process.exit(0);
}

main().catch(err => {
  console.error('Error during cleanup:', err);
  process.exit(1);
});
