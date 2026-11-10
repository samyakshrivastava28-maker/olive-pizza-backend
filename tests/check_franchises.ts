import { adminDb } from '../src/config/firebase.js';

async function check() {
  const f1 = await adminDb.collection('franchise_entities').get();
  console.log('=== FRANCHISE_ENTITIES (' + f1.docs.length + ') ===');
  f1.docs.forEach(d => {
    console.log(d.id, d.data().name, d.data().city, d.data().slug);
  });

  const f2 = await adminDb.collection('franchises').get();
  console.log('\n=== FRANCHISES (' + f2.docs.length + ') ===');
  f2.docs.forEach(d => {
    console.log(d.id, d.data().name, d.data().city, d.data().code);
  });
}

check().catch(console.error);
