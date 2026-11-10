import { Router, Request, Response } from 'express';
import { PaymentService } from '../services/payment/PaymentService.js';
import { PaymentHealthMonitor } from '../services/payment/PaymentHealthMonitor.js';
import { PaymentReportingService } from '../services/payment/PaymentReportingService.js';
import { InvoiceEngine } from '../services/payment/InvoiceEngine.js';
import { getPaymentConfig, updatePaymentConfig } from '../config/payment.config.js';
import { optionalAuth, verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { query } from '../lib/db.js';
import { adminDb } from '../config/firebase.js';
import { CODCollectionService } from '../services/payment/CODCollectionService.js';
import { redisService } from '../services/redis/RedisService.js';
import { PaymentGrpcClient } from '../grpc/clients/PaymentGrpcClient.js';
import crypto from 'crypto';

const router = Router();
const paymentGrpcClient = new PaymentGrpcClient();

// ─── 1. Create Payment Intent / Session ─────────────────────────────────────────
router.post('/create-intent', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { items, deliveryAddress, paymentMethod, couponCode, customerName, customerPhone, customerEmail, branchId, deliveryType } = req.body;
    const userId = req.user?.uid || 'guest-user';
    const userIp = (req.headers['x-forwarded-for'] as string) || req.ip || '127.0.0.1';
    const deviceId = (req.headers['x-device-id'] as string) || 'unknown-device';

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Cart items are required' });
      return;
    }

    // Verify distributed idempotency key to prevent double charge or duplicate session creation
    const idempotencyKey = ((req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '') as string).trim();
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify({
      userId,
      items: items.map((it: any) => ({ id: it.menuItemId || it.id, qty: it.quantity, size: it.size, variant: it.variant })),
      deliveryAddress,
      paymentMethod,
      couponCode,
      branchId,
      deliveryType
    })).digest('hex');

    if (idempotencyKey) {
      const cached = await redisService.get(`idempotency:pay_intent:${idempotencyKey}`);
      if (cached) {
        try {
          const parsed = JSON.parse(cached as string);
          if (parsed.hash === payloadHash) {
            return res.json({ success: true, ...parsed.data, idempotentReplay: true });
          } else {
            return res.status(409).json({ error: 'Idempotency key conflict: key was previously used with different request parameters.' });
          }
        } catch {}
      }
    }

    // Authoritative delivery fee calculation: only authorized staff roles can supply manual fee adjustments
    const userRole = (req.user?.role || 'customer').toLowerCase();
    const isStaff = ['owner', 'admin', 'restaurant_manager', 'cashier'].includes(userRole);
    const authorizedCustomDeliveryFee = isStaff && req.body.deliveryFee != null ? Number(req.body.deliveryFee) : undefined;

    const sessionRes = await PaymentService.createPaymentSession({
      userId,
      items,
      deliveryAddress,
      paymentMethod: paymentMethod || 'cod',
      couponCode,
      branchId,
      deliveryType,
      deliveryFee: authorizedCustomDeliveryFee,
      userIp,
      deviceId,
      customerName: customerName || (req.user as any)?.name || 'Gourmet Customer',
      customerPhone: customerPhone || (req.user as any)?.phone || '',
      customerEmail: customerEmail || (req.user as any)?.email || '',
    });

    if (idempotencyKey) {
      await redisService.set(
        `idempotency:pay_intent:${idempotencyKey}`,
        JSON.stringify({ hash: payloadHash, data: sessionRes }),
        86400
      ).catch(() => {});
    }

    res.json({
      success: true,
      ...sessionRes,
    });
  } catch (error: any) {
    console.error('[PaymentRoute] Error in /create-intent:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ─── 2. Client Payment Verification Callback ──────────────────────────────────
router.post('/verify', verifyToken, async (req: AuthRequest, res: Response) => {
  const requestId = `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  try {
    const { paymentId, providerPaymentId, providerSignature, providerTransactionId } = req.body;
    const authenticatedUid = req.user?.uid;
    const userRole = (req.user?.role || 'customer').toLowerCase();
    const isStaffOrAdmin = ['owner', 'admin'].includes(userRole);

    if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid paymentId is required' });
    }

    // 1. Fetch canonical payment record from PostgreSQL
    const payRecordRes = await query(
      'SELECT id, user_id, amount, currency, status, provider, payment_method, metadata FROM payments WHERE id = $1 LIMIT 1',
      [paymentId]
    );

    if (payRecordRes.rows.length === 0) {
      console.warn(`[PaymentSecurity][${requestId}] Verification rejected: Payment record ${paymentId} not found`);
      return res.status(404).json({ success: false, error: 'Payment record not found' });
    }

    const canonicalPayment = payRecordRes.rows[0];

    // 2. Strict IDOR Check: Ensure payment belongs to authenticated user
    if (!isStaffOrAdmin && canonicalPayment.user_id !== authenticatedUid) {
      console.error(`[PaymentSecurity][${requestId}] IDOR ALERT: User ${authenticatedUid} attempted to verify payment ${paymentId} belonging to user ${canonicalPayment.user_id}`);
      return res.status(403).json({ success: false, error: 'Unauthorized: Payment does not belong to this account' });
    }

    // 3. Idempotent check: If already captured, return success immediately
    if (canonicalPayment.status === 'PAYMENT_CAPTURED' || canonicalPayment.status === 'CAPTURED') {
      return res.json({
        success: true,
        verified: true,
        status: 'captured',
        idempotent: true,
        paymentId,
        providerPaymentId: providerPaymentId || canonicalPayment.id,
      });
    }

    // 4. Delegate to authoritative provider
    const config = getPaymentConfig();
    const providerName = canonicalPayment.provider || config.activeProvider;
    const provider = (await import('../services/payment/PaymentProviderFactory.js')).PaymentProviderFactory.getProvider(providerName);

    const verifyResult = await provider.verifyPayment({
      paymentId,
      providerPaymentId: providerPaymentId || canonicalPayment.provider_payment_id || canonicalPayment.id,
      providerSignature,
      providerTransactionId,
      rawPayload: {
        paymentId,
        currency: canonicalPayment.currency || 'INR'
      }
    });

    // Enforce payment provider verification: require captured status and matching transaction details
    const finalTxId = verifyResult.providerTransactionId || providerTransactionId;
    if (!verifyResult.verified || verifyResult.status !== 'captured') {
      console.warn(`[PaymentSecurity][${requestId}] Verification rejected for ${paymentId}: ${verifyResult.errorReason || 'Not captured'}`);
      return res.status(400).json({
        success: false,
        verified: false,
        status: verifyResult.status || 'failed',
        error: verifyResult.errorReason || 'Payment verification failed at provider (not captured)',
      });
    }

    // Require real non-empty provider transaction ID (never fall back to fake random ID)
    if (!finalTxId || typeof finalTxId !== 'string' || finalTxId.trim().length === 0) {
      console.error(`[PaymentSecurity][${requestId}] REJECT: Missing provider transaction ID for payment ${paymentId}`);
      return res.status(400).json({
        success: false,
        verified: false,
        status: 'failed',
        error: 'Payment provider transaction ID is missing or invalid',
      });
    }

    const expectedAmount = Number(canonicalPayment.amount || 0);
    const receivedAmount = Number(verifyResult.amount || 0);

    // Require positive monetary value
    if (receivedAmount <= 0) {
      console.error(`[PaymentSecurity][${requestId}] REJECT: Zero or non-positive amount received for payment ${paymentId}`);
      return res.status(400).json({
        success: false,
        verified: false,
        status: 'failed',
        error: 'Invalid payment amount received from provider (must be greater than 0)',
      });
    }

    // Amount must match canonical PostgreSQL amount within accepted precision
    if (Math.abs(expectedAmount - receivedAmount) > 0.05) {
      console.error(`[PaymentSecurity][${requestId}] AMOUNT TAMPER ALERT for payment ${paymentId}: Expected ₹${expectedAmount}, received ₹${receivedAmount}`);
      return res.status(400).json({
        success: false,
        verified: false,
        status: 'failed',
        error: `Payment amount mismatch: Expected ₹${expectedAmount}, received ₹${receivedAmount}`,
      });
    }

    // Currency check if provided
    if (verifyResult.currency && String(verifyResult.currency).toUpperCase() !== 'INR') {
      console.error(`[PaymentSecurity][${requestId}] Currency mismatch for payment ${paymentId}: ${verifyResult.currency}`);
      return res.status(400).json({
        success: false,
        verified: false,
        status: 'failed',
        error: `Payment currency mismatch: Expected INR, received ${verifyResult.currency}`,
      });
    }

    // 6. Concurrency-Safe Transactional State Transition with Row-Level Lock
    const { pool } = await import('../lib/db.js');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedRes = await client.query(
        'SELECT id, user_id, amount, currency, status, order_id FROM payments WHERE id = $1 FOR UPDATE',
        [paymentId]
      );
      if (lockedRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Payment record not found' });
      }
      const current = lockedRes.rows[0];
      if (current.status === 'PAYMENT_CAPTURED' || current.status === 'CAPTURED') {
        await client.query('COMMIT');
        return res.json({
          success: true,
          verified: true,
          status: 'captured',
          idempotent: true,
          paymentId,
          providerPaymentId: verifyResult.providerPaymentId || providerPaymentId,
          providerTransactionId: finalTxId
        });
      }
      if (current.status !== 'CREATED' && current.status !== 'PAYMENT_PENDING' && current.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Invalid payment transition: cannot capture payment in status ${current.status}`
        });
      }

      await client.query(
        `UPDATE payments 
         SET status = 'PAYMENT_CAPTURED', provider_transaction_id = $2, verified_at = NOW(), updated_at = NOW() 
         WHERE id = $1`,
        [paymentId, finalTxId]
      );

      if (current.order_id) {
        try {
          await client.query(
            `UPDATE orders SET payment_status = 'PAID', updated_at = NOW() WHERE id = $1 AND payment_status != 'PAID'`,
            [current.order_id]
          );
        } catch (_) {}
      }

      await client.query('COMMIT');
      console.log(`[PaymentSecurity][${requestId}] Payment ${paymentId} successfully verified & CAPTURED via ${providerName} (txId: ${finalTxId})`);

      return res.json({
        success: true,
        verified: true,
        status: 'captured',
        providerPaymentId: verifyResult.providerPaymentId || providerPaymentId,
        providerTransactionId: finalTxId,
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error(`[PaymentSecurity][${requestId}] Internal error during verification:`, error.message);
    res.status(500).json({ success: false, error: 'Internal payment verification failure' });
  }
});

const ALLOWED_PROVIDERS = ['razorpay', 'phonepe', 'cashfree', 'mock'];

// ─── 3. Provider Webhook Listener (HMAC Signature Verified) ───────────────────
router.post('/webhook/:provider', async (req: Request, res: Response) => {
  try {
    const providerName = (req.params.provider || '').toLowerCase().trim();
    if (!ALLOWED_PROVIDERS.includes(providerName)) {
      res.status(400).json({ error: `Unsupported payment provider: ${providerName}` });
      return;
    }

    const signature = (req.headers['x-razorpay-signature'] ||
      req.headers['x-verify'] ||
      req.headers['x-cashfree-signature'] ||
      req.headers['signature']) as string;

    const idempotencyKey = ((req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '') as string).trim();

    const rawPayload = (req as any).rawBody || req.body;
    let result: any;
    const grpcEnabled = process.env.GRPC_ENABLED === 'true';

    if (grpcEnabled) {
      try {
        result = await paymentGrpcClient.processWebhook({
          provider: providerName,
          payloadJson: req.body,
          signature: signature || '',
          idempotencyKey: idempotencyKey || undefined,
        });
      } catch (grpcErr: any) {
        const isConnectionError = grpcErr.code === 14 /* UNAVAILABLE */ ||
          grpcErr.message?.includes('UNAVAILABLE') ||
          grpcErr.message?.includes('ECONNREFUSED') ||
          grpcErr.message?.includes('connect');

        if (isConnectionError) {
          console.warn('[WebhookRoute] gRPC server offline/unavailable, falling back to direct PaymentService:', grpcErr.message);
          const { PaymentService } = await import('../services/payment/PaymentService.js');
          result = await PaymentService.processWebhook(providerName, rawPayload, signature || '');
        } else {
          // Ambiguous error or timeout: check if event was already recorded in payment_webhooks
          const payload = req.body || {};
          const eventId = payload.event_id || payload.id;
          if (eventId) {
            const { query } = await import('../lib/db.js');
            const checkRes = await query('SELECT 1 FROM payment_webhooks WHERE event_id = $1 LIMIT 1', [eventId]);
            if (checkRes.rows.length > 0) {
              result = { success: true, eventType: 'duplicate_ignored', handledBy: 'grpc_committed' };
            } else {
              console.error('[WebhookRoute] gRPC timed out without committing event. Returning 504 for gateway retry.');
              return res.status(504).json({ error: 'Gateway timeout during webhook processing' });
            }
          } else {
            return res.status(502).json({ error: 'gRPC processing failure: ' + grpcErr.message });
          }
        }
      }
    } else {
      const { PaymentService } = await import('../services/payment/PaymentService.js');
      result = await PaymentService.processWebhook(providerName, rawPayload, signature || '');
    }

    res.json({ received: true, ...result });
  } catch (error: any) {
    console.error('[WebhookRoute] Webhook processing failed:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ─── 4. Customer Payment History ──────────────────────────────────────────────
router.get('/history', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const dbRes = await query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
      res.json(dbRes.rows);
    } catch (e) {
      // Fallback from Firestore orders if postgres unavailable
      const snap = await adminDb.collection('orders').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(10).get();
      const history = snap.docs.map((doc) => ({
        id: doc.id,
        orderId: doc.id,
        amount: doc.data().totalAmount,
        status: doc.data().status === 'delivered' ? 'COMPLETED' : 'ORDER_CREATED',
        payment_method: doc.data().paymentMethod || 'cod',
        created_at: doc.data().createdAt,
      }));
      res.json(history);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 4A. COD Cash Collection (Rider / Manager Auth Required) ───────────────────
router.post('/cod/cash-collect', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, amount, notes, lat, lng, riderLat, riderLng, clientCoordinates } = req.body;
    const user = req.user!;

    if (!orderId) {
      res.status(400).json({ success: false, error: 'Order ID is required' });
      return;
    }

    const allowedRoles = ['delivery_partner', 'rider', 'delivery', 'restaurant_manager', 'cashier', 'admin', 'owner', 'system'];
    const userRole = (user.role || 'customer').toLowerCase().trim();
    if (!allowedRoles.includes(userRole)) {
      res.status(403).json({ success: false, error: `Role '${user.role}' is not authorized to collect cash payments.` });
      return;
    }

    const resolvedCoords = clientCoordinates || (
      (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } :
      (riderLat != null && riderLng != null) ? { lat: Number(riderLat), lng: Number(riderLng) } : undefined
    );

    const result = await CODCollectionService.collectCash({
      orderId,
      actorUid: user.uid,
      actorRole: user.role || 'delivery_partner',
      actorName: (user as any).name || 'Delivery Partner',
      actorBranchId: (user as any).branchId,
      clientAmount: amount !== undefined ? Number(amount) : undefined,
      clientCoordinates: resolvedCoords,
      notes,
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.ip || '127.0.0.1',
    });

    res.json(result);
  } catch (error: any) {
    console.error('[PaymentRoute] Error in /cod/cash-collect:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── 4B. COD Dynamic UPI QR Intent Generation ─────────────────────────────────
router.post('/cod/upi-intent', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    const user = req.user!;

    if (!orderId) {
      res.status(400).json({ success: false, error: 'Order ID is required' });
      return;
    }

    const allowedRoles = ['delivery_partner', 'rider', 'delivery', 'restaurant_manager', 'cashier', 'admin', 'owner', 'system'];
    const userRole = (user.role || 'customer').toLowerCase().trim();
    if (!allowedRoles.includes(userRole)) {
      res.status(403).json({ success: false, error: `Role '${user.role}' is not authorized to generate COD UPI QR codes.` });
      return;
    }

    const result = await CODCollectionService.createUpiAttempt({
      orderId,
      actorUid: user.uid,
      actorRole: user.role || 'delivery_partner',
      actorName: (user as any).name || 'Delivery Partner',
      actorBranchId: (user as any).branchId,
    });

    res.json(result);
  } catch (error: any) {
    console.error('[PaymentRoute] Error in /cod/upi-intent:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── 4C. COD Authoritative Payment Status ─────────────────────────────────────
router.get('/cod/status/:orderId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) {
      res.status(400).json({ success: false, error: 'Order ID is required' });
      return;
    }

    const result = await CODCollectionService.getPaymentStatus(orderId);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error('[PaymentRoute] Error in /cod/status:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── 4D. COD Webhook Simulation (Sandbox / Test Verification) ─────────────────
router.post('/cod/simulate-webhook', verifyToken, async (req: AuthRequest, res: Response) => {
  // SECURITY: Block completely in production environment - no exceptions
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }

  try {
    const config = getPaymentConfig();
    const isSandboxOrDev = config.sandboxMode || process.env.NODE_ENV !== 'production';
    const user = req.user!;
    const isPrivileged = ['admin', 'owner', 'developer', 'system'].includes((user.role || '').toLowerCase());

    if (!isSandboxOrDev && !isPrivileged) {
      res.status(403).json({ success: false, error: 'Simulated webhooks only permitted in sandbox mode or by privileged roles.' });
      return;
    }

    const { orderId, attemptId, amount, provider = 'mock' } = req.body;
    if (!orderId) {
      res.status(400).json({ success: false, error: 'Order ID is required' });
      return;
    }

    const txId = `sim_tx_${Date.now()}`;
    const captureResult = await CODCollectionService.captureUpiPaymentFromWebhook({
      orderId,
      attemptId,
      provider,
      providerTransactionId: txId,
      amountPaid: Number(amount || 0),
    });

    res.json({ success: true, simulated: true, providerTransactionId: txId, ...captureResult });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// ─── 5. Invoice Generator HTML/PDF (Protected: Customer Owner or Staff) ────────
router.get('/invoice/:orderId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const orderId = req.params.orderId;
    const user = req.user!;

    const docSnap = await adminDb.collection('orders').doc(orderId).get();
    if (!docSnap.exists) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const orderData = docSnap.data()!;
    const isOwnerOrStaff = ['owner', 'admin', 'restaurant_manager', 'franchise_owner', 'cashier', 'kitchen_staff', 'developer', 'platform_owner'].includes(user.role || '');
    const isCustomerOwner = (orderData.userId === user.uid || orderData.customerUid === user.uid);

    if (!isOwnerOrStaff && !isCustomerOwner) {
      res.status(403).json({ error: 'Access denied to this invoice' });
      return;
    }

    const html = InvoiceEngine.generateInvoiceHtml({
      orderId,
      paymentId: orderData?.paymentId || `pay_${orderId.slice(0, 8)}`,
      customerName: orderData?.contactName || orderData?.customerName || 'Gourmet Customer',
      customerPhone: orderData?.contactPhone || orderData?.phone || '',
      customerAddress: orderData?.deliveryAddress?.addressLine || (typeof orderData?.deliveryAddress === 'string' ? orderData.deliveryAddress : 'Rajnandgaon, CG'),
      items: orderData?.items || [],
      totalAmount: Number(orderData?.totalAmount || 0),
      paymentMethod: orderData?.paymentMethod || 'cod',
      createdAt: orderData?.createdAt ? new Date(orderData.createdAt).toISOString() : new Date().toISOString(),
    });

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error: any) {
    res.status(500).send(`<h2>Invoice Generation Error: ${error.message}</h2>`);
  }
});

// ─── 6. Owner Refund Endpoint ──────────────────────────────────────────────────
router.post('/refund', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId || !amount) {
      res.status(400).json({ error: 'paymentId and amount are required' });
      return;
    }

    const refundRes = await PaymentService.processRefund(paymentId, Number(amount), reason || 'Customer request', req.user?.uid || 'owner');
    res.json(refundRes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 7. Owner Financial Reports & CSV Export ───────────────────────────────────
router.get('/reports', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
  try {
    const period = (req.query.period as 'daily' | 'weekly' | 'monthly') || 'daily';
    const format = req.query.format as string;

    const report = await PaymentReportingService.generateReport(period);

    if (format === 'csv') {
      const csv = PaymentReportingService.exportReportCsv(report);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=financial_report_${period}_${Date.now()}.csv`);
      res.send(csv);
    } else {
      res.json(report);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 8. Developer Telemetry & Payment Diagnostics ─────────────────────────────
router.get('/diagnostics', verifyToken, requireRole(['owner', 'admin', 'developer']), async (_req: Request, res: Response) => {
  try {
    const config = getPaymentConfig();
    const health = await PaymentHealthMonitor.checkAllHealth();

    res.json({
      config: {
        activeProvider: config.activeProvider,
        sandboxMode: config.sandboxMode,
        maintenanceMode: config.maintenanceMode,
        disableOnlinePayments: config.disableOnlinePayments,
        enableCodOnly: config.enableCodOnly,
        currency: config.currency,
        maxOrderAmount: config.maxOrderAmount,
        businessName: config.businessName,
      },
      health,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 9. Developer Dynamic Config Update (Hot Reload) ─────────────────────────
router.put('/config', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res: Response) => {
  try {
    const updated = updatePaymentConfig(req.body);
    res.json({ success: true, config: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
