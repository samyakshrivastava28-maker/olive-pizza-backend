import assert from 'assert';
import { test as nodeTest } from 'node:test';
import { CustomerTemplates, RestaurantTemplates, DeliveryTemplates } from '../services/notification/NotificationTemplates.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { notificationQueue } from '../services/notification/NotificationQueueService.js';
import { pgPool } from '../config/postgres.js';

nodeTest('Restaurant management notification system test suite', async () => {
  await runTests();
});

async function runTests() {
  console.log('====================================================');
  console.log('RESTAURANT MANAGEMENT NOTIFICATION SYSTEM TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    total++;
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        return res.then(() => {
          console.log(`  [PASS] ${name}`);
          passed++;
        }).catch((err: any) => {
          console.error(`  [FAIL] ${name}:`, err.message);
          throw err;
        });
      }
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  [FAIL] ${name}:`, err.message);
      throw err;
    }
  }

  // ── 1. Template Text Exact Match Tests ──────────────────────────────
  console.log('--- TEST GROUP 1: Canonical Template Copy Verification ---');

  test('Customer notification for ORDER ACCEPTED matches required copy', () => {
    const payload = CustomerTemplates.orderUpdate('ord_101', {
      orderNumber: '101',
      status: 'accepted',
      totalAmount: 399,
    });
    assert(payload.data.body?.includes('Your Olive Pizza order has been accepted.'),
      `Expected body to contain "Your Olive Pizza order has been accepted.", got: "${payload.data.body}"`);
  });

  test('Customer notification for ORDER PREPARING matches required copy', () => {
    const payload = CustomerTemplates.orderUpdate('ord_101', {
      orderNumber: '101',
      status: 'preparing',
      totalAmount: 399,
    });
    assert(payload.data.body?.includes('being freshly prepared') || payload.data.body?.includes('being prepared'),
      `Expected body to contain preparing status text, got: "${payload.data.body}"`);
  });

  test('Customer notification for PICKUP READY matches required copy', () => {
    const payload = CustomerTemplates.orderUpdate('ord_101', {
      orderNumber: '101',
      status: 'ready',
      totalAmount: 399,
      isPickup: true,
    });
    assert(payload.data.body?.includes('Your order is ready for pickup at the restaurant counter.'),
      `Expected body to contain "Your order is ready for pickup at the restaurant counter.", got: "${payload.data.body}"`);
  });

  test('Customer notification for DELIVERY READY matches required copy', () => {
    const payload = CustomerTemplates.orderUpdate('ord_101', {
      orderNumber: '101',
      status: 'ready',
      totalAmount: 399,
      isPickup: false,
    });
    assert(payload.data.body?.includes('ready for delivery'),
      `Expected body to contain "ready for delivery", got: "${payload.data.body}"`);
  });

  test('Customer notification for ORDER CANCELLED matches required copy', () => {
    const payload = CustomerTemplates.orderUpdate('ord_101', {
      orderNumber: '101',
      status: 'cancelled',
      totalAmount: 399,
    });
    assert(payload.data.body?.includes('Sorry, your order was cancelled by the restaurant.'),
      `Expected body to contain "Sorry, your order was cancelled by the restaurant.", got: "${payload.data.body}"`);
  });

  test('Restaurant notification for ORDER DELIVERED uses celebratory copy and delivered sound', () => {
    const payload = RestaurantTemplates.orderDelivered('ord_101', {
      orderNumber: '101',
      customerName: 'Aarav',
      totalAmount: 599,
      branchId: 'main_branch',
      riderName: 'Vikram',
    });
    assert.strictEqual(payload.data.sound, 'order_delivered', 'Sound should be order_delivered');
    assert.strictEqual(payload.data.type, 'ORDER_DELIVERED', 'Type should be ORDER_DELIVERED');
    assert(payload.data.body?.includes('successfully delivered by Vikram'), 'Body should mention successful delivery');
  });

  // ── 2. Idempotency & Deduplication Tests ─────────────────────────────
  console.log('\n--- TEST GROUP 2: Server-Side Deduplication & Idempotency ---');

  await test('NotificationEngine drops duplicate eventId within window', async () => {
    const testEventId = `test_idempotent_event_${Date.now()}`;
    const payload = CustomerTemplates.orderUpdate('ord_dup_1', {
      orderNumber: 'DUP-1',
      status: 'accepted',
      totalAmount: 499,
      eventId: testEventId,
    });

    // First send attempt (even if user has no tokens, eventId is registered)
    const firstResult = await notificationEngine.sendBulk(['mock_user_dedup_1'], payload, {
      eventId: testEventId,
      orderId: 'ord_dup_1',
    });

    // Second send attempt with the EXACT same eventId
    const secondResult = await notificationEngine.sendBulk(['mock_user_dedup_1'], payload, {
      eventId: testEventId,
      orderId: 'ord_dup_1',
    });

    assert.strictEqual(secondResult.errors[0], 'duplicate_event_suppressed',
      `Second dispatch should be suppressed with 'duplicate_event_suppressed', got: ${JSON.stringify(secondResult.errors)}`);
    assert.strictEqual(secondResult.successCount, 0, 'Second dispatch should not send any FCM push');
  });

  // ── 3. Multi-Device Token Persistence Tests ─────────────────────────
  console.log('\n--- TEST GROUP 3: Multi-Device FCM Token Registration ---');

  await test('Registering second device does not deactivate first device token', async () => {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS fcm_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id VARCHAR(255) NOT NULL,
        token TEXT NOT NULL,
        device_id VARCHAR(255),
        device_name VARCHAR(255),
        platform VARCHAR(100),
        browser VARCHAR(100),
        app_version VARCHAR(50),
        app_name VARCHAR(100),
        role VARCHAR(100),
        branch_id VARCHAR(255),
        franchise_id VARCHAR(255),
        terminal_id VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fcm_tokens_user_token_uniq UNIQUE (user_id, token)
      );
      ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS browser VARCHAR(100);
      ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS app_version VARCHAR(50);
      ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      CREATE UNIQUE INDEX IF NOT EXISTS fcm_tokens_user_token_uniq ON fcm_tokens (user_id, token);
    `).catch(() => {});

    const testUserId = `test_mgr_multi_${Date.now()}`;
    const tokenPhone = `fcm_phone_token_${Date.now()}`;
    const tokenTablet = `fcm_tablet_token_${Date.now()}`;

    // Register Device 1 (Android Phone)
    await notificationQueue.registerToken(testUserId, tokenPhone, {
      deviceId: 'device_phone_1',
      deviceName: 'Pixel 8 Pro',
      platform: 'android',
      appName: 'restaurant',
      role: 'restaurant_manager',
      branchId: 'branch_rjn',
    });

    // Register Device 2 (iPad / Kitchen Tablet)
    await notificationQueue.registerToken(testUserId, tokenTablet, {
      deviceId: 'device_tablet_1',
      deviceName: 'iPad Air 5',
      platform: 'ios',
      appName: 'restaurant',
      role: 'restaurant_manager',
      branchId: 'branch_rjn',
    });

    // Verify both tokens in Postgres
    const res = await pgPool.query(
      `SELECT token, device_id, is_active FROM fcm_tokens WHERE user_id = $1 AND is_active = TRUE`,
      [testUserId]
    );

    const activeTokens = res.rows.map((r: any) => r.token);
    assert(activeTokens.includes(tokenPhone), 'Device 1 (Phone) token must still be active');
    assert(activeTokens.includes(tokenTablet), 'Device 2 (Tablet) token must still be active');

    // Clean up test records
    await pgPool.query(`DELETE FROM fcm_tokens WHERE user_id = $1`, [testUserId]);
  });

  console.log('\n====================================================');
  console.log(`ALL TESTS COMPLETED: ${passed} / ${total} PASSED`);
  console.log('====================================================');
}
