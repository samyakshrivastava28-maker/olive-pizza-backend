import { adminDb as db } from '../src/config/firebase.js';

async function main() {
  const collectionsToCheck = [
    'pos_bills',
    'order_audit_logs',
    'activity_logs',
    'owner_alerts',
    'notifications',
    'orders'
  ];

  for (const col of collectionsToCheck) {
    const snap = await db.collection(col).get();
    snap.forEach(d => {
      const data = d.data();
      const str = (d.id + ' ' + JSON.stringify(data)).toLowerCase();
      if (str.includes('de0b11')) {
        console.log(`FOUND in collection ${col}, doc ${d.id}:`, data);
      }
    });
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
