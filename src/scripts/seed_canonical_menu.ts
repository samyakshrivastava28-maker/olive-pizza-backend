import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';

export async function seedCanonicalMenu(): Promise<void> {
  console.log('====================================================');
  console.log('🍕 Seeding Canonical Artisan Menu Catalog to PostgreSQL 18.6');
  console.log('====================================================\n');

  // 1. Categories
  const categories = [
    {
      id: 'cat_pizzas',
      name: 'Wood-Fired Pizzas',
      description: '100% Pure Veg artisan wood-fired crusts crafted with San Marzano tomatoes.',
      emoji: '🍕',
      imageUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
      subcategories: ['Classic Classics', 'Supreme Delights', 'Cheese Burst', 'Gourmet Woodfired'],
      displayOrder: 1
    },
    {
      id: 'cat_sides',
      name: 'Garlic Bread & Sides',
      description: 'Crispy herb butter toasts, stuffed sticks, and savory dips.',
      emoji: '🧄',
      imageUrl: 'https://images.unsplash.com/photo-1619535860434-ba1d8fa12536?w=500',
      subcategories: ['Garlic Breads', 'Cheese Dips', 'Appetizers'],
      displayOrder: 2
    },
    {
      id: 'cat_beverages',
      name: 'Beverages & Shakes',
      description: 'Chilled sodas, artisan mocktails, and rich thickshakes.',
      emoji: '🥤',
      imageUrl: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=500',
      subcategories: ['Cold Drinks', 'Mocktails', 'Milkshakes'],
      displayOrder: 3
    },
    {
      id: 'cat_desserts',
      name: 'Artisanal Desserts',
      description: 'Decadent chocolate lava cakes and warm sweet treats.',
      emoji: '🍰',
      imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=500',
      subcategories: ['Lava Cakes', 'Brownies', 'Dessert Cups'],
      displayOrder: 4
    }
  ];

  for (const c of categories) {
    await query(
      `INSERT INTO menu_categories (id, name, description, emoji, image_url, subcategories, display_order, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         emoji = EXCLUDED.emoji,
         image_url = EXCLUDED.image_url,
         subcategories = EXCLUDED.subcategories,
         display_order = EXCLUDED.display_order,
         is_active = true,
         updated_at = NOW();`,
      [c.id, c.name, c.description, c.emoji, c.imageUrl, JSON.stringify(c.subcategories), c.displayOrder]
    );
  }
  console.log(`✅ Seeded ${categories.length} canonical categories into PostgreSQL.`);

  // 2. Master Products
  const products = [
    {
      id: 'prod_margherita',
      categoryId: 'cat_pizzas',
      categoryName: 'Wood-Fired Pizzas',
      name: 'Classic Margherita',
      description: 'San Marzano tomatoes, fresh buffalo mozzarella, fragrant sweet basil, and extra virgin olive oil.',
      basePrice: 199.00,
      imageUrl: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=500',
      isVegetarian: true,
      isFeatured: true,
      variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
      crusts: ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
      addons: [
        { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
        { id: 'add_jalapeno', name: 'Pickled Jalapenos', price: 40 },
        { id: 'add_olives', name: 'Black Olives', price: 45 }
      ],
      rating: 4.90
    },
    {
      id: 'prod_farmhouse',
      categoryId: 'cat_pizzas',
      categoryName: 'Wood-Fired Pizzas',
      name: 'Farmhouse Special Pizza',
      description: 'Crunchy bell peppers, sweet golden corn, button mushrooms, and red onions with herb marinara.',
      basePrice: 349.00,
      imageUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500',
      isVegetarian: true,
      isFeatured: true,
      variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
      crusts: ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
      addons: [
        { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
        { id: 'add_paneer', name: 'Spiced Paneer Cubes', price: 55 }
      ],
      rating: 4.85
    },
    {
      id: 'prod_paneer_tikka',
      categoryId: 'cat_pizzas',
      categoryName: 'Wood-Fired Pizzas',
      name: 'Paneer Tikka Supreme',
      description: 'Clay-oven charred cottage cheese cubes, smoked red paprika, coriander leaves, and spicy tikka drizzle.',
      basePrice: 399.00,
      imageUrl: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=500',
      isVegetarian: true,
      isFeatured: true,
      variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
      crusts: ['Classic Hand Tossed', 'Thin Crust', 'Cheese Burst'],
      addons: [
        { id: 'add_extra_cheese', name: 'Extra Cheese', price: 60 },
        { id: 'add_paprika', name: 'Red Paprika', price: 40 }
      ],
      rating: 4.92
    },
    {
      id: 'prod_cheese_burst',
      categoryId: 'cat_pizzas',
      categoryName: 'Wood-Fired Pizzas',
      name: 'Four-Cheese Overload Burst',
      description: 'Molten cheddar crust filled with liquid cheese, topped with provolone, parmesan, and mozzarella.',
      basePrice: 449.00,
      imageUrl: 'https://images.unsplash.com/photo-1593560708920-61dd98c46a4e?w=500',
      isVegetarian: true,
      isFeatured: true,
      variants: ['Regular (7")', 'Medium (10")', 'Large (12")'],
      crusts: ['Cheese Burst'],
      addons: [
        { id: 'add_jalapeno', name: 'Pickled Jalapenos', price: 40 }
      ],
      rating: 4.95
    },
    {
      id: 'prod_garlic_bread',
      categoryId: 'cat_sides',
      categoryName: 'Garlic Bread & Sides',
      name: 'Artisan Stuffed Garlic Breadsticks',
      description: 'Baked golden brown with rich garlic butter, creamy sweet corn, and stretchy mozzarella cheese.',
      basePrice: 149.00,
      imageUrl: 'https://images.unsplash.com/photo-1619535860434-ba1d8fa12536?w=500',
      isVegetarian: true,
      isFeatured: false,
      variants: ['Standard (4 pcs)'],
      crusts: ['Herb Crust'],
      addons: [{ id: 'add_dip', name: 'Cheesy Dip', price: 35 }],
      rating: 4.80
    },
    {
      id: 'prod_cheesy_dip',
      categoryId: 'cat_sides',
      categoryName: 'Garlic Bread & Sides',
      name: 'Creamy Jalapeno Cheese Dip',
      description: 'Velvety smooth cheddar cheese dip infused with pickled Mexican jalapenos and cracked pepper.',
      basePrice: 49.00,
      imageUrl: 'https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?w=500',
      isVegetarian: true,
      isFeatured: false,
      variants: ['Regular (50g)'],
      crusts: [],
      addons: [],
      rating: 4.75
    },
    {
      id: 'prod_choco_lava',
      categoryId: 'cat_desserts',
      categoryName: 'Artisanal Desserts',
      name: 'Choco Lava Volcano Cake',
      description: 'Warm dark chocolate cake with a molten Belgian fudge center that flows on the first bite.',
      basePrice: 99.00,
      imageUrl: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=500',
      isVegetarian: true,
      isFeatured: true,
      variants: ['Single (1 pc)'],
      crusts: [],
      addons: [],
      rating: 4.96
    },
    {
      id: 'prod_cold_coffee',
      categoryId: 'cat_beverages',
      categoryName: 'Beverages & Shakes',
      name: 'Artisan Chilled Cold Brew Shake',
      description: 'Single-origin Arabica coffee slow-steeped for 18 hours and blended with vanilla cream.',
      basePrice: 119.00,
      imageUrl: 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=500',
      isVegetarian: true,
      isFeatured: false,
      variants: ['300ml Glass Bottle'],
      crusts: [],
      addons: [],
      rating: 4.85
    }
  ];

  for (const p of products) {
    await query(
      `INSERT INTO menu_products (
         id, category_id, category_name, name, description, base_price, image_url,
         is_vegetarian, is_featured, is_active, variants, crusts, addons, rating, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, NOW())
       ON CONFLICT (id) DO UPDATE SET
         category_id = EXCLUDED.category_id,
         category_name = EXCLUDED.category_name,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         base_price = EXCLUDED.base_price,
         image_url = EXCLUDED.image_url,
         is_vegetarian = EXCLUDED.is_vegetarian,
         is_featured = EXCLUDED.is_featured,
         is_active = true,
         variants = EXCLUDED.variants,
         crusts = EXCLUDED.crusts,
         addons = EXCLUDED.addons,
         rating = EXCLUDED.rating,
         updated_at = NOW();`,
      [
        p.id, p.categoryId, p.categoryName, p.name, p.description, p.basePrice, p.imageUrl,
        p.isVegetarian, p.isFeatured, JSON.stringify(p.variants), JSON.stringify(p.crusts),
        JSON.stringify(p.addons), p.rating
      ]
    );
  }
  console.log(`✅ Seeded ${products.length} canonical products into PostgreSQL.`);

  // 3. Coupons
  const coupons = [
    {
      id: 'coup_welcome50',
      code: 'WELCOME50',
      title: '50% OFF on First Wood-Fired Order',
      description: 'Flat 50% discount up to ₹150 for your first artisan pizza experience.',
      discountType: 'percentage',
      discountValue: 50.00,
      minOrderAmount: 249.00,
      maxDiscountAmount: 150.00,
      usageLimit: 100000
    },
    {
      id: 'coup_olive20',
      code: 'OLIVE20',
      title: '20% OFF Artisan Feast',
      description: 'Get 20% off on all pizzas and sides on orders above ₹399.',
      discountType: 'percentage',
      discountValue: 20.00,
      minOrderAmount: 399.00,
      maxDiscountAmount: 120.00,
      usageLimit: 50000
    },
    {
      id: 'coup_cheeselove',
      code: 'CHEESELOVE',
      title: 'Flat ₹75 Cheese Lover Discount',
      description: 'Flat ₹75 discount on orders above ₹499.',
      discountType: 'flat',
      discountValue: 75.00,
      minOrderAmount: 499.00,
      maxDiscountAmount: 75.00,
      usageLimit: 50000
    }
  ];

  for (const coup of coupons) {
    await query(
      `INSERT INTO menu_coupons (
         id, code, title, description, discount_type, discount_value, min_order_amount,
         max_discount_amount, usage_limit, usage_count, is_active, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, true, NOW())
       ON CONFLICT (code) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         discount_type = EXCLUDED.discount_type,
         discount_value = EXCLUDED.discount_value,
         min_order_amount = EXCLUDED.min_order_amount,
         max_discount_amount = EXCLUDED.max_discount_amount,
         usage_limit = EXCLUDED.usage_limit,
         is_active = true,
         updated_at = NOW();`,
      [
        coup.id, coup.code, coup.title, coup.description, coup.discountType,
        coup.discountValue, coup.minOrderAmount, coup.maxDiscountAmount, coup.usageLimit
      ]
    );
  }
  console.log(`✅ Seeded ${coupons.length} canonical coupons into PostgreSQL.`);

  // 4. Authoritative Restaurant Branches
  const branches = [
    {
      id: 'main_branch',
      franchise_id: 'fra_rajnandgaon',
      name: 'Olive Pizza (Rajnandgaon HQ)',
      address: 'Shop 12, Station Road, Rajnandgaon, Chhattisgarh 491441',
      phone: '9826199887',
      latitude: 21.0974,
      longitude: 81.0347,
      radiusKm: 25
    },
    {
      id: 'branch_bsp_main',
      franchise_id: 'fra_bilaspur',
      name: 'Bilaspur Main Branch',
      address: 'Vyapar Vihar, Bilaspur, Chhattisgarh 495001',
      phone: '9179944447',
      latitude: 22.0797,
      longitude: 82.1409,
      radiusKm: 25
    }
  ];

  for (const b of branches) {
    await query(`
      INSERT INTO restaurant_branches (
        id, franchise_id, name, address, phone, latitude, longitude,
        is_open, accepting_orders, delivery_settings
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8)
      ON CONFLICT (id) DO UPDATE SET
        franchise_id = EXCLUDED.franchise_id,
        name = EXCLUDED.name,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        is_open = true,
        accepting_orders = true,
        delivery_settings = EXCLUDED.delivery_settings;
    `, [
      b.id, b.franchise_id, b.name, b.address, b.phone, b.latitude, b.longitude,
      JSON.stringify({ radiusKm: b.radiusKm })
    ]);
  }
  console.log(`✅ Seeded ${branches.length} authoritative branches with GPS & delivery radii into PostgreSQL.`);

  // 5. Invalidate Redis menu bootstrap caches
  try {
    await redisService.invalidateMenu();
    console.log('✅ Invalidation of Redis menu bootstrap cache completed.');
  } catch (redisErr: any) {
    console.warn('Cache invalidation notice:', redisErr.message);
  }

  console.log('\n====================================================');
  console.log('✅ PostgreSQL 18.6 Master Catalog Seeding Complete!');
  console.log('====================================================\n');
}

if (process.argv[1]?.includes('seed_canonical_menu')) {
  seedCanonicalMenu()
    .then(async () => {
      await pgPool.end();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('Fatal seed error:', e);
      await pgPool.end();
      process.exit(1);
    });
}
