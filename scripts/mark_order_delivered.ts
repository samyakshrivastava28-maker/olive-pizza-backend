import { adminDb } from '../src/config/firebase.js';
import { OrderStateMachine } from '../src/services/order/OrderStateMachine.js';
import { pgPool } from '../src/config/postgres.js';

async function main() {
  const orderId = '2852b9fb-1780-4856-8844-1ad3ee2c7c31';
  const doc = await adminDb.collection('orders').doc(orderId).get();
  if (!doc.exists) {
    console.error('Order not found!');
    process.exit(1);
  }
  const orderData = doc.data()!;
  console.log('Order branchId:', orderData.branchId, 'currentStatus:', orderData.status);

  console.log('Transitioning order', orderId, 'to delivered...');
  const res = await OrderStateMachine.transition(orderId, 'delivered', {
    uid: 'manager_auto',
    role: 'restaurant_manager',
    name: 'webhub2811',
    branchId: orderData.branchId || 'main-store'
  });
  console.log('Transition result:', JSON.stringify(res, null, 2));

  await pgPool.end().catch(() => {});
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
