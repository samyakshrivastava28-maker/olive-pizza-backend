import { adminDb, adminAuth } from '../src/config/firebase.js';

async function runFirestoreCleanup() {
  console.log('=== STARTING MILESTONE 1 FIRESTORE & AUTH CLEANUP ===');

  if (!adminDb || !adminAuth) {
    throw new Error('Firebase Admin DB or Auth instance is not available.');
  }

  // 1. Purge test delivery_partners (Keep ONLY Uln5UKsRyZaCzTePgBmfourQngu1 / dp_rjn_samyak_01)
  console.log('\n--- 1. Purging Firestore delivery_partners ---');
  const dpSnap = await adminDb.collection('delivery_partners').get();
  let dpDeleted = 0;
  for (const doc of dpSnap.docs) {
    const data = doc.data();
    const isRjnValidRider = (doc.id === 'Uln5UKsRyZaCzTePgBmfourQngu1' || doc.id === 'dp_rjn_samyak_01') &&
      data.email === 'samyaks695@gmail.com';
    
    if (doc.id !== 'Uln5UKsRyZaCzTePgBmfourQngu1' && doc.id !== 'dp_rjn_samyak_01') {
      await doc.ref.delete();
      console.log(`Deleted test delivery_partner: ${doc.id} (${data.name || data.email || 'no name'})`);
      dpDeleted++;
    } else {
      console.log(`Preserved canonical delivery_partner: ${doc.id} (${data.name || data.email})`);
    }
  }
  console.log(`Delivery partners purged: ${dpDeleted}`);

  // 2. Purge test franchise_entities (Keep ONLY fra_rajnandgaon)
  console.log('\n--- 2. Purging Firestore franchise_entities ---');
  const entSnap = await adminDb.collection('franchise_entities').get();
  let entDeleted = 0;
  for (const doc of entSnap.docs) {
    if (doc.id !== 'fra_rajnandgaon') {
      await doc.ref.delete();
      console.log(`Deleted franchise_entity: ${doc.id}`);
      entDeleted++;
    } else {
      console.log(`Preserved canonical franchise_entity: ${doc.id}`);
    }
  }
  console.log(`Franchise entities purged: ${entDeleted}`);

  // 3. Purge test franchises (Keep ONLY main_branch, fra_primary, fra_rajnandgaon)
  console.log('\n--- 3. Purging Firestore franchises ---');
  const fSnap = await adminDb.collection('franchises').get();
  let fDeleted = 0;
  const canonicalFranchiseIds = ['main_branch', 'fra_primary', 'fra_rajnandgaon'];
  for (const doc of fSnap.docs) {
    if (!canonicalFranchiseIds.includes(doc.id)) {
      await doc.ref.delete();
      console.log(`Deleted test franchise: ${doc.id}`);
      fDeleted++;
    } else {
      console.log(`Preserved canonical franchise: ${doc.id}`);
    }
  }
  console.log(`Franchises purged: ${fDeleted}`);

  // 4. Purge test customer_ordering_contexts
  console.log('\n--- 4. Purging Firestore customer_ordering_contexts ---');
  const ctxSnap = await adminDb.collection('customer_ordering_contexts').get();
  let ctxDeleted = 0;
  for (const doc of ctxSnap.docs) {
    const data = doc.data();
    const shouldDelete = (
      data.franchiseId !== 'fra_rajnandgaon' ||
      doc.id.toLowerCase().includes('test') ||
      doc.id.toLowerCase().includes('bsp') ||
      doc.id.toLowerCase().includes('durg') ||
      (data.location && (data.location.lat > 21.15 || data.location.lat < 20.95))
    );
    if (shouldDelete) {
      await doc.ref.delete();
      console.log(`Deleted test customer_ordering_context: ${doc.id}`);
      ctxDeleted++;
    }
  }
  console.log(`Customer ordering contexts purged: ${ctxDeleted}`);

  // 5. Align Customer s.callhub2811@gmail.com in Firebase Auth & Firestore users
  console.log('\n--- 5. Aligning Customer s.callhub2811@gmail.com ---');
  let customerUser = null;
  try {
    customerUser = await adminAuth.getUserByEmail('s.callhub2811@gmail.com');
  } catch (e) {
    console.warn('Could not find customer by email in Auth:', e.message);
  }

  if (customerUser) {
    await adminAuth.setCustomUserClaims(customerUser.uid, {
      role: 'customer',
      allowedApps: ['CUSTOMER'],
      franchiseId: 'fra_rajnandgaon',
      branchId: 'branch_rjn_main'
    });
    console.log(`Set Auth custom user claims for customer UID ${customerUser.uid}: role=customer, franchise=fra_rajnandgaon, branch=branch_rjn_main`);

    await adminDb.collection('users').doc(customerUser.uid).set({
      role: 'customer',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'branch_rjn_main',
      allowedApps: ['CUSTOMER'],
      lat: 21.0974,
      lng: 81.0347,
      fullAddress: 'Station Road, Rajnandgaon, Chhattisgarh 491441',
      address: 'Station Road, Rajnandgaon, Chhattisgarh 491441',
      city: 'Rajnandgaon',
      state: 'Chhattisgarh',
      postalCode: '491441',
      location: {
        lat: 21.0974,
        lng: 81.0347
      },
      default_address: 'Station Road, Rajnandgaon, Chhattisgarh 491441',
      updatedAt: new Date().toISOString()
    }, { merge: true });
    console.log(`Updated Firestore users document for customer UID ${customerUser.uid}`);
  }

  // Also verify Master Owner claims
  try {
    const ownerAuth = await adminAuth.getUserByEmail('olivepizzarjn@gmail.com');
    if (ownerAuth) {
      await adminAuth.setCustomUserClaims(ownerAuth.uid, {
        role: 'owner',
        allowedApps: ['OWNER', 'FRANCHISE_MANAGER', 'RESTAURANT_MANAGER', 'POS', 'DELIVERY', 'CUSTOMER'],
        franchiseId: 'fra_rajnandgaon',
        branchId: 'all'
      });
      console.log(`Verified Owner claims for UID ${ownerAuth.uid}`);
    }
  } catch (e) {
    console.warn('Owner Auth check note:', e.message);
  }

  // 6. Delete test users from Firestore users collection
  console.log('\n--- 6. Deleting test users from Firestore users ---');
  const dummyStaffEmails = [
    'ssamyak265@gmail.com',
    'samyakssaamm@gmail.com',
    'rahul.rider@olivepizza.in',
    'amit.rider@olivepizza.in',
    'bsp.rider@olivepizza.in',
    'rider@olivepizza.in',
    'rider2@olivepizza.in',
    'manager.bsp@olivepizza.in',
    'owner.bsp@olivepizza.in',
    'cashier@olivepizza.in'
  ];

  for (const email of dummyStaffEmails) {
    const uSnap = await adminDb.collection('users').where('email', '==', email).get();
    for (const d of uSnap.docs) {
      await d.ref.delete();
      console.log(`Deleted Firestore test user doc: ${d.id} (${email})`);
    }
  }

  // 7. Verify Firestore Collections
  console.log('\n--- VERIFICATION: CURRENT FIRESTORE STATE ---');
  const dpCheck = await adminDb.collection('delivery_partners').get();
  console.log(`Remaining delivery_partners count: ${dpCheck.size}`);
  dpCheck.docs.forEach(d => console.log(` - delivery_partner: ${d.id} -> ${JSON.stringify(d.data().email || d.data().name)}`));

  const entCheck = await adminDb.collection('franchise_entities').get();
  console.log(`Remaining franchise_entities count: ${entCheck.size}`);
  entCheck.docs.forEach(d => console.log(` - franchise_entity: ${d.id}`));

  const fCheck = await adminDb.collection('franchises').get();
  console.log(`Remaining franchises count: ${fCheck.size}`);
  fCheck.docs.forEach(d => console.log(` - franchise: ${d.id}`));

  console.log('=== FIRESTORE & AUTH CLEANUP FINISHED SUCCESSFULLY ===');
  process.exit(0);
}

runFirestoreCleanup().catch(err => {
  console.error('Firestore cleanup error:', err);
  process.exit(1);
});
