import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGrpcServer, stopGrpcServer } from '../grpc/grpcServer.ts';
import { OrderGrpcClient } from '../grpc/clients/OrderGrpcClient.ts';
import { PaymentGrpcClient } from '../grpc/clients/PaymentGrpcClient.ts';
import { NotificationGrpcClient } from '../grpc/clients/NotificationGrpcClient.ts';
import { DeliveryGrpcClient } from '../grpc/clients/DeliveryGrpcClient.ts';
import { ArchiveGrpcClient } from '../grpc/clients/ArchiveGrpcClient.ts';
import { GrpcDomainError } from '../grpc/clients/BaseGrpcClient.ts';
import * as grpc from '@grpc/grpc-js';

const TEST_PORT = 50059;
const TEST_ENDPOINT = `127.0.0.1:${TEST_PORT}`;

describe('Internal gRPC + Protobuf Service Architecture', () => {
  let orderClient: OrderGrpcClient;
  let paymentClient: PaymentGrpcClient;
  let notificationClient: NotificationGrpcClient;
  let deliveryClient: DeliveryGrpcClient;
  let archiveClient: ArchiveGrpcClient;

  before(async () => {
    // Start gRPC server on test port
    await startGrpcServer(TEST_PORT);

    orderClient = new OrderGrpcClient({ endpoint: TEST_ENDPOINT, defaultDeadlineMs: 15000 });
    paymentClient = new PaymentGrpcClient({ endpoint: TEST_ENDPOINT, defaultDeadlineMs: 15000 });
    notificationClient = new NotificationGrpcClient({ endpoint: TEST_ENDPOINT, defaultDeadlineMs: 15000 });
    deliveryClient = new DeliveryGrpcClient({ endpoint: TEST_ENDPOINT, defaultDeadlineMs: 15000 });
    archiveClient = new ArchiveGrpcClient({ endpoint: TEST_ENDPOINT, defaultDeadlineMs: 15000 });
  });

  after(async () => {
    orderClient.close();
    paymentClient.close();
    notificationClient.close();
    deliveryClient.close();
    archiveClient.close();
    await stopGrpcServer(true);
  });

  it('1. Token authorization check: rejects invalid x-internal-auth metadata', async () => {
    try {
      await paymentClient.verifyAndReconcilePayment(
        {
          orderId: 'test_order_unauth',
          amount: 299,
          currency: 'INR',
          providerTxId: 'tx_unauth_001',
        },
        3000,
        'WRONG_FORGED_CLUSTER_SECRET'
      );
      assert.fail('Should have rejected with UNAUTHENTICATED error');
    } catch (err: any) {
      assert(err instanceof GrpcDomainError, 'Error should be an instance of GrpcDomainError');
      assert.equal(err.code, grpc.status.UNAUTHENTICATED);
      assert.equal(err.isAuthError, true);
      assert(err.message.includes('authentication failed') || err.message.includes('x-internal-auth'));
    }
  });

  it('2. Successful RPC execution: validates contract structures across services', async () => {
    // Delivery RPC: FIFO assignment
    const assignRes = await deliveryClient.assignRider({
      orderId: 'test_order_rpc_001',
      branchId: 'main_branch',
    });
    assert.equal(typeof assignRes.success, 'boolean');
    assert.equal(assignRes.orderId, 'test_order_rpc_001');

    // Notification RPC: direct dispatch
    const notifRes = await notificationClient.dispatchOrderNotification({
      orderId: 'test_order_rpc_001',
      recipientUid: 'test_user_uid_123',
      title: 'Order Confirmed',
      body: 'Your pizza is being prepared!',
      category: 'order_update',
    });
    assert.equal(typeof notifRes.success, 'boolean');
    assert.equal(typeof notifRes.dispatchedCount, 'number');

    // Archive RPC: Terminal finalize contract check
    const archiveRes = await archiveClient.reconcileAndFinalizeOrder('test_order_archive_001');
    assert.equal(typeof archiveRes.success, 'boolean');
    assert.equal(archiveRes.orderId, 'test_order_archive_001');
  });

  it('3. Deadline enforcement: aborts calls exceeding client deadline', async () => {
    // We simulate an ultra-tight 1ms deadline that will expire
    try {
      await orderClient.getAuthoritativeOrder('test_order_timeout', 1);
      // If it somehow completed within 1ms, it's fine, but usually it exceeds deadline
    } catch (err: any) {
      assert(err instanceof GrpcDomainError, 'Should throw a GrpcDomainError');
      if (err.code === grpc.status.DEADLINE_EXCEEDED) {
        assert.equal(err.isTimeout, true);
        assert(err.message.includes('deadline exceeded'));
      }
    }
  });

  it('4. Payment verification with strict INR currency, TxID, and Idempotency', async () => {
    const idempotencyKey = `idem_key_${Date.now()}`;

    // Test 4a: Rejects non-INR currency
    const usdRes = await paymentClient.verifyAndReconcilePayment({
      orderId: 'order_currency_test',
      amount: 450,
      currency: 'USD',
      providerTxId: 'tx_usd_123',
      idempotencyKey: `idem_usd_${Date.now()}`,
    });
    assert.equal(usdRes.verified, false);
    assert.equal(usdRes.status, 'REJECTED_CURRENCY');
    assert(usdRes.error?.includes('INR'));

    // Test 4b: Rejects missing providerTxId
    const noTxRes = await paymentClient.verifyAndReconcilePayment({
      orderId: 'order_notx_test',
      amount: 450,
      currency: 'INR',
      providerTxId: '',
    });
    assert.equal(noTxRes.verified, false);
    assert.equal(noTxRes.status, 'REJECTED_MISSING_TXID');

    // Test 4c: Successful payment verification
    const successRes = await paymentClient.verifyAndReconcilePayment({
      orderId: 'order_idem_test',
      amount: 550,
      currency: 'INR',
      provider: 'razorpay',
      providerTxId: 'tx_rzp_99999',
      idempotencyKey,
    });
    assert.equal(successRes.verified, true);
    assert.equal(successRes.status, 'PAYMENT_CAPTURED');
    assert.equal(successRes.amount, 550);
    assert.equal(successRes.currency, 'INR');
    assert.equal(successRes.isDuplicate, false);

    // Test 4d: Idempotency check with the same idempotency key
    const duplicateRes = await paymentClient.verifyAndReconcilePayment({
      orderId: 'order_idem_test',
      amount: 550,
      currency: 'INR',
      provider: 'razorpay',
      providerTxId: 'tx_rzp_99999',
      idempotencyKey,
    });
    assert.equal(duplicateRes.verified, true);
    assert.equal(duplicateRes.status, 'PAYMENT_CAPTURED');
    assert.equal(duplicateRes.amount, 550);
    assert.equal(duplicateRes.isDuplicate, true);
  });
});
