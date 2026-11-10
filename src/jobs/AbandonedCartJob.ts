/**
 * AbandonedCartJob.ts — Server-Side 8-Hour Inactive Cart Push Reminder
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. TIMING: Backend-driven (runs hourly), identifies carts inactive for >= 8 hours.
 * 2. ORDER SAFETY: Never notifies if customer placed an order since cart modification or cleared cart.
 * 3. REAL COUPONS ONLY: Queries active, non-expired, valid coupons that meet min order amount.
 * 4. DEDUPLICATION: Exactly ONE reminder sent per abandoned cart session (keyed on abandonedCartReminderSentAt).
 * 5. PRIVACY: Clean notification with deep link to '/cart'; zero customer addresses or payment info exposed.
 */

import cron from 'node-cron';
import { adminDb } from '../config/firebase.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { CustomerTemplates } from '../services/notification/NotificationTemplates.js';
import { distributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';

export interface AbandonedCartResult {
  userId: string;
  cartTotal: number;
  itemsCount: number;
  couponApplied?: string;
  notified: boolean;
  reason?: string;
}

export class AbandonedCartJob {
  private static isRunning = false;
  // 8 hours in milliseconds (allow slight window: 7.5h to 24h)
  private static readonly INACTIVITY_THRESHOLD_MS = 8 * 60 * 60 * 1000;
  private static readonly MAX_AGE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // Ignore stale carts older than 48h

  public static init() {
    // Schedule: Runs hourly at minute 0 (coordinated across cluster)
    cron.schedule('0 * * * *', async () => {
      await distributedJobCoordinator.runScheduledSingleton('abandoned_cart_hourly', 300, async () => {
        console.log('⏰ [AbandonedCartJob] Running hourly abandoned cart scan...');
        try {
          await AbandonedCartJob.processAbandonedCarts();
        } catch (err: any) {
          console.error('❌ [AbandonedCartJob] Error during abandoned cart processing:', err.message);
        }
      });
    });

    console.log('⏰ [AbandonedCartJob] Initialized hourly 8-hour abandoned cart reminder job (distributed).');
  }

  /**
   * Scans all active carts and dispatches reminders to eligible customers.
   */
  public static async processAbandonedCarts(): Promise<AbandonedCartResult[]> {
    if (this.isRunning) {
      console.warn('[AbandonedCartJob] Job already running. Skipping concurrent run.');
      return [];
    }

    this.isRunning = true;
    const results: AbandonedCartResult[] = [];
    const now = Date.now();

    try {
      // 1. Query candidate carts from user_carts collection
      const cartsSnap = await adminDb.collection('user_carts')
        .where('itemCount', '>', 0)
        .get();

      if (cartsSnap.empty) {
        this.isRunning = false;
        return [];
      }

      // 2. Fetch available active coupons once for efficient matching
      const couponsSnap = await adminDb.collection('coupons')
        .where('isActive', '==', true)
        .get()
        .catch(() => ({ docs: [] } as any));

      const activeCoupons = couponsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

      for (const cartDoc of cartsSnap.docs) {
        const cart = cartDoc.data();
        const userId = cart.userId || cartDoc.id;

        // Skip if already reminded
        if (cart.abandonedCartReminderSentAt) {
          continue;
        }

        const updatedAtTime = cart.cartLastUpdatedAt || cart.updatedAt;
        if (!updatedAtTime) continue;

        const cartUpdatedDate = new Date(updatedAtTime).getTime();
        if (isNaN(cartUpdatedDate)) continue;

        const ageMs = now - cartUpdatedDate;

        // Check if cart has been inactive for at least 8 hours and not older than 48 hours
        if (ageMs < this.INACTIVITY_THRESHOLD_MS || ageMs > this.MAX_AGE_THRESHOLD_MS) {
          continue;
        }

        const items = Array.isArray(cart.items) ? cart.items : [];
        if (items.length === 0) {
          continue;
        }

        const cartTotal = Number(cart.total || 0);

        // 3. Verification: Check if user has placed an order since cartLastUpdatedAt
        const recentOrdersSnap = await adminDb.collection('orders')
          .where('userId', '==', userId)
          .where('createdAt', '>=', new Date(cartUpdatedDate))
          .limit(1)
          .get()
          .catch(() => ({ empty: true } as any));

        if (!recentOrdersSnap.empty) {
          // User already ordered! Mark reminded so we never notify
          await cartDoc.ref.update({
            abandonedCartReminderSentAt: new Date().toISOString(),
            skipReason: 'ORDER_ALREADY_PLACED'
          }).catch(() => {});

          results.push({
            userId,
            cartTotal,
            itemsCount: items.length,
            notified: false,
            reason: 'Customer placed order after cart update'
          });
          continue;
        }

        // 4. Find valid active coupon for this customer and cart total
        const nowIso = new Date().toISOString();
        let matchedCoupon: any = null;

        for (const c of activeCoupons) {
          if (c.expiresAt && c.expiresAt < nowIso) continue;
          if (c.startsAt && c.startsAt > nowIso) continue;
          if (c.usageLimit && (c.usageCount || 0) >= c.usageLimit) continue;
          const minOrder = Number(c.minOrderAmount || 0);
          if (cartTotal < minOrder) continue;

          // Pick the best coupon
          matchedCoupon = c;
          break;
        }

        // 5. Construct personalized, privacy-safe notification
        let notificationTitle = 'Your pizza is waiting 🍕';
        let notificationBody = "You added delicious items to your cart but haven't finished your order. They're still waiting for you!";
        let couponText = '';

        if (matchedCoupon) {
          const discountDesc = matchedCoupon.discountType === 'percentage'
            ? `${matchedCoupon.discountValue}% off`
            : `₹${matchedCoupon.discountValue} off`;

          notificationTitle = 'You left your pizza behind 🍕';
          notificationBody = `Come back and complete your order. Use coupon ${matchedCoupon.code} for ${discountDesc}!`;
          couponText = matchedCoupon.code;
        }

        // 6. Send Push Notification via NotificationEngine
        try {
          const payload = CustomerTemplates.informational(
            notificationTitle,
            notificationBody,
            '/cart'
          );

          await notificationEngine.send(userId, payload, {
            targetApp: 'customer',
            category: 'marketing',
            priority: 'normal'
          });

          // 7. Prevent Duplicate Reminders
          await cartDoc.ref.update({
            abandonedCartReminderSentAt: new Date().toISOString(),
            abandonedCartCouponUsed: couponText || null
          });

          console.log(`[AbandonedCartJob] Successfully sent reminder to user ${userId} (Coupon: ${couponText || 'None'}).`);

          results.push({
            userId,
            cartTotal,
            itemsCount: items.length,
            couponApplied: couponText,
            notified: true
          });
        } catch (sendErr: any) {
          console.warn(`[AbandonedCartJob] Failed to dispatch reminder to user ${userId}:`, sendErr.message);
          results.push({
            userId,
            cartTotal,
            itemsCount: items.length,
            notified: false,
            reason: sendErr.message
          });
        }
      }

      return results;
    } catch (err: any) {
      console.error('[AbandonedCartJob] Error in processAbandonedCarts:', err.message);
      return [];
    } finally {
      this.isRunning = false;
    }
  }
}
