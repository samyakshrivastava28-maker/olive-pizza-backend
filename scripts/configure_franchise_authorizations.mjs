import { createRequire } from 'module';
import path from 'path';

const require = createRequire('C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\package.json');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const admin = require('firebase-admin');

dotenv.config({ path: 'C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  const serviceAccount = require('C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\service-account.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const adminAuth = admin.auth();
const adminDb = admin.firestore();

async function getOrCreateFirebaseUser(email, defaultName, defaultPhone) {
  try {
    const user = await adminAuth.getUserByEmail(email);
    return user;
  } catch (err) {
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
  console.log('--- 1. CONFIGURING POSTGRESQL & FIREBASE AUTHORIZATIONS ---');

  // Verify branch IDs in restaurant_branches
  const branchesRes = await pool.query(`SELECT id, franchise_id, name FROM restaurant_branches`);
  console.log('Available restaurant branches:', branchesRes.rows);

  // Ensure branch_rjn_main and main_branch both exist or are consistent
  // For RJN: check if main_branch exists
  const rjnBranch = branchesRes.rows.find(b => b.franchise_id === 'fra_rajnandgaon')?.id || 'main_branch';
  const durgBranch = branchesRes.rows.find(b => b.franchise_id === 'fra_op_durg_01')?.id || 'fra_op_durg_01_main_branch';
  console.log(`Using RJN Branch: ${rjnBranch}, Durg Branch: ${durgBranch}`);

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
      name: 'Webhub Durg Owner',
      role: 'owner', // Grants OWNER & FRANCHISE_MANAGER
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
      name: 'Samyak RJN Delivery Rider',
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
      name: 'Samyak Durg Delivery Rider',
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
      name: 'Test Customer Samyak',
      role: 'customer',
      franchiseId: 'fra_op_durg_01',
      branchId: durgBranch,
      allowedApps: ['CUSTOMER'],
      phone: '+919876543210'
    }
  ];

  for (const cfg of userConfigs) {
    console.log(`\nConfiguring user: ${cfg.email} (${cfg.role})...`);
    
    // 1. Firebase Auth
    let fbUser;
    try {
      fbUser = await getOrCreateFirebaseUser(cfg.email, cfg.name, cfg.phone);
    } catch (e) {
      console.warn(`  Warning fetching Firebase user ${cfg.email}:`, e.message);
      fbUser = { uid: `uid_${cfg.email.split('@')[0]}` };
    }

    const claims = {
      role: cfg.role,
      allowedApps: cfg.allowedApps,
      franchiseId: cfg.franchiseId,
      branchId: cfg.branchId
    };

    if (fbUser.uid && !fbUser.uid.startsWith('uid_')) {
      await adminAuth.setCustomUserClaims(fbUser.uid, claims);
      console.log(`  Set Firebase Custom Claims for UID: ${fbUser.uid}`);
    }

    // 2. PostgreSQL app_users
    // Upsert into app_users
    const upsertRes = await pool.query(`
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
      updatedAt: new Date().toISOString()
    }, { merge: true });

    // 4. If rider, configure delivery_partners & delivery_locations
    if (cfg.isRider && cfg.riderId) {
      await pool.query(`
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

      await pool.query(`
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

      console.log(`  Configured rider ${cfg.riderId} in Postgres & Firestore`);
    }
  }

  // Clean up delivery_partners so managers/owners are NOT in delivery_partners
  await pool.query(`
    DELETE FROM delivery_partners WHERE email IN ('webhub2811@gmail.com', 'samyakssaamm@gmail.com', 'olivepizzarjn@gmail.com', 'samyakshrivastava28@gmail.com')
  `);
  console.log('Cleaned non-riders out of delivery_partners table.');

  // Ensure franchises table has Durg with webhub2811@gmail.com
  await pool.query(`
    UPDATE franchises
    SET owner_email = 'webhub2811@gmail.com', status = 'ACTIVE', updated_at = NOW()
    WHERE id = 'fra_op_durg_01'
  `);

  console.log('--- ALL AUTHORIZATIONS SUCCESSFULLY CONFIGURED ---');
  await pool.end();
}

configureSystem().catch(err => {
  console.error('Fatal configuration error:', err);
  process.exit(1);
});
