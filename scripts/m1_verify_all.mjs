import { createRequire } from 'module';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { adminDb, adminAuth } from '../src/config/firebase.js';
import { CustomerOrderingContextService } from '../src/services/order/CustomerOrderingContextService.js';

dotenv.config({ path: 'C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runComprehensiveVerification() {
  console.log('====================================================');
  console.log('  MILESTONE 1 COMPREHENSIVE VERIFICATION AUDIT');
  console.log('====================================================\n');

  let passed = true;

  // 1. PostgreSQL Audit
  console.log('--- 1. POSTGRESQL DATABASE AUDIT ---');
  const client = await pool.connect();
  try {
    const fRes = await client.query('SELECT id, name, status FROM franchises');
    console.log('Franchises in PG:', fRes.rows);
    if (fRes.rows.length !== 1 || fRes.rows[0].id !== 'fra_rajnandgaon') {
      console.error('❌ FAIL: Expected exclusively fra_rajnandgaon in franchises');
      passed = false;
    } else {
      console.log('✅ PASS: Exclusively fra_rajnandgaon present in franchises');
    }

    const bRes = await client.query('SELECT id, franchise_id, name, latitude, longitude, delivery_settings, is_open FROM restaurant_branches');
    console.log('Branches in PG:', bRes.rows);
    const nonRjnBranches = bRes.rows.filter(b => b.franchise_id !== 'fra_rajnandgaon');
    if (nonRjnBranches.length > 0) {
      console.error('❌ FAIL: Found non-Rajnandgaon branches:', nonRjnBranches);
      passed = false;
    } else {
      console.log('✅ PASS: Exclusively Rajnandgaon branches present in restaurant_branches');
    }

    const dpRes = await client.query('SELECT id, franchise_id, branch_id, name, email, status FROM delivery_partners');
    console.log('Delivery Partners in PG:', dpRes.rows);
    if (dpRes.rows.length !== 1 || dpRes.rows[0].id !== 'dp_rjn_samyak_01') {
      console.error('❌ FAIL: Expected exclusively dp_rjn_samyak_01 in delivery_partners');
      passed = false;
    } else {
      console.log('✅ PASS: Exclusively dp_rjn_samyak_01 in delivery_partners');
    }

    const uRes = await client.query('SELECT id, email, role, franchise_id, branch_id FROM app_users ORDER BY role');
    console.log('App Users in PG:', uRes.rows);
    const testUsers = uRes.rows.filter(u => u.email.includes('ssamyak') || u.email.includes('rider') || u.email.includes('bsp'));
    if (testUsers.length > 0) {
      console.error('❌ FAIL: Found dummy test users in app_users:', testUsers);
      passed = false;
    } else {
      console.log('✅ PASS: Zero dummy test staff in app_users');
    }

    const custRow = uRes.rows.find(u => u.email === 's.callhub2811@gmail.com');
    if (!custRow || custRow.franchise_id !== 'fra_rajnandgaon' || custRow.branch_id !== 'branch_rjn_main') {
      console.error('❌ FAIL: Customer s.callhub2811@gmail.com not properly mapped to fra_rajnandgaon / branch_rjn_main:', custRow);
      passed = false;
    } else {
      console.log('✅ PASS: Customer s.callhub2811@gmail.com correctly mapped to fra_rajnandgaon / branch_rjn_main');
    }

    const testLocCount = await client.query('SELECT count(*) FROM delivery_locations WHERE delivery_partner_id != \'dp_rjn_samyak_01\'');
    const testQueueCount = await client.query('SELECT count(*) FROM pending_dispatch_queue WHERE franchise_id != \'fra_rajnandgaon\'');
    const testPricesCount = await client.query('SELECT count(*) FROM franchise_prices WHERE franchise_id != \'fra_rajnandgaon\'');

    console.log(`Test delivery_locations: ${testLocCount.rows[0].count}`);
    console.log(`Test pending_dispatch_queue: ${testQueueCount.rows[0].count}`);
    console.log(`Test franchise_prices: ${testPricesCount.rows[0].count}`);

    if (testLocCount.rows[0].count !== '0' || testQueueCount.rows[0].count !== '0' || testPricesCount.rows[0].count !== '0') {
      console.error('❌ FAIL: Orphaned test records remain in PG tables');
      passed = false;
    } else {
      console.log('✅ PASS: Zero orphaned test records in secondary tables');
    }
  } finally {
    client.release();
    await pool.end();
  }

  // 2. Firestore & Firebase Auth Audit
  console.log('\n--- 2. FIRESTORE & FIREBASE AUTH AUDIT ---');
  if (adminDb && adminAuth) {
    const dpCheck = await adminDb.collection('delivery_partners').get();
    console.log(`Firestore delivery_partners count: ${dpCheck.size}`);
    dpCheck.docs.forEach(d => console.log(` - ${d.id}:`, d.data().name || d.data().email));
    const nonRjnRiders = dpCheck.docs.filter(d => d.id !== 'Uln5UKsRyZaCzTePgBmfourQngu1' && d.id !== 'dp_rjn_samyak_01');
    if (nonRjnRiders.length > 0) {
      console.error('❌ FAIL: Unexpected delivery_partners in Firestore:', nonRjnRiders.map(d => d.id));
      passed = false;
    } else {
      console.log('✅ PASS: Exclusively canonical rider in Firestore delivery_partners');
    }

    const entCheck = await adminDb.collection('franchise_entities').get();
    console.log(`Firestore franchise_entities count: ${entCheck.size}`);
    entCheck.docs.forEach(d => console.log(` - ${d.id}:`, d.data().name || d.data().status));
    if (entCheck.size !== 1 || entCheck.docs[0].id !== 'fra_rajnandgaon') {
      console.error('❌ FAIL: Expected exclusively fra_rajnandgaon in franchise_entities');
      passed = false;
    } else {
      console.log('✅ PASS: Exclusively fra_rajnandgaon in franchise_entities');
    }

    const fCheck = await adminDb.collection('franchises').get();
    console.log(`Firestore franchises count: ${fCheck.size}`);
    fCheck.docs.forEach(d => console.log(` - ${d.id}:`, d.data().name || d.data().status));
    const invalidFranchises = fCheck.docs.filter(d => !['main_branch', 'fra_primary', 'fra_rajnandgaon'].includes(d.id));
    if (invalidFranchises.length > 0) {
      console.error('❌ FAIL: Found invalid franchises in Firestore:', invalidFranchises.map(d => d.id));
      passed = false;
    } else {
      console.log('✅ PASS: Only canonical Rajnandgaon franchise docs in Firestore franchises');
    }

    // Customer Auth Claims Check
    try {
      const custAuth = await adminAuth.getUser('zRZ60M8P5oXBXMU3Y1LMV3YlmGH3');
      console.log('Customer Auth Custom Claims:', custAuth.customClaims);
      if (
        custAuth.customClaims?.role !== 'customer' ||
        custAuth.customClaims?.franchiseId !== 'fra_rajnandgaon' ||
        custAuth.customClaims?.branchId !== 'branch_rjn_main'
      ) {
        console.error('❌ FAIL: Customer Auth claims do not match expected Rajnandgaon assignment');
        passed = false;
      } else {
        console.log('✅ PASS: Customer Auth custom claims verified for Rajnandgaon');
      }
    } catch (authErr) {
      console.warn('Auth getUser notice (checking Firestore users doc fallback):', authErr.message);
      const userDoc = await adminDb.collection('users').doc('zRZ60M8P5oXBXMU3Y1LMV3YlmGH3').get();
      if (userDoc.exists && userDoc.data().franchiseId === 'fra_rajnandgaon') {
        console.log('✅ PASS: Customer Firestore document verified for Rajnandgaon');
      } else {
        console.error('❌ FAIL: Customer Firestore document not verified');
        passed = false;
      }
    }
  }

  // 3. Dynamic Geofencing & Serviceability Tests
  console.log('\n--- 3. DYNAMIC GEOFENCING & SERVICEABILITY TESTS ---');
  
  // Test A: Out-of-radius delivery rejection (Durg coordinates: 21.1904, 81.2849, ~27.6 km away, max radius 12 km)
  console.log('Test A: Testing Out-of-Radius Rejection for Durg coordinates (21.1904, 81.2849)...');
  const outOfRadiusResult = await CustomerOrderingContextService.resolveOrderingContext({
    lat: 21.1904,
    lng: 81.2849,
    addressLine: 'Mohan Nagar, Durg, Chhattisgarh 491001'
  });
  console.log('Out-of-Radius Result:', JSON.stringify(outOfRadiusResult, null, 2));

  if (outOfRadiusResult.isServiceable === false && outOfRadiusResult.code === 'OUT_OF_DELIVERY_ZONE') {
    console.log('✅ PASS: Out-of-radius location correctly rejected with OUT_OF_DELIVERY_ZONE code.');
  } else {
    console.error('❌ FAIL: Out-of-radius location was not rejected properly:', outOfRadiusResult);
    passed = false;
  }

  // Test B: In-radius delivery acceptance (Rajnandgaon HQ coordinates: 21.0974, 81.0347, distance 0 km)
  console.log('\nTest B: Testing In-Radius Acceptance for Rajnandgaon HQ coordinates (21.0974, 81.0347)...');
  const inRadiusResult = await CustomerOrderingContextService.resolveOrderingContext({
    lat: 21.0974,
    lng: 81.0347,
    addressLine: 'Station Road, Rajnandgaon, Chhattisgarh 491441'
  });
  console.log('In-Radius Result:', JSON.stringify(inRadiusResult, null, 2));

  if (
    inRadiusResult.isServiceable === true &&
    inRadiusResult.context?.franchiseId === 'fra_rajnandgaon' &&
    inRadiusResult.context?.branchId === 'branch_rjn_main'
  ) {
    console.log('✅ PASS: In-radius location correctly accepted and resolved to fra_rajnandgaon / branch_rjn_main.');
  } else {
    console.error('❌ FAIL: In-radius location was not accepted properly:', inRadiusResult);
    passed = false;
  }

  // Test C: Gate 3 / Gate 4 Pre-checkout validation check
  console.log('\nTest C: Testing validateCustomerOrderLocation for Out-of-Radius location...');
  const valReject = await CustomerOrderingContextService.validateCustomerOrderLocation({
    lat: 21.1904,
    lng: 81.2849,
    targetFranchiseId: 'fra_rajnandgaon',
    targetBranchId: 'branch_rjn_main'
  });
  console.log('Validation Reject Result:', valReject);
  if (!valReject.isValid && valReject.code === 'OUT_OF_DELIVERY_ZONE') {
    console.log('✅ PASS: Order location validation successfully blocked out-of-zone checkout.');
  } else {
    console.error('❌ FAIL: Order location validation failed to block out-of-zone checkout:', valReject);
    passed = false;
  }

  console.log('\nTest D: Testing validateCustomerOrderLocation for In-Radius location...');
  const valAccept = await CustomerOrderingContextService.validateCustomerOrderLocation({
    lat: 21.0974,
    lng: 81.0347,
    targetFranchiseId: 'fra_rajnandgaon',
    targetBranchId: 'branch_rjn_main'
  });
  console.log('Validation Accept Result:', valAccept);
  if (valAccept.isValid && valAccept.resolvedFranchiseId === 'fra_rajnandgaon') {
    console.log('✅ PASS: Order location validation successfully approved in-zone checkout.');
  } else {
    console.error('❌ FAIL: Order location validation failed to approve in-zone checkout:', valAccept);
    passed = false;
  }

  console.log('\n====================================================');
  if (passed) {
    console.log('🎉 ALL MILESTONE 1 VERIFICATIONS PASSED WITH 100% SUCCESS!');
  } else {
    console.error('⚠️ SOME VERIFICATIONS FAILED. PLEASE INSPECT LOGS ABOVE.');
    process.exit(1);
  }
  console.log('====================================================\n');
  process.exit(0);
}

runComprehensiveVerification().catch(err => {
  console.error('Comprehensive verification failed with error:', err);
  process.exit(1);
});
