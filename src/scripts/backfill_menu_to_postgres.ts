import { adminDb } from '../config/firebase.js';
import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';

export async function backfillMenuToPostgres(): Promise<{
  categoriesCount: number;
  productsCount: number;
  combosCount: number;
  couponsCount: number;
  adsCount: number;
}> {
  console.log('====================================================');
  console.log('🍕 Backfilling Menu & Promotions from Firestore to PostgreSQL 18.6');
  console.log('====================================================\n');

  let categoriesCount = 0;
  let productsCount = 0;
  let combosCount = 0;
  let couponsCount = 0;
  let adsCount = 0;

  // 1. Categories
  try {
    const snap = await adminDb.collection('categories').get();
    console.log(`Discovered ${snap.size} categories in Firestore.`);
    for (const doc of snap.docs) {
      const d = doc.data();
      const id = doc.id;
      const name = d.name || 'Category';
      const description = d.description || '';
      const emoji = d.emoji || '🍕';
      const imageUrl = d.imageUrl || d.image || '';
      const subcategories = JSON.stringify(d.subcategories || d.subCategories || []);
      const displayOrder = Number(d.displayOrder || d.order || 0);
      const isActive = d.isActive ?? true;

      await query(
        `INSERT INTO menu_categories (id, name, description, emoji, image_url, subcategories, display_order, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           emoji = EXCLUDED.emoji,
           image_url = EXCLUDED.image_url,
           subcategories = EXCLUDED.subcategories,
           display_order = EXCLUDED.display_order,
           is_active = EXCLUDED.is_active,
           updated_at = NOW();`,
        [id, name, description, emoji, imageUrl, subcategories, displayOrder, isActive]
      );
      categoriesCount++;
    }
  } catch (err: any) {
    console.warn('Warning during categories backfill:', err.message);
  }

  // 2. Products
  try {
    const snap = await adminDb.collection('products').get();
    console.log(`Discovered ${snap.size} products in Firestore.`);
    for (const doc of snap.docs) {
      const d = doc.data();
      const id = doc.id;
      const categoryId = d.categoryId || null;
      const categoryName = d.category || d.categoryName || 'Pizzas';
      const name = d.productName || d.name || 'Master Product';
      const description = d.description || '';
      const basePrice = Number(d.basePrice || d.price || d.offerPrice || 299);
      const imageUrl = d.imageUrl || d.image || '';
      const isVegetarian = d.isVegetarian ?? true;
      const isFeatured = d.isFeatured ?? false;
      const isActive = d.isActive ?? d.isAvailable ?? true;
      const variants = JSON.stringify(d.variants || ['Regular (7")', 'Medium (10")', 'Large (12")']);
      const crusts = JSON.stringify(d.crusts || ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst']);
      const addons = JSON.stringify(d.addons || [
        { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
        { id: 'add_jalapeno', name: 'Pickled Jalapenos', price: 40 },
        { id: 'add_olives', name: 'Black Olives', price: 45 }
      ]);
      const channelAvailability = JSON.stringify(d.channelAvailability || { online: true, dineIn: true, takeaway: true, posDelivery: true });
      const rating = Number(d.rating || 4.8);

      await query(
        `INSERT INTO menu_products (
           id, category_id, category_name, name, description, base_price, image_url,
           is_vegetarian, is_featured, is_active, variants, crusts, addons, channel_availability, rating, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
         ON CONFLICT (id) DO UPDATE SET
           category_name = EXCLUDED.category_name,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           base_price = EXCLUDED.base_price,
           image_url = EXCLUDED.image_url,
           is_vegetarian = EXCLUDED.is_vegetarian,
           is_featured = EXCLUDED.is_featured,
           is_active = EXCLUDED.is_active,
           variants = EXCLUDED.variants,
           crusts = EXCLUDED.crusts,
           addons = EXCLUDED.addons,
           channel_availability = EXCLUDED.channel_availability,
           rating = EXCLUDED.rating,
           updated_at = NOW();`,
        [id, categoryId, categoryName, name, description, basePrice, imageUrl, isVegetarian, isFeatured, isActive, variants, crusts, addons, channelAvailability, rating]
      );
      productsCount++;
    }
  } catch (err: any) {
    console.warn('Warning during products backfill:', err.message);
  }

  // 3. Combos
  try {
    const snap = await adminDb.collection('combos').get();
    console.log(`Discovered ${snap.size} combos in Firestore.`);
    for (const doc of snap.docs) {
      const d = doc.data();
      const id = doc.id;
      const name = d.name || d.comboName || 'Artisan Combo';
      const description = d.description || '';
      const price = Number(d.price || d.comboPrice || 399);
      const originalPrice = d.originalPrice ? Number(d.originalPrice) : null;
      const imageUrl = d.imageUrl || d.image || '';
      const items = JSON.stringify(d.items || []);
      const isActive = d.isActive ?? true;

      await query(
        `INSERT INTO menu_combos (id, name, description, price, original_price, image_url, items, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           price = EXCLUDED.price,
           original_price = EXCLUDED.original_price,
           image_url = EXCLUDED.image_url,
           items = EXCLUDED.items,
           is_active = EXCLUDED.is_active,
           updated_at = NOW();`,
        [id, name, description, price, originalPrice, imageUrl, items, isActive]
      );
      combosCount++;
    }
  } catch (err: any) {
    console.warn('Warning during combos backfill:', err.message);
  }

  // 4. Coupons
  try {
    const snap = await adminDb.collection('coupons').get();
    console.log(`Discovered ${snap.size} coupons in Firestore.`);
    for (const doc of snap.docs) {
      const d = doc.data();
      const id = doc.id;
      const code = (d.code || doc.id).toUpperCase().trim();
      const title = d.title || `${d.discountValue || 50}% OFF`;
      const description = d.description || '';
      const discountType = d.discountType || d.type || 'percentage';
      const discountValue = Number(d.discountValue || 0);
      const minOrderAmount = Number(d.minOrderAmount || d.minOrderValue || 0);
      const maxDiscountAmount = d.maxDiscount || d.maxDiscountAmount ? Number(d.maxDiscount || d.maxDiscountAmount) : null;
      const usageLimit = d.usageLimit ? Number(d.usageLimit) : null;
      const usageCount = Number(d.usageCount || 0);
      const startsAt = d.startsAt ? new Date(d.startsAt) : null;
      const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
      const isActive = d.isActive ?? true;

      await query(
        `INSERT INTO menu_coupons (
           id, code, title, description, discount_type, discount_value, min_order_amount,
           max_discount_amount, usage_limit, usage_count, starts_at, expires_at, is_active, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
         ON CONFLICT (code) DO UPDATE SET
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           discount_type = EXCLUDED.discount_type,
           discount_value = EXCLUDED.discount_value,
           min_order_amount = EXCLUDED.min_order_amount,
           max_discount_amount = EXCLUDED.max_discount_amount,
           usage_limit = EXCLUDED.usage_limit,
           usage_count = EXCLUDED.usage_count,
           starts_at = EXCLUDED.starts_at,
           expires_at = EXCLUDED.expires_at,
           is_active = EXCLUDED.is_active,
           updated_at = NOW();`,
        [id, code, title, description, discountType, discountValue, minOrderAmount, maxDiscountAmount, usageLimit, usageCount, startsAt, expiresAt, isActive]
      );
      couponsCount++;
    }
  } catch (err: any) {
    console.warn('Warning during coupons backfill:', err.message);
  }

  // 5. Promotional Banners & Ads
  try {
    const snap = await adminDb.collection('offers').get();
    console.log(`Discovered ${snap.size} offers/ads in Firestore.`);
    for (const doc of snap.docs) {
      const d = doc.data();
      const id = doc.id;
      const title = d.title || 'Special Offer';
      const subtitle = d.description || d.subtitle || '';
      const imageUrl = d.imageUrl || d.image || d.bannerUrl || '';
      const actionType = d.actionType || 'CATEGORY';
      const actionTarget = d.actionTarget || d.link || '';
      const badge = d.badge || 'PROMO';
      const displayOrder = Number(d.displayOrder || d.order || 0);
      const isActive = d.isActive ?? true;

      await query(
        `INSERT INTO promotional_ads (id, title, subtitle, image_url, action_type, action_target, badge, display_order, is_active, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           subtitle = EXCLUDED.subtitle,
           image_url = EXCLUDED.image_url,
           action_type = EXCLUDED.action_type,
           action_target = EXCLUDED.action_target,
           badge = EXCLUDED.badge,
           display_order = EXCLUDED.display_order,
           is_active = EXCLUDED.is_active,
           updated_at = NOW();`,
        [id, title, subtitle, imageUrl, actionType, actionTarget, badge, displayOrder, isActive]
      );
      adsCount++;
    }
  } catch (err: any) {
    console.warn('Warning during offers/ads backfill:', err.message);
  }

  // Clear Redis menu bootstrap caches
  try {
    await redisService.invalidateMenu();
    console.log('✅ Invalidation of Redis menu bootstrap cache completed.');
  } catch (redisErr: any) {
    console.warn('Cache invalidation notice:', redisErr.message);
  }

  console.log('\n====================================================');
  console.log('✅ Backfill Completed Successfully:');
  console.log(`   - Categories: ${categoriesCount}`);
  console.log(`   - Products:   ${productsCount}`);
  console.log(`   - Combos:     ${combosCount}`);
  console.log(`   - Coupons:    ${couponsCount}`);
  console.log(`   - Ads/Offers: ${adsCount}`);
  console.log('====================================================\n');

  return {
    categoriesCount,
    productsCount,
    combosCount,
    couponsCount,
    adsCount
  };
}

if (process.argv[1]?.includes('backfill_menu_to_postgres')) {
  backfillMenuToPostgres()
    .then(async () => {
      await pgPool.end();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('Fatal backfill error:', e);
      await pgPool.end();
      process.exit(1);
    });
}
