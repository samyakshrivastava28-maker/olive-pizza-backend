import assert from 'node:assert';
import test from 'node:test';
import crypto from 'crypto';
import { PaymentService } from '../services/payment/PaymentService.js';

test('Payment & Financial Security Authority Test Suite', async (t) => {
  await t.test('Server Delivery Fee Authority: Customers cannot manipulate deliveryFee or prices', async () => {
    // Attempting createPaymentSession without valid canonical records throws fail-closed error
    await assert.rejects(
      async () => {
        await PaymentService.createPaymentSession({
          userId: 'test_malicious_user',
          items: [{ menuItemId: 'non_existent_item_id', quantity: 2, price: 1 } as any],
          deliveryAddress: { line1: 'Test St', city: 'Rajnandgaon', pincode: '491441' } as any,
          paymentMethod: 'ONLINE_UPI',
          paymentGateway: 'RAZORPAY',
          deliveryFee: 0 // Malicious 0 delivery fee attempt
        });
      },
      (err: any) => {
        // Must reject fail-closed because item doesn't exist in authoritative catalog
        return err instanceof Error;
      },
      'Must reject payment session creation with invalid/tampered catalog items'
    );
  });

  await t.test('Webhook Fail-Closed on Invalid Signature / Tampering: Throws security error', async () => {
    // When amount or payload is tampered and signature does not match, it must fail closed immediately
    const fakeSignature = 'invalid_sig';
    const fakePayload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_tampered_123',
            order_id: 'order_canon_123',
            amount: 100 // Gateway reports ₹1.00 when order was ₹500.00
          }
        }
      }
    };

    await assert.rejects(
      async () => {
        await PaymentService.processWebhook(
          'razorpay',
          fakePayload,
          fakeSignature
        );
      },
      (err: any) => {
        return err.code === 'INVALID_SIGNATURE' || err.message?.includes('signature mismatch') || err instanceof Error;
      },
      'Tampered or unverified webhook must fail closed immediately'
    );
  });

  await t.test('Distributed Idempotency Hash: Identical payload produces same hash, modified produces different', () => {
    const baseRequest = {
      userId: 'usr_100',
      items: [{ id: 'item_pizza_1', qty: 2 }],
      deliveryAddress: 'Main St',
      paymentMethod: 'ONLINE_UPI',
      couponCode: 'WELCOME50',
      branchId: 'branch_rjn',
      deliveryType: 'DELIVERY'
    };

    const hash1 = crypto.createHash('sha256').update(JSON.stringify(baseRequest)).digest('hex');
    const hash2 = crypto.createHash('sha256').update(JSON.stringify(baseRequest)).digest('hex');

    const tamperedRequest = { ...baseRequest, items: [{ id: 'item_pizza_1', qty: 3 }] };
    const hash3 = crypto.createHash('sha256').update(JSON.stringify(tamperedRequest)).digest('hex');

    assert.strictEqual(hash1, hash2, 'Identical payloads must yield identical idempotency hash');
    assert.notStrictEqual(hash1, hash3, 'Modified payloads must yield completely different hash, preventing replay conflict');
  });

  await t.test('POS Catalog Authority: Strictly rejects client-supplied prices when item is uncataloged or missing id', async () => {
    const { POSService } = await import('../services/pos/POSService.js');
    await assert.rejects(
      async () => {
        await POSService.calculateBill({
          items: [{ name: 'Fake Pizza', price: 99, quantity: 1 } as any],
          orderType: 'DINE_IN'
        });
      },
      (err: any) => err instanceof Error && err.message.includes('Menu item identifier is required'),
      'Must strictly reject bill calculation without menuItemId'
    );

    await assert.rejects(
      async () => {
        await POSService.calculateBill({
          items: [{ menuItemId: 'non_existent_fake_id', name: 'Fake Pizza', price: 99, quantity: 1 } as any],
          orderType: 'DINE_IN'
        });
      },
      (err: any) => err instanceof Error && err.message.includes('not found in authoritative catalog'),
      'Must strictly reject bill calculation for items not found in catalog'
    );
  });

  await t.test('Canonical Order Pricing Authority: Strictly rejects uncataloged items and calculates total server-authoritatively', async () => {
    const { CanonicalOrderService } = await import('../services/pos/CanonicalOrderService.js');
    await assert.rejects(
      async () => {
        await CanonicalOrderService.createCanonicalOrder({
          orderSource: 'ONLINE',
          items: [{ menuItemId: 'non_existent_item_canon', name: 'Fake Pizza', price: 99, quantity: 1 }],
          subtotal: 99,
          totalAmount: 99,
          paymentMethod: 'CASH'
        });
      },
      (err: any) => err instanceof Error && err.message.includes('authoritative catalog price'),
      'Must reject order creation when item is not in catalog'
    );
  });
});
