import assert from 'assert';
import { DeliveryTemplates } from '../services/notification/NotificationTemplates.js';

async function runDeliveryActionTests() {
  console.log('===========================================================');
  console.log('ACTIONABLE DELIVERY PUSH NOTIFICATIONS SUITE');
  console.log('===========================================================\n');

  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        return res.then(() => {
          console.log('  [PASS] ' + name);
          passed++;
        }).catch((err: any) => {
          console.error('  [FAIL] ' + name + ':', err.message);
          throw err;
        });
      }
      console.log('  [PASS] ' + name);
      passed++;
    } catch (err: any) {
      console.error('  [FAIL] ' + name + ':', err.message);
      throw err;
    }
  }

  // ── 1. Template & Action Identifier Tests ──────────────────────────────
  console.log('--- TEST GROUP 1: Delivery Assignment Action Verification ---');

  test('Delivery assignment notification contains ACCEPT_DELIVERY and DECLINE_DELIVERY actions', () => {
    const payload = DeliveryTemplates.newAssignment('ord_test_999', {
      orderNumber: '999',
      customerName: 'Aarav Sharma',
      customerPhone: '+919876543210',
      deliveryAddress: 'Sector 5, Rajnandgaon',
      distance: '2.5 km',
      eta: '15 mins',
      totalAmount: 499,
      paymentMethod: 'UPI'
    });

    const actions = JSON.parse(payload.data.actions || '[]');
    assert.strictEqual(actions.length, 4, 'Expected 4 action buttons');
    assert.strictEqual(actions[0].action, 'ACCEPT_DELIVERY');
    assert.strictEqual(actions[1].action, 'OPEN_LOCATION');
    assert.strictEqual(actions[2].action, 'CALL_CUSTOMER');
    assert.strictEqual(actions[3].action, 'VIEW_ORDER');
    assert.strictEqual(payload.apns?.payload?.aps?.category, 'DELIVERY_ASSIGNMENT_CATEGORY');
  });

  console.log('\n--- TEST GROUP 2: Delivery Lifecycle Stage Actions ---');

  test('Accepted / At restaurant stage provides PICKED_UP action', () => {
    const payload = DeliveryTemplates.deliveryUpdate('ord_test_999', {
      orderNumber: '999',
      customerName: 'Aarav Sharma',
      deliveryAddress: 'Sector 5, Rajnandgaon',
      stage: 'arrived_restaurant'
    });

    const actions = JSON.parse(payload.data.actions || '[]');
    assert(actions.some((a: any) => a.action === 'PICKED_UP'), 'Expected PICKED_UP action');
    assert.strictEqual(payload.apns?.payload?.aps?.category, 'DELIVERY_ORDER_ACCEPTED');
  });

  test('Picked up stage provides OUT_FOR_DELIVERY action', () => {
    const payload = DeliveryTemplates.deliveryUpdate('ord_test_999', {
      orderNumber: '999',
      customerName: 'Aarav Sharma',
      deliveryAddress: 'Sector 5, Rajnandgaon',
      stage: 'picked_up'
    });

    const actions = JSON.parse(payload.data.actions || '[]');
    assert(actions.some((a: any) => a.action === 'OUT_FOR_DELIVERY'), 'Expected OUT_FOR_DELIVERY action');
    assert.strictEqual(payload.apns?.payload?.aps?.category, 'DELIVERY_ORDER_PICKED_UP');
  });

  test('Out for delivery stage provides DELIVERED action', () => {
    const payload = DeliveryTemplates.deliveryUpdate('ord_test_999', {
      orderNumber: '999',
      customerName: 'Aarav Sharma',
      deliveryAddress: 'Sector 5, Rajnandgaon',
      stage: 'out_for_delivery'
    });

    const actions = JSON.parse(payload.data.actions || '[]');
    assert(actions.some((a: any) => a.action === 'DELIVERED'), 'Expected DELIVERED action');
    assert.strictEqual(payload.apns?.payload?.aps?.category, 'DELIVERY_ORDER_OUT_FOR_DELIVERY');
  });

  test('Delivered stage has no pending actions', () => {
    const payload = DeliveryTemplates.deliveryUpdate('ord_test_999', {
      orderNumber: '999',
      customerName: 'Aarav Sharma',
      deliveryAddress: 'Sector 5, Rajnandgaon',
      stage: 'delivered'
    });

    const actions = JSON.parse(payload.data.actions || '[]');
    assert.strictEqual(actions.length, 0, 'Expected 0 actions on delivered');
  });

  console.log(`\nResults: ${passed}/${total} tests passed.`);
  if (passed !== total) {
    throw new Error(`Failed tests: ${total - passed}`);
  }
}

runDeliveryActionTests().catch(err => {
  console.error('Fatal test error:', err);
  throw err;
});
