import { adminDb } from '../src/config/firebase.js';

async function run() {
  try {
    const gSnap = await adminDb.collection('settings').doc('global').get();
    console.log('SETTINGS/GLOBAL:', JSON.stringify(gSnap.data(), null, 2));

    const fSnap = await adminDb.collection('franchises').get();
    console.log('FRANCHISES COUNT:', fSnap.size);
    fSnap.forEach(d => {
      console.log(`Franchise [${d.id}]:`, JSON.stringify(d.data(), null, 2));
    });

    const restSnap = await adminDb.collection('restaurant_settings').get();
    console.log('RESTAURANT_SETTINGS COUNT:', restSnap.size);
    restSnap.forEach(d => {
      console.log(`Restaurant Settings [${d.id}]:`, JSON.stringify(d.data(), null, 2));
    });
  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

run();
