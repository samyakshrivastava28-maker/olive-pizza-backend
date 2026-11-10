import assert from 'assert';
import { RestaurantTemplates, DeliveryTemplates } from '../services/notification/NotificationTemplates.js';

async function runTests() {
  console.log('=== RUNNING CRITICAL ORDER ALERT TEMPLATE TESTS ===\n');

  // 1. TEST: RestaurantTemplates.newOrder with 5 items, rich customizations, COD
  console.log('Test 1: RestaurantTemplates.newOrder — Complete items, no truncation, COD collection');
  const items = [
    { name: 'Farmhouse Pizza', quantity: 2, size: 'Medium', crust: 'Cheese Burst', addOns: [{ name: 'Extra Cheese', price: 40 }], price: 350, totalItemPrice: 780 },
    { name: 'Veggie Paradise', quantity: 1, size: 'Large', crust: 'Thin Crust', addOns: [{ name: 'Jalapenos', price: 30 }, { name: 'Olives', price: 30 }], price: 450, totalItemPrice: 510 },
    { name: 'Garlic Breadsticks', quantity: 2, price: 120, totalItemPrice: 240 },
    { name: 'Stuffed Garlic Bread', quantity: 1, addOns: [{ name: 'Dip', price: 25 }], price: 150, totalItemPrice: 175 },
    { name: 'Choco Lava Cake', quantity: 3, price: 99, totalItemPrice: 297 },
  ];

  const pricing = {
    subtotal: 2002,
    packagingFee: 40,
    deliveryFee: 50,
    taxAmount: 105,
    discountAmount: 100,
    grandTotal: 2097,
  };

  const payloadCod = RestaurantTemplates.newOrder('ord_test_998877', {
    orderNumber: 'OP-104',
    customerName: 'Rahul Sharma',
    phone: '+919876543210',
    deliveryAddress: 'Flat 402, Royal Palms, Rajnandgaon',
    deliveryInstructions: 'Ring bell twice, leave at door if no answer',
    lat: 21.0975,
    lng: 81.0315,
    items,
    financials: {
      subtotal: pricing.subtotal,
      packagingCharge: pricing.packagingFee,
      deliveryFee: pricing.deliveryFee,
      taxes: pricing.taxAmount,
      discount: pricing.discountAmount,
      total: pricing.grandTotal,
    },
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    cashToCollect: 2097,
    orderType: 'delivery',
    totalAmount: 2097,
  });

  // Verify Title and Urgency
  const notif = payloadCod.notification!;
  assert.ok(notif, 'Top-level notification must be defined');
  assert.ok(notif.title.includes('OP-104'), 'Title must contain order number');
  assert.ok(notif.title.includes('2097'), 'Title must contain grand total');
  assert.strictEqual(payloadCod.android.priority, 'high');
  assert.strictEqual(payloadCod.android.notification.sound, 'new_order');

  // Verify Body has NO truncation (all 5 items must appear)
  assert.ok(notif.body.includes('Farmhouse Pizza'), 'Must contain item 1');
  assert.ok(notif.body.includes('Veggie Paradise'), 'Must contain item 2');
  assert.ok(notif.body.includes('Garlic Breadsticks'), 'Must contain item 3');
  assert.ok(notif.body.includes('Stuffed Garlic Bread'), 'Must contain item 4');
  assert.ok(notif.body.includes('Choco Lava Cake'), 'Must contain item 5');
  assert.ok(!notif.body.includes('more items'), 'Must NOT have truncation ("more items")');

  // Verify Customizations in Body
  assert.ok(notif.body.includes('Cheese Burst'), 'Must contain crust');
  assert.ok(notif.body.includes('Medium'), 'Must contain size');
  assert.ok(notif.body.includes('Extra Cheese'), 'Must contain add-on name');
  assert.ok(notif.body.includes('+₹40'), 'Must contain add-on price');

  // Verify Payment Callout
  assert.ok(notif.body.includes('CASH TO COLLECT: ₹2097'), 'Must explicitly display cash to collect for COD');

  // Verify Customer Phone & Address & Instructions
  assert.ok(notif.body.includes('+919876543210'), 'Must include customer phone');
  assert.ok(notif.body.includes('Royal Palms'), 'Must include address');
  assert.ok(notif.body.includes('Ring bell twice'), 'Must include customer instructions');

  // Verify data fullOrderJson
  assert.ok(payloadCod.data.fullOrderJson, 'data must include serialized fullOrderJson');
  const parsedJson = JSON.parse(payloadCod.data.fullOrderJson);
  assert.strictEqual(parsedJson.items.length, 5, 'fullOrderJson must have all 5 items');
  assert.strictEqual(parsedJson.customer.phone, '+919876543210');
  assert.strictEqual(parsedJson.financials.total, 2097);
  assert.strictEqual(parsedJson.cashToCollect, 2097);

  // Verify Webpush / APNs Action Buttons
  const actions = payloadCod.webpush.notification.actions;
  assert.strictEqual(actions?.length, 4, 'Must provide 4 action buttons');
  assert.strictEqual(actions?.[0].action, 'ACCEPT');
  assert.strictEqual(actions?.[0].title, 'ACCEPT ORDER');
  assert.strictEqual(actions?.[1].action, 'REJECT');
  assert.strictEqual(actions?.[1].title, 'REJECT ORDER');
  assert.strictEqual(actions?.[2].action, 'VIEW');
  assert.strictEqual(actions?.[2].title, 'VIEW FULL ORDER');
  assert.strictEqual(actions?.[3].action, 'OPEN_LOCATION');
  assert.strictEqual(actions?.[3].title, 'OPEN LOCATION');

  console.log('  -> PASS: RestaurantTemplates.newOrder COD verified.\n');

  // 2. TEST: RestaurantTemplates.newOrder with Online Payment
  console.log('Test 2: RestaurantTemplates.newOrder — Online Payment verified');
  const payloadOnline = RestaurantTemplates.newOrder('ord_online_123', {
    orderNumber: 'OP-105',
    customerName: 'Priya Verma',
    phone: '+919123456789',
    deliveryAddress: 'Gokul Nagar, Rajnandgaon',
    items: [{ name: 'Margherita', quantity: 1, price: 199 }],
    totalAmount: 219,
    financials: { subtotal: 199, total: 219 },
    paymentMethod: 'ONLINE',
    paymentStatus: 'PAID',
    cashToCollect: 0,
    orderType: 'delivery',
  });

  const onlineNotif = payloadOnline.notification!;
  assert.ok(onlineNotif.body.includes('ONLINE (PAID)'), 'Must show ONLINE (PAID)');
  assert.ok(!onlineNotif.body.includes('CASH TO COLLECT: ₹219'), 'Must not ask to collect cash when online paid');
  const parsedOnlineJson = JSON.parse(payloadOnline.data.fullOrderJson);
  assert.strictEqual(parsedOnlineJson.cashToCollect, 0);
  assert.strictEqual(parsedOnlineJson.paymentStatus, 'PAID');
  console.log('  -> PASS: RestaurantTemplates.newOrder Online verified.\n');

  // 3. TEST: DeliveryTemplates.newAssignment
  console.log('Test 3: DeliveryTemplates.newAssignment — Full rider alert with cash collection & maps');
  const payloadRider = DeliveryTemplates.newAssignment('ord_rider_55', {
    orderNumber: 'OP-106',
    customerName: 'Anil Kumar',
    customerPhone: '+919988776655',
    deliveryAddress: 'Station Road, Rajnandgaon',
    deliveryInstructions: 'Call upon arrival at main gate',
    distance: '2.5 km',
    eta: '15 mins',
    lat: 21.096,
    lng: 81.034,
    items: [
      { name: 'Paneer Makhani Pizza', quantity: 1, size: 'Medium' },
      { name: 'Pepsi 500ml', quantity: 2 }
    ],
    cashToCollect: 549,
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    totalAmount: 549,
  });

  const riderNotif = payloadRider.notification!;
  assert.ok(riderNotif.title.includes('OP-106'));
  assert.ok(riderNotif.body.includes('Collect Cash: ₹549'), 'Rider alert must state cash to collect');
  assert.ok(riderNotif.body.includes('Paneer Makhani Pizza'), 'Must show item');
  assert.ok(riderNotif.body.includes('Pepsi 500ml'), 'Must show beverage');
  assert.ok(riderNotif.body.includes('Call upon arrival'), 'Must show rider instructions');
  const riderActions = payloadRider.webpush.notification.actions;
  assert.strictEqual(riderActions?.length, 4);
  assert.strictEqual(riderActions?.[0].action, 'ACCEPT_DELIVERY');
  assert.strictEqual(riderActions?.[1].action, 'OPEN_LOCATION');
  assert.strictEqual(riderActions?.[2].action, 'CALL_CUSTOMER');
  assert.strictEqual(riderActions?.[3].action, 'VIEW_ORDER');
  console.log('  -> PASS: DeliveryTemplates.newAssignment verified.\n');

  console.log('ALL CRITICAL ALERT TEMPLATE TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
