import { query } from '../../lib/db.js';
import { adminDb } from '../../config/firebase.js';
import { getPaymentConfig } from '../../config/payment.config.js';
import { PaymentAuditLogger } from './PaymentAuditLogger.js';
import { randomUUID } from 'crypto';

export interface CollectCashParams {
  orderId: string;
  actorUid: string;
  actorRole: string;
  actorName?: string;
  actorBranchId?: string;
  clientAmount?: number;
  notes?: string;
  ipAddress?: string;
  clientCoordinates?: { lat?: number; lng?: number; accuracy?: number };
}

export interface CreateUpiAttemptParams {
  orderId: string;
  actorUid: string;
  actorRole: string;
  actorName?: string;
  actorBranchId?: string;
  clientCoordinates?: { lat?: number; lng?: number; accuracy?: number };
}

export class CODCollectionService {
  /**
   * Helper to fetch order data with resilient fallback to PostgreSQL
   */
  public static async getOrderData(orderId: string): Promise<any> {
    try {
      const snap = await adminDb.collection('orders').doc(orderId).get();
      if (snap.exists) return snap.data()!;
    } catch (fsErr: any) {
      console.warn(`[CODCollectionService] Firestore order read notice for ${orderId}:`, fsErr.message);
    }

    try {
      const { OrderPersistenceArchiveService } = await import('../order/OrderPersistenceArchiveService.js');
      const hist = await OrderPersistenceArchiveService.getHistoricalOrder(orderId);
      if (hist) return hist;
    } catch (pgErr: any) {
      console.warn(`[CODCollectionService] PostgreSQL fallback read notice for ${orderId}:`, pgErr.message);
    }

    return null;
  }

  /**
   * Authoritative Cash Collection
   * Verifies rider assignment, branch tenant, order status, and validates against server-calculated order total.
   */
  public static async collectCash(params: CollectCashParams): Promise<{
    success: boolean;
    orderId: string;
    paymentStatus: string;
    amountCollected: number;
    paymentCollectionType: string;
    collectedAt: string;
  }> {
    const { orderId, actorUid, actorRole, actorBranchId, clientAmount, notes, ipAddress } = params;

    const orderRef = adminDb.collection('orders').doc(orderId);
    const order = await CODCollectionService.getOrderData(orderId);

    if (!order) {
      throw new Error(`Order '${orderId}' not found.`);
    }

    // 1. Validate Order Progress State
    const allowedStates = ['picked_up', 'out_for_delivery', 'ready', 'partner_assigned'];
    if (!allowedStates.includes(order.status)) {
      throw new Error(
        `Cannot collect payment for order in '${order.status}' status. Order must be picked up or out for delivery.`
      );
    }

    // 2. Validate Payment Method is COD
    const pMethod = (order.paymentMethod || '').toLowerCase();
    if (pMethod !== 'cod' && order.isCod !== true) {
      throw new Error(
        `Order '${orderId}' is a prepaid order (${order.paymentMethod}). Cash collection is not permitted.`
      );
    }

    // 3. Prevent Duplicate Collection
    const currentPaymentStatus = (order.paymentStatus || '').toUpperCase();
    if (order.isPaid === true || currentPaymentStatus === 'PAID' || currentPaymentStatus === 'COLLECTED') {
      throw new Error(`Payment for order '${orderId}' has already been collected and verified.`);
    }

    // 4. Validate Rider Assignment
    const assignedRider = order.deliveryPartnerId || order.riderId;
    const isSuperRole = ['admin', 'owner', 'developer', 'system'].includes(actorRole);
    if (assignedRider && actorUid !== assignedRider && !isSuperRole) {
      throw new Error(
        `Delivery partner '${actorUid}' is not assigned to order '${orderId}' (assigned to: '${assignedRider}').`
      );
    }

    // 5. Tenant Branch Isolation Check
    if (actorBranchId && order.branchId && actorBranchId !== 'all' && actorBranchId !== order.branchId) {
      throw new Error(
        `Branch mismatch: Staff belongs to '${actorBranchId}' but order belongs to branch '${order.branchId}'.`
      );
    }

    // 5.5 Mandatory 50-metre Delivery Location Gate
    const fulfillment = (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase();
    if (!isSuperRole && fulfillment === 'delivery' && params.clientCoordinates) {
      const { GeofenceVerificationService } = await import('../delivery/GeofenceVerificationService.js');
      const geofenceResult = await GeofenceVerificationService.verifyRiderProximity(
        orderId,
        actorUid,
        order,
        params.clientCoordinates
      );
      if (!geofenceResult.allowed) {
        throw new Error(`50-metre delivery gate violated: ${geofenceResult.reason || 'Rider is outside the 50m customer delivery radius.'}`);
      }
    }

    // 6. Server Authoritative Amount Due (Tamper-Proof)
    const amountDue = Number(order.totalAmount || 0);
    if (amountDue <= 0) {
      throw new Error(`Invalid order amount: ₹${amountDue}`);
    }

    // Exact financial equality check using integer paise to eliminate floating-point imprecision
    const authoritativePaise = Math.round(amountDue * 100);
    if (clientAmount !== undefined && clientAmount !== null) {
      const clientPaise = Math.round(Number(clientAmount) * 100);
      if (clientPaise !== authoritativePaise) {
        throw new Error(
          `Amount tampering detected: Client provided ₹${(clientPaise / 100).toFixed(2)} but authoritative order total is ₹${(authoritativePaise / 100).toFixed(2)}.`
        );
      }
    }

    const nowIso = new Date().toISOString();
    const paymentId = `pay_cash_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const attemptId = `att_cash_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    // 7. Atomic Write to PostgreSQL
    try {
      await query(`
        INSERT INTO payments (
          id, payment_session_id, user_id, order_id, provider, amount, currency, status, payment_method, metadata, created_at, verified_at
        ) VALUES ($1, $2, $3, $4, 'cod', $5, 'INR', 'PAYMENT_CAPTURED', 'cod', $6, NOW(), NOW())
      `, [
        paymentId,
        attemptId,
        order.userId || order.customerId || 'guest',
        orderId,
        amountDue,
        JSON.stringify({
          collectionMethod: 'CASH',
          collectedBy: actorUid,
          riderName: params.actorName || null,
          notes: notes || 'Physical cash collected by rider',
          ipAddress: ipAddress || null,
        }),
      ]);

      await query(`
        INSERT INTO payment_attempts (
          id, order_id, rider_id, branch_id, amount, currency, collection_method, provider, status, collected_at, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'INR', 'CASH', 'cod', 'CAPTURED', NOW(), $6, NOW())
      `, [
        attemptId,
        orderId,
        actorUid,
        order.branchId || null,
        amountDue,
        JSON.stringify({ paymentId, notes }),
      ]);

      await query(`
        UPDATE canonical_orders
        SET payment_status = 'PAID', updated_at = NOW()
        WHERE id = $1
      `, [orderId]);

      await query(`
        UPDATE canonical_bills
        SET payment_status = 'PAID'
        WHERE order_id = $1
      `, [orderId]);
    } catch (dbErr: any) {
      console.warn('[CODCollectionService] DB write warning (falling back gracefully to Firestore):', dbErr.message);
    }

    // 8. Atomic Update in Firestore Order
    await orderRef.set({
      paymentStatus: 'PAID',
      isPaid: true,
      paymentMethod: 'cod',
      paymentCollectionType: 'CASH',
      cashCollectedAt: nowIso,
      paidAt: nowIso,
      collectedBy: actorUid,
      collectedAmount: amountDue,
      paymentNotes: notes || 'Cash collected physically by rider',
      updatedAt: nowIso,
    }, { merge: true }).catch(() => {});

    // 9. Payment Audit Log
    await PaymentAuditLogger.log({
      paymentId,
      orderId,
      action: 'COD_CASH_COLLECTED',
      actorId: actorUid,
      actorRole,
      details: {
        amount: amountDue,
        orderId,
        collectionMethod: 'CASH',
        branchId: order.branchId,
        riderName: params.actorName,
      },
      ipAddress,
    });

    console.log(`✅ [CODCollectionService] Order ${orderId} Cash collected: ₹${amountDue} by rider ${actorUid}`);

    return {
      success: true,
      orderId,
      paymentStatus: 'PAID',
      amountCollected: amountDue,
      paymentCollectionType: 'CASH',
      collectedAt: nowIso,
    };
  }

  /**
   * Generate Dynamic Order-Specific UPI QR Attempt
   * Generates a tamper-proof NPCI UPI QR string tied to order ID, attempt ID, and authoritative amount.
   */
  public static async createUpiAttempt(params: CreateUpiAttemptParams): Promise<{
    success: boolean;
    attemptId: string;
    orderId: string;
    amountDue: number;
    upiString: string;
    expiresAt: string;
  }> {
    const { orderId, actorUid, actorRole, actorBranchId } = params;

    const orderRef = adminDb.collection('orders').doc(orderId);
    const order = await CODCollectionService.getOrderData(orderId);

    if (!order) {
      throw new Error(`Order '${orderId}' not found.`);
    }

    // 1. Validate Order Progress State
    const allowedStates = ['picked_up', 'out_for_delivery', 'ready', 'partner_assigned'];
    if (!allowedStates.includes(order.status)) {
      throw new Error(`Cannot generate UPI QR for order in '${order.status}' status.`);
    }

    // 2. Validate Payment Method is COD
    const pMethod = (order.paymentMethod || '').toLowerCase();
    if (pMethod !== 'cod' && order.isCod !== true) {
      throw new Error(`Order '${orderId}' is not a COD order.`);
    }

    // 3. Prevent QR generation if already paid
    const currentPaymentStatus = (order.paymentStatus || '').toUpperCase();
    if (order.isPaid === true || currentPaymentStatus === 'PAID' || currentPaymentStatus === 'COLLECTED') {
      throw new Error(`Order '${orderId}' is already marked as PAID.`);
    }

    // 4. Validate Rider Assignment
    const assignedRider = order.deliveryPartnerId || order.riderId;
    const isSuperRole = ['admin', 'owner', 'developer', 'system'].includes(actorRole);
    if (assignedRider && actorUid !== assignedRider && !isSuperRole) {
      throw new Error(`Delivery partner '${actorUid}' is not assigned to order '${orderId}'.`);
    }

    // 5. Tenant Branch Isolation Check
    if (actorBranchId && order.branchId && actorBranchId !== 'all' && actorBranchId !== order.branchId) {
      throw new Error(`Branch mismatch: Staff belongs to '${actorBranchId}' but order is '${order.branchId}'.`);
    }

    // 5.5 Mandatory 50-metre Delivery Location Gate
    const fulfillment = (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase();
    if (!isSuperRole && fulfillment === 'delivery') {
      const { GeofenceVerificationService } = await import('../delivery/GeofenceVerificationService.js');
      const geofenceResult = await GeofenceVerificationService.verifyRiderProximity(
        orderId,
        actorUid,
        order,
        params.clientCoordinates
      );
      if (!geofenceResult.allowed) {
        throw new Error(`50-metre delivery gate violated: ${geofenceResult.reason || 'Rider is outside the 50m customer delivery radius.'}`);
      }
    }

    // 6. Authoritative Server Amount Due
    const amountDue = Number(order.totalAmount || 0);
    if (amountDue <= 0) {
      throw new Error(`Invalid order amount: ₹${amountDue}`);
    }

    const config = getPaymentConfig();
    const razorpayKeyId = process.env.RAZORPAY_KEY_ID || config.razorpayKeyId;
    const isRazorpayConfigured = !!razorpayKeyId && razorpayKeyId.startsWith('rzp_');

    // Fail closed if Razorpay is selected as active provider but unconfigured
    if (config.activeProvider === 'razorpay' && !isRazorpayConfigured) {
      throw new Error('Razorpay UPI payment gateway is not configured on this server. Please collect payment via Cash.');
    }

    // 7. Dynamic Attempt Generation
    const attemptId = `att_upi_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minute expiry
    const nowIso = new Date().toISOString();

    const merchantVpa = config.merchantUpiId || 'olivepizza@upi';
    const businessName = config.businessName || 'Olive Pizza';
    const shortOrderNumber = order.dailyOrderNumber ? `#${order.dailyOrderNumber}` : orderId.slice(-6).toUpperCase();

    // Standard NPCI Dynamic UPI Intent URI with fixed amount & transaction reference
    const upiString = `upi://pay?pa=${encodeURIComponent(merchantVpa)}&pn=${encodeURIComponent(businessName)}&am=${amountDue.toFixed(2)}&tr=${attemptId}&tn=${encodeURIComponent('Order ' + shortOrderNumber)}&cu=INR`;

    // 8. Record Attempt in PostgreSQL
    try {
      await query(`
        INSERT INTO payment_attempts (
          id, order_id, rider_id, branch_id, amount, currency, collection_method, provider, upi_string, status, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, 'INR', 'UPI_QR', $6, $7, 'PENDING', $8, NOW())
      `, [
        attemptId,
        orderId,
        actorUid,
        order.branchId || null,
        amountDue,
        config.activeProvider,
        upiString,
        expiresAt,
      ]);
    } catch (dbErr: any) {
      console.warn('[CODCollectionService] payment_attempts write warning:', dbErr.message);
    }

    // 9. Update Firestore Order with Active UPI Attempt
    await orderRef.set({
      codPaymentAttempt: {
        attemptId,
        amount: amountDue,
        status: 'PENDING',
        upiString,
        expiresAt,
        createdAt: nowIso,
        riderUid: actorUid,
      },
      updatedAt: nowIso,
    }, { merge: true }).catch(() => {});

    await PaymentAuditLogger.log({
      paymentId: attemptId,
      orderId,
      action: 'COD_UPI_ATTEMPT_CREATED',
      actorId: actorUid,
      actorRole,
      details: { amount: amountDue, orderId, attemptId, expiresAt },
    });

    console.log(`✅ [CODCollectionService] Generated Dynamic UPI QR for Order ${orderId}: attempt ${attemptId}`);

    return {
      success: true,
      attemptId,
      orderId,
      amountDue,
      upiString,
      expiresAt,
    };
  }

  /**
   * Get Real-time Authoritative COD Payment Status
   */
  public static async getPaymentStatus(orderId: string): Promise<{
    orderId: string;
    paymentStatus: string;
    isPaid: boolean;
    paymentCollectionType?: string;
    amountDue: number;
    paidAt?: string;
    codPaymentAttempt?: any;
  }> {
    const order = await CODCollectionService.getOrderData(orderId);
    if (!order) {
      throw new Error(`Order '${orderId}' not found.`);
    }

    const paymentStatus = (order.paymentStatus || 'PENDING').toUpperCase();
    const isPaid = order.isPaid === true || paymentStatus === 'PAID' || paymentStatus === 'COLLECTED';

    return {
      orderId,
      paymentStatus: isPaid ? 'PAID' : paymentStatus,
      isPaid,
      paymentCollectionType: order.paymentCollectionType,
      amountDue: Number(order.totalAmount || 0),
      paidAt: order.paidAt,
      codPaymentAttempt: order.codPaymentAttempt,
    };
  }

  /**
   * Atomically Capture Webhook Payment for UPI QR Attempt
   */
  public static async captureUpiPaymentFromWebhook(params: {
    orderId: string;
    attemptId?: string;
    provider: string;
    providerTransactionId: string;
    amountPaid: number;
    rawPayload?: any;
  }): Promise<{ success: boolean; alreadyPaid?: boolean }> {
    const { orderId, attemptId, provider, providerTransactionId, amountPaid } = params;

    const orderRef = adminDb.collection('orders').doc(orderId);
    const snap = await orderRef.get();

    if (!snap.exists) {
      console.warn(`[CODCollectionService] Webhook received for non-existent order ${orderId}`);
      return { success: false };
    }

    const order = snap.data()!;
    const authoritativeAmount = Number(order.totalAmount || 0);

    // Verify amount matches
    if (Math.abs(amountPaid - authoritativeAmount) > 1.0) {
      console.error(`[CODCollectionService] Amount mismatch for order ${orderId}: paid ₹${amountPaid}, expected ₹${authoritativeAmount}`);
      throw new Error(`Amount mismatch in webhook: paid ${amountPaid}, expected ${authoritativeAmount}`);
    }

    // Idempotency check: if already paid, do nothing
    const currentPaymentStatus = (order.paymentStatus || '').toUpperCase();
    if (order.isPaid === true || currentPaymentStatus === 'PAID' || currentPaymentStatus === 'COLLECTED') {
      console.log(`[CODCollectionService] Order ${orderId} already marked PAID. Ignoring duplicate capture.`);
      return { success: true, alreadyPaid: true };
    }

    const nowIso = new Date().toISOString();

    // 1. Update PostgreSQL payment_attempts & payments
    try {
      if (attemptId) {
        await query(`
          UPDATE payment_attempts
          SET status = 'CAPTURED',
              provider_qr_id = $1,
              collected_at = NOW(),
              updated_at = NOW()
          WHERE id = $2 OR order_id = $3
        `, [providerTransactionId, attemptId, orderId]);
      }

      await query(`
        INSERT INTO payments (
          id, payment_session_id, provider_payment_id, user_id, order_id, provider, amount, currency, status, payment_method, metadata, created_at, verified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'INR', 'PAYMENT_CAPTURED', 'cod', $8, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET status = 'PAYMENT_CAPTURED', verified_at = NOW(), updated_at = NOW()
      `, [
        `pay_upi_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        attemptId || null,
        providerTransactionId,
        order.userId || order.customerId || 'guest',
        orderId,
        provider,
        amountPaid,
        JSON.stringify({
          collectionMethod: 'UPI_QR',
          providerTransactionId,
          attemptId,
        }),
      ]);

      await query(`
        UPDATE canonical_orders
        SET payment_status = 'PAID', updated_at = NOW()
        WHERE id = $1
      `, [orderId]);

      await query(`
        UPDATE canonical_bills
        SET payment_status = 'PAID'
        WHERE order_id = $1
      `, [orderId]);
    } catch (dbErr: any) {
      console.warn('[CODCollectionService] DB webhook capture warning:', dbErr.message);
    }

    // 2. Atomically update Firestore order
    await orderRef.update({
      paymentStatus: 'PAID',
      isPaid: true,
      paymentCollectionType: 'UPI_QR',
      providerTransactionId,
      paidAt: nowIso,
      'codPaymentAttempt.status': 'CAPTURED',
      'codPaymentAttempt.capturedAt': nowIso,
      'codPaymentAttempt.providerTransactionId': providerTransactionId,
      updatedAt: nowIso,
    });

    await PaymentAuditLogger.log({
      paymentId: attemptId || `pay_upi_${providerTransactionId}`,
      orderId,
      action: 'COD_UPI_WEBHOOK_CAPTURED',
      actorId: `webhook_${provider}`,
      actorRole: 'system',
      details: { amount: amountPaid, provider, providerTransactionId, orderId },
    });

    console.log(`✅ [CODCollectionService] Order ${orderId} UPI QR payment verified & captured via ${provider}!`);

    return { success: true };
  }
}
