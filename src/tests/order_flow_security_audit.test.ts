import test from 'node:test';
import assert from 'assert';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';

test('Order Flow Security & Read-Only Audit', async () => {
  console.log('====================================================');
  console.log('OLIVE PIZZA ORDER FLOW SECURITY & READ-ONLY AUDIT');
  console.log('====================================================\n');

  // 1. Verify Customer role is rejected for staff operational transitions
  console.log('--- TEST 1: Customer Operational Mutation Blocked in State Machine ---');
  
  const operationalStages = ['accepted', 'preparing', 'ready', 'partner_assigned', 'picked_up', 'out_for_delivery', 'delivered'] as const;

  for (const stage of operationalStages) {
    const result = await OrderStateMachine.transition(
      'mock_test_order_id',
      stage,
      { uid: 'customer_uid_123', role: 'customer', name: 'Olive Pizza Customer' },
      {}
    );

    assert.strictEqual(
      result.success,
      false,
      `Customer should NEVER succeed transitioning an operational stage (${stage})`
    );

    console.log(`  [PASS] Operational transition to '${stage}' correctly rejected for role: 'customer'.`);
  }

  // 2. Verify non-existent order rejection
  console.log('\n--- TEST 2: Non-existent order rejection ---');
  for (const stage of operationalStages) {
    const result = await OrderStateMachine.transition(
      'mock_nonexistent_order_id',
      stage,
      { uid: 'owner_uid_123', role: 'owner', name: 'Olive Pizza Owner' },
      {}
    );

    assert.strictEqual(
      result.success,
      false,
      `Non-existent order should fail transition (${stage})`
    );
    console.log(`  [PASS] Transition to '${stage}' rejected for non-existent order.`);
  }

  // 3. Verify Delivery Partner cannot accept/prepare orders
  console.log('\n--- TEST 3: Cross-Role Authority Isolation ---');
  const kitchenStages = ['accepted', 'preparing', 'ready'] as const;
  for (const stage of kitchenStages) {
    const result = await OrderStateMachine.transition(
      'mock_test_order_id',
      stage,
      { uid: 'rider_uid_123', role: 'delivery_partner', name: 'Delivery Rider' },
      {}
    );
    assert.strictEqual(result.success, false, `Rider should not perform kitchen stage (${stage})`);
    console.log(`  [PASS] Kitchen transition to '${stage}' rejected for role: 'delivery_partner'.`);
  }

  console.log('\n====================================================');
  console.log('ALL ORDER FLOW SECURITY & READ-ONLY AUDIT TESTS PASSED');
  console.log('====================================================\n');
});
