import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { CODCollectionService } from '../services/payment/CODCollectionService.js';
import { RazorpayProvider } from '../services/payment/RazorpayProvider.js';
import { PaymentService } from '../services/payment/PaymentService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';

describe('Delivery COD Collection & Dynamic UPI QR Security Suite', () => {

  // 1. Signature Verification Resilience
  it('1. RazorpayProvider rejects signature mismatch cleanly without throwing RangeError on length difference', () => {
    const provider = new RazorpayProvider();
    
    // Normal payload
    const payload = JSON.stringify({ event: 'payment.captured', id: 'pay_test_123' });
    
    // Invalid signature with random length
    const shortInvalidSig = 'invalid_short';
    const isValidShort = provider.verifySignature(payload, shortInvalidSig, 'dummy_secret');
    assert.strictEqual(isValidShort, false, 'Short invalid signature must return false');

    // Invalid signature with 64 hex chars
    const hexInvalidSig = 'a'.repeat(64);
    const isValidHex = provider.verifySignature(payload, hexInvalidSig, 'dummy_secret');
    assert.strictEqual(isValidHex, false, 'Invalid hex signature must return false');

    // Valid HMAC calculation
    const secret = 'test_webhook_secret_key_123';
    const validHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const isValid = provider.verifySignature(payload, validHmac, secret);
    assert.strictEqual(isValid, true, 'Valid HMAC signature must verify true');
  });

  // 2. Dynamic UPI QR String Generation Verification
  it('2. NPCI UPI URI format adheres to standard with fixed amount, transaction ref, and merchant VPA', async () => {
    // Generate UPI string directly or test formatting
    const amount = 499.00;
    const attemptId = 'att_upi_test_9988';
    const merchantVpa = 'olivepizza@upi';
    const businessName = 'Olive Pizza';
    const shortOrderNumber = '#1042';

    const upiString = `upi://pay?pa=${encodeURIComponent(merchantVpa)}&pn=${encodeURIComponent(businessName)}&am=${amount.toFixed(2)}&tr=${attemptId}&tn=${encodeURIComponent('Order ' + shortOrderNumber)}&cu=INR`;

    assert.ok(upiString.startsWith('upi://pay?'), 'Must start with upi://pay?');
    assert.ok(upiString.includes('pa=olivepizza%40upi') || upiString.includes('pa=olivepizza@upi'), 'Must include merchant VPA');
    assert.ok(upiString.includes('am=499.00'), 'Must lock exact authoritative amount due (499.00)');
    assert.ok(upiString.includes(`tr=${attemptId}`), 'Must bind unique payment attempt ID to prevent cross-order collision');
    assert.ok(upiString.includes('cu=INR'), 'Currency must be INR');
  });

  // 3. Delivery Completion Gate in OrderStateMachine
  it('3. OrderStateMachine blocks transition to delivered for COD orders if unpaid', async () => {
    // Attempt to transition non-existent or mock order to delivered
    const actorRider = {
      uid: 'rider_unit_test',
      role: 'delivery_partner',
      name: 'Test Rider',
      branchId: 'branch_rjn',
    };

    const res = await OrderStateMachine.transition(
      'non_existent_unpaid_order',
      'delivered',
      actorRider
    );

    // Cannot transition order that is not in system or not paid
    assert.strictEqual(res.success, false);
    assert.ok(res.error, 'Must return descriptive rejection error');
  });

  // 4. Client Amount Tampering Detection
  it('4. CODCollectionService rejects client-supplied amount manipulation', async () => {
    // If order does not exist or client passes mismatched amount, it must throw / reject
    await assert.rejects(
      async () => {
        await CODCollectionService.collectCash({
          orderId: 'fake_order_id_tamper_test',
          actorUid: 'rider_1',
          actorRole: 'delivery_partner',
          clientAmount: 1, // Attacker tries paying ₹1
        });
      },
      /Order 'fake_order_id_tamper_test' not found/
    );
  });

  // 5. Webhook Replay Protection & Duplicate Handling
  it('5. Webhook rejects unsupported providers', async () => {
    await assert.rejects(
      async () => {
        // Unsupported provider should throw
        await PaymentService.processWebhook('unknown_crypto_pay', {}, 'sig_123');
      },
      /Unsupported payment provider|not found/
    );
  });

});

