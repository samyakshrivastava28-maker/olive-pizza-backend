import { adminAuth } from '../src/config/firebase.js';

async function testAllAuthorizations() {
  console.log('======================================================================');
  console.log('🧪 Olive Pizza — Database-Indexed Multi-App Authorization Test Suite');
  console.log('======================================================================\n');

  const testMatrix = [
    { targetApp: 'OWNER', email: 'webhub2811@gmail.com', uid: 'admin_webhub', expectAuth: true, label: 'Owner (Master Admin) -> OWNER APP' },
    { targetApp: 'RESTAURANT_MANAGER', email: 'olivepizzarjn@gmail.com', uid: 'admin_olive', expectAuth: true, label: 'Restaurant Owner -> RESTAURANT MANAGER APP' },
    { targetApp: 'RESTAURANT_MANAGER', email: 'manager@olivepizza.in', uid: 'staff_manager_01', expectAuth: true, label: 'Store Manager -> RESTAURANT MANAGER APP' },
    { targetApp: 'FRANCHISE_MANAGER', email: 'webhub2811@gmail.com', uid: 'admin_webhub', expectAuth: true, label: 'Franchise Head -> FRANCHISE MANAGER APP' },
    { targetApp: 'DELIVERY', email: 'rider@olivepizza.in', uid: 'staff_rider_01', expectAuth: true, label: 'Delivery Rider -> DELIVERY APP' },
    { targetApp: 'POS', email: 'cashier@olivepizza.in', uid: 'staff_cashier_01', expectAuth: true, label: 'Cashier Terminal -> POS APP' },
    { targetApp: 'CUSTOMER', email: 'customer@gmail.com', uid: 'cust_default_01', expectAuth: true, label: 'Customer -> CUSTOMER APP' },
    { targetApp: 'OWNER', email: 'customer@gmail.com', uid: 'cust_default_01', expectAuth: false, label: 'Unauthorized Customer -> OWNER APP (Must Be Denied)' },
    { targetApp: 'RESTAURANT_MANAGER', email: 'customer@gmail.com', uid: 'cust_default_01', expectAuth: false, label: 'Unauthorized Customer -> RESTAURANT APP (Must Be Denied)' },
    { targetApp: 'DELIVERY', email: 'customer@gmail.com', uid: 'cust_default_01', expectAuth: false, label: 'Unauthorized Customer -> DELIVERY APP (Must Be Denied)' }
  ];

  const apiKey = 'AIzaSyAqkcY-WQrW3WoZWRrv8oo7MTAI_nVrLw4';
  let passedCount = 0;

  const tokenCache: Record<string, string> = {};

  for (const tc of testMatrix) {
    try {
      let idToken = tokenCache[tc.uid];
      if (!idToken) {
        const customToken = await adminAuth.createCustomToken(tc.uid, { email: tc.email });
        const exchangeRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customToken, returnSecureToken: true })
        });
        const authData: any = await exchangeRes.json();
        if (!authData.idToken) {
          console.error(`❌ Token exchange failed for ${tc.email}:`, authData);
          continue;
        }
        idToken = authData.idToken;
        tokenCache[tc.uid] = idToken;
      }

      // 3. Call /api/auth/authorize-app
      const authRes = await fetch('http://localhost:5000/api/auth/authorize-app', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({
          targetApp: tc.targetApp,
          requestedBranchId: 'main_branch'
        })
      });

      const resData = await authRes.json();
      const isAuthorized = authRes.status === 200 && resData.authorized === true;

      if (isAuthorized === tc.expectAuth) {
        console.log(`✅ PASS: ${tc.label}`);
        console.log(`   Status: HTTP ${authRes.status} | Authorized: ${resData.authorized} | Role: ${resData.user?.role || 'N/A'}`);
        passedCount++;
      } else {
        console.error(`❌ FAIL: ${tc.label}`);
        console.error(`   Expected authorized=${tc.expectAuth}, got HTTP ${authRes.status}`, resData);
      }
    } catch (err: any) {
      console.error(`💥 ERROR on ${tc.label}:`, err.message);
    }
  }

  console.log('\n======================================================================');
  console.log(`🏁 Result: ${passedCount}/${testMatrix.length} Authorization Tests Passed!`);
  console.log('======================================================================');
  process.exit(passedCount === testMatrix.length ? 0 : 1);
}

testAllAuthorizations();
