import { query } from '../../lib/db.js';
import { AuthoritativePricingResolver } from '../menu/AuthoritativePricingResolver.js';
import { adminDb } from '../../config/firebase.js';
import { getPaymentConfig } from '../../config/payment.config.js';
import { PaymentProviderFactory } from './PaymentProviderFactory.js';
import { PaymentStateMachine, PaymentState } from './PaymentStateMachine.js';
import { OrderStateMachine } from '../order/OrderStateMachine.js';
import { PaymentErrorHandler } from './PaymentErrorHandler.js';
import { FraudProtectionEngine } from './FraudProtectionEngine.js';
import { PaymentAuditLogger } from './PaymentAuditLogger.js';
import { PaymentEventQueue } from './PaymentEventQueue.js';
import { PaymentRecoveryQueue } from './PaymentRecoveryQueue.js';
import { CODCollectionService } from './CODCollectionService.js';
import crypto from 'crypto';

export interface CreatePaymentSessionParams {
  userId: string;
  items: any[];
  deliveryAddress?: string;
  paymentMethod: 'cod' | 'upi' | 'card' | 'wallet';
  couponCode?: string;
  branchId?: string;
  deliveryType?: 'delivery' | 'pickup' | 'dine_in';
  deliveryFee?: number;
  userIp?: string;
  deviceId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
}

export class PaymentService {
  /**
   * Recalculates total server-side with 100% price accuracy from Firestore products/menu_items/combos
   * Strictly server-authoritative: rejects unknown items, computes variants & addons, includes 5% GST & branch delivery fee.
   */
  public static async recalculateServerTotal(
    items: any[],
    options?: {
      branchId?: string;
      deliveryType?: string;
      couponCode?: string;
      customDeliveryFee?: number;
    }
  ): Promise<{
    validatedItems: any[];
    subtotal: number;
    taxes: number;
    deliveryFee: number;
    packagingCharge: number;
    discountAmount: number;
    totalAmount: number;
  }> {
    let subtotal = 0;
    const validatedItems: any[] = [];
    const resolvedBranchId = options?.branchId || 'main_branch';

    for (const item of items) {
      const itemId = item.menuItemId || item.id;
      if (!itemId || typeof itemId !== 'string') {
        throw new Error('Invalid or missing menu item identifier.');
      }

      let itemPrice = 0;
      let itemName = item.name || 'Menu Item';
      let itemImage = item.image || '';
      const validatedAddons: any[] = [];
      let isAuthoritativelyResolved = false;

      // 1. Authoritative Pricing Resolution (PostgreSQL franchise_prices + size + crust + addons)
      try {
        const authPrice = await AuthoritativePricingResolver.resolveItemPrice({
          branchId: resolvedBranchId,
          productId: itemId,
          size: item.size || item.variant,
          crust: item.crust,
          addons: item.addons
        });
        itemPrice = authPrice.unitPrice; // includes basePrice + sizePrice + crustPrice + addonsPrice
        itemName = authPrice.productName || itemName;
        for (const a of authPrice.addons) {
          validatedAddons.push({
            id: a.name,
            name: a.name,
            price: a.price
          });
        }
        isAuthoritativelyResolved = true;
      } catch (authErr: any) {
        // Fall back to catalog check if not configured in branch overrides
      }

      if (!isAuthoritativelyResolved) {
        let menuData: any = null;
        if (!itemId.startsWith('item-')) {
          let snap = await adminDb.collection('products').doc(itemId).get();
          if (snap.exists) {
            menuData = snap.data();
          } else {
            snap = await adminDb.collection('menu_items').doc(itemId).get();
            if (snap.exists) {
              menuData = snap.data();
            } else {
              snap = await adminDb.collection('combos').doc(itemId).get();
              if (snap.exists) {
                menuData = snap.data();
              }
            }
          }
        }

        if (!menuData) {
          throw new Error(`Item "${item.name || itemId}" was not found in our authoritative menu catalog.`);
        }

        if (menuData.isAvailable === false || menuData.isActive === false) {
          throw new Error(`Item "${menuData.name || menuData.productName || item.name}" is currently unavailable.`);
        }

        const selectedSize = (item.size || item.variant || '').toLowerCase();
        if (selectedSize && menuData.sizes && menuData.sizes[selectedSize]?.price) {
          itemPrice = Number(menuData.sizes[selectedSize].price);
        } else if (selectedSize && Array.isArray(menuData.variants)) {
          const variant = menuData.variants.find((v: any) => (v.name || v.size || '').toLowerCase() === selectedSize);
          if (variant && variant.price) {
            itemPrice = Number(variant.price);
          }
        }

        if (!itemPrice || itemPrice <= 0) {
          itemPrice = Number(menuData.offerPrice ?? menuData.basePrice ?? menuData.price ?? menuData.base_price ?? 0);
        }

        if (itemPrice <= 0) {
          throw new Error(`Unable to verify authoritative price for item "${menuData.name || item.name}".`);
        }

        itemName = menuData.productName || menuData.name || item.name || 'Artisan Pizza Item';
        itemImage = menuData.imageUrl || menuData.image || item.image || '';

        if (Array.isArray(item.addons) && item.addons.length > 0 && Array.isArray(menuData.addons)) {
          for (const addon of item.addons) {
            if (!addon) continue;
            const authoritativeAddon = menuData.addons.find((a: any) => (
              (addon.id && a.id === addon.id) ||
              (addon.name && a.name && a.name.toLowerCase().trim() === String(addon.name).toLowerCase().trim())
            ));
            if (authoritativeAddon) {
              const addonPrice = Number(authoritativeAddon.price || 0);
              itemPrice += addonPrice;
              validatedAddons.push({
                id: authoritativeAddon.id || addon.id || addon.name,
                name: authoritativeAddon.name || addon.name,
                price: addonPrice
              });
            }
          }
        }
      }

      const qty = Math.max(1, Math.min(50, Math.floor(Number(item.quantity || 1))));
      subtotal += itemPrice * qty;

      validatedItems.push({
        id: itemId,
        menuItemId: itemId,
        name: itemName,
        price: itemPrice,
        quantity: qty,
        size: item.size || item.variant || 'Medium',
        crust: item.crust || 'Classic Crust',
        addons: validatedAddons,
        image: itemImage,
      });
    }

    // Authoritative Delivery Fee calculation
    let deliveryFee = 0;
    const deliveryType = options?.deliveryType || 'delivery';
    if (deliveryType === 'delivery') {
      if (options?.customDeliveryFee != null) {
        deliveryFee = Math.max(0, Number(options.customDeliveryFee));
      } else if (resolvedBranchId) {
        try {
          const bDoc = await adminDb.collection('franchises').doc(resolvedBranchId).get();
          const bData = bDoc.data();
          const dSettings = bData?.deliverySettings;
          const baseFee = Number(dSettings?.deliveryFee ?? 30);
          const freeAbove = Number(dSettings?.freeDeliveryThreshold ?? 500);
          deliveryFee = (freeAbove > 0 && subtotal >= freeAbove) ? 0 : Math.max(0, baseFee);
        } catch {
          deliveryFee = subtotal >= 500 || subtotal === 0 ? 0 : 30;
        }
      } else {
        deliveryFee = subtotal >= 500 || subtotal === 0 ? 0 : 30;
      }
    }

    // 5% GST
    const taxes = Math.round(subtotal * 0.05);

    // Authoritative packaging charge from PostgreSQL branch settings
    let packagingCharge = 0;
    try {
      const branchRes = await query('SELECT tax_settings FROM restaurant_branches WHERE id = $1 LIMIT 1', [resolvedBranchId]);
      if (branchRes.rows.length > 0 && branchRes.rows[0].tax_settings?.packagingCharge != null) {
        packagingCharge = Number(branchRes.rows[0].tax_settings.packagingCharge);
      } else {
        packagingCharge = 20;
      }
    } catch {
      packagingCharge = 20;
    }

    // Optional Coupon Discount re-evaluation
    let discountAmount = 0;
    if (options?.couponCode) {
      try {
        const cCode = options.couponCode.toUpperCase().trim();
        let cSnap = await adminDb.collection('coupons').doc(cCode).get();
        let cData = cSnap.exists ? cSnap.data() : null;
        if (!cData) {
          const qSnap = await adminDb.collection('coupons').where('code', '==', cCode).limit(1).get();
          if (!qSnap.empty) {
            cData = qSnap.docs[0].data();
          }
        }
        if (cData) {
          const now = new Date();
          const startsAt = cData.startsAt ? new Date(cData.startsAt) : null;
          const expiresAt = cData.expiresAt ? new Date(cData.expiresAt) : null;
          const usageCount = Number(cData.usageCount || 0);
          const usageLimit = Number(cData.usageLimit ?? Infinity);
          const minOrderAmount = Number(cData.minOrderAmount || 0);

          if (cData.isActive !== false && (!expiresAt || now <= expiresAt) && (!startsAt || now >= startsAt) && usageCount < usageLimit && subtotal >= minOrderAmount) {
            const discountType = cData.discountType || 'percentage';
            const discountValue = Number(cData.discountValue || 0);
            const maxDiscount = Number(cData.maxDiscount || Infinity);
            if (discountType === 'percentage') {
              discountAmount = Math.min(Math.round(subtotal * (discountValue / 100)), maxDiscount);
            } else if (discountType === 'flat') {
              discountAmount = Math.min(discountValue, subtotal);
            }
          }
        }
      } catch (cErr: any) {
        console.warn('[PaymentService] Coupon recheck notice:', cErr.message);
      }
    }

    const totalAmount = Math.max(0, subtotal - discountAmount) + deliveryFee + taxes + packagingCharge;

    return {
      validatedItems,
      subtotal,
      taxes,
      deliveryFee,
      packagingCharge,
      discountAmount,
      totalAmount,
    };
  }

  /**
   * Main Intent & Session Creator
   */
  public static async createPaymentSession(params: CreatePaymentSessionParams): Promise<{
    paymentId: string;
    sessionId: string;
    state: PaymentState;
    totalAmount: number;
    paymentMethod: string;
    sdkPayload?: any;
    checkoutUrl?: string;
    orderId?: string;
  }> {
    const config = getPaymentConfig();

    if (config.maintenanceMode) {
      throw new Error('Online payments are temporarily paused for maintenance. Cash on Delivery is available!');
    }
    if (config.enableCodOnly && params.paymentMethod !== 'cod') {
      throw new Error('Only Cash on Delivery payments are enabled at this time.');
    }

    // 1. Recalculate total server-side
    const { validatedItems, totalAmount } = await this.recalculateServerTotal(params.items, {
      branchId: params.branchId,
      deliveryType: params.deliveryType,
      couponCode: params.couponCode,
      customDeliveryFee: params.deliveryFee,
    });

    // 2. Fraud & Velocity Evaluation
    const fraudRes = FraudProtectionEngine.evaluateRisk({
      userId: params.userId,
      userIp: params.userIp,
      deviceId: params.deviceId,
      amount: totalAmount,
      currency: config.currency,
      itemCount: validatedItems.length,
    });

    if (!fraudRes.passed) {
      throw new Error(`Payment security check failed: ${fraudRes.reason}`);
    }

    const paymentId = `pay_${crypto.randomUUID()}`;
    const sessionId = `sess_${crypto.randomUUID()}`;
    let state: PaymentState = 'CREATED';

    // Log Initial State
    await PaymentAuditLogger.log({
      paymentId,
      action: 'PAYMENT_SESSION_CREATED',
      actorId: params.userId,
      actorRole: 'customer',
      details: { amount: totalAmount, paymentMethod: params.paymentMethod, riskScore: fraudRes.riskScore },
      ipAddress: params.userIp,
    });

    state = PaymentStateMachine.transition(state, 'INTENT_CREATED');

    // Store in PostgreSQL canonical financial ledger before returning session
    try {
      await query(`
        INSERT INTO payments (id, payment_session_id, user_id, provider, amount, currency, status, payment_method, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      `, [
        paymentId,
        sessionId,
        params.userId,
        config.activeProvider,
        totalAmount,
        config.currency,
        state,
        params.paymentMethod,
        JSON.stringify({ items: validatedItems, deliveryAddress: params.deliveryAddress }),
      ]);
    } catch (err: any) {
      console.error('[PaymentService] CRITICAL: Canonical payment persistence failed in PostgreSQL:', err.message);
      throw new Error(`Payment session creation aborted: Canonical financial record could not be secured. (${err.message})`);
    }

    // Handle Online vs COD
    if (params.paymentMethod === 'cod') {
      return {
        paymentId,
        sessionId,
        state,
        totalAmount,
        paymentMethod: 'cod',
      };
    }

    // Online Gateway Intent Creation
    const provider = PaymentProviderFactory.getProvider();
    try {
      const intentRes = await provider.createPaymentIntent({
        paymentId,
        sessionId,
        amount: totalAmount,
        currency: config.currency,
        userId: params.userId,
        customerName: params.customerName,
        customerEmail: params.customerEmail,
        customerPhone: params.customerPhone,
      });

      PaymentProviderFactory.recordSuccess(provider.name);

      // Update provider_payment_id in Postgres
      try {
        await query(`UPDATE payments SET provider_payment_id = $1, status = 'PAYMENT_PENDING' WHERE id = $2`, [intentRes.providerPaymentId, paymentId]);
      } catch (e) {}

      return {
        paymentId,
        sessionId,
        state: 'PAYMENT_PENDING',
        totalAmount,
        paymentMethod: params.paymentMethod,
        sdkPayload: intentRes.sdkPayload,
        checkoutUrl: intentRes.checkoutUrl,
      };
    } catch (err: any) {
      PaymentProviderFactory.recordFailure(provider.name);
      throw err;
    }
  }

  /**
   * Process Webhook Notification safely with HMAC validation
   */
  public static async processWebhook(providerName: string, rawBody: string | object, signature: string): Promise<{ success: boolean; eventType: string }> {
    const normProvider = (providerName || '').toLowerCase().trim();
    const ALLOWED_PROVIDERS = ['razorpay', 'phonepe', 'cashfree', 'mock'];
    if (!ALLOWED_PROVIDERS.includes(normProvider)) {
      throw new Error(`Unsupported payment provider: ${providerName}`);
    }

    const provider = PaymentProviderFactory.getProvider(normProvider);
    const isSignatureValid = provider.verifySignature(rawBody, signature);

    if (!isSignatureValid) {
      console.error(`[Webhook] Invalid signature from provider: ${providerName}`);
      throw PaymentErrorHandler.createError('INVALID_SIGNATURE', 'Webhook HMAC signature mismatch', { provider: providerName });
    }

    const payload: any = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const eventId = payload.event_id || payload.id || `evt_${Date.now()}`;

    // Replay attack prevention check in DB (fail closed on DB error)
    const existing = await query('SELECT 1 FROM payment_webhooks WHERE event_id = $1', [eventId]);
    if (existing.rows.length > 0) {
      console.warn(`[Webhook] Duplicate webhook event ID ${eventId} ignored.`);
      return { success: true, eventType: 'duplicate_ignored' };
    }

    await query(
      'INSERT INTO payment_webhooks (id, provider, event_type, event_id, payload, signature_verified, processed_at) VALUES ($1, $2, $3, $4, $5, true, NOW())',
      [crypto.randomUUID(), providerName, payload.event || 'payment.success', eventId, JSON.stringify(payload)]
    );

    console.log(`✅ [Webhook] Verified webhook received from ${providerName}:`, payload.event || 'payment.success');

    // Extract payment ID, order ID, attempt ID & Provider Transaction ID across standard gateway payloads
    let paymentId = payload.paymentId || payload.orderId;
    let orderId = payload.orderId;
    let attemptId = payload.attemptId;
    let providerTxId = payload.id;
    let amount = payload.amount;

    if (payload.payload?.payment?.entity) {
      // Razorpay webhook format
      const rzpPayment = payload.payload.payment.entity;
      paymentId = rzpPayment.notes?.paymentId || rzpPayment.order_id || paymentId;
      orderId = rzpPayment.notes?.orderId || orderId;
      attemptId = rzpPayment.notes?.attemptId || attemptId;
      providerTxId = rzpPayment.id || providerTxId;
      amount = rzpPayment.amount ? rzpPayment.amount / 100 : amount;
    } else if (payload.data?.order) {
      // Cashfree webhook format
      const cfOrder = payload.data.order;
      paymentId = cfOrder.order_id || cfOrder.order_tags?.paymentId || paymentId;
      orderId = cfOrder.order_tags?.orderId || orderId;
      attemptId = cfOrder.order_tags?.attemptId || attemptId;
      providerTxId = payload.data?.payment?.cf_payment_id || providerTxId;
    }

    // Check if this payment is for a COD order / UPI QR attempt
    const targetOrderId = orderId || paymentId;
    if (targetOrderId) {
      try {
        const orderSnap = await adminDb.collection('orders').doc(targetOrderId).get();
        if (orderSnap.exists) {
          const oData = orderSnap.data()!;
          const isCodOrder = (oData.paymentMethod || '').toLowerCase() === 'cod' || oData.isCod === true;
          if (isCodOrder) {
            await CODCollectionService.captureUpiPaymentFromWebhook({
              orderId: targetOrderId,
              attemptId: attemptId || oData.codPaymentAttempt?.attemptId,
              provider: providerName,
              providerTransactionId: providerTxId || `tx_${Date.now()}`,
              amountPaid: Number(amount || oData.totalAmount || 0),
              rawPayload: payload,
            });
            return { success: true, eventType: payload.event || 'payment.success' };
          }
        }
      } catch (codErr: any) {
        console.warn('[Webhook] COD UPI capture check warning:', codErr.message);
      }
    }

    if (paymentId) {
      // 1. Validate payment record exists in PostgreSQL
      const payRecordRes = await query('SELECT id, amount, currency, status, user_id, metadata FROM payments WHERE id = $1 OR provider_payment_id = $1 LIMIT 1', [paymentId]);
      if (payRecordRes.rows.length === 0) {
        console.error(`[Webhook] CRITICAL: Unknown payment ID ${paymentId} received in webhook from ${providerName}`);
        throw new Error(`Payment verification failed: No payment record found for ${paymentId}`);
      }

      const canonicalPayment = payRecordRes.rows[0];

      // 2. Validate amount and currency match recorded transaction
      if (amount != null) {
        const expectedAmount = Number(canonicalPayment.amount || 0);
        const receivedAmount = Number(amount);
        if (Math.abs(expectedAmount - receivedAmount) > 0.05) {
          console.error(`[Webhook] CRITICAL SECURITY ALERT: Webhook amount mismatch for payment ${paymentId}! Expected: ₹${expectedAmount}, Received: ₹${receivedAmount}`);
          throw new Error(`CRITICAL SECURITY ALERT: Webhook amount mismatch for ${paymentId}`);
        }
      }

      // 3. Atomically update PostgreSQL payment status
      await query(
        "UPDATE payments SET status = 'PAYMENT_CAPTURED', provider_transaction_id = $1, verified_at = NOW(), updated_at = NOW() WHERE id = $2 OR provider_payment_id = $2",
        [providerTxId || `tx_${Date.now()}`, paymentId]
      );

      // 4. Update canonical order status and projection via OrderStateMachine
      const orderIdToUpdate = orderId || canonicalPayment.metadata?.orderId || paymentId;
      if (orderIdToUpdate) {
        // Update PostgreSQL canonical_orders
        await query(
          "UPDATE canonical_orders SET payment_status = 'PAID', is_paid = TRUE, updated_at = NOW() WHERE id = $1",
          [orderIdToUpdate]
        ).catch(() => {});

        // Synchronize operational state through OrderStateMachine
        try {
          const orderSnap = await adminDb.collection('orders').doc(orderIdToUpdate).get();
          if (orderSnap.exists) {
            const currentStatus = orderSnap.data()?.status;
            if (currentStatus === 'pending' || currentStatus === 'pending_payment') {
              await OrderStateMachine.transition(orderIdToUpdate, 'accepted', {
                uid: `webhook_${providerName}`,
                role: 'system',
                name: 'Payment Webhook Service'
              });
            } else {
              await adminDb.collection('orders').doc(orderIdToUpdate).update({
                paymentStatus: 'PAID',
                isPaid: true,
                paidAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                providerTransactionId: providerTxId || null
              });
            }
            console.log(`[Webhook] Order ${orderIdToUpdate} marked as PAID`);
          }
        } catch (stateErr: any) {
          console.warn('[Webhook] Order state sync warning:', stateErr.message);
        }
      }

      // 5. Log Payment Audit Event
      await PaymentAuditLogger.log({
        paymentId,
        action: 'WEBHOOK_PAYMENT_CAPTURED',
        actorId: `webhook_${providerName}`,
        actorRole: 'system',
        details: { provider: providerName, providerTxId, eventType: payload.event || 'payment.success', amount: canonicalPayment.amount }
      });
    }

    return { success: true, eventType: payload.event || 'payment.success' };
  }

  /**
   * Initiates full or partial refund in canonical PostgreSQL ledger
   */
  public static async processRefund(paymentId: string, refundAmount: number, reason: string, actorId: string): Promise<{ success: boolean; refundId: string }> {
    let providerTxId = `tx_${paymentId}`;
    let providerName = 'mock';

    const res = await query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (res.rows.length === 0) {
      throw new Error(`Refund failed: Payment record ${paymentId} not found in database.`);
    }

    providerTxId = res.rows[0].provider_payment_id || providerTxId;
    providerName = res.rows[0].provider || 'mock';

    const provider = PaymentProviderFactory.getProvider(providerName);
    const refundRes = await provider.createRefund({
      paymentId,
      providerTransactionId: providerTxId,
      refundAmount,
      reason,
    });

    if (refundRes.success) {
      await PaymentAuditLogger.log({
        paymentId,
        action: 'REFUND_PROCESSED',
        actorId,
        actorRole: 'owner',
        details: { refundAmount, reason, refundTransactionId: refundRes.refundTransactionId },
      });

      // Atomically commit refund to PostgreSQL
      await query('INSERT INTO refunds (id, payment_id, refund_amount, reason, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())', [
        refundRes.refundTransactionId,
        paymentId,
        refundAmount,
        reason,
        'PROCESSED',
      ]);
      await query("UPDATE payments SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1", [paymentId]);
    }

    return {
      success: refundRes.success,
      refundId: refundRes.refundTransactionId,
    };
  }

  /**
   * Security Invariant: Verifies that a server-captured payment is valid, matches the required amount,
   * and atomically binds it to targetOrderId, preventing captured payment reuse across bills.
   * 
   * Returns:
   * - verified: true if payment is captured, covers amount, and is successfully bound/already bound to targetOrderId.
   * - verified: false if missing, uncaptured, insufficient, or already consumed by a different order.
   */
  public static async verifyAndBindCapturedPayment(params: {
    paymentRef: string;
    targetOrderId: string;
    expectedAmount: number;
    expectedMethod?: string;
    currency?: string;
  }): Promise<{
    verified: boolean;
    reason?: 'ALREADY_CONSUMED' | 'NOT_FOUND' | 'NOT_CAPTURED' | 'INSUFFICIENT_AMOUNT' | 'CURRENCY_MISMATCH' | 'DB_ERROR';
    paymentId?: string;
    amount?: number;
    status?: string;
  }> {
    const { paymentRef, targetOrderId, expectedAmount, currency = 'INR' } = params;
    const cleanRef = (paymentRef || '').toString().trim();
    const cleanOrderId = (targetOrderId || '').toString().trim();

    if (!cleanRef || !cleanOrderId || expectedAmount <= 0) {
      return { verified: false, reason: 'NOT_FOUND' };
    }

    try {
      // 1. Check existing record first to provide exact audit diagnostics
      const checkRes = await query(
        `SELECT id, order_id, amount, currency, status, payment_method, provider 
         FROM payments 
         WHERE (id = $1 OR provider_payment_id = $1 OR payment_session_id = $1)
         LIMIT 1`,
        [cleanRef]
      );

      if (checkRes.rows.length === 0) {
        return { verified: false, reason: 'NOT_FOUND' };
      }

      const rec = checkRes.rows[0];

      // Verify status
      if (!['PAYMENT_CAPTURED', 'PAID'].includes(rec.status)) {
        return { verified: false, reason: 'NOT_CAPTURED', paymentId: rec.id, status: rec.status };
      }

      // Verify amount (allow 5 paisa rounding tolerance)
      const payAmount = Number(rec.amount || 0);
      if (payAmount < (expectedAmount - 0.05)) {
        return { verified: false, reason: 'INSUFFICIENT_AMOUNT', paymentId: rec.id, amount: payAmount };
      }

      // Verify currency if present
      if (rec.currency && rec.currency.toUpperCase() !== currency.toUpperCase()) {
        return { verified: false, reason: 'CURRENCY_MISMATCH', paymentId: rec.id };
      }

      // Anti-Reuse Check: If already assigned to a DIFFERENT order, strictly reject!
      if (rec.order_id && rec.order_id !== cleanOrderId) {
        console.warn(`[PaymentSecurity] REUSE ATTEMPT DETECTED! Payment ${rec.id} is already bound to order ${rec.order_id}. Cannot be reused for order ${cleanOrderId}.`);
        return { verified: false, reason: 'ALREADY_CONSUMED', paymentId: rec.id };
      }

      // 2. Atomic Bind: Claim payment for this targetOrderId under concurrency protection
      // If order_id is NULL or already equals cleanOrderId, set order_id = cleanOrderId
      const updateRes = await query(
        `UPDATE payments 
         SET order_id = $1, updated_at = NOW() 
         WHERE (id = $2 OR provider_payment_id = $2 OR payment_session_id = $2)
           AND status IN ('PAYMENT_CAPTURED', 'PAID')
           AND amount >= ($3 - 0.05)
           AND (order_id IS NULL OR order_id = $1)
         RETURNING id, order_id, amount, status`,
        [cleanOrderId, cleanRef, expectedAmount]
      );

      if (updateRes.rows.length === 0) {
        // Under concurrent race condition, another request claimed the payment first!
        console.warn(`[PaymentSecurity] Concurrency lock: Payment ${cleanRef} was claimed by another transaction during atomic bind.`);
        return { verified: false, reason: 'ALREADY_CONSUMED' };
      }

      return {
        verified: true,
        paymentId: updateRes.rows[0].id,
        amount: Number(updateRes.rows[0].amount),
        status: updateRes.rows[0].status
      };
    } catch (err: any) {
      console.error('[PaymentSecurity] Database error during payment verification and binding:', err.message || err);
      return { verified: false, reason: 'DB_ERROR' };
    }
  }
}
