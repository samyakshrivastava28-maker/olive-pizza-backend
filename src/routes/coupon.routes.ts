import { Router, Request, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { DataExpiryJob } from '../jobs/DataExpiryJob.js';
import { redisService } from '../services/redis/RedisService.js';

const router = Router();

let cachedCoupons: any[] | null = null;

/**
 * GET /api/coupons
 * Returns all active, unexpired coupons for customer display
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const activeCoupons = await redisService.fetchWithStampedeProtection<any[]>(
      'cache:coupons:active',
      async () => {
        const now = new Date();
        const snap = await adminDb.collection('coupons').where('isActive', '==', true).get();
        const list: any[] = [];

        snap.forEach((doc) => {
          const data = doc.data();
          const expiryDate = DataExpiryJob.extractExpiryDate(data);
          if (expiryDate && expiryDate < now) {
            // Asynchronously archive expired coupon
            doc.ref.update({ isActive: false, isArchived: true, autoExpiredAt: now.toISOString() }).catch(() => {});
            return;
          }

          // Check start date
          if (data.startDate) {
            const start = new Date(data.startDate);
            if (!isNaN(start.getTime()) && now < start) return;
          }

          list.push({
            id: doc.id,
            code: data.code,
            type: data.type || 'percentage',
            discountType: data.discountType || data.type || 'percentage',
            discountValue: data.discountValue || 0,
            minOrderValue: data.minOrderValue || data.minOrderAmount || 0,
            maxDiscount: data.maxDiscount || data.maxDiscountAmount || 0,
            startDate: data.startDate || null,
            endDate: data.endDate || data.expiryDate || null,
            expiryDate: data.expiryDate || data.endDate || null,
            description: data.description || '',
            tiers: data.tiers || [],
            isFirstOrderOnly: data.isFirstOrderOnly || false,
          });
        });

        cachedCoupons = list;
        return list;
      },
      { ttlSeconds: 120, jitterSeconds: 20 }
    );

    res.json({ success: true, coupons: activeCoupons });
  } catch (error: any) {
    if (cachedCoupons) {
      return res.json({ success: true, coupons: cachedCoupons, fallback: true });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/coupons/validate
 * Validates a coupon code against minimum order, customer eligibility, and strict expiry
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { code, cartTotal, userId } = req.body;
    if (!code || cartTotal === undefined) {
      return res.status(400).json({ valid: false, error: 'Missing code or cartTotal' });
    }

    const cleanCode = String(code).trim().toUpperCase();
    const snapshot = await adminDb.collection('coupons').where('code', '==', cleanCode).where('isActive', '==', true).get();

    if (snapshot.empty) {
      return res.status(404).json({ valid: false, error: `Coupon "${cleanCode}" is invalid or inactive` });
    }

    const doc = snapshot.docs[0];
    const coupon = doc.data();
    const now = new Date();

    // Check Start Date
    if (coupon.startDate) {
      const startDate = new Date(coupon.startDate);
      if (!isNaN(startDate.getTime()) && now < startDate) {
        return res.status(400).json({ valid: false, error: `Coupon will be active starting from ${startDate.toLocaleDateString()}` });
      }
    }

    // Check Expiry Date (supports endDate, expiryDate, validUntil, etc.)
    const expiryDate = DataExpiryJob.extractExpiryDate(coupon);
    if (expiryDate && expiryDate < now) {
      // Auto-archive the expired coupon in Firestore
      doc.ref.update({ isActive: false, isArchived: true, autoExpiredAt: now.toISOString() }).catch(() => {});
      return res.status(400).json({
        valid: false,
        error: `Coupon "${cleanCode}" expired on ${expiryDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
      });
    }

    // First order only validation
    if (coupon.isFirstOrderOnly && userId) {
      const userOrders = await adminDb.collection('orders').where('userId', '==', userId).limit(1).get();
      if (!userOrders.empty) {
        return res.status(400).json({ valid: false, error: 'This coupon is valid for first-time orders only' });
      }
    }

    const minAmount = Number(coupon.minOrderValue || coupon.minOrderAmount || 0);
    if (cartTotal < minAmount) {
      return res.status(400).json({ valid: false, error: `Minimum order value for this coupon is ₹${minAmount}` });
    }

    let discount = 0;
    const type = coupon.type || coupon.discountType || 'percentage';

    switch (type) {
      case 'fixed':
        discount = Number(coupon.discountValue || 0);
        break;

      case 'percentage':
        discount = (cartTotal * Number(coupon.discountValue || 0)) / 100;
        const maxDiscount = Number(coupon.maxDiscount || coupon.maxDiscountAmount || 0);
        if (maxDiscount > 0 && discount > maxDiscount) {
          discount = maxDiscount;
        }
        break;

      case 'tier':
        const sortedTiers = (coupon.tiers || []).sort((a: any, b: any) => b.minAmount - a.minAmount);
        const applicableTier = sortedTiers.find((t: any) => cartTotal >= t.minAmount);
        if (!applicableTier) {
          return res.status(400).json({ valid: false, error: 'Cart total does not meet any tier requirements' });
        }
        discount = applicableTier.discount;
        break;

      case 'free_delivery':
        discount = Number(req.body.deliveryFee || 0);
        break;

      default:
        discount = Number(coupon.discountValue || 0);
        break;
    }

    // Discount cannot exceed cart total
    if (discount > cartTotal) discount = cartTotal;

    res.json({
      valid: true,
      code: cleanCode,
      discountAmount: Math.round(discount),
      finalTotal: Math.max(0, Math.round(cartTotal - discount)),
      couponDetails: {
        code: cleanCode,
        type,
        discountValue: coupon.discountValue,
        description: coupon.description || ''
      }
    });
  } catch (error: any) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

export default router;
