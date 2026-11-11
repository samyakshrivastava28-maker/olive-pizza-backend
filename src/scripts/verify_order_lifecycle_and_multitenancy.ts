import '../config/env.js';
import { adminAuth } from '../config/firebase.js';
import { query } from '../config/postgres.js';
import axios from 'axios';

const BASE_URL = 'http://localhost:5000';

async function getIdToken(uid: string, claims: Record<string, any> = {}): Promise<string> {
  const customToken = await adminAuth.createCustomToken(uid, claims);
  const apiKey = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('VITE_FIREBASE_API_KEY is missing');

  const response = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { token: customToken, returnSecureToken: true }
  );
  return response.data.idToken;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runE2ETest() {
  console.log('================================================================');
  console.log('OLIVE PIZZA — COMPREHENSIVE END-TO-END PLATFORM VERIFICATION');
  console.log('Testing: Order Placement, Auto Prep Time, Auto Rider Dispatch,');
  console.log('Multi-Franchise Isolation, and Rider Delivery Handshake.');
  console.log('================================================================\n');

  // STEP 0: Reset test state in PostgreSQL
  console.log('[Step 0] Cleaning test fixtures in PostgreSQL...');
  await query(`
    UPDATE canonical_orders 
    SET order_status = 'DELIVERED' 
    WHERE customer_id = 'usr_e2e_cust_01' 
      AND order_status NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED', 'FAILED')
  `);
  await query(`
    UPDATE delivery_partners 
    SET active_order_id = NULL, is_online = true, status = 'APPROVED'
    WHERE id IN ('rider_01', 'rider_02', 'rider_bsp_01')
  `);
  console.log('✅ Test fixtures initialized.\n');

  // STEP 1: Mint Tokens
  console.log('[Step 1] Minting authentic Firebase ID tokens...');
  const customerToken = await getIdToken('usr_e2e_cust_01', { role: 'customer' });
  const rjnManagerToken = await getIdToken('usr_mgr_rjn', { 
    role: 'restaurant_manager', 
    branchId: 'main_branch', 
    franchiseId: 'fra_rajnandgaon',
    allowedApps: ['RESTAURANT_MANAGER', 'POS']
  });
  const bspManagerToken = await getIdToken('usr_mgr_bsp', { 
    role: 'restaurant_manager', 
    branchId: 'branch_bsp_main', 
    franchiseId: 'fra_bilaspur',
    allowedApps: ['RESTAURANT_MANAGER', 'POS']
  });
  const rjnRiderToken = await getIdToken('rider_01', { 
    role: 'delivery_partner', 
    branchId: 'main_branch', 
    franchiseId: 'fra_rajnandgaon',
    allowedApps: ['DELIVERY']
  });
  const bspRiderToken = await getIdToken('rider_bsp_01', { 
    role: 'delivery_partner', 
    branchId: 'branch_bsp_main', 
    franchiseId: 'fra_bilaspur',
    allowedApps: ['DELIVERY']
  });
  console.log('✅ All 5 authenticated ID tokens successfully minted.\n');

  // Ensure test riders are available in PostgreSQL
  await query(`
    UPDATE delivery_partners
    SET active_order_id = NULL, is_online = true, status = 'APPROVED'
    WHERE id IN ('rider_01', 'rider_02', 'rider_bsp_01')
  `);
  console.log('✅ Test delivery partners reset to online & unassigned.\n');

  // STEP 2: Place Order for Rajnandgaon
  console.log('[Step 2] Placing Customer Order for Rajnandgaon (main_branch)...');
  const rjnOrderPayload = {
    items: [
      {
        id: 'prod_margherita',
        name: 'Margherita Pizza',
        price: 199,
        quantity: 1,
        variant: 'regular',
        crust: 'normal'
      }
    ],
    deliveryType: 'delivery',
    paymentMethod: 'COD',
    branchId: 'main_branch',
    franchiseId: 'fra_rajnandgaon',
    contactPhone: '9826199887',
    customerName: 'Aarav Sharma',
    deliveryAddress: {
      addressLine: 'Shop 12, Station Road, Rajnandgaon',
      lat: 21.0974,
      lng: 81.0347
    }
  };

  const createRes = await axios.post(`${BASE_URL}/api/orders`, rjnOrderPayload, {
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('Order Placement Response:', createRes.status, createRes.data?.success, createRes.data?.orderId);
  const rjnOrderId = createRes.data?.orderId || createRes.data?.order?.id;
  if (!rjnOrderId) throw new Error('Order creation failed to return orderId');

  const pgOrderCheck1 = await query('SELECT id, order_status, branch_id, franchise_id, total_amount FROM canonical_orders WHERE id = $1', [rjnOrderId]);
  console.log('PostgreSQL Canonical Order State:', pgOrderCheck1.rows[0]);
  if (pgOrderCheck1.rows.length === 0) throw new Error('Order not found in canonical_orders table!');
  console.log('✅ Order placed and canonically persisted.\n');

  // STEP 3: Auto Preparation Time Calculation on Acceptance
  console.log('[Step 3] Accepting Order via Restaurant Manager (Automatic Prep Time Assignment)...');
  const acceptRes = await axios.post(`${BASE_URL}/api/orders/${rjnOrderId}/accept`, {}, {
    headers: {
      Authorization: `Bearer ${rjnManagerToken}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('Accept Response Status:', acceptRes.status);
  console.log('Accept Response Body:', acceptRes.data);

  const pgOrderCheck2 = await query(
    'SELECT id, order_status, estimated_preparation_minutes, expected_ready_at, accepted_at FROM canonical_orders WHERE id = $1',
    [rjnOrderId]
  );
  console.log('PostgreSQL After Acceptance:', pgOrderCheck2.rows[0]);
  const prepMinutes = pgOrderCheck2.rows[0]?.estimated_preparation_minutes;
  const expectedReady = pgOrderCheck2.rows[0]?.expected_ready_at;
  console.log(`Auto Prep Time Calculated: ${prepMinutes} minutes, Expected Ready At: ${expectedReady}`);
  if (!prepMinutes || prepMinutes <= 0) throw new Error('estimated_preparation_minutes was not auto-assigned!');
  console.log('✅ Preparation time dynamically calculated and assigned.\n');

  // STEP 4: Kitchen Transitions to Ready -> Auto Rider Dispatch
  console.log('[Step 4] Kitchen marks order READY -> Verifying Automatic Rider Dispatch...');
  const readyRes = await axios.post(`${BASE_URL}/api/orders/${rjnOrderId}/status`, {
    status: 'ready'
  }, {
    headers: {
      Authorization: `Bearer ${rjnManagerToken}`,
      'Content-Type': 'application/json'
    }
  });
  console.log('Status Ready Response:', readyRes.status, readyRes.data);

  console.log('Waiting for asynchronous RiderDispatchEngine to lock & assign rider (polling up to 10s)...');
  let assignedRiderId: string | null = null;
  let pgOrderCheck3: any = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(1000);
    const res = await query(
      'SELECT id, order_status, delivery_partner_id, delivery_partner_name, delivery_partner_phone, partner_assigned_at FROM canonical_orders WHERE id = $1',
      [rjnOrderId]
    );
    if (res.rows[0]?.delivery_partner_id) {
      pgOrderCheck3 = res;
      assignedRiderId = res.rows[0].delivery_partner_id;
      break;
    }
    console.log(`  ...polling rider assignment (attempt ${attempt}/10)`);
  }
  console.log('PostgreSQL Order After Ready/Dispatch:', pgOrderCheck3?.rows[0]);
  console.log(`Assigned Rider ID: ${assignedRiderId} (${pgOrderCheck3?.rows[0]?.delivery_partner_name})`);
  if (!assignedRiderId) throw new Error('Rider was NOT automatically assigned upon ready status!');
  if (assignedRiderId === 'rider_bsp_01') throw new Error('Cross-tenant violation: Bilaspur rider assigned to Rajnandgaon order!');
  console.log('✅ Local branch rider automatically dispatched.\n');

  // STEP 5: Delivery Raider Handshake, Pickup & Delivery Completion
  console.log('[Step 5] Rider Handshake: Active Orders, Accept, Pickup, Complete...');

  // 5a. Cross-Rider Security Check: Verify unassigned rider cannot accept order assigned to another rider
  console.log('Testing Cross-Rider Access Protection (Unassigned rider attempts to accept)...');
  try {
    await axios.post(`${BASE_URL}/api/delivery/rider/orders/${rjnOrderId}/accept`, {}, {
      headers: { Authorization: `Bearer ${rjnRiderToken}` }
    });
    if (assignedRiderId !== 'rider_01') {
      throw new Error('SECURITY VIOLATION: Unassigned rider was able to accept another rider order!');
    }
  } catch (err: any) {
    if (err.response?.status === 403) {
      console.log('🔒 Security Confirmed: Unassigned rider blocked with 403 Forbidden.');
    } else if (assignedRiderId === 'rider_01') {
      // rider_01 was assigned
    } else {
      throw err;
    }
  }

  // Mint token for the dynamically assigned rider
  console.log(`Minting authenticated token for assigned rider (${assignedRiderId})...`);
  const assignedRiderToken = await getIdToken(assignedRiderId, { 
    role: 'delivery_partner', 
    branchId: 'main_branch', 
    franchiseId: 'fra_rajnandgaon',
    allowedApps: ['DELIVERY']
  });

  const activeOrdersRes = await axios.get(`${BASE_URL}/api/delivery/rider/active-orders`, {
    headers: { Authorization: `Bearer ${assignedRiderToken}` }
  });
  console.log(`Assigned Rider Active Orders Count: ${activeOrdersRes.data?.orders?.length || 0}`);

  // Rider accepts
  const riderAcceptRes = await axios.post(`${BASE_URL}/api/delivery/rider/orders/${rjnOrderId}/accept`, {}, {
    headers: { Authorization: `Bearer ${assignedRiderToken}` }
  });
  console.log('Rider Accept Delivery Status:', riderAcceptRes.status, riderAcceptRes.data?.success);

  // Rider picks up
  const riderPickupRes = await axios.post(`${BASE_URL}/api/delivery/rider/orders/${rjnOrderId}/pickup`, {}, {
    headers: { Authorization: `Bearer ${assignedRiderToken}` }
  });
  console.log('Rider Pickup Status:', riderPickupRes.status, riderPickupRes.data?.success);

  const pgOrderCheck4 = await query('SELECT order_status FROM canonical_orders WHERE id = $1', [rjnOrderId]);
  console.log('Order Status After Pickup:', pgOrderCheck4.rows[0]?.order_status);

  // Rider collects cash for COD order
  console.log('Rider collecting COD payment...');
  const cashCollectRes = await axios.post(`${BASE_URL}/api/payment/cod/cash-collect`, {
    orderId: rjnOrderId,
    amount: 259,
    clientCoordinates: { lat: 21.0974, lng: 81.0347 }
  }, {
    headers: { Authorization: `Bearer ${assignedRiderToken}` }
  });
  console.log('Cash Collection Status:', cashCollectRes.status, cashCollectRes.data?.paymentStatus);

  // Rider completes delivery
  const riderCompleteRes = await axios.post(`${BASE_URL}/api/delivery/rider/orders/${rjnOrderId}/complete`, {
    notes: 'Delivered to customer successfully',
    clientCoordinates: { lat: 21.0974, lng: 81.0347 }
  }, {
    headers: { Authorization: `Bearer ${assignedRiderToken}` }
  });
  console.log('Rider Complete Delivery Status:', riderCompleteRes.status, riderCompleteRes.data?.success);

  const pgOrderCheck5 = await query(
    'SELECT id, order_status, delivered_at FROM canonical_orders WHERE id = $1',
    [rjnOrderId]
  );
  console.log('Final Order Status in PostgreSQL:', pgOrderCheck5.rows[0]);
  if (pgOrderCheck5.rows[0]?.order_status !== 'DELIVERED') {
    throw new Error(`Order status is ${pgOrderCheck5.rows[0]?.order_status}, expected DELIVERED!`);
  }

  const billCheck = await query(
    'SELECT id, permanent_bill_no, payment_status, net_amount FROM canonical_bills WHERE order_id = $1',
    [rjnOrderId]
  );
  console.log('Canonical Bill State:', billCheck.rows[0]);
  console.log('✅ Complete rider delivery lifecycle verified.\n');

  // STEP 6: Multi-Franchise Isolation Test (Bilaspur vs Rajnandgaon)
  console.log('================================================================');
  console.log('[Step 6] Multi-Franchise Isolation & Auto Dispatch (Bilaspur Branch)');
  console.log('================================================================');

  const bspOrderPayload = {
    items: [
      {
        id: 'prod_farmhouse',
        name: 'Farmhouse Special Pizza',
        price: 349,
        quantity: 1,
        variant: 'regular',
        crust: 'normal'
      }
    ],
    deliveryType: 'delivery',
    paymentMethod: 'COD',
    branchId: 'branch_bsp_main',
    franchiseId: 'fra_bilaspur',
    contactPhone: '9826199887',
    customerName: 'Aarav Sharma',
    deliveryAddress: {
      addressLine: 'Link Road, Bilaspur',
      lat: 22.0797,
      lng: 82.1409
    }
  };

  const bspCreateRes = await axios.post(`${BASE_URL}/api/orders`, bspOrderPayload, {
    headers: {
      Authorization: `Bearer ${customerToken}`,
      'Content-Type': 'application/json'
    }
  });

  const bspOrderId = bspCreateRes.data?.orderId || bspCreateRes.data?.order?.id;
  console.log('Bilaspur Order Placed:', bspOrderId);

  // Cross-Franchise Access Control Check: Rajnandgaon manager attempts to view or accept Bilaspur order
  console.log('Testing Cross-Tenant Access Protection...');
  try {
    await axios.post(`${BASE_URL}/api/orders/${bspOrderId}/accept`, {}, {
      headers: { Authorization: `Bearer ${rjnManagerToken}` }
    });
    throw new Error('SECURITY VIOLATION: Rajnandgaon manager was able to accept Bilaspur order!');
  } catch (err: any) {
    if (err.response?.status === 403) {
      console.log('🔒 Security Confirmed: Rajnandgaon manager blocked with 403 Forbidden on Bilaspur order.');
    } else {
      throw err;
    }
  }

  // Bilaspur Manager accepts
  console.log('Bilaspur Manager accepting Bilaspur order...');
  const bspAcceptRes = await axios.post(`${BASE_URL}/api/orders/${bspOrderId}/accept`, {}, {
    headers: { Authorization: `Bearer ${bspManagerToken}` }
  });
  console.log('Bilaspur Accept Status:', bspAcceptRes.status, bspAcceptRes.data);

  // Transition to ready
  console.log('Bilaspur kitchen transitions order to READY...');
  await axios.post(`${BASE_URL}/api/orders/${bspOrderId}/status`, {
    status: 'ready'
  }, {
    headers: { Authorization: `Bearer ${bspManagerToken}` }
  });

  console.log('Waiting for Bilaspur auto-rider dispatch (polling up to 10s)...');
  let pgBspCheck: any = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(1000);
    const res = await query(
      'SELECT id, order_status, delivery_partner_id, delivery_partner_name, branch_id FROM canonical_orders WHERE id = $1',
      [bspOrderId]
    );
    if (res.rows[0]?.delivery_partner_id) {
      pgBspCheck = res;
      break;
    }
    console.log(`  ...polling Bilaspur rider assignment (attempt ${attempt}/10)`);
  }
  console.log('PostgreSQL Bilaspur Order Dispatch:', pgBspCheck?.rows[0]);
  if (pgBspCheck?.rows[0]?.delivery_partner_id !== 'rider_bsp_01') {
    throw new Error(`Expected Bilaspur rider rider_bsp_01, got ${pgBspCheck?.rows[0]?.delivery_partner_id}!`);
  }
  console.log('✅ Bilaspur order strictly dispatched to Bilaspur rider (rider_bsp_01). Cross-tenant isolation 100% verified!\n');

  // Bilaspur Rider completes delivery
  console.log('Bilaspur Rider (rider_bsp_01) accepting, picking up, and completing delivery...');
  await axios.post(`${BASE_URL}/api/delivery/rider/orders/${bspOrderId}/accept`, {}, {
    headers: { Authorization: `Bearer ${bspRiderToken}` }
  });
  await axios.post(`${BASE_URL}/api/delivery/rider/orders/${bspOrderId}/pickup`, {}, {
    headers: { Authorization: `Bearer ${bspRiderToken}` }
  });
  // Bilaspur Rider collects cash for COD order
  console.log('Bilaspur Rider collecting COD payment...');
  const bspOrderData = await query('SELECT total_amount FROM canonical_orders WHERE id = $1', [bspOrderId]);
  const bspAmount = Number(bspOrderData.rows[0]?.total_amount || 409);
  await axios.post(`${BASE_URL}/api/payment/cod/cash-collect`, {
    orderId: bspOrderId,
    amount: bspAmount,
    clientCoordinates: { lat: 22.0797, lng: 82.1409 }
  }, {
    headers: { Authorization: `Bearer ${bspRiderToken}` }
  });

  await axios.post(`${BASE_URL}/api/delivery/rider/orders/${bspOrderId}/complete`, { 
    notes: 'Delivered in Bilaspur',
    clientCoordinates: { lat: 22.0797, lng: 82.1409 }
  }, {
    headers: { Authorization: `Bearer ${bspRiderToken}` }
  });

  const pgBspFinal = await query('SELECT order_status FROM canonical_orders WHERE id = $1', [bspOrderId]);
  console.log('Bilaspur Final Order Status in PostgreSQL:', pgBspFinal.rows[0]?.order_status);
  if (pgBspFinal.rows[0]?.order_status !== 'DELIVERED') {
    throw new Error('Bilaspur order failed to reach DELIVERED status!');
  }
  console.log('✅ Bilaspur complete delivery lifecycle verified.\n');

  console.log('================================================================');
  console.log('🏆 ALL E2E PLATFORM TESTS PASSED SUCCESSFULLY! 🏆');
  console.log('================================================================');
  process.exit(0);
}

runE2ETest().catch(err => {
  console.error('\n❌ E2E TEST FAILED:', err.response?.data || err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
