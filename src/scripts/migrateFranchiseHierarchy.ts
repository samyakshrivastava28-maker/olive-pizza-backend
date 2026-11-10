import { adminDb } from '../config/firebase.js';

async function migrateFranchiseHierarchy() {
  console.log('[Migration] Starting Olive Pizza Franchise Hierarchy Migration...');

  // 1. Organization
  const orgRef = adminDb.collection('organizations').doc('org_olive_pizza');
  const orgDoc = await orgRef.get();
  if (!orgDoc.exists) {
    await orgRef.set({
      id: 'org_olive_pizza',
      name: 'Olive Pizza India',
      legalName: 'Olive Pizza Foodworks Private Limited',
      contactEmail: 'olivepizzarjn@gmail.com',
      contactPhone: '+91 91799 44445',
      currency: 'INR',
      country: 'IN',
      createdAt: new Date().toISOString()
    });
    console.log('[Migration] Created Organization: org_olive_pizza');
  }

  // 2. Franchise
  const fraRef = adminDb.collection('franchises_groups').doc('fra_primary');
  const fraDoc = await fraRef.get();
  if (!fraDoc.exists) {
    await fraRef.set({
      id: 'fra_primary',
      organizationId: 'org_olive_pizza',
      name: 'Olive Pizza Primary Franchise',
      code: 'FRA-IN-01',
      region: 'Chhattisgarh',
      contactEmail: 'olivepizzarjn@gmail.com',
      contactPhone: '+91 91799 44445',
      isActive: true,
      createdAt: new Date().toISOString()
    });
    console.log('[Migration] Created Franchise Group: fra_primary');
  }

  // 3. Branches
  const DEFAULT_BRANCHES = [
    {
      id: 'main_branch',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      name: 'Olive Pizza — Rajnandgaon (Main Branch)',
      code: 'OP-RJN-01',
      city: 'Rajnandgaon',
      state: 'Chhattisgarh',
      address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
      lat: 21.0810244,
      lng: 81.0123793,
      phone: '+91 91799 44445',
      email: 'olivepizzarjn@gmail.com',
      maxDeliveryRadiusKm: 15,
      openingTime: '12:00',
      closingTime: '23:59',
      isActive: true,
      isHeadquarters: true,
      createdAt: new Date().toISOString()
    },
    {
      id: 'durg_branch',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      name: 'Olive Pizza — Durg (Branch 2)',
      code: 'OP-DURG-02',
      city: 'Durg',
      state: 'Chhattisgarh',
      address: 'Station Road, Durg, CG 491001',
      lat: 21.190449,
      lng: 81.284920,
      phone: '+91 91799 44446',
      email: 'durg@olivepizza.in',
      maxDeliveryRadiusKm: 12,
      openingTime: '12:00',
      closingTime: '23:59',
      isActive: true,
      isHeadquarters: false,
      createdAt: new Date().toISOString()
    },
    {
      id: 'bhilai_branch',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      name: 'Olive Pizza — Bhilai (Branch 3)',
      code: 'OP-BHL-03',
      city: 'Bhilai',
      state: 'Chhattisgarh',
      address: 'Civic Centre, Sector 5, Bhilai, CG 490006',
      lat: 21.193848,
      lng: 81.350941,
      phone: '+91 91799 44447',
      email: 'bhilai@olivepizza.in',
      maxDeliveryRadiusKm: 12,
      openingTime: '12:00',
      closingTime: '23:59',
      isActive: true,
      isHeadquarters: false,
      createdAt: new Date().toISOString()
    },
    {
      id: 'raipur_branch',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      name: 'Olive Pizza — Raipur (Branch 4)',
      code: 'OP-RPR-04',
      city: 'Raipur',
      state: 'Chhattisgarh',
      address: 'VIP Road, Telibandha, Raipur, CG 492006',
      lat: 21.237944,
      lng: 81.667427,
      phone: '+91 91799 44448',
      email: 'raipur@olivepizza.in',
      maxDeliveryRadiusKm: 15,
      openingTime: '12:00',
      closingTime: '23:59',
      isActive: true,
      isHeadquarters: false,
      createdAt: new Date().toISOString()
    }
  ];

  for (const b of DEFAULT_BRANCHES) {
    await adminDb.collection('franchises').doc(b.id).set(b, { merge: true });
    await adminDb.collection('branches').doc(b.id).set(b, { merge: true });
    console.log(`[Migration] Synced Branch: ${b.name} (${b.id})`);
  }

  // 4. Backfill legacy orders without branchId
  const ordersSnap = await adminDb.collection('orders').limit(100).get().catch(() => ({ docs: [] } as any));
  let updatedOrders = 0;
  for (const doc of ordersSnap.docs) {
    const data = doc.data();
    if (!data.branchId || !data.organizationId) {
      await doc.ref.set({
        organizationId: data.organizationId || 'org_olive_pizza',
        franchiseId: data.franchiseId || 'fra_primary',
        branchId: data.branchId || 'main_branch',
        branchName: data.branchName || 'Olive Pizza — Rajnandgaon (Main Branch)'
      }, { merge: true });
      updatedOrders++;
    }
  }
  console.log(`[Migration] Backfilled ${updatedOrders} legacy orders to main_branch.`);

  console.log('[Migration] Franchise Hierarchy Migration Complete!');
}

migrateFranchiseHierarchy().catch(console.error);
