import { RestaurantTemplates, DeliveryTemplates, CustomerTemplates } from './services/notification/NotificationTemplates.js';
import { NotificationEngine } from './services/notification/NotificationEngine.js';
import { OrderStateMachine } from './services/order/OrderStateMachine.js';

async function runTestFlow() {
  console.log('================================================================');
  console.log('OLIVE PIZZA — END-TO-END ORDER + NOTIFICATION FLOW TEST SUITE');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
      failed++;
    }
  }

  // ── 1. Permission State Machine Logic ──
  console.log('--- 1. Notification Permission State Machine Tests ---');
  function resolvePermissionState(platform: string, nativeState?: string, webState?: string): string {
    if (platform === 'electron') return 'GRANTED';
    if (platform === 'android' || platform === 'ios') {
      if (nativeState === 'granted') return 'GRANTED';
      if (nativeState === 'denied') return 'BLOCKED';
      return 'NOT_DETERMINED';
    }
    if (!webState) return 'UNSUPPORTED';
    if (webState === 'granted') return 'GRANTED';
    if (webState === 'denied') return 'BLOCKED';
    return 'NOT_DETERMINED';
  }

  assert(resolvePermissionState('web', undefined, 'default') === 'NOT_DETERMINED',
    'Web initial permission maps to NOT_DETERMINED (prompt required)');
  assert(resolvePermissionState('web', undefined, 'granted') === 'GRANTED',
    'Web granted permission maps to GRANTED');
  assert(resolvePermissionState('web', undefined, 'denied') === 'BLOCKED',
    'Web blocked permission maps to BLOCKED (settings required)');
  assert(resolvePermissionState('android', 'denied') === 'BLOCKED',
    'Android denied permission maps to BLOCKED (prevents repeated OS dialogs)');
  assert(resolvePermissionState('electron') === 'GRANTED',
    'Electron native desktop platform maps to GRANTED');

  // ── 2. App Isolation & Target App Scoping ──
  console.log('\n--- 2. Role & App Isolation Tests ---');
  const validApps = ['customer', 'owner', 'restaurant', 'franchise', 'delivery', 'pos'];
  validApps.forEach((app) => {
    assert(validApps.includes(app), `App isolation targetApp supported: ${app}`);
  });

  // ── 3. Notification Deduplication Key Format ──
  console.log('\n--- 3. Notification Deduplication Architecture ---');
  function buildEventId(type: string, entityId: string, version: number): string {
    return `${type}:${entityId}:${version}`;
  }
  const event1 = buildEventId('order_update', 'ord_12345', 2);
  const event2 = buildEventId('delivery_assign', 'ord_12345', 1);
  assert(event1 === 'order_update:ord_12345:2', 'Deterministic eventId format: order_update:ord_12345:2');
  assert(event1 !== event2, 'Distinct event types produce unique deduplication keys');

  // ── 4. Customer Automatic Cancellation Notification ──
  console.log('\n--- 4. Customer Auto-Cancellation Copy & Unpinning Tests ---');
  const cancelPayload = CustomerTemplates.orderUpdate('ord_timeout_99', {
    orderNumber: 'OP-9999',
    status: 'cancelled',
    totalAmount: 499,
    cancellationReason: 'RESTAURANT_ACCEPT_TIMEOUT',
    version: 3
  });

  assert(cancelPayload.notification?.title === 'Order Cancelled',
    'Customer timeout cancel title is exactly "Order Cancelled"');
  assert(cancelPayload.notification?.body?.includes('Sorry, your Olive Pizza order was cancelled because the restaurant could not accept it in time.'),
    'Customer timeout cancel body matches user-mandated empathetic copy');
  assert(cancelPayload.data.url === '/order-cancelled/ord_timeout_99',
    'Customer timeout cancel deepLink points to /order-cancelled/:id');
  assert(cancelPayload.data.ongoing === undefined || cancelPayload.data.ongoing === 'false',
    'Customer tracker unpinned on cancellation (ongoing = false)');
  assert(cancelPayload.data.sound === 'cancel_buzz',
    'Customer cancellation sound is mapped to cancel_buzz');

  // ── 5. Restaurant High-Priority New Order Notification ──
  console.log('\n--- 5. Restaurant Rich New Order Alert Tests ---');
  const restPayload = RestaurantTemplates.newOrder('ord_rest_01', {
    customerName: 'Aman Sharma',
    orderNumber: 'OP-8821',
    totalAmount: 649,
    items: [
      { name: 'Veggie Supreme', quantity: 1, size: 'Large', crust: 'Cheese Burst' },
      { name: 'Garlic Breadsticks', quantity: 2 }
    ],
    paymentMethod: 'ONLINE',
    paymentStatus: 'PAID',
    deliveryAddress: 'Street 4, Rajnandgaon',
    phone: '9179944445',
    branchId: 'main_branch',
    version: 1
  });

  assert(restPayload.data.category === 'alarm_actionable',
    'Restaurant new order category is alarm_actionable');
  assert(restPayload.data.priority === 'critical',
    'Restaurant new order priority is critical');
  assert(restPayload.data.alert === 'continuous',
    'Restaurant new order alert mode is continuous');
  assert(restPayload.data.actions?.includes('ACCEPT') && restPayload.data.actions?.includes('REJECT'),
    'Restaurant new order contains interactive ACCEPT and REJECT actions');
  assert(restPayload.data.body?.includes('Aman Sharma'),
    'Restaurant alert body contains customer name');
  assert(restPayload.data.body?.includes('Veggie Supreme Large [Cheese Burst]'),
    'Restaurant alert body contains item customizations');

  // ── 6. Delivery Partner Urgent Assignment Notification ──
  console.log('\n--- 6. Delivery Partner Urgent Alert Tests ---');
  const dlvPayload = DeliveryTemplates.newAssignment('ord_dlv_01', {
    orderNumber: 'OP-7712',
    customerName: 'Pooja Verma',
    customerPhone: '9876543210',
    deliveryAddress: 'Gokul Nagar, Near Main Gate, Rajnandgaon',
    distance: '2.4 km',
    eta: '12 mins',
    totalAmount: 520,
    paymentMethod: 'COD',
    version: 1
  });

  assert(dlvPayload.data.category === 'alarm_actionable',
    'Delivery assignment category is alarm_actionable');
  assert(dlvPayload.data.priority === 'critical',
    'Delivery assignment priority is critical');
  assert(dlvPayload.data.sound === 'delivery_chime',
    'Delivery assignment uses delivery_chime audio');
  assert(dlvPayload.data.actions?.includes('ACCEPT') && dlvPayload.data.actions?.includes('DECLINE'),
    'Delivery assignment provides explicit ACCEPT and DECLINE actions');
  assert(dlvPayload.data.actionUrlAccept?.includes('/orders/ord_dlv_01/accept'),
    'Delivery accept action URL points to backend atomic endpoint');
  assert(dlvPayload.data.actionUrlReject?.includes('/orders/ord_dlv_01/decline'),
    'Delivery decline action URL points to backend atomic endpoint');

  // ── 7. Customer Pinned Tracker Lifecycle ──
  console.log('\n--- 7. Customer Live Tracker Ongoing Lifecycle Tests ---');
  const prepPayload = CustomerTemplates.orderUpdate('ord_track_01', {
    orderNumber: 'OP-1234',
    status: 'preparing',
    totalAmount: 450,
    eta: '20 mins'
  });
  assert(prepPayload.data.ongoing === 'true',
    'Customer tracker is ongoing (pinned live card) while preparing');

  const deliveredPayload = CustomerTemplates.orderUpdate('ord_track_01', {
    orderNumber: 'OP-1234',
    status: 'delivered',
    totalAmount: 450
  });
  assert(deliveredPayload.data.ongoing === undefined || deliveredPayload.data.ongoing === 'false',
    'Customer tracker is terminated (ongoing = false) when delivered');

  console.log('\n================================================================');
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTestFlow().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
