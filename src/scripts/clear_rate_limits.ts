import '../config/env.js';
import { adminDb } from '../config/firebase.js';

async function run() {
  if (!adminDb) return;
  const snap = await adminDb.collection('device_login_rate_limits').get();
  console.log(`Found ${snap.size} rate limit records in device_login_rate_limits`);
  const batch = adminDb.batch();
  snap.forEach(d => {
    console.log('Deleting lock:', d.id, d.data());
    batch.delete(d.ref);
  });
  if (snap.size > 0) {
    await batch.commit();
    console.log('All rate limit locks cleared!');
  }
}
run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
