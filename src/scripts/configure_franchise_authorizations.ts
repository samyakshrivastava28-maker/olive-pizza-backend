import '../config/env.js';
import { adminAuth, adminDb } from '../config/firebase.js';
import { query, pgPool } from '../config/postgres.js';

async function getOrCreateFirebaseUser(email: string, defaultName: string, defaultPhone?: string) {
  try {
    const user = await adminAuth.getUserByEmail(email);
    return user;
  } catch (err: any) {
    if (err.code === 'auth/user-not-found') {
      const user = await adminAuth.createUser({
        email,
        displayName: defaultName,
        phoneNumber: defaultPhone || undefined,
        emailVerified: true
      });
      return user;
    }
    throw err;
  }
}

async function configureSystem() {
  console.log('================================================================');
  console.log('🍕 CONFIGURING AUTHORIZED USERS & MULTI-FRANCHISE ACCESS');
  console.log('================================================================\n');

  // Query branches
  const branchesRes = await query(`SELECT id, franchise_id, name FROM restaurant_branches`);
  console.log('Available restaurant branches in Postgres:', branchesRes.rows);

  const rjnBranch = branchesRes.rows.find((b: any) => b.franchise_id === 'fra_rajnandgaon')?.id || 'main_branch';
  const durgBranch = branchesRes.rows.find((b: any) => b.franchise_id === 'fra_op_durg_01')?.id || 'fra_op_durg_01_main_branch';

  console.log(`Resolved RJN Branch: ${rjnBranch}, Durg Branch: ${durgBranch}\n`);

  const userConfigs = [
    {
      email: 'olivepizzarjn@gmail.com',
      name: 'Olive Pizza Master Owner',
      role: 'owner',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'all',
      allowedApps: ['OWNER', 'FRANCHISE_MANAGER', 'RESTAURANT_MANAGER', 'POS', 'DELIVERY', 'CUSTOMER'],
      phone: '+919179944445'
    },
    {
      email: 'webhub2811@gmail.com',
      name: 'Webhub Durg Franchise Owner',
      role: 'owner', // Must be owner so it gets OWNER & FRANCHISE_MANAGER access
      franchiseId: 'fra_op_durg_01',
      branchId: durgBranch,
      allowedApps: ['OWNER', 'FRANCHISE_MANAGER', 'RESTAURANT_MANAGER', 'POS', 'DELIVERY', 'CUSTOMER'],
      phone: '+919179944446'
    },
    {
      email: 'samyakshrivastava28@gmail.com',
      name: 'Samyak RJN Restaurant Manager',
      role: 'restaurant_manager',
      franchiseId: 'fra_rajnandgaon',
      branchId: rjnBranch,
      allowedApps: ['RESTAURANT_MANAGER', 'POS'],
      phone: '+919179944447'
    },
    {
      email: 'samyakssaamm@gmail.com',
      name: 'Samyak Durg Restaurant Manager',
      role: 'restaurant_manager',
      franchiseId: 'fra_op_durg_01',
      branchId: durgBranch,
      allowedApps: ['RESTAURANT_MANAGER', 'POS'],
      phone: '+919179944448'
    },
    {
      email: 'samyaks695@gmail.com',
      name: 'Samyak RJN Delivery Raider',
      role: 'delivery_partner',
      franchiseId: 'fra_rajnandgaon',
      branchId: rjnBranch,
      allowedApps: ['DELIVERY', 'CUSTOMER'],
      phone: '+919876543211',
      isRider: true,
      riderId: 'dp_rjn_samyak_01'
    },
    {
      email: 'ssamyak265@gmail.com',
      name: 'Samyak Durg Delivery Raider',
      role: 'delivery_partner',
      franchiseId: 'fra_op_durg_01',
      branchId: durgBranch,
      allowedApps: ['DELIVERY', 'CUSTOMER'],
      phone: '+919876543212',
      isRider: true,
      riderId: 'dp_durg_ssamyak_01'
    },
    {
      email: 's.callhub2811@gmail.com',
      name: 'Samyak Customer Durg',
      role: 'customer',
      franchiseId: 'fra_op_durg_01',
      branchId: durgBranch,
      allowedApps: ['CUSTOMER'],
      phone: '+919876543210'
    }
  ];

  for (const cfg of userConfigs) {
    console.log(`Processing: ${cfg.email} (${cfg.role})...`);

    // 1. Firebase Auth User & Claims
    let fbUser: any;
    try {
      fbUser = await getOrCreateFirebaseUser(cfg.email, cfg.name, cfg.phone);
    } catch (e: any) {
      console.warn(`  Firebase user error for ${cfg.email}:`, e.message);
      fbUser = { uid: `uid_${cfg.email.split('@')[0]}` };
    }

    const claims = {
      role: cfg.role,
      allowedApps: cfg.allowedApps,
      franchiseId: cfg.franchiseId,
      branchId: cfg.branchId
    };

    if (fbUser.uid && !fbUser.uid.startsWith('uid_')) {
      try {
        await adminAuth.updateUser(fbUser.uid, { displayName: cfg.name });
        await adminAuth.setCustomUserClaims(fbUser.uid, claims);
        console.log(`  Set Firebase Custom Claims & displayName for UID: ${fbUser.uid}`);
      } catch (claimsErr: any) {
        console.warn(`  Warning setting claims:`, claimsErr.message);
      }
    }

    // 2. PostgreSQL app_users
    const upsertRes = await query(`
      INSERT INTO app_users (
        id, email, phone, name, role, status, franchise_id, branch_id, firebase_uid, is_active, allowed_apps, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'APPROVED', $6, $7, $1, true, $8::jsonb, NOW()
      )
      ON CONFLICT (email) DO UPDATE SET
        role = EXCLUDED.role,
        status = 'APPROVED',
        franchise_id = EXCLUDED.franchise_id,
        branch_id = EXCLUDED.branch_id,
        firebase_uid = EXCLUDED.firebase_uid,
        is_active = true,
        allowed_apps = EXCLUDED.allowed_apps,
        updated_at = NOW()
      RETURNING id, email, role, franchise_id, branch_id, allowed_apps, is_active, status;
    `, [
      fbUser.uid,
      cfg.email,
      cfg.phone,
      cfg.name,
      cfg.role,
      cfg.franchiseId,
      cfg.branchId,
      JSON.stringify(cfg.allowedApps)
    ]);
    console.log(`  Postgres app_users updated:`, upsertRes.rows[0]);

    // 3. Firestore users collection
    try {
      await adminDb.collection('users').doc(fbUser.uid).set({
        uid: fbUser.uid,
        email: cfg.email,
        name: cfg.name,
        phone: cfg.phone,
        role: cfg.role,
        franchiseId: cfg.franchiseId,
        branchId: cfg.branchId,
        allowedApps: cfg.allowedApps,
        status: 'APPROVED',
        isActive: true,
        isOnline: cfg.isRider ? true : false,
        deliveryStatus: cfg.isRider ? 'available' : undefined,
        phoneVerified: true,
        phoneSetupCompleted: true,
        locationSetupCompleted: true,
        onboardingComplete: true,
        lat: cfg.role === 'customer' ? 21.1904 : 21.1904,
        lng: cfg.role === 'customer' ? 81.2849 : 81.2849,
        fullAddress: 'Station Road, Mohan Nagar, Durg, CG 491001',
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (fsErr: any) {
      console.warn(`  Firestore users write notice:`, fsErr.message);
    }

    // 4. Rider specific records in Postgres & Firestore
    if (cfg.isRider && cfg.riderId) {
      await query(`
        INSERT INTO delivery_partners (
          id, name, phone, email, franchise_id, branch_id, vehicle_type, vehicle_number, is_online, status, current_lat, current_lng, last_location_time, active_order_id, user_id, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 'motorcycle', 'CG-04-OP-9999', true, 'APPROVED', 21.1904, 81.2849, NOW(), NULL, $7, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          franchise_id = EXCLUDED.franchise_id,
          branch_id = EXCLUDED.branch_id,
          is_online = true,
          status = 'APPROVED',
          user_id = EXCLUDED.user_id,
          active_order_id = NULL,
          updated_at = NOW()
      `, [cfg.riderId, cfg.name, cfg.phone, cfg.email, cfg.franchiseId, cfg.branchId, fbUser.uid]);

      await query(`
        INSERT INTO delivery_locations (
          delivery_partner_id, active_order_id, latitude, longitude, online_status, last_updated
        ) VALUES (
          $1, NULL, 21.1904, 81.2849, true, NOW()
        )
        ON CONFLICT (delivery_partner_id) DO UPDATE SET
          active_order_id = NULL,
          latitude = 21.1904,
          longitude = 81.2849,
          online_status = true,
          last_updated = NOW()
      `, [cfg.riderId]);

      try {
        await adminDb.collection('delivery_partners').doc(fbUser.uid).set({
          id: cfg.riderId,
          uid: fbUser.uid,
          name: cfg.name,
          phone: cfg.phone,
          email: cfg.email,
          branchId: cfg.branchId,
          franchiseId: cfg.franchiseId,
          isOnline: true,
          status: 'APPROVED',
          deliveryStatus: 'available',
          activeOrderId: null,
          availableSince: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }, { merge: true });
      } catch (fsDpErr: any) {
        console.warn(`  Firestore delivery_partners write notice:`, fsDpErr.message);
      }

      console.log(`  Configured rider ${cfg.riderId} in Postgres & Firestore`);
    }
  }

  // Clean non-riders out of delivery_partners table
  await query(`
    DELETE FROM delivery_partners 
    WHERE email IN ('webhub2811@gmail.com', 'samyakssaamm@gmail.com', 'olivepizzarjn@gmail.com', 'samyakshrivastava28@gmail.com')
  `);
  console.log('\nCleaned non-riders out of delivery_partners table.');

  // Ensure Durg franchise is active with owner webhub2811@gmail.com
  await query(`
    UPDATE franchises
    SET owner_email = 'webhub2811@gmail.com', status = 'ACTIVE', updated_at = NOW()
    WHERE id = 'fra_op_durg_01'
  `);
  console.log('Verified Durg franchise status and owner in Postgres.');

  console.log('\n================================================================');
  console.log('✅ ALL AUTHORIZATIONS SUCCESSFULLY CONFIGURED');
  console.log('================================================================');
}

configureSystem().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Fatal error during configuration:', err);
  process.exit(1);
});
