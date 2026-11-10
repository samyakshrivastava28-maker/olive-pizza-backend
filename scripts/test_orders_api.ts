import { adminAuth } from '../src/config/firebase.js';

async function testOrdersApi() {
  try {
    // Mint customer token
    const custToken = await adminAuth.createCustomToken('cust_default_01', { role: 'customer' });
    const apiKey = 'AIzaSyAqkcY-WQrW3WoZWRrv8oo7MTAI_nVrLw4';
    const exchangeRes = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: custToken, returnSecureToken: true })
    });
    const { idToken } = await exchangeRes.json();

    console.log('Customer idToken obtained:', !!idToken);

    const ordersRes = await fetch('http://localhost:5000/api/orders', {
      headers: { Authorization: `Bearer ${idToken}` }
    });
    const orders = await ordersRes.json();
    console.log('Orders returned for customer:', Array.isArray(orders) ? orders.length : orders);
    if (Array.isArray(orders)) {
      const active = orders.filter(o => ['pending', 'accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery'].includes((o.status || '').toLowerCase()));
      console.log('Active orders for customer:', active.length);
      active.forEach(a => console.log('  Active:', a.id, a.status));
      const terminal = orders.filter(o => ['delivered', 'cancelled'].includes((o.status || '').toLowerCase()));
      console.log('Delivered / Cancelled orders for customer:', terminal.length);
    }

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}
testOrdersApi();
