import { adminDb, adminAuth } from '../src/config/firebase.js';

const VALID_RIDER_UID = '6tLLR6q7aTYqzTG2blRx3TU5sA42';
const VALID_RIDER_EMAIL = 'webhub2811@gmail.com';

async function purgeFakeRiders() {
  console.log('--- PURGING FAKE RIDERS ---');
  console.log(`Preserving ONLY valid rider: ${VALID_RIDER_EMAIL} (${VALID_RIDER_UID})`);

  // 1. Purge delivery_partners collection
  console.log('\n[1/5] Cleaning delivery_partners collection...');
  const dpSnap = await adminDb.collection('delivery_partners').get();
  for (const doc of dpSnap.docs) {
    if (doc.id !== VALID_RIDER_UID) {
      console.log(`  Deleting fake delivery_partner: ID=${doc.id}, Name=${doc.data().name || doc.data().displayName}, Email=${doc.data().email}`);
      await doc.ref.delete();
    }
  }

  // Ensure valid rider has pristine, canonical delivery partner document
  await adminDb.collection('delivery_partners').doc(VALID_RIDER_UID).set({
    id: VALID_RIDER_UID,
    uid: VALID_RIDER_UID,
    riderId: VALID_RIDER_UID,
    name: 'webhub2811',
    displayName: 'webhub2811',
    email: VALID_RIDER_EMAIL,
    phone: '+918305500767',
    role: 'delivery_partner',
    status: 'online',
    isOnline: true,
    isActive: true,
    approvalStatus: 'approved',
    branchId: 'main_branch',
    franchiseId: 'fra_rajnandgaon',
    vehicleType: 'Scooty',
    vehicleNumber: 'CG 08 AR 9000',
    battery: 100,
    heading: 0,
    speed: 0,
    lat: 21.0829192,
    lng: 81.0366384,
    latitude: 21.0829192,
    longitude: 81.0366384,
    updatedAt: new Date().toISOString(),
    onlineStatusUpdatedAt: new Date().toISOString()
  }, { merge: true });
  console.log(`  ✅ Preserved & standardized delivery partner: ${VALID_RIDER_UID}`);

  // 2. Purge fake riders from users collection
  console.log('\n[2/5] Cleaning users collection...');
  const usersSnap = await adminDb.collection('users').get();
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const email = (data.email || '').toLowerCase();
    const name = (data.name || data.displayName || '').toLowerCase();
    
    // If it's the valid rider/owner, NEVER delete
    if (doc.id === VALID_RIDER_UID || email === VALID_RIDER_EMAIL || email === 'olivepizzarjn@gmail.com') {
      continue;
    }

    // Check if it's a fake/test rider
    if (
      email.includes('fake.rider') ||
      email.includes('scoped.rider') ||
      email.includes('rider.rider_') ||
      name.includes('fake owner rider') ||
      name.includes('fake rider') ||
      doc.id.startsWith('rider_543210') ||
      doc.id.startsWith('test_scoped_rider')
    ) {
      console.log(`  Deleting fake rider user: ID=${doc.id}, Email=${email}, Name=${data.name}`);
      await doc.ref.delete();
    }
  }

  // 3. Purge delivery_locations collection
  console.log('\n[3/5] Cleaning delivery_locations collection...');
  const locSnap = await adminDb.collection('delivery_locations').get();
  for (const doc of locSnap.docs) {
    if (doc.id !== VALID_RIDER_UID) {
      console.log(`  Deleting fake delivery location: ID=${doc.id}`);
      await doc.ref.delete();
    }
  }

  // Ensure location for valid rider is set in delivery_locations
  await adminDb.collection('delivery_locations').doc(VALID_RIDER_UID).set({
    delivery_partner_id: VALID_RIDER_UID,
    latitude: 21.0829192,
    longitude: 81.0366384,
    heading: 0,
    speed: 0,
    updated_at: new Date().toISOString()
  }, { merge: true });
  console.log(`  ✅ Preserved & standardized delivery location: ${VALID_RIDER_UID}`);

  // 4. Purge riders / delivery_boys collections if any exist
  console.log('\n[4/5] Cleaning other rider collections...');
  const ridersSnap = await adminDb.collection('riders').get().catch(() => ({ docs: [] } as any));
  for (const doc of ridersSnap.docs) {
    if (doc.id !== VALID_RIDER_UID) {
      console.log(`  Deleting doc in riders collection: ID=${doc.id}`);
      await doc.ref.delete();
    }
  }

  // 5. Purge fake rider users from Firebase Authentication
  console.log('\n[5/5] Purging fake rider users from Firebase Auth...');
  const fakeAuthEmails = [
    'fake.rider@olivepizza.in',
    'scoped.rider@olivepizza.in',
    'unverified.mgr@olivepizza.in'
  ];

  for (const fakeEmail of fakeAuthEmails) {
    try {
      const authUser = await adminAuth.getUserByEmail(fakeEmail);
      console.log(`  Deleting Firebase Auth user: ${authUser.email} (${authUser.uid})`);
      await adminAuth.deleteUser(authUser.uid);
    } catch (e: any) {
      if (e.code !== 'auth/user-not-found') {
        console.warn(`  Warning deleting auth user ${fakeEmail}:`, e.message);
      }
    }
  }

  // Also check if UID Z5XNyqWfioUFW487twpeiVYugM82 exists in Auth
  try {
    const authUser = await adminAuth.getUser('Z5XNyqWfioUFW487twpeiVYugM82');
    console.log(`  Deleting Firebase Auth user by UID: ${authUser.email} (${authUser.uid})`);
    await adminAuth.deleteUser('Z5XNyqWfioUFW487twpeiVYugM82');
  } catch (e: any) {
    // not found
  }

  console.log('\n✅ ALL FAKE RIDERS REMOVED SUCCESSFULLY! Only webhub2811 remains active.');
}

purgeFakeRiders().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error purging fake riders:', err);
  process.exit(1);
});
