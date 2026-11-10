import { adminDb } from '../src/config/firebase.js';

async function purgeAndClean() {
  console.log('Cleaning Firestore franchises...');

  // 1. Purge unwanted franchise_entities
  const entitiesToKeep = ['fra_rajnandgaon'];
  const fEntitiesSnap = await adminDb.collection('franchise_entities').get();
  for (const doc of fEntitiesSnap.docs) {
    if (!entitiesToKeep.includes(doc.id)) {
      console.log(`Deleting franchise_entities doc: ${doc.id}`);
      await doc.ref.delete();
    }
  }

  // Ensure fra_rajnandgaon is complete and canonical
  await adminDb.collection('franchise_entities').doc('fra_rajnandgaon').set({
    id: 'fra_rajnandgaon',
    slug: 'rajnandgaon',
    name: 'Olive Pizza — Rajnandgaon',
    code: 'OP-RJN-01',
    city: 'Rajnandgaon',
    state: 'Chhattisgarh',
    region: 'Chhattisgarh',
    address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
    lat: 21.0810244,
    lng: 81.0123793,
    contactEmail: 'olivepizzarjn@gmail.com',
    contactPhone: '+91 91799 44445',
    phone: '+91 91799 44445',
    email: 'olivepizzarjn@gmail.com',
    franchiseOwnerName: 'Olive Pizza Master Owner',
    franchiseOwnerEmail: 'olivepizzarjn@gmail.com',
    restaurantManagerEmail: 'webhub2811@gmail.com',
    restaurantManagerName: 'Primary Branch Manager',
    mainBranchId: 'main_branch',
    isActive: true,
    status: 'ACTIVE',
    maxDeliveryRadiusKm: 15,
    openingTime: '12:00',
    closingTime: '23:59',
    posTerminalCount: 1,
    updatedAt: new Date().toISOString()
  }, { merge: true });
  console.log('✅ Canonical fra_rajnandgaon updated in franchise_entities');

  // 2. Purge unwanted branches from 'franchises' collection - only main_branch should exist
  const branchesToKeep = ['main_branch'];
  const fBranchesSnap = await adminDb.collection('franchises').get();
  for (const doc of fBranchesSnap.docs) {
    if (!branchesToKeep.includes(doc.id)) {
      console.log(`Deleting extra franchises doc: ${doc.id}`);
      await doc.ref.delete();
    }
  }

  // Ensure main_branch is complete
  await adminDb.collection('franchises').doc('main_branch').set({
    id: 'main_branch',
    franchiseId: 'fra_rajnandgaon',
    name: 'Olive Pizza — Rajnandgaon',
    code: 'OP-RJN-01',
    city: 'Rajnandgaon',
    state: 'Chhattisgarh',
    address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
    lat: 21.0810244,
    lng: 81.0123793,
    phone: '+91 91799 44445',
    email: 'olivepizzarjn@gmail.com',
    franchiseOwnerEmail: 'olivepizzarjn@gmail.com',
    restaurantManagerEmail: 'webhub2811@gmail.com',
    maxDeliveryRadiusKm: 15,
    openingTime: '12:00',
    closingTime: '23:59',
    isActive: true,
    isHeadquarters: false,
    posTerminalCount: 1,
    updatedAt: new Date().toISOString()
  }, { merge: true });
  console.log('✅ Canonical main_branch updated in franchises');

  // Also ensure franchise_metadata is updated
  await adminDb.collection('franchise_metadata').doc('fra_primary').set({
    id: 'fra_primary',
    name: 'Olive Pizza — Rajnandgaon',
    code: 'OP-RJN-01',
    region: 'Chhattisgarh',
    contactEmail: 'olivepizzarjn@gmail.com',
    contactPhone: '+91 91799 44445',
    isActive: true,
    defaultBranchId: 'main_branch',
    updatedAt: new Date().toISOString()
  }, { merge: true });
  console.log('✅ Canonical franchise_metadata updated');

  console.log('Purge completed successfully.');
}

purgeAndClean().catch(console.error);
