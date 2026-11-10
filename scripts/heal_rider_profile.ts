import { adminDb } from '../src/config/firebase.js';
import { pgPool } from '../src/config/postgres.js';

async function heal() {
  const uid = '6tLLR6q7aTYqzTG2blRx3TU5sA42';
  console.log('Healing delivery partner profile for', uid);

  await adminDb.collection('delivery_partners').doc(uid).set({
    activeOrderId: null,
    isOnline: true,
    status: 'available',
    approvalStatus: 'approved',
    role: 'delivery_partner',
    allowedApps: ['DELIVERY', 'RESTAURANT_MANAGER', 'OWNER', 'POS', 'FRANCHISE_MANAGER'],
    applicationAccess: {
      app_delivery: true,
      app_restaurant_management: true,
      app_pos: true,
      app_franchise_management: true
    },
    updatedAt: new Date().toISOString()
  }, { merge: true });

  await adminDb.collection('users').doc(uid).set({
    activeOrderId: null,
    isOnline: true,
    applicationAccess: {
      app_delivery: true,
      app_restaurant_management: true,
      app_pos: true,
      app_franchise_management: true
    },
    updatedAt: new Date().toISOString()
  }, { merge: true });

  console.log('✅ Rider profile healed in Firestore.');
  await pgPool.end().catch(() => {});
  process.exit(0);
}

heal().catch(err => {
  console.error(err);
  process.exit(1);
});
