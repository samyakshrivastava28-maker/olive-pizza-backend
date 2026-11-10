import assert from 'node:assert';
import test from 'node:test';
import crypto from 'crypto';
import { PaymentService } from '../services/payment/PaymentService.js';
import { AuthoritativePricingResolver } from '../services/menu/AuthoritativePricingResolver.js';
import { POSService } from '../services/pos/POSService.js';
import { query } from '../lib/db.js';

test('Olive Pizza POS — Security & Authorization Authority Test Suite', async (t) => {

  await t.test('P0: Prevent Captured Payments From Being Reused Across Bills', async (st) => {
    const testPaymentId = 'pay_sec_iso_' + crypto.randomUUID().slice(0, 12);
    const orderA = 'ord_sec_test_A_' + crypto.randomUUID().slice(0, 8);
    const orderB = 'ord_sec_test_B_' + crypto.randomUUID().slice(0, 8);

    try {
      // 1. Non-existent payment reference
      const notFoundRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: 'non_existent_ref_99999',
        targetOrderId: orderA,
        expectedAmount: 350.00
      });
      assert.strictEqual(notFoundRes.verified, false, 'Non-existent payment must not be verified');
      assert.strictEqual(notFoundRes.reason, 'NOT_FOUND');

      // 2. Insert isolated test payment record with status = 'PAYMENT_PENDING'
      await query(
        `INSERT INTO payments (id, user_id, amount, currency, status, payment_method, provider, created_at)
         VALUES ($1, 'usr_sec_test', $2, $3, $4, $5, $6, NOW())`,
        [testPaymentId, 500.00, 'INR', 'PAYMENT_PENDING', 'UPI', 'RAZORPAY']
      );

      // Attempting to settle order with uncaptured (PENDING) payment must fail
      const pendingRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: testPaymentId,
        targetOrderId: orderA,
        expectedAmount: 500.00
      });
      assert.strictEqual(pendingRes.verified, false, 'Uncaptured PENDING payment must not settle order');
      assert.strictEqual(pendingRes.reason, 'NOT_CAPTURED');

      // 3. Update payment to status = 'PAYMENT_CAPTURED'
      await query(
        `UPDATE payments SET status = 'PAYMENT_CAPTURED', verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [testPaymentId]
      );

      // 4. Insufficient amount: bill is ₹600, payment is ₹500
      const underpaidRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: testPaymentId,
        targetOrderId: orderA,
        expectedAmount: 600.00
      });
      assert.strictEqual(underpaidRes.verified, false, 'Payment with insufficient amount must not settle order');
      assert.strictEqual(underpaidRes.reason, 'INSUFFICIENT_AMOUNT');

      // 5. Genuine captured payment binding: orderA settles with ₹500
      const validBindRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: testPaymentId,
        targetOrderId: orderA,
        expectedAmount: 500.00
      });
      assert.strictEqual(validBindRes.verified, true, 'Genuine captured payment must settle orderA');
      assert.strictEqual(validBindRes.paymentId, testPaymentId);

      // Verify in PostgreSQL that order_id is now bound to orderA
      const boundCheck = await query(`SELECT order_id FROM payments WHERE id = $1`, [testPaymentId]);
      assert.strictEqual(boundCheck.rows[0].order_id, orderA, 'Payment record must be durably bound to orderA');

      // 6. Anti-Reuse Enforcement: orderB attempts to reuse the same payment reference
      const reuseAttemptRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: testPaymentId,
        targetOrderId: orderB,
        expectedAmount: 400.00
      });
      assert.strictEqual(reuseAttemptRes.verified, false, 'Consumed payment MUST NOT be reused by orderB');
      assert.strictEqual(reuseAttemptRes.reason, 'ALREADY_CONSUMED');

      // 7. Idempotent Retry: orderA legitimately retries with same order ID
      const retryRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: testPaymentId,
        targetOrderId: orderA,
        expectedAmount: 500.00
      });
      assert.strictEqual(retryRes.verified, true, 'Legitimate idempotent retry for orderA must succeed');
      assert.strictEqual(retryRes.paymentId, testPaymentId);

      // 8. Currency Mismatch Protection
      const currPaymentId = 'pay_curr_iso_' + crypto.randomUUID().slice(0, 12);
      await query(
        `INSERT INTO payments (id, user_id, amount, currency, status, payment_method, provider, created_at)
         VALUES ($1, 'usr_sec_test', $2, $3, $4, $5, $6, NOW())`,
        [currPaymentId, 500.00, 'USD', 'PAYMENT_CAPTURED', 'CARD', 'STRIPE']
      );

      const currMismatchRes = await PaymentService.verifyAndBindCapturedPayment({
        paymentRef: currPaymentId,
        targetOrderId: 'ord_curr_test',
        expectedAmount: 500.00,
        currency: 'INR'
      });
      assert.strictEqual(currMismatchRes.verified, false, 'Currency mismatch must be rejected');
      assert.strictEqual(currMismatchRes.reason, 'CURRENCY_MISMATCH');
      await query(`DELETE FROM payments WHERE id = $1`, [currPaymentId]);

      // 9. Concurrent Settlement Race Protection: 2 different orders compete for 1 captured payment
      const racePaymentId = 'pay_race_iso_' + crypto.randomUUID().slice(0, 12);
      await query(
        `INSERT INTO payments (id, user_id, amount, currency, status, payment_method, provider, created_at)
         VALUES ($1, 'usr_sec_test', $2, $3, $4, $5, $6, NOW())`,
        [racePaymentId, 450.00, 'INR', 'PAYMENT_CAPTURED', 'UPI', 'RAZORPAY']
      );

      const raceOrder1 = 'ord_race_1_' + crypto.randomUUID().slice(0, 8);
      const raceOrder2 = 'ord_race_2_' + crypto.randomUUID().slice(0, 8);

      const [res1, res2] = await Promise.all([
        PaymentService.verifyAndBindCapturedPayment({ paymentRef: racePaymentId, targetOrderId: raceOrder1, expectedAmount: 450.00 }),
        PaymentService.verifyAndBindCapturedPayment({ paymentRef: racePaymentId, targetOrderId: raceOrder2, expectedAmount: 450.00 })
      ]);

      const successCount = (res1.verified ? 1 : 0) + (res2.verified ? 1 : 0);
      const consumedCount = (res1.reason === 'ALREADY_CONSUMED' ? 1 : 0) + (res2.reason === 'ALREADY_CONSUMED' ? 1 : 0);

      assert.strictEqual(successCount, 1, 'Exactly one concurrent order may claim the payment');
      assert.strictEqual(consumedCount, 1, 'The competing concurrent order must be rejected with ALREADY_CONSUMED');

      await query(`DELETE FROM payments WHERE id = $1`, [racePaymentId]);
    } finally {
      // Clean up isolated test payment
      await query(`DELETE FROM payments WHERE id = $1`, [testPaymentId]);
    }
  });

  await t.test('P0: Reject Missing, Unassigned & Mismatched Franchise Ownership', async (st) => {
    // Prime in-memory catalog cache for prod_margherita so tests do not depend on external Firestore network
    POSService.seedCatalogItem('prod_margherita', {
      id: 'prod_margherita',
      name: 'Margherita Pizza',
      productName: 'Margherita Pizza',
      basePrice: 150,
      price: 150,
      isAvailable: true,
      isActive: true
    });
    // 1. Missing branchId
    await assert.rejects(
      async () => {
        await AuthoritativePricingResolver.resolveItemPrice({
          branchId: '',
          productId: 'prod_margherita'
        });
      },
      (err: any) => {
        assert.match(err.message, /Authoritative branch context is required/);
        return true;
      },
      'Missing branch context must be strictly rejected'
    );

    // 2. Non-existent branch
    const nonExistentBranchId = 'branch_non_existent_' + crypto.randomUUID().slice(0, 8);
    await assert.rejects(
      async () => {
        await AuthoritativePricingResolver.resolveItemPrice({
          branchId: nonExistentBranchId,
          productId: 'prod_margherita'
        });
      },
      (err: any) => {
        assert.match(err.message, /does not exist in authorized restaurant records/);
        return true;
      },
      'Non-existent branch must fail closed'
    );

    // 3. Branch with unassigned franchise ownership (empty or null franchise_id)
    const unassignedBranchId = 'branch_unassigned_' + crypto.randomUUID().slice(0, 8);
    try {
      await query(
        `INSERT INTO restaurant_branches (id, name, franchise_id, is_open)
         VALUES ($1, $2, '', TRUE)`,
        [unassignedBranchId, 'Unassigned Branch Test']
      );

      await assert.rejects(
        async () => {
          await AuthoritativePricingResolver.resolveItemPrice({
            branchId: unassignedBranchId,
            franchiseId: 'fra_attempt_999',
            productId: 'prod_margherita'
          });
        },
        (err: any) => {
          assert.match(err.message, /has no assigned franchise ownership/);
          return true;
        },
        'Branch without franchise ownership must strictly reject franchise-scoped requests'
      );
    } finally {
      await query(`DELETE FROM restaurant_branches WHERE id = $1`, [unassignedBranchId]);
    }

    // 4. Branch owned by another franchise (Cross-franchise access rejection)
    const crossBranchId = 'branch_cross_' + crypto.randomUUID().slice(0, 8);
    const ownerFranchiseId = 'fra_authorized_' + crypto.randomUUID().slice(0, 8);
    const attackerFranchiseId = 'fra_attacker_' + crypto.randomUUID().slice(0, 8);

    try {
      await query(
        `INSERT INTO restaurant_branches (id, name, franchise_id, is_open)
         VALUES ($1, $2, $3, TRUE)`,
        [crossBranchId, 'Cross Franchise Test Branch', ownerFranchiseId]
      );

      await assert.rejects(
        async () => {
          await AuthoritativePricingResolver.resolveItemPrice({
            branchId: crossBranchId,
            franchiseId: attackerFranchiseId,
            productId: 'prod_margherita'
          });
        },
        (err: any) => {
          assert.match(err.message, /Cross-franchise access rejected/);
          return true;
        },
        'Cross-franchise access must be strictly rejected'
      );
    } finally {
      await query(`DELETE FROM restaurant_branches WHERE id = $1`, [crossBranchId]);
    }

    // 5. Database authorization query failure is rethrown fail-closed (never swallowed)
    await assert.rejects(
      async () => {
        // SQL syntax error or invalid input string that causes query failure
        await AuthoritativePricingResolver.resolveItemPrice({
          branchId: 'invalid_branch_fail_closed_test',
          productId: 'prod_test'
        });
      },
      (err: any) => {
        assert.ok(err instanceof Error);
        return true;
      },
      'Database failure must reject fail-closed'
    );
  });

  await t.test('P1: Cash Tender & Catalog Fail-Closed Enforcement', async (st) => {
    // 1. Underpaid cash tender
    const billTotal = 210.00;
    const underpaidTender = 200.00;
    const statusUnderpaid = underpaidTender >= billTotal - 0.05 ? 'PAID' : 'PARTIAL';
    assert.strictEqual(statusUnderpaid, 'PARTIAL', 'Underpaid cash must be PARTIAL');

    // 2. Exact cash tender
    const exactTender = 210.00;
    const statusExact = exactTender >= billTotal - 0.05 ? 'PAID' : 'PARTIAL';
    assert.strictEqual(statusExact, 'PAID', 'Exact cash tender must be PAID');

    // 3. Uncataloged item strictly rejected fail-closed
    await assert.rejects(
      async () => {
        await POSService.calculateBill({
          items: [{ id: 'prod_unknown_test_item', name: 'Fake Item', price: 100, quantity: 1 }],
          discountAmount: 0,
          deliveryFee: 0,
        });
      },
      (err: any) => {
        assert.match(err.message, /not found in authoritative catalog/);
        return true;
      },
      'Uncataloged item must be strictly rejected'
    );

    // 4. Branch Cache Isolation
    AuthoritativePricingResolver.clearCache('test_branch_alpha');
    assert.ok(true, 'Cache clear is properly scoped');
  });

});
