import { orderEventService } from './src/services/order/OrderEventService.js';
import { notificationQueue } from './src/services/notification/NotificationQueueService.js';
import { adminDb } from './src/config/firebase.js';

async function run() {
  console.log('--- STARTING RUNTIME VERIFICATION ---');
  
  // Fake User ID (must exist in DB or we use a known customer role)
  // Since we can't reliably predict a user ID in the local DB, we will just enqueue payloads directly 
  // to observe the Email Rules Engine and router behavior in the logs.
  
  const customerId = 'test-customer-uuid';
  
  const stages = [
    'pending',
    'accepted',
    'preparing',
    'baking',
    'packed',
    'partner_assigned',
    'out_for_delivery',
    'delivered'
  ];
  
  for (const stage of stages) {
    console.log(`\n=> Simulating Stage: ${stage.toUpperCase()}`);
    const payload = {
      notification: { title: `Order ${stage}`, body: `Your order is now ${stage}` },
      data: { role: 'customer', stage: stage, orderId: 'test-order-123' }
    };
    
    // We expect this to fail FCM (no tokens) and trigger fallback logic
    await notificationQueue.enqueue(customerId, payload);
    await new Promise(r => setTimeout(r, 1000)); // wait for queue processing logs
  }
  
  console.log('\n--- FINISHED ---');
  process.exit(0);
}

run().catch(console.error);
