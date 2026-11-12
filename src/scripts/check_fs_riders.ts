import '../config/env.js';
import { adminDb } from '../config/firebase.js';

async function run() {
  if (!adminDb) return;
  const cols = ['delivery_partners', 'riders', 'delivery_partners_locations'];
  for (const c of cols) {
    const snap = await adminDb.collection(c).get();
    console.log(`Firestore collection '${c}': count = ${snap.size}`);
    snap.forEach(d => console.log(d.id, d.data()));
  }
}
run().then(() => process.exit(0));
