/**
 * aiIntegration.routes.ts — Production AI Event Gateway
 *
 * Architecture:
 *   Olive Pizza AI ──(Firebase ID Token + X-AI-Signature HMAC)──► Main Backend
 *   Main Backend validates → executes business logic → pushes SSE event to frontend
 *
 * Security Guarantee:
 *  - Firebase ID token = proves WHO the customer is.
 *  - X-AI-Signature HMAC = proves the request came from the trusted AI server.
 *  - AI NEVER touches card details, UPI PINs, OTPs, CVVs or passwords.
 *  - ALL business logic runs exclusively on the Main Backend.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { verifyToken, AuthRequest, requireRole } from '../middleware/auth.middleware.js';
import { adminDb } from '../config/firebase.js';
import kb from '../services/KnowledgeBaseService.js';
import { aiEventStreamService } from '../services/aiEventStream.js';
import { redisService } from '../services/redis/RedisService.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HMAC Signature Validation — server-to-server trust
// ─────────────────────────────────────────────────────────────────────────────
// No default: when AI_GATEWAY_SECRET is unset the gateway rejects every AI service call (fail closed).
function getAIGatewaySecret(): string | undefined {
  const s = process.env.AI_GATEWAY_SECRET?.trim();
  return s ? s : undefined;
}

async function requireAISignature(req: Request, res: Response, next: Function): Promise<void> {
  const secret = getAIGatewaySecret();
  if (!secret) {
    console.error('[AIGateway] AI_GATEWAY_SECRET is not configured — rejecting AI service request.');
    res.status(503).json({ error: 'AI_GATEWAY_UNAVAILABLE: gateway secret not configured' });
    return;
  }

  const signature = req.headers['x-ai-signature'] as string;
  const timestamp  = req.headers['x-ai-timestamp'] as string;
  const nonce = (req.headers['x-ai-nonce'] as string) || signature;

  if (!signature || !timestamp) {
    res.status(401).json({ error: 'AI_GATEWAY_UNAUTHORIZED: Missing signature headers' });
    return;
  }

  // Reject requests older than 2 minutes (replay attack prevention)
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > 2 * 60 * 1000 || age < -30_000) {
    res.status(401).json({ error: 'AI_GATEWAY_UNAUTHORIZED: Request timestamp expired' });
    return;
  }

  const payload = `${timestamp}:${JSON.stringify(req.body)}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'AI_GATEWAY_UNAUTHORIZED: Invalid signature' });
      return;
    }
  } catch {
    res.status(401).json({ error: 'AI_GATEWAY_UNAUTHORIZED: Malformed signature' });
    return;
  }

  // Multi-server distributed replay protection (atomic nonce check in Redis)
  const nonceKey = `ai:nonce:${nonce}`;
  const isFresh = await redisService.acquireLock(nonceKey, 180, false);
  if (!isFresh) {
    console.warn(`[AIGateway] Replay attack detected for AI nonce: ${nonce.slice(0, 16)}...`);
    res.status(401).json({ error: 'AI_GATEWAY_UNAUTHORIZED: Replay attack detected or duplicate request' });
    return;
  }

  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE: Real-Time Event Stream (frontend subscribes; AI pushes events here)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stream', verifyToken, (req: AuthRequest, res: Response) => {
  const userId = req.user?.uid;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  aiEventStreamService.handleConnection(req, res, userId);
});

// ─────────────────────────────────────────────────────────────────────────────
// SSO / AUTH SYNC: Validate user token and return enriched profile for AI
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/sync', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const userDoc = await adminDb.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    res.json({
      success: true,
      uid: userId,
      email: req.user?.email,
      role: req.user?.role || 'customer',
      profile: {
        displayName: userData?.displayName || userData?.name,
        photoURL: userData?.photoURL,
        phone: userData?.phone,
        defaultAddress: userData?.defaultAddress,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER CONTEXT: Profile + recent orders + cart for AI personalisation
// ─────────────────────────────────────────────────────────────────────────────
router.get('/customer', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const [userDoc, ordersSnap, cartDoc] = await Promise.all([
      adminDb.collection('users').doc(userId).get(),
      adminDb.collection('orders').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(5).get(),
      adminDb.collection('carts').doc(userId).get(),
    ]);

    const userData = userDoc.exists ? userDoc.data() : null;
    // Never expose payment secrets or sensitive financial data
    const recentOrders = ordersSnap.docs.map(doc => {
      const d = doc.data();
      return { id: doc.id, status: d.status, totalAmount: d.totalAmount, createdAt: d.createdAt, items: d.items };
    });
    const cartData = cartDoc.exists ? cartDoc.data() : { items: [] };

    res.json({
      success: true,
      profile: { uid: userId, displayName: userData?.displayName || userData?.name, email: req.user?.email, phone: userData?.phone, defaultAddress: userData?.defaultAddress, loyaltyPoints: userData?.loyaltyPoints || 0 },
      recentOrders,
      cart: cartData,
      role: req.user?.role || 'customer',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE MENU: From KB cache (always up to date via Firestore listener)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/menu', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    res.json({
      success: true,
      menu: {
        products: kb.getAllProducts().filter(p => p.isAvailable),
        categories: kb.getAllCategories(),
        coupons: kb.getAllCoupons().filter(c => c.isActive),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HEARTBEAT: AI server registers liveness every 5 minutes
// ─────────────────────────────────────────────────────────────────────────────
router.post('/heartbeat', requireAISignature, async (req: Request, res: Response): Promise<void> => {
  try {
    const { version, activeUsers, modelStatus } = req.body;
    await adminDb.collection('_ai_status_').doc('current').set({
      online: true,
      lastHeartbeat: new Date().toISOString(),
      lastHeartbeatMs: Date.now(),
      version: version || 'unknown',
      activeUsers: activeUsers || 0,
      modelStatus: modelStatus || {},
    }, { merge: true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS: Full 21-action event gateway (cart, coupons, navigation, orders)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/actions', verifyToken, requireAISignature, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.uid!;
  const { actionType, payload = {} } = req.body;

  if (!actionType) { res.status(400).json({ success: false, error: 'actionType is required' }); return; }
  console.log(`[AI Gateway] Action: ${actionType} | User: ${userId}`);

  try {
    let result: any;

    switch (actionType.toUpperCase()) {

      // ── CART MANAGEMENT ────────────────────────────────────────────────────
      case 'ADD_TO_CART': {
        const { productId, quantity = 1, customization = {} } = payload;
        if (!productId) { res.status(400).json({ success: false, error: 'productId required' }); return; }
        const product = kb.getAllProducts().find(p => p.id === productId && p.isAvailable);
        if (!product) { res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND_OR_UNAVAILABLE' }); return; }
        const cartRef = adminDb.collection('carts').doc(userId);
        await adminDb.runTransaction(async t => {
          const doc = await t.get(cartRef);
          let items: any[] = doc.exists ? (doc.data()?.items || []) : [];
          const existing = items.find((i: any) => i.productId === productId && JSON.stringify(i.customization) === JSON.stringify(customization));
          if (existing) { existing.quantity += quantity; } else { items.push({ productId, quantity, name: product.name, price: product.discountedPrice || product.price, customization }); }
          t.set(cartRef, { items, updatedAt: new Date() }, { merge: true });
        });
        result = { productId, productName: product.name, quantity, price: product.discountedPrice || product.price };
        aiEventStreamService.sendToUser(userId, { type: 'CART_UPDATED', action: 'ADD_TO_CART', data: result });
        break;
      }

      case 'REMOVE_FROM_CART': {
        const { productId } = payload;
        if (!productId) { res.status(400).json({ success: false, error: 'productId required' }); return; }
        const cartRef = adminDb.collection('carts').doc(userId);
        await adminDb.runTransaction(async t => {
          const doc = await t.get(cartRef);
          if (!doc.exists) return;
          const items = (doc.data()?.items || []).filter((i: any) => i.productId !== productId);
          t.set(cartRef, { items, updatedAt: new Date() }, { merge: true });
        });
        result = { productId, removed: true };
        aiEventStreamService.sendToUser(userId, { type: 'CART_UPDATED', action: 'REMOVE_FROM_CART', data: result });
        break;
      }

      case 'UPDATE_CART_QUANTITY': {
        const { productId, quantity } = payload;
        if (!productId || quantity === undefined) { res.status(400).json({ success: false, error: 'productId and quantity required' }); return; }
        const cartRef = adminDb.collection('carts').doc(userId);
        await adminDb.runTransaction(async t => {
          const doc = await t.get(cartRef);
          if (!doc.exists) return;
          let items: any[] = doc.data()?.items || [];
          if (quantity <= 0) { items = items.filter((i: any) => i.productId !== productId); }
          else { const item = items.find((i: any) => i.productId === productId); if (item) item.quantity = quantity; }
          t.set(cartRef, { items, updatedAt: new Date() }, { merge: true });
        });
        result = { productId, quantity };
        aiEventStreamService.sendToUser(userId, { type: 'CART_UPDATED', action: 'UPDATE_CART_QUANTITY', data: result });
        break;
      }

      case 'CUSTOMIZE_PRODUCT': {
        const { productId, customization } = payload;
        if (!productId) { res.status(400).json({ success: false, error: 'productId required' }); return; }
        const cartRef = adminDb.collection('carts').doc(userId);
        await adminDb.runTransaction(async t => {
          const doc = await t.get(cartRef);
          if (!doc.exists) return;
          const items: any[] = doc.data()?.items || [];
          const item = items.find((i: any) => i.productId === productId);
          if (item) item.customization = customization || {};
          t.set(cartRef, { items, updatedAt: new Date() }, { merge: true });
        });
        result = { productId, customization };
        aiEventStreamService.sendToUser(userId, { type: 'CART_UPDATED', action: 'CUSTOMIZE_PRODUCT', data: result });
        break;
      }

      // ── COUPON MANAGEMENT ─────────────────────────────────────────────────
      case 'APPLY_COUPON': {
        const { couponCode } = payload;
        if (!couponCode) { res.status(400).json({ success: false, error: 'couponCode required' }); return; }
        const coupon = kb.getAllCoupons().find(c => c.code.toUpperCase() === couponCode.toUpperCase() && c.isActive);
        if (!coupon) { res.status(404).json({ success: false, error: 'COUPON_NOT_FOUND_OR_INACTIVE' }); return; }
        result = { couponCode: coupon.code, discount: coupon.discountValue, discountType: coupon.discountType, minOrder: coupon.minOrder };
        aiEventStreamService.sendToUser(userId, { type: 'COUPON_APPLIED', data: result });
        break;
      }

      case 'REMOVE_COUPON': {
        result = { removed: true };
        aiEventStreamService.sendToUser(userId, { type: 'COUPON_REMOVED', data: result });
        break;
      }

      // ── NAVIGATION (AI signals frontend — never touches DOM directly) ──────
      case 'OPEN_MENU':
      case 'OPEN_OFFERS':
      case 'OPEN_PROFILE':
      case 'OPEN_HELP':
      case 'OPEN_CONTACT':
      case 'OPEN_CHECKOUT':
      case 'CANCEL_CHECKOUT':
      case 'OPEN_PAYMENT_PAGE': {
        const navMap: Record<string, string> = {
          OPEN_MENU: '/menu', OPEN_OFFERS: '/offers', OPEN_PROFILE: '/profile',
          OPEN_HELP: '/help', OPEN_CONTACT: '/contact', OPEN_CHECKOUT: '/checkout',
          CANCEL_CHECKOUT: '/', OPEN_PAYMENT_PAGE: '/payment',
        };
        result = { navigate: navMap[actionType.toUpperCase()] };
        aiEventStreamService.sendToUser(userId, { type: 'NAVIGATE', data: result });
        break;
      }

      case 'TRACK_ORDER': {
        result = { navigate: `/track/${payload.orderId || ''}` };
        aiEventStreamService.sendToUser(userId, { type: 'NAVIGATE', data: result });
        break;
      }

      // ── ORDER FLOW ────────────────────────────────────────────────────────
      case 'PLACE_ORDER': {
        // AI NEVER places an order directly. Signals frontend to open secure checkout.
        result = { navigate: '/checkout', message: 'Please review your order and complete payment securely.' };
        aiEventStreamService.sendToUser(userId, {
          type: 'NAVIGATE', data: { navigate: '/checkout' },
          message: 'Your items are ready! Please review and confirm payment.',
        });
        break;
      }

      case 'REPEAT_ORDER': {
        const { orderId } = payload;
        if (!orderId) { res.status(400).json({ success: false, error: 'orderId required' }); return; }
        const orderDoc = await adminDb.collection('orders').doc(orderId).get();
        if (!orderDoc.exists || orderDoc.data()?.userId !== userId) { res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' }); return; }
        const prevItems = orderDoc.data()?.items || [];
        await adminDb.collection('carts').doc(userId).set({ items: prevItems, updatedAt: new Date() });
        result = { itemsRestored: prevItems.length, navigate: '/checkout' };
        aiEventStreamService.sendToUser(userId, { type: 'CART_UPDATED', action: 'REPEAT_ORDER', data: result });
        aiEventStreamService.sendToUser(userId, { type: 'NAVIGATE', data: { navigate: '/checkout' } });
        break;
      }

      case 'SEND_NOTIFICATION': {
        const { title, body } = payload;
        if (!title || !body) { res.status(400).json({ success: false, error: 'title and body required' }); return; }
        result = { sent: true };
        aiEventStreamService.sendToUser(userId, { type: 'NOTIFICATION', data: { title, body } });
        break;
      }

      case 'RECOMMEND_PRODUCTS': {
        const products = kb.getAllProducts().filter(p => p.isAvailable);
        const recommended = products.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5);
        result = { recommendations: recommended.map(p => ({ id: p.id, name: p.name, price: p.discountedPrice || p.price, category: p.category })) };
        aiEventStreamService.sendToUser(userId, { type: 'RECOMMENDATIONS', data: result });
        break;
      }

      default:
        res.status(400).json({ success: false, error: `Unsupported actionType: ${actionType}` });
        return;
    }

    res.json({ success: true, actionType: actionType.toUpperCase(), data: result });
  } catch (err: any) {
    console.error(`[AI Gateway] Error in ${actionType}:`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS: Analytical / context events from AI (fire-and-forget logging)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/events', verifyToken, requireAISignature, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { eventType, context } = req.body;
    await adminDb.collection('_ai_events_log_').add({
      userId: req.user?.uid || null, eventType, context: context || {}, timestamp: new Date().toISOString(),
    });
    res.json({ success: true, acknowledged: eventType });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ALERT RELAY: AI app forwards production error alerts here for email delivery
// ─────────────────────────────────────────────────────────────────────────────
router.post('/alert', requireAISignature, async (req: Request, res: Response): Promise<void> => {
  try {
    const { to, subject, htmlBody } = req.body;
    await adminDb.collection('_ai_alerts_').add({ to, subject, receivedAt: new Date().toISOString(), status: 'received' });
    const { queueEmail } = await import('../services/email.service.js');
    const recipients = Array.isArray(to) ? to : [to];
    for (const recipient of recipients) {
      await queueEmail(recipient, subject, htmlBody, 'transactional');
    }
    res.json({ success: true, message: 'Alert relayed to email queue' });
  } catch (err: any) {
    console.error('[AI Alert Relay] Failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AI MANAGEMENT DASHBOARD: Owner/Admin only routes
// ─────────────────────────────────────────────────────────────────────────────
router.get('/management/status', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const statusDoc = await adminDb.collection('_ai_status_').doc('current').get();
    const s = statusDoc.exists ? statusDoc.data() : {};
    const secondsSince = (Date.now() - (s?.lastHeartbeatMs || 0)) / 1000;
    res.json({ success: true, status: { online: secondsSince < 360, lastHeartbeat: s?.lastHeartbeat, secondsSinceLastBeat: Math.round(secondsSince), version: s?.version, activeUsers: s?.activeUsers || 0, modelStatus: s?.modelStatus || {}, maintenanceMode: s?.maintenanceMode || false, disabled: s?.disabled || false } });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/management/dashboard', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const [statusDoc, eventsSnap, alertsSnap] = await Promise.all([
      adminDb.collection('_ai_status_').doc('current').get(),
      adminDb.collection('_ai_events_log_').orderBy('timestamp', 'desc').limit(20).get(),
      adminDb.collection('_ai_alerts_').orderBy('receivedAt', 'desc').limit(10).get(),
    ]);
    const s = statusDoc.exists ? statusDoc.data() : {};
    const secondsSince = (Date.now() - (s?.lastHeartbeatMs || 0)) / 1000;
    res.json({
      success: true,
      dashboard: {
        ai: { online: secondsSince < 360, lastHeartbeat: s?.lastHeartbeat, secondsSinceLastBeat: Math.round(secondsSince), version: s?.version, activeUsers: s?.activeUsers || 0, modelStatus: s?.modelStatus || {}, maintenanceMode: s?.maintenanceMode, disabled: s?.disabled },
        knowledge: { totalVectors: 0, syncQueueSize: 0, failedSyncJobs: 0 },
        recentEvents: eventsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        recentAlerts: alertsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      }
    });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/management/maintenance', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { enabled } = req.body;
    await adminDb.collection('_ai_status_').doc('current').set({ maintenanceMode: !!enabled }, { merge: true });
    res.json({ success: true, maintenanceMode: !!enabled });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/management/disable', verifyToken, requireRole(['owner', 'admin']), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await adminDb.collection('_ai_status_').doc('current').set({ disabled: true }, { merge: true });
    res.json({ success: true, message: 'AI disabled. Users will see a maintenance message.' });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/management/enable', verifyToken, requireRole(['owner', 'admin']), async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await adminDb.collection('_ai_status_').doc('current').set({ disabled: false }, { merge: true });
    res.json({ success: true, message: 'AI re-enabled.' });
  } catch (err: any) { res.status(500).json({ success: false, error: err.message }); }
});

export default router;
