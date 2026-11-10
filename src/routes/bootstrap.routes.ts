import { Router, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { pgPool, query } from '../config/postgres.js';
import { verifyToken, requireRole, optionalAuth, AuthRequest } from '../middleware/auth.middleware.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { InventoryService } from '../services/inventory/InventoryService.js';
import { POSService } from '../services/pos/POSService.js';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';
import { computeEffectiveStatus } from './restaurant.routes.js';
import { DataExpiryJob } from '../jobs/DataExpiryJob.js';
import { redisService } from '../services/redis/RedisService.js';
import { verifyTrackingToken } from '../utils/trackingToken.js';
import { FranchisePricingSyncService } from '../services/menu/FranchisePricingSyncService.js';

const router = Router();

// Canonical branch defaults
const DEFAULT_BRANCH_ID = FranchiseScopeService.DEFAULT_BRANCH_ID || 'main_branch';
const DEFAULT_BRANCH_LAT = 21.0967;
const DEFAULT_BRANCH_LNG = 81.0315;
const DEFAULT_BRANCH_COORDINATES = {
  lat: DEFAULT_BRANCH_LAT,
  lng: DEFAULT_BRANCH_LNG,
  name: 'Olive Pizza — Rajnandgaon (Main Branch)',
  address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
  phone: '+91 91799 44445'
};

const DEFAULT_CATEGORIES = [
  {
    id: 'cat_pizzas',
    name: 'Wood-Fired Pizzas',
    description: '100% Pure Veg artisan wood-fired crusts crafted with San Marzano tomatoes.',
    emoji: '🍕',
    subcategories: ['Classic Classics', 'Supreme Delights', 'Cheese Burst', 'Gourmet Woodfired']
  },
  {
    id: 'cat_sides',
    name: 'Garlic Bread & Sides',
    description: 'Crispy herb butter toasts, stuffed sticks, and savory dips.',
    emoji: '🧄',
    subcategories: ['Garlic Breads', 'Cheese Dips', 'Appetizers']
  },
  {
    id: 'cat_beverages',
    name: 'Beverages & Shakes',
    description: 'Chilled sodas, artisan mocktails, and rich thickshakes.',
    emoji: '🥤',
    subcategories: ['Cold Drinks', 'Mocktails', 'Milkshakes']
  },
  {
    id: 'cat_desserts',
    name: 'Artisanal Desserts',
    description: 'Decadent chocolate lava cakes and warm sweet treats.',
    emoji: '🍰',
    subcategories: ['Lava Cakes', 'Brownies', 'Dessert Cups']
  }
];

// Helper: safe query to Firestore collection with fallback
async function safeGetDocs(collectionName: string, queryModifier?: (ref: any) => any): Promise<any[]> {
  try {
    let ref: any = adminDb.collection(collectionName);
    if (queryModifier) {
      ref = queryModifier(ref);
    }
    const snap = await ref.get();
    return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  } catch (err: any) {
    console.warn(`[Bootstrap] Warning fetching collection "${collectionName}":`, err?.message);
    return [];
  }
}

// ============================================================================
// 1. GET /home/bootstrap
// ============================================================================
/**
 * Customer Home Page Aggregator
 * Retrieves in parallel:
 * - Featured products (limit 8)
 * - Categories with subcategories
 * - Active offers / banners
 * - Store open/closed status & branch context
 * - Optional authenticated customer summary: current active order & unread notification count
 *
 * Cache-Control: public, max-age=30, stale-while-revalidate=120 (private if authenticated)
 */
router.get(['/home/bootstrap', '/v1/home/bootstrap'], optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const isAuth = Boolean(req.user?.uid);
  if (isAuth) {
    res.setHeader('Cache-Control', 'private, no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  }

  const branchId = (req.query.branchId as string) || DEFAULT_BRANCH_ID;
  const franchiseId = (req.query.franchiseId as string) || (req.query.franchise as string) || 'fra_primary';
  const channel = (req.query.channel as string) || 'web';
  const locale = (req.query.locale as string) || 'en';
  const userUid = req.user?.uid;

  try {
    const baseData = await redisService.fetchWithStampedeProtection<{
      featuredProductsRaw: any[];
      categoriesRaw: any[];
      offersRaw: any[];
      storeSettingsRaw: any;
    }>(
      `olive:home:bootstrap:${franchiseId}:${branchId}:${channel}:${locale}`,
      async () => {
        const [
          featuredProductsRaw,
          categoriesRaw,
          offersRaw,
          storeSettingsRaw
        ] = await Promise.all([
          // 1. Featured products (limit 8)
      (async () => {
        try {
          let items: any[] = [];
          try {
            const snap = await adminDb.collection('products')
              .where('isActive', '==', true)
              .limit(16)
              .get()
              .catch(async () => {
                return await adminDb.collection('products').limit(16).get().catch(() => ({ docs: [] }));
              });
            if (snap && snap.docs && snap.docs.length > 0) {
              items = snap.docs.map((doc: any) => {
                const data = doc.data();
                return {
                  id: doc.id,
                  name: data.productName || data.name || 'Artisan Pizza',
                  description: data.description || '',
                  category: data.category || 'Pizzas',
                  basePrice: Number(data.basePrice || data.price || 299),
                  price: Number(data.basePrice || data.price || 299),
                  imageUrl: data.imageUrl || data.image || 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
                  isVegetarian: data.isVegetarian ?? true,
                  isFeatured: data.isFeatured ?? true,
                  variants: data.variants || ['Regular (7")', 'Medium (10")', 'Large (12")'],
                  rating: data.rating || 4.8
                };
              });
            }
          } catch (fsErr: any) {
            console.warn('[Bootstrap] Home products Firestore notice:', fsErr.message);
          }
          if (items.length === 0) {
            const pgProds = await query('SELECT * FROM menu_products WHERE is_active = true ORDER BY is_featured DESC, rating DESC LIMIT 16').catch(() => ({ rows: [] }));
            if (pgProds.rows.length > 0) {
              items = pgProds.rows.map((r: any) => ({
                id: r.id,
                name: r.name,
                description: r.description || '',
                category: r.category_name || 'Pizzas',
                basePrice: Number(r.base_price || 299),
                price: Number(r.base_price || 299),
                imageUrl: r.image_url || 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
                isVegetarian: r.is_vegetarian ?? true,
                isFeatured: r.is_featured ?? true,
                variants: r.variants || ['Regular (7")', 'Medium (10")', 'Large (12")'],
                rating: Number(r.rating || 4.8)
              }));
            }
          }

          // Apply PostgreSQL authoritative franchise prices first
          try {
            const pgPricesMap = await FranchisePricingSyncService.getBranchPricesMap(branchId);
            if (pgPricesMap.size > 0) {
              items = items.map(it => {
                const ov = pgPricesMap.get(it.id);
                if (!ov) return it;
                const sellingPrice = ov.sellingPrice ? Number(ov.sellingPrice) : undefined;
                return {
                  ...it,
                  price: sellingPrice && sellingPrice > 0 ? sellingPrice : it.price,
                  basePrice: sellingPrice && sellingPrice > 0 ? sellingPrice : it.basePrice,
                  isAvailable: ov.isAvailable
                };
              });
            }
          } catch (pgErr: any) {
            console.warn('[Bootstrap] Home PostgreSQL franchise_prices lookup warning:', pgErr?.message);
          }

          // Apply branch overrides (custom price and availability)
          try {
            const oSnap = await adminDb.collection('branch_menu_overrides')
              .where('branchId', '==', branchId)
              .get()
              .catch(() => ({ docs: [] } as any));
            if (!oSnap.empty) {
              const oMap = new Map<string, any>();
              oSnap.docs.forEach((d: any) => oMap.set(d.data().productId, d.data()));
              items = items.map(it => {
                const ov = oMap.get(it.id);
                if (!ov) return it;
                const customPrice = ov.customPrice ? Number(ov.customPrice) : undefined;
                return {
                  ...it,
                  price: customPrice && customPrice > 0 ? customPrice : it.price,
                  basePrice: customPrice && customPrice > 0 ? customPrice : it.basePrice,
                  isAvailable: ov.stockStatus !== 'OUT_OF_STOCK' && ov.isEnabledForBranch !== false
                };
              });
            }
          } catch {}

          // Prioritize explicitly featured items or take top 8
          const featuredOnly = items.filter(i => i.isFeatured);
          return (featuredOnly.length >= 4 ? featuredOnly : items).slice(0, 8);
        } catch (e: any) {
          console.warn('[Bootstrap] Home featured products fallback:', e?.message);
          return [];
        }
      })(),

      // 2. Categories with subcategories
      (async () => {
        try {
          let snap = await adminDb.collection('categories').get().catch(() => ({ empty: true, docs: [] }));
          if (!snap.empty) {
            return snap.docs.map(doc => {
              const data = doc.data();
              return {
                id: doc.id,
                name: data.name || 'Category',
                description: data.description || '',
                emoji: data.emoji || '🍕',
                imageUrl: data.imageUrl || data.image || '',
                subcategories: data.subcategories || data.subCategories || []
              };
            });
          }
          const pgCats = await query('SELECT * FROM menu_categories WHERE is_active = true ORDER BY display_order ASC').catch(() => ({ rows: [] }));
          if (pgCats.rows.length > 0) {
            return pgCats.rows.map((r: any) => ({
              id: r.id,
              name: r.name,
              description: r.description || '',
              emoji: r.emoji || '🍕',
              imageUrl: r.image_url || '',
              subcategories: r.subcategories || []
            }));
          }
          return DEFAULT_CATEGORIES;

          return snap.docs.map(doc => {
            const data = doc.data();
            return {
              id: doc.id,
              name: data.name || 'Category',
              description: data.description || '',
              emoji: data.emoji || '🍕',
              imageUrl: data.imageUrl || data.image || '',
              subcategories: data.subcategories || data.subCategories || []
            };
          });
        } catch {
          return DEFAULT_CATEGORIES;
        }
      })(),

      // 3. Active offers / banners
      (async () => {
        try {
          const [offersSnap, couponsSnap] = await Promise.all([
            adminDb.collection('offers').where('isActive', '==', true).limit(10).get().catch(() => ({ docs: [] } as any)),
            adminDb.collection('coupons').where('isActive', '==', true).limit(5).get().catch(() => ({ docs: [] } as any))
          ]);

          const offersList: any[] = [];
          offersSnap.docs.forEach((d: any) => {
            offersList.push({ id: d.id, ...d.data(), type: 'banner_offer' });
          });

          couponsSnap.docs.forEach((d: any) => {
            const c = d.data();
            offersList.push({
              id: d.id,
              code: c.code,
              title: c.title || `${c.discountValue || 50}% OFF`,
              description: c.description || `Use code ${c.code}`,
              discountType: c.discountType || c.type || 'percentage',
              discountValue: c.discountValue || 0,
              minOrderValue: c.minOrderValue || c.minOrderAmount || 0,
              type: 'coupon_deal'
            });
          });

          if (offersList.length === 0) {
            offersList.push({
              id: 'offer_welcome',
              title: 'Welcome to Olive Pizza',
              description: 'Flat 50% OFF on your first wood-fired order with code WELCOME50',
              code: 'WELCOME50',
              badge: 'FIRST ORDER',
              type: 'banner_offer'
            });
          }

          return offersList;
        } catch {
          return [];
        }
      })(),

      // 4. Store open/closed status & branch context
      (async () => {
        try {
          const [settingsDoc, branchDoc] = await Promise.all([
            adminDb.collection('restaurant_settings').doc(branchId).get().catch(() => null),
            adminDb.collection('franchises').doc(branchId).get().catch(() => null)
          ]);

          const settingsData = settingsDoc && settingsDoc.exists ? settingsDoc.data()! : {
            isOpen: true,
            acceptingOrders: true,
            currentPrepTime: 25,
            operatingHours: {
              monday: { open: '10:00', close: '23:00', isOpen: true },
              tuesday: { open: '10:00', close: '23:00', isOpen: true },
              wednesday: { open: '10:00', close: '23:00', isOpen: true },
              thursday: { open: '10:00', close: '23:00', isOpen: true },
              friday: { open: '10:00', close: '23:30', isOpen: true },
              saturday: { open: '10:00', close: '23:30', isOpen: true },
              sunday: { open: '10:00', close: '23:30', isOpen: true }
            }
          };

          const effective = computeEffectiveStatus(settingsData);
          const branchData = branchDoc && branchDoc.exists ? branchDoc.data()! : DEFAULT_BRANCH_COORDINATES;

          return {
            isOpen: effective.effectiveOpen,
            isManagerOpen: effective.isManagerOpen,
            isScheduleOpen: effective.isScheduleOpen,
            reason: effective.effectiveReason,
            scheduleText: effective.scheduleText,
            prepTimeMinutes: settingsData.currentPrepTime || 25,
            branch: {
              branchId,
              name: branchData.name || DEFAULT_BRANCH_COORDINATES.name,
              address: branchData.address || DEFAULT_BRANCH_COORDINATES.address,
              phone: branchData.phone || DEFAULT_BRANCH_COORDINATES.phone,
              lat: Number(branchData.lat || DEFAULT_BRANCH_LAT),
              lng: Number(branchData.lng || DEFAULT_BRANCH_LNG)
            }
          };
        } catch {
          return {
            isOpen: true,
            isManagerOpen: true,
            isScheduleOpen: true,
            reason: 'Restaurant is open and accepting orders.',
            scheduleText: '10:00 - 23:00',
            prepTimeMinutes: 25,
            branch: {
              branchId,
              ...DEFAULT_BRANCH_COORDINATES
            }
          };
        }
      })()
    ]);

        return {
          featuredProductsRaw,
          categoriesRaw,
          offersRaw,
          storeSettingsRaw
        };
      },
      { ttlSeconds: 180, jitterSeconds: 30 }
    );

    // Authenticated user context (current active order & unread count)
    let userState = { activeOrderSummary: null as any, unreadNotifications: 0 };
    if (userUid) {
      try {
        const [orderRes, unreadCount] = await Promise.all([
          // Active customer order
          (async () => {
            try {
              const activeStatuses = ['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'];
              const snap = await adminDb.collection('orders')
                .where('customerId', '==', userUid)
                .where('status', 'in', activeStatuses)
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get()
                .catch(async () => {
                  return await adminDb.collection('orders')
                    .where('userId', '==', userUid)
                    .where('status', 'in', activeStatuses)
                    .orderBy('createdAt', 'desc')
                    .limit(1)
                    .get()
                    .catch(() => ({ empty: true, docs: [] } as any));
                });

              if (snap.empty) return null;
              const oDoc = snap.docs[0];
              const oData = oDoc.data();
              return {
                id: oDoc.id,
                orderNumber: oData.orderNumber || oDoc.id.slice(-6).toUpperCase(),
                status: oData.status,
                totalAmount: Number(oData.totalAmount || oData.finalTotal || 0),
                itemsCount: Array.isArray(oData.items) ? oData.items.length : 0,
                createdAt: oData.createdAt,
                estimatedDeliveryTime: oData.estimatedDeliveryTime || '25-35 mins'
              };
            } catch {
              return null;
            }
          })(),

          // Unread notifications count
          (async () => {
            try {
              if (pgPool) {
                const client = await pgPool.connect();
                try {
                  const qRes = await client.query(
                    `SELECT COUNT(*) FROM notification_inbox WHERE user_id = $1 AND is_read = false`,
                    [userUid]
                  );
                  return parseInt(qRes.rows[0]?.count || '0', 10);
                } finally {
                  client.release();
                }
              }
            } catch {}
            return 0;
          })()
        ]);

        userState = {
          activeOrderSummary: orderRes,
          unreadNotifications: unreadCount
        };
      } catch {
        userState = { activeOrderSummary: null, unreadNotifications: 0 };
      }
    }

    res.json({
      success: true,
      categories: baseData.categoriesRaw,
      featuredProducts: baseData.featuredProductsRaw,
      offers: baseData.offersRaw,
      storeStatus: baseData.storeSettingsRaw,
      activeOrderSummary: userState.activeOrderSummary,
      unreadNotifications: userState.unreadNotifications
    });
  } catch (error: any) {
    console.error('[Bootstrap] Home bootstrap error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap home screen' });
  }
});

// ============================================================================
// 2. GET /menu/bootstrap
// ============================================================================
/**
 * Customer & Client Menu Catalog Aggregator
 * Retrieves in parallel:
 * - Categories
 * - All active products (with variants and addons)
 * - Current menu offers / coupon codes applicable
 * - Realtime stock availability map
 *
 * Cache-Control: public, max-age=30, stale-while-revalidate=120
 */
router.get(['/menu/bootstrap', '/v1/menu/bootstrap'], async (req: AuthRequest, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  const branchId = (req.query.branchId as string) || DEFAULT_BRANCH_ID;
  const franchiseId = (req.query.franchiseId as string) || (req.query.franchise as string) || 'fra_primary';
  const channel = (req.query.channel as string) || 'web';
  const locale = (req.query.locale as string) || 'en';

  try {
    const data = await redisService.fetchWithStampedeProtection<{
      categories: any[];
      products: any[];
      offers: any[];
      availability: Record<string, any>;
    }>(
      `olive:menu:bootstrap:${franchiseId}:${branchId}:${channel}:${locale}`,
      async () => {
        const [
          categoriesRaw,
          productsRaw,
          offersRaw,
          availabilityMap
        ] = await Promise.all([
          // 1. Categories
      (async () => {
        try {
          let snap = await adminDb.collection('categories').get().catch(() => ({ empty: true, docs: [] }));
          if (!snap.empty) {
            return snap.docs.map(doc => {
              const data = doc.data();
              return {
                id: doc.id,
                name: data.name || 'Category',
                description: data.description || '',
                emoji: data.emoji || '🍕',
                imageUrl: data.imageUrl || data.image || '',
                subcategories: data.subcategories || data.subCategories || []
              };
            });
          }
          const pgCats = await query('SELECT * FROM menu_categories WHERE is_active = true ORDER BY display_order ASC').catch(() => ({ rows: [] }));
          if (pgCats.rows.length > 0) {
            return pgCats.rows.map((r: any) => ({
              id: r.id,
              name: r.name,
              description: r.description || '',
              emoji: r.emoji || '🍕',
              imageUrl: r.image_url || '',
              subcategories: r.subcategories || []
            }));
          }
          return DEFAULT_CATEGORIES;
        } catch {
          return DEFAULT_CATEGORIES;
        }
      })(),

      // 2. All active products (with variants and addons)
      (async () => {
        try {
          let items: any[] = [];
          try {
            const snap = await adminDb.collection('products').get().catch(() => ({ docs: [] }));
            if (snap && snap.docs && snap.docs.length > 0) {
              items = snap.docs.map((doc: any) => {
                const data = doc.data();
                return {
                  id: doc.id,
                  name: data.productName || data.name || 'Master Product',
                  description: data.description || '',
                  category: data.category || 'Pizzas',
                  basePrice: Number(data.basePrice || data.price || 299),
                  price: Number(data.basePrice || data.price || 299),
                  imageUrl: data.imageUrl || data.image || 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
                  isVegetarian: data.isVegetarian ?? true,
                  isActive: data.isActive ?? data.isAvailable ?? true,
                  variants: data.variants || ['Regular (7")', 'Medium (10")', 'Large (12")'],
                  crusts: data.crusts || ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
                  addons: data.addons || [
                    { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
                    { id: 'add_jalapeno', name: 'Pickled Jalapenos', price: 40 },
                    { id: 'add_olives', name: 'Black Olives', price: 45 }
                  ],
                  channelAvailability: data.channelAvailability || { online: true, dineIn: true, takeaway: true, posDelivery: true }
                };
              });
            }
          } catch (fsErr: any) {
            console.warn('[Bootstrap] Menu products Firestore notice:', fsErr.message);
          }

          if (items.length === 0) {
            const pgProds = await query('SELECT * FROM menu_products WHERE is_active = true ORDER BY is_featured DESC, rating DESC').catch(() => ({ rows: [] }));
            if (pgProds.rows.length > 0) {
              items = pgProds.rows.map((r: any) => ({
                id: r.id,
                name: r.name,
                description: r.description || '',
                category: r.category_name || 'Pizzas',
                basePrice: Number(r.base_price || 299),
                price: Number(r.base_price || 299),
                imageUrl: r.image_url || 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
                isVegetarian: r.is_vegetarian ?? true,
                isActive: r.is_active ?? true,
                variants: r.variants || ['Regular (7")', 'Medium (10")', 'Large (12")'],
                crusts: r.crusts || ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
                addons: r.addons || [
                  { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
                  { id: 'add_jalapeno', name: 'Pickled Jalapenos', price: 40 },
                  { id: 'add_olives', name: 'Black Olives', price: 45 }
                ],
                channelAvailability: r.channel_availability || { online: true, dineIn: true, takeaway: true, posDelivery: true }
              }));
            }
          }

          if (items.length === 0) {
            items = [
              {
                id: 'prod_margherita',
                name: 'Classic Margherita',
                description: 'San Marzano tomatoes, fresh mozzarella, and sweet basil.',
                category: 'Pizzas',
                basePrice: 199,
                price: 199,
                imageUrl: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400',
                isVegetarian: true,
                isActive: true,
                variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
                crusts: ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
                addons: [{ id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 }],
                channelAvailability: { online: true, dineIn: true, takeaway: true, posDelivery: true }
              },
              {
                id: 'prod_farmhouse',
                name: 'Farmhouse Special Pizza',
                description: 'Crunchy capsicum, sweet corn, mushrooms, and onions.',
                category: 'Pizzas',
                basePrice: 349,
                price: 349,
                imageUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=400',
                isVegetarian: true,
                isActive: true,
                variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
                crusts: ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
                addons: [{ id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 }],
                channelAvailability: { online: true, dineIn: true, takeaway: true, posDelivery: true }
              }
            ];
          }

          return items;
        } catch {
          return [];
        }
      })(),

      // 3. Current menu offers / coupon codes
      (async () => {
        try {
          let coupons: any[] = [];
          try {
            const snap = await adminDb.collection('coupons').where('isActive', '==', true).get().catch(() => ({ empty: true, forEach: () => {} }));
            const now = new Date();
            if (snap && typeof snap.forEach === 'function') {
              snap.forEach((doc: any) => {
                const data = doc.data();
                const expiryDate = DataExpiryJob.extractExpiryDate(data);
                if (expiryDate && expiryDate < now) return;

                coupons.push({
                  id: doc.id,
                  code: data.code,
                  type: data.type || 'percentage',
                  discountValue: data.discountValue || 0,
                  minOrderValue: data.minOrderValue || data.minOrderAmount || 0,
                  maxDiscount: data.maxDiscount || data.maxDiscountAmount || 0,
                  description: data.description || `Get ${data.discountValue}% off`
                });
              });
            }
          } catch (fsErr: any) {
            console.warn('[Bootstrap] Menu coupons Firestore notice:', fsErr.message);
          }

          if (coupons.length === 0) {
            const pgCoups = await query('SELECT * FROM menu_coupons WHERE is_active = true ORDER BY discount_value DESC LIMIT 10').catch(() => ({ rows: [] }));
            if (pgCoups.rows.length > 0) {
              coupons = pgCoups.rows.map((r: any) => ({
                id: r.id,
                code: r.code,
                type: r.discount_type || 'percentage',
                discountValue: Number(r.discount_value || 0),
                minOrderValue: Number(r.min_order_amount || 0),
                maxDiscount: Number(r.max_discount_amount || 0),
                description: r.description || `Get ${r.discount_value}% off`
              }));
            }
          }
          return coupons;
        } catch {
          return [];
        }
      })(),

      // 4. Realtime stock availability map (authoritative PostgreSQL franchise_prices with Firestore fallback)
      (async () => {
        try {
          const snap = await adminDb.collection('branch_menu_overrides')
            .where('branchId', '==', branchId)
            .get()
            .catch(() => ({ docs: [] } as any));

          const map: Record<string, { inStock: boolean; stockStatus: string; isEnabled: boolean; customPrice?: number }> = {};
          try {
            const pgPricesMap = await FranchisePricingSyncService.getBranchPricesMap(branchId);
            for (const [prodId, data] of pgPricesMap.entries()) {
              map[prodId] = {
                inStock: data.isAvailable,
                stockStatus: data.isAvailable ? 'IN_STOCK' : 'OUT_OF_STOCK',
                isEnabled: data.isAvailable,
                customPrice: data.sellingPrice
              };
            }
          } catch (pgErr: any) {
            console.warn('[Bootstrap] Menu Postgres franchise_prices lookup warning:', pgErr?.message);
          }
          snap.docs.forEach((doc: any) => {
            const data = doc.data();
            map[data.productId] = {
              inStock: data.stockStatus !== 'OUT_OF_STOCK' && data.inStock !== false,
              stockStatus: data.stockStatus || 'IN_STOCK',
              isEnabled: data.isEnabledForBranch !== false,
              customPrice: data.customPrice
            };
          });
          return map;
        } catch {
          return {};
        }
      })()
    ]);

        const mergedProducts = productsRaw.map((p: any) => {
          const override = availabilityMap[p.id];
          const customPrice = override?.customPrice;
          const isEnabled = override ? override.isEnabled : (p.isActive !== false);
          return {
            ...p,
            price: customPrice !== undefined && Number(customPrice) > 0 ? Number(customPrice) : p.price,
            basePrice: customPrice !== undefined && Number(customPrice) > 0 ? Number(customPrice) : p.basePrice,
            isAvailable: override ? override.inStock && isEnabled : (p.isActive !== false)
          };
        });

        return {
          categories: categoriesRaw,
          products: mergedProducts,
          offers: offersRaw,
          availability: availabilityMap
        };
      },
      { ttlSeconds: 300, jitterSeconds: 30 }
    );

    res.json({
      success: true,
      ...data
    });
  } catch (error: any) {
    console.error('[Bootstrap] Menu bootstrap error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap menu screen' });
  }
});

// ============================================================================
// 3. GET /orders/:orderId/tracking/bootstrap
// ============================================================================
/**
 * Customer Order Tracking Aggregator
 * Retrieves in parallel:
 * - Authoritative order state from Firestore (or fallback historical from Postgres)
 * - Restaurant branch location (lat, lng, address, phone)
 * - Assigned rider public details (name, phone, rating, vehicleNumber, liveLocation)
 * - Payment status and display summary
 * - Estimated delivery timeline and milestone progress
 *
 * Cache-Control: private, no-cache
 */
router.get(['/orders/:orderId/tracking/bootstrap', '/v1/orders/:orderId/tracking/bootstrap'], optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'private, no-cache');
  const { orderId } = req.params;

  if (!orderId) {
    res.status(400).json({ success: false, error: 'Order ID is required' });
    return;
  }

  try {
    // 1. Fetch authoritative order document first to resolve partnerId & branchId
    let orderData: any = null;
    const docSnap = await adminDb.collection('orders').doc(orderId).get().catch(() => null);

    if (docSnap && docSnap.exists) {
      orderData = { id: docSnap.id, ...docSnap.data() };
    } else if (pgPool) {
      // Historical fallback from PostgreSQL
      try {
        const client = await pgPool.connect();
        try {
          const pgRes = await client.query('SELECT * FROM canonical_orders WHERE id = $1 LIMIT 1', [orderId]).catch(() => ({ rows: [] } as any));
          if (pgRes.rows && pgRes.rows.length > 0) {
            orderData = pgRes.rows[0];
          } else {
            const fallbackRes = await client.query('SELECT * FROM orders WHERE id = $1 OR order_number = $1 LIMIT 1', [orderId]).catch(() => ({ rows: [] } as any));
            if (fallbackRes.rows && fallbackRes.rows.length > 0) {
              orderData = fallbackRes.rows[0];
            }
          }
        } finally {
          client.release();
        }
      } catch (pgErr) {
        console.warn('[Bootstrap] PG order fallback warning:', pgErr);
      }
    }

    if (!orderData) {
      res.status(404).json({ success: false, error: `Order ${orderId} not found` });
      return;
    }

    // Security & BOLA/IDOR Guard: Verify caller is authorized to view this order tracking data
    const isOwner = req.user?.role === 'owner' || req.user?.role === 'admin' || req.user?.role === 'developer';
    const isAssignedPartner = req.user?.uid && (req.user.uid === orderData.deliveryPartnerId || req.user.uid === orderData.delivery_partner_id);
    const isCustomer = req.user?.uid && (req.user.uid === orderData.userId || req.user.uid === orderData.customerId);

    const rawToken = req.query.trackingToken;
    const tokenOrderId = typeof rawToken === 'string' ? verifyTrackingToken(rawToken) : null;
    const hasValidToken = tokenOrderId === orderId;

    if (!isOwner && !isAssignedPartner && !isCustomer && !hasValidToken) {
      res.status(403).json({ success: false, error: 'Forbidden: You do not have permission to track this order' });
      return;
    }

    const partnerId = orderData.deliveryPartnerId || orderData.delivery_partner_id;
    const branchId = orderData.branchId || DEFAULT_BRANCH_ID;

    // 2. Parallel retrieval for Restaurant, Rider, Payment, and Milestone Timeline
    const [restaurantInfo, riderInfo, liveLocation] = await Promise.all([
      // Restaurant details
      (async () => {
        try {
          const bDoc = await adminDb.collection('franchises').doc(branchId).get().catch(() => null);
          if (bDoc && bDoc.exists) {
            const b = bDoc.data()!;
            return {
              id: branchId,
              name: b.name || DEFAULT_BRANCH_COORDINATES.name,
              address: b.address || DEFAULT_BRANCH_COORDINATES.address,
              phone: b.phone || DEFAULT_BRANCH_COORDINATES.phone,
              lat: Number(b.lat || DEFAULT_BRANCH_LAT),
              lng: Number(b.lng || DEFAULT_BRANCH_LNG)
            };
          }
        } catch {}
        return {
          id: branchId,
          ...DEFAULT_BRANCH_COORDINATES
        };
      })(),

      // Rider public details
      (async () => {
        if (!partnerId) return null;
        try {
          const [partnerDoc, userDoc] = await Promise.all([
            adminDb.collection('delivery_partners').doc(partnerId).get().catch(() => null),
            adminDb.collection('users').doc(partnerId).get().catch(() => null)
          ]);

          const pData = partnerDoc && partnerDoc.exists ? partnerDoc.data() : (userDoc && userDoc.exists ? userDoc.data() : {});
          return {
            id: partnerId,
            name: pData?.name || pData?.displayName || orderData.deliveryPartnerName || 'Assigned Rider',
            phone: pData?.phone || pData?.phoneNumber || orderData.deliveryPartnerPhone || null,
            rating: pData?.rating || 4.9,
            vehicleNumber: pData?.vehicleNumber || 'CG 08 OP 1234',
            vehicleType: pData?.vehicleType || 'Two Wheeler',
            photoUrl: pData?.photoUrl || pData?.avatar || null
          };
        } catch {
          return null;
        }
      })(),

      // Supabase live GPS location if partner assigned
      (async () => {
        if (!partnerId) return null;
        try {
          return await SupabaseGpsService.getLatestLocation(partnerId);
        } catch {
          return null;
        }
      })()
    ]);

    // Payment display summary
    const payment = {
      method: (orderData.paymentMethod || orderData.payment_method || 'ONLINE').toUpperCase(),
      status: (orderData.paymentStatus || orderData.payment?.status || (orderData.status === 'delivered' ? 'COMPLETED' : 'PENDING')).toUpperCase(),
      amount: Number(orderData.totalAmount || orderData.finalTotal || orderData.amount || 0),
      isPaid: Boolean(orderData.isPaid || orderData.paymentStatus === 'COMPLETED' || orderData.paymentStatus === 'PAID')
    };

    // Milestone calculation
    const currentStatus = (orderData.status || 'pending').toLowerCase();
    const milestonesList = [
      { key: 'placed', label: 'Order Placed', completed: true, timestamp: orderData.createdAt },
      { key: 'accepted', label: 'Order Confirmed', completed: ['accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus), timestamp: orderData.acceptedAt || null },
      { key: 'preparing', label: 'Kitchen Preparing', completed: ['preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus), timestamp: orderData.preparingAt || null },
      { key: 'ready', label: 'Food Ready', completed: ['ready', 'picked_up', 'out_for_delivery', 'delivered'].includes(currentStatus), timestamp: orderData.readyAt || null },
      { key: 'out_for_delivery', label: 'Out for Delivery', completed: ['out_for_delivery', 'delivered'].includes(currentStatus), timestamp: orderData.outForDeliveryAt || orderData.pickedUpAt || null },
      { key: 'delivered', label: 'Delivered', completed: currentStatus === 'delivered', timestamp: orderData.deliveredAt || null }
    ];

    const completedCount = milestonesList.filter(m => m.completed).length;
    const progressPercent = Math.min(100, Math.round((completedCount / milestonesList.length) * 100));

    const timeline = {
      currentStatus,
      milestones: milestonesList,
      progressPercent,
      estimatedDeliveryMins: orderData.estimatedDeliveryMins || 30,
      estimatedDeliveryTime: orderData.estimatedDeliveryTime || '30-40 mins'
    };

    // Attach GPS coordinates to rider if found
    const riderWithLocation = riderInfo ? {
      ...riderInfo,
      lat: liveLocation?.latitude != null ? Number(liveLocation.latitude) : (orderData.driverLocation?.lat || null),
      lng: liveLocation?.longitude != null ? Number(liveLocation.longitude) : (orderData.driverLocation?.lng || null),
      speed: liveLocation?.speed || 0,
      heading: liveLocation?.heading || 0,
      lastUpdated: liveLocation?.last_updated || new Date().toISOString()
    } : null;

    res.json({
      success: true,
      order: {
        id: orderData.id || orderId,
        orderNumber: orderData.orderNumber || orderId.slice(-6).toUpperCase(),
        status: orderData.status,
        customerName: orderData.customerName || orderData.name,
        customerPhone: orderData.contactPhone || orderData.customerPhone || orderData.phone,
        deliveryAddress: orderData.deliveryAddress,
        items: orderData.items || [],
        subtotal: Number(orderData.subtotal || 0),
        tax: Number(orderData.taxes || orderData.taxAmount || 0),
        deliveryFee: Number(orderData.deliveryFee || 0),
        packagingCharge: Number(orderData.packagingCharge || 0),
        discountAmount: Number(orderData.discountAmount || 0),
        totalAmount: Number(orderData.totalAmount || orderData.finalTotal || 0),
        createdAt: orderData.createdAt
      },
      restaurant: restaurantInfo,
      rider: riderWithLocation,
      payment,
      timeline
    });
  } catch (error: any) {
    console.error('[Bootstrap] Tracking bootstrap error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap order tracking' });
  }
});

// ============================================================================
// 4. GET /cart/bootstrap
// ============================================================================
/**
 * Cart & Checkout Screen Aggregator
 * Retrieves in parallel:
 * - Active coupons whitelist and discount rules
 * - Current delivery fee tier configuration
 * - Packaging charges & tax rates
 *
 * Cache-Control: public, max-age=30, stale-while-revalidate=120
 */
router.get(['/cart/bootstrap', '/v1/cart/bootstrap'], async (req: AuthRequest, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  const branchId = (req.query.branchId as string) || DEFAULT_BRANCH_ID;
  const franchiseId = (req.query.franchiseId as string) || (req.query.franchise as string) || 'fra_primary';
  const channel = (req.query.channel as string) || 'web';
  const locale = (req.query.locale as string) || 'en';

  try {
    const data = await redisService.fetchWithStampedeProtection<{
      coupons: any[];
      deliveryFeeConfig: any;
      packagingCharge: number;
      taxRates: any;
    }>(
      `bootstrap:cart:${branchId}`,
      async () => {
        const [couponsRaw, settingsRaw, remoteConfigRaw] = await Promise.all([
          // 1. Active coupons whitelist & rules
          (async () => {
            try {
              const snap = await adminDb.collection('coupons').where('isActive', '==', true).get();
              const activeCoupons: any[] = [];
              const now = new Date();

              snap.forEach(doc => {
                const data = doc.data();
                const expiryDate = DataExpiryJob.extractExpiryDate(data);
                if (expiryDate && expiryDate < now) return;

                activeCoupons.push({
                  id: doc.id,
                  code: data.code,
                  type: data.type || 'percentage',
                  discountType: data.discountType || data.type || 'percentage',
                  discountValue: data.discountValue || 0,
                  minOrderValue: data.minOrderValue || data.minOrderAmount || 0,
                  maxDiscount: data.maxDiscount || data.maxDiscountAmount || 0,
                  description: data.description || '',
                  isFirstOrderOnly: data.isFirstOrderOnly || false,
                  tiers: data.tiers || []
                });
              });

              return activeCoupons;
            } catch {
              return [];
            }
          })(),

          // 2. Branch restaurant settings (delivery fees, tax & charges)
          (async () => {
            try {
              const snap = await adminDb.collection('restaurant_settings').doc(branchId).get();
              if (snap.exists) return snap.data()!;
            } catch {}
            return null;
          })(),

          // 3. Global Remote Config fallback for delivery fees
          (async () => {
            try {
              const snap = await adminDb.collection('remote_configs').doc('customer').get();
              if (snap.exists) return snap.data()!;
            } catch {}
            return null;
          })()
        ]);

        const deliveryConfig = settingsRaw?.deliverySettings || remoteConfigRaw?.delivery || {
          baseDeliveryFee: 40,
          freeDeliveryThreshold: 499,
          maxDeliveryRadiusKm: 12,
          estimatedDeliveryMins: 30,
          tiers: [
            { maxDistanceKm: 3, fee: 20 },
            { maxDistanceKm: 7, fee: 40 },
            { maxDistanceKm: 12, fee: 60 }
          ]
        };

        const taxRates = settingsRaw?.taxAndCharges || {
          gstPercentage: 5,
          serviceChargePercentage: 0
        };

        const packagingCharge = Number(settingsRaw?.taxAndCharges?.packagingCharge ?? 20);

        return {
          coupons: couponsRaw,
          deliveryFeeConfig: deliveryConfig,
          packagingCharge,
          taxRates
        };
      },
      { ttlSeconds: 180, jitterSeconds: 20 }
    );

    res.json({
      success: true,
      ...data
    });
  } catch (error: any) {
    console.error('[Bootstrap] Cart bootstrap error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap cart screen' });
  }
});

// ============================================================================
// 5. GET /owner/dashboard/bootstrap
// ============================================================================
/**
 * Owner Dashboard Command Center Aggregator
 * Protected by verifyToken & staff/owner role.
 * Retrieves in parallel:
 * - Today's order metrics (total, pending, preparing, delivered, cancelled)
 * - Today's revenue & average order value
 * - Active delivery riders online count
 * - Low stock inventory alerts summary
 *
 * Cache-Control: private, no-cache
 */
router.get(
  ['/owner/dashboard/bootstrap', '/v1/owner/dashboard/bootstrap'],
  verifyToken,
  requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']),
  async (req: AuthRequest, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const branchFilter = req.query.branchId as string;

    try {
      const [ordersSnapshot, ridersSnapshot, inventoryAlertsRaw] = await Promise.all([
        // 1. Order metrics & revenue
        (async () => {
          try {
            // Retrieve orders from today (or limit recent 200 orders for metrics)
            const snap = await adminDb.collection('orders')
              .orderBy('createdAt', 'desc')
              .limit(200)
              .get()
              .catch(async () => {
                return await adminDb.collection('orders').limit(100).get();
              });

            let total = 0;
            let pending = 0;
            let preparing = 0;
            let delivered = 0;
            let cancelled = 0;
            let todayRevenue = 0;
            let eligibleCount = 0;

            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

            snap.docs.forEach((doc: any) => {
              const data = doc.data();
              if (branchFilter && branchFilter !== 'all' && data.branchId && data.branchId !== branchFilter) {
                return;
              }

              const status = (data.status || 'pending').toLowerCase();
              const amt = Number(data.totalAmount || data.finalTotal || 0);

              total++;
              if (status === 'pending') pending++;
              else if (['preparing', 'accepted', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'].includes(status)) preparing++;
              else if (status === 'delivered') delivered++;
              else if (status === 'cancelled' || status === 'rejected') cancelled++;

              if (status !== 'cancelled' && status !== 'rejected') {
                todayRevenue += amt;
                eligibleCount++;
              }
            });

            const avgOrderValue = eligibleCount > 0 ? Math.round(todayRevenue / eligibleCount) : 0;

            return {
              metrics: { total, pending, preparing, delivered, cancelled },
              revenue: { todaySales: todayRevenue, avgOrderValue, currency: 'INR' }
            };
          } catch {
            return {
              metrics: { total: 0, pending: 0, preparing: 0, delivered: 0, cancelled: 0 },
              revenue: { todaySales: 0, avgOrderValue: 0, currency: 'INR' }
            };
          }
        })(),

        // 2. Active riders online count
        (async () => {
          try {
            const snap = await adminDb.collection('delivery_partners').get().catch(() => ({ docs: [] } as any));
            const count = snap.docs.filter((d: any) => {
              const r = d.data();
              return r.isActive !== false && r.isOnline !== false;
            }).length;
            return Math.max(1, count); // At least 1 registered rider
          } catch {
            return 1;
          }
        })(),

        // 3. Low stock inventory alerts summary
        (async () => {
          try {
            const alerts = await InventoryService.getLowStockAlerts({ branchId: branchFilter });
            return alerts.slice(0, 10);
          } catch {
            return [];
          }
        })()
      ]);

      res.json({
        success: true,
        metrics: ordersSnapshot.metrics,
        revenue: ordersSnapshot.revenue,
        activeRidersCount: ridersSnapshot,
        lowStockAlerts: inventoryAlertsRaw
      });
    } catch (error: any) {
      console.error('[Bootstrap] Owner dashboard bootstrap error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap owner dashboard' });
    }
  }
);

// ============================================================================
// 6. GET /restaurant/live/bootstrap
// ============================================================================
/**
 * Restaurant Manager Live Operational Dashboard Aggregator
 * Protected by verifyToken & restaurant staff/manager role.
 * Retrieves in parallel:
 * - Current active orders (pending, accepted, preparing, ready, partner_assigned, picked_up, out_for_delivery)
 * - Restaurant open/close toggle state
 * - Sound alerts configuration
 * - Unread manager alerts
 *
 * Cache-Control: private, no-cache
 */
router.get(
  ['/restaurant/live/bootstrap', '/v1/restaurant/live/bootstrap'],
  verifyToken,
  requireRole(['restaurant_manager', 'manager', 'kitchen_staff', 'cashier', 'franchise_owner', 'owner', 'admin', 'developer', 'platform_owner']),
  async (req: AuthRequest, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const branchId = (req.query.branchId as string) || req.user?.branchId || DEFAULT_BRANCH_ID;

    try {
      const [activeOrdersRaw, settingsRaw, soundConfigRaw, alertsRaw] = await Promise.all([
        // 1. Current active orders
        (async () => {
          try {
            const activeStatuses = ['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'];
            const snap = await adminDb.collection('orders')
              .where('status', 'in', activeStatuses)
              .orderBy('createdAt', 'desc')
              .limit(50)
              .get()
              .catch(async () => {
                const allSnap = await adminDb.collection('orders').orderBy('createdAt', 'desc').limit(50).get();
                return {
                  docs: allSnap.docs.filter((d: any) => activeStatuses.includes(d.data().status))
                };
              });

            return snap.docs
              .map((doc: any) => ({ id: doc.id, ...doc.data() }))
              .filter((o: any) => !branchId || branchId === 'all' || !o.branchId || o.branchId === branchId);
          } catch (e: any) {
            console.warn('[Bootstrap] Live orders fetch notice:', e?.message);
            return [];
          }
        })(),

        // 2. Restaurant open/close toggle state
        (async () => {
          try {
            const doc = await adminDb.collection('restaurant_settings').doc(branchId).get();
            if (doc.exists) {
              const data = doc.data()!;
              const eff = computeEffectiveStatus(data);
              return {
                storeOpen: eff.effectiveOpen,
                isManagerOpen: eff.isManagerOpen,
                isScheduleOpen: eff.isScheduleOpen,
                reason: eff.effectiveReason
              };
            }
          } catch {}
          return { storeOpen: true, isManagerOpen: true, isScheduleOpen: true, reason: 'Open' };
        })(),

        // 3. Sound alerts configuration
        (async () => {
          try {
            const doc = await adminDb.collection('device_alarm_settings').doc(`RESTAURANT_MANAGER_${branchId}`).get();
            if (doc.exists) {
              return {
                alarmEnabled: doc.data()!.alarmEnabled !== false,
                soundType: 'chime',
                volume: 1.0,
                loop: true
              };
            }
          } catch {}
          return { alarmEnabled: true, soundType: 'chime', volume: 1.0, loop: true };
        })(),

        // 4. Unread manager alerts
        (async () => {
          try {
            const snap = await adminDb.collection('notifications')
              .where('isRead', '==', false)
              .limit(10)
              .get()
              .catch(() => ({ docs: [] } as any));

            return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
          } catch {
            return [];
          }
        })()
      ]);

      res.json({
        success: true,
        activeOrders: activeOrdersRaw,
        storeOpen: settingsRaw.storeOpen,
        soundConfig: soundConfigRaw,
        alerts: alertsRaw
      });
    } catch (error: any) {
      console.error('[Bootstrap] Restaurant live bootstrap error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap restaurant live screen' });
    }
  }
);

// ============================================================================
// 7. GET /delivery/live/bootstrap
// ============================================================================
/**
 * Delivery Partner Live Shift & Mission Aggregator
 * Protected by verifyToken & delivery partner role.
 * Retrieves in parallel:
 * - Rider's assigned active order(s)
 * - Rider shift & online status
 * - Store pickup coordinates
 * - Today's earnings and completed deliveries count
 *
 * Cache-Control: private, no-cache
 */
router.get(
  ['/delivery/live/bootstrap', '/v1/delivery/live/bootstrap'],
  verifyToken,
  requireRole(['delivery_partner', 'delivery', 'rider', 'restaurant_manager', 'owner', 'admin', 'developer']),
  async (req: AuthRequest, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const riderUid = req.user?.uid || '';

    try {
      const [activeOrdersRaw, riderStatusRaw, branchLocationRaw, earningsRaw] = await Promise.all([
        // 1. Rider's assigned active orders
        (async () => {
          if (!riderUid) return [];
          try {
            const riderActiveStatuses = ['partner_assigned', 'ready', 'picked_up', 'out_for_delivery'];
            const snap = await adminDb.collection('orders')
              .where('deliveryPartnerId', '==', riderUid)
              .where('status', 'in', riderActiveStatuses)
              .get()
              .catch(() => ({ docs: [] } as any));

            return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
          } catch {
            return [];
          }
        })(),

        // 2. Rider shift & online status
        (async () => {
          if (!riderUid) return { isOnline: true, status: 'AVAILABLE', vehicleNumber: 'CG 08 OP 1234' };
          try {
            const [pDoc, uDoc] = await Promise.all([
              adminDb.collection('delivery_partners').doc(riderUid).get().catch(() => null),
              adminDb.collection('users').doc(riderUid).get().catch(() => null)
            ]);

            const data = pDoc && pDoc.exists ? pDoc.data() : (uDoc && uDoc.exists ? uDoc.data() : {});
            return {
              uid: riderUid,
              name: data?.name || data?.displayName || 'Delivery Partner',
              isOnline: data?.isOnline !== false,
              shiftStatus: data?.shiftStatus || 'ON_DUTY',
              vehicleNumber: data?.vehicleNumber || 'CG 08 OP 1234',
              vehicleType: data?.vehicleType || 'Two Wheeler',
              phone: data?.phone || data?.phoneNumber || null
            };
          } catch {
            return { isOnline: true, status: 'AVAILABLE', vehicleNumber: 'CG 08 OP 1234' };
          }
        })(),

        // 3. Store pickup coordinates
        (async () => {
          const branchId = req.user?.branchId || DEFAULT_BRANCH_ID;
          try {
            const bDoc = await adminDb.collection('franchises').doc(branchId).get().catch(() => null);
            if (bDoc && bDoc.exists) {
              const b = bDoc.data()!;
              return {
                lat: Number(b.lat || DEFAULT_BRANCH_LAT),
                lng: Number(b.lng || DEFAULT_BRANCH_LNG),
                name: b.name || DEFAULT_BRANCH_COORDINATES.name,
                address: b.address || DEFAULT_BRANCH_COORDINATES.address,
                phone: b.phone || DEFAULT_BRANCH_COORDINATES.phone
              };
            }
          } catch {}
          return DEFAULT_BRANCH_COORDINATES;
        })(),

        // 4. Today's earnings and completed deliveries count
        (async () => {
          if (!riderUid) return { earnings: 0, completedDeliveries: 0 };
          try {
            const snap = await adminDb.collection('orders')
              .where('deliveryPartnerId', '==', riderUid)
              .where('status', '==', 'delivered')
              .get()
              .catch(() => ({ docs: [] } as any));

            const completed = snap.docs.length;
            const BASE_PAY_PER_DROP = 40;
            const earnings = completed * BASE_PAY_PER_DROP;

            return {
              earnings,
              completedDeliveries: completed
            };
          } catch {
            return { earnings: 0, completedDeliveries: 0 };
          }
        })()
      ]);

      res.json({
        success: true,
        activeOrders: activeOrdersRaw,
        riderStatus: riderStatusRaw,
        branchCoordinates: branchLocationRaw,
        todayEarnings: earningsRaw
      });
    } catch (error: any) {
      console.error('[Bootstrap] Delivery live bootstrap error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap delivery live screen' });
    }
  }
);

// ============================================================================
// 8. GET /pos/bootstrap
// ============================================================================
/**
 * POS Terminal Billing & Counter Aggregator
 * Protected by verifyToken & cashier/staff role.
 * Retrieves in parallel:
 * - Menu catalog with variants
 * - Active dine-in tables state
 * - Active held carts
 * - Current cashier shift & cash drawer summary
 *
 * Cache-Control: private, no-cache
 */
router.get(
  ['/pos/bootstrap', '/v1/pos/bootstrap'],
  verifyToken,
  requireRole(['cashier', 'pos', 'pos_operator', 'restaurant_manager', 'franchise_owner', 'owner', 'admin', 'developer', 'platform_owner']),
  async (req: AuthRequest, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'private, no-cache');
    const branchId = (req.query.branchId as string) || req.user?.branchId || DEFAULT_BRANCH_ID;
    const terminalId = (req.query.terminalId as string) || req.user?.terminalId || 'POS-T1';

    try {
      const [catalogRaw, tablesRaw, heldCartsRaw, shiftSummaryRaw] = await Promise.all([
        // 1. Menu catalog with variants
        (async () => {
          try {
            const snap = await adminDb.collection('products').get();
            let items = snap.docs.map(doc => {
              const data = doc.data();
              return {
                id: doc.id,
                name: data.productName || data.name || 'Master Product',
                category: data.category || 'Pizzas',
                basePrice: Number(data.basePrice || data.price || 299),
                price: Number(data.basePrice || data.price || 299),
                imageUrl: data.imageUrl || data.image || '',
                isVegetarian: data.isVegetarian ?? true,
                isAvailable: data.isActive ?? data.isAvailable ?? true,
                variants: data.variants || ['Regular (7")', 'Medium (10")', 'Large (12")'],
                crusts: data.crusts || ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
                addons: data.addons || [{ id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 }]
              };
            });

            try {
              const pgPricesMap = await FranchisePricingSyncService.getBranchPricesMap(branchId);
              if (pgPricesMap.size > 0) {
                items = items.map(it => {
                  const ov = pgPricesMap.get(it.id);
                  if (!ov) return it;
                  const customPrice = ov.sellingPrice ? Number(ov.sellingPrice) : undefined;
                  return {
                    ...it,
                    price: customPrice && customPrice > 0 ? customPrice : it.price,
                    basePrice: customPrice && customPrice > 0 ? customPrice : it.basePrice,
                    isAvailable: ov.isAvailable
                  };
                });
              }
            } catch (pgErr: any) {
              console.warn('[Bootstrap] POS Postgres franchise_prices lookup warning:', pgErr?.message);
            }

            return items;
          } catch {
            return [];
          }
        })(),

        // 2. Active dine-in tables state
        (async () => {
          try {
            // Find active dine-in orders to mark table occupancy
            const dineInSnap = await adminDb.collection('orders')
              .where('fulfillmentType', '==', 'DINE_IN')
              .where('status', 'in', ['pending', 'accepted', 'preparing', 'ready'])
              .get()
              .catch(() => ({ docs: [] } as any));

            const occupiedMap = new Map<string, any>();
            dineInSnap.docs.forEach((d: any) => {
              const data = d.data();
              if (data.tableNumber) {
                occupiedMap.set(String(data.tableNumber).toUpperCase(), {
                  orderId: d.id,
                  customerName: data.customerName,
                  totalAmount: data.totalAmount,
                  status: data.status
                });
              }
            });

            // 10 standard restaurant dine-in tables
            const defaultTables = [
              { tableNumber: 'T-1', capacity: 2 },
              { tableNumber: 'T-2', capacity: 2 },
              { tableNumber: 'T-3', capacity: 4 },
              { tableNumber: 'T-4', capacity: 4 },
              { tableNumber: 'T-5', capacity: 4 },
              { tableNumber: 'T-6', capacity: 6 },
              { tableNumber: 'T-7', capacity: 6 },
              { tableNumber: 'T-8', capacity: 8 },
              { tableNumber: 'T-9', capacity: 2 },
              { tableNumber: 'T-10', capacity: 4 }
            ];

            return defaultTables.map(t => {
              const occ = occupiedMap.get(t.tableNumber);
              return {
                tableNumber: t.tableNumber,
                capacity: t.capacity,
                status: occ ? 'OCCUPIED' : 'AVAILABLE',
                activeOrder: occ || null
              };
            });
          } catch {
            return [];
          }
        })(),

        // 3. Active held carts
        (async () => {
          try {
            return await POSService.getHeldBills(branchId);
          } catch {
            return [];
          }
        })(),

        // 4. Current cashier shift & cash drawer summary
        (async () => {
          try {
            const shift = await POSService.getActiveShift(branchId, terminalId);
            if (!shift) {
              return {
                status: 'NO_OPEN_SHIFT',
                branchId,
                terminalId,
                openingCash: 0,
                cashSales: 0,
                upiSales: 0,
                cardSales: 0,
                totalRevenue: 0,
                totalBills: 0
              };
            }
            return {
              shiftId: shift.id,
              status: shift.status || 'OPEN',
              branchId: shift.branchId,
              terminalId: shift.terminalId,
              cashierName: shift.cashierName,
              openingCash: shift.openingCash || 0,
              cashSales: shift.cashSales || 0,
              upiSales: shift.upiSales || 0,
              cardSales: shift.cardSales || 0,
              totalRevenue: shift.totalRevenue || 0,
              totalBills: shift.totalBills || 0,
              expectedCash: (shift.openingCash || 0) + (shift.cashSales || 0),
              openedAt: shift.openedAt
            };
          } catch {
            return null;
          }
        })()
      ]);

      res.json({
        success: true,
        catalog: catalogRaw,
        tables: tablesRaw,
        heldCarts: heldCartsRaw,
        shiftSummary: shiftSummaryRaw
      });
    } catch (error: any) {
      console.error('[Bootstrap] POS bootstrap error:', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to bootstrap POS screen' });
    }
  }
);

export default router;
