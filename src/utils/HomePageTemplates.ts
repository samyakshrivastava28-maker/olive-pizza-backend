import { PageSchema, BuiltInPageSchema } from '../types/PageSchema.js';

export const PREDEFINED_TEMPLATES: BuiltInPageSchema[] = [
  // 1. Default Flagship Luxury Home
  {
    versionId: 'v1',
    pageId: 'default',
    type: 'BUILT_IN',
    templateId: 'default',
    metadata: {
      name: 'Default Flagship Home',
      description: 'The standard premium wood-fired artisan experience with live ordering urgency and 20-min delivery guarantee.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'urgency_ribbon',
        type: 'COUNTDOWN',
        isHidden: false,
        config: {
          headline: '⚡ FLASH SALE: Free Artisanal Garlic Bread on all orders above ₹399 • 20 Min Delivery Guarantee',
          subtitle: 'Limited Time Deal • Ends Tonight',
          animationType: 'Fade Down',
          styleOverrides: { backgroundColor: '#EA580C', textColor: '#FFFFFF' }
        }
      },
      {
        id: 'hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Wood-Fired Gourmet Perfection 🍕',
          subtitle: 'Artisan hand-stretched sourdough, rich San Marzano sauce, and 100% pure Fior di Latte mozzarella melted over flaming beechwood.',
          mediaUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Fade Up',
          buttonText: 'EXPLORE LIVE MENU',
          buttonAction: { type: 'OPEN_MENU' },
          styleOverrides: { backgroundColor: '#0B0F17', textColor: '#FFFFFF' }
        }
      },
      {
        id: 'cravings',
        type: 'CRAVINGS',
        isHidden: false,
        config: {
          headline: "WHAT'S YOUR CRAVING TODAY?",
          subtitle: 'Handcrafted fresh to order in Rajnandgaon.'
        }
      },
      {
        id: 'featured',
        type: 'FEATURED',
        isHidden: false,
        config: {
          headline: '🔥 Best Sellers & Chef Recommendations',
          subtitle: 'Over 10,000+ orders delivered with 4.9★ rating'
        }
      },
      {
        id: 'pizza_showcase',
        type: 'PIZZA_SHOWCASE',
        isHidden: false,
        config: {
          headline: 'Artisanal Double Cheese Burst Combos',
          subtitle: 'Pair 2 Gourmet Medium Pizzas + Cheesy Dip at 30% OFF',
          animationType: 'Slide'
        }
      },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🏷️ Exclusive Promo Codes & Instant Discounts' } },
      { id: 'ads', type: 'ADS', isHidden: false, config: {} },
      { id: 'testimonials', type: 'TESTIMONIALS', isHidden: false, config: { headline: '💬 Loved by Foodies Across Rajnandgaon' } },
      { id: 'app', type: 'DOWNLOAD_APP', isHidden: false, config: {} }
    ]
  },

  // 2. Diwali Special — Royal Golden Festive Feast (Stitch Generated)
  {
    versionId: 'v1',
    pageId: 'diwali',
    type: 'BUILT_IN',
    templateId: 'diwali',
    metadata: {
      name: 'Diwali Special',
      description: 'Royal Golden Feast with glowing diyas, 50% festival discount, and cheese pull photography.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'diwali_ribbon',
        type: 'COUNTDOWN',
        isHidden: false,
        config: {
          headline: '🪔 DIWALI MEGA SALE: Flat 50% OFF + Free Choco Lava Cake on orders above ₹499',
          subtitle: 'Limited Festive Offer • Order Before Midnight',
          animationType: 'Fade Down',
          styleOverrides: { backgroundColor: '#B45309', textColor: '#FEF08A' }
        }
      },
      {
        id: 'diwali_hero',
        type: 'VIDEO_HERO',
        isHidden: false,
        config: {
          headline: 'Happy Diwali Celebrations! 🪔✨',
          subtitle: 'Light up your festivities with our Royal Golden Feast combos and sizzling wood-fired mozzarella pulls.',
          mediaUrl: 'https://lh3.googleusercontent.com/aida/AP1WRLu-HiPLEdFgxQPwp_gHpGY-Tq_TQn9slCWVENETBEMfLpcti5D7YZ5GpSa7qgPKEZxfz_0r7jEzMR3aJtRyr0E5Y10ZUF2VZuhQLWYLAL7JNV-142R0Mcp3OUz5LGwag4-zVkoMaxPD_bQiCt-A6-1D_XjlAV4qhqWKHrHSHU3AEPaDHqfm2iojgaPSY7tbZq-FuzGoluGtlzq-3kS5POKbRKZEnLtkZGVazn64oWnnto4Mzsi4hZmtGg',
          animationType: 'Pop',
          buttonText: 'CLAIM 50% FESTIVAL DEAL',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#3E1404', textColor: '#FEF08A' }
        }
      },
      {
        id: 'cravings',
        type: 'CRAVINGS',
        isHidden: false,
        config: { headline: 'FESTIVE DIWALI SELECTIONS', subtitle: 'Royal Paneer, Golden Corn, Saffron BBQ & Festive Sweets' }
      },
      {
        id: 'featured',
        type: 'FEATURED',
        isHidden: false,
        config: { headline: '🌟 Royal Golden Festive Pizzas', subtitle: 'Specially crafted for family celebrations' }
      },
      {
        id: 'pizza_showcase',
        type: 'PIZZA_SHOWCASE',
        isHidden: false,
        config: { headline: 'Diwali Grand Family Feast Box (4-6 People)', animationType: 'Slide' }
      },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🪔 Festive Promo Code: DIWALI50' } },
      { id: 'testimonials', type: 'TESTIMONIALS', isHidden: false, config: { headline: 'Loved by Families This Festive Season' } },
      { id: 'app', type: 'DOWNLOAD_APP', isHidden: false, config: {} }
    ]
  },

  // 3. Holi Colors — Gulal & Crust (Stitch Generated)
  {
    versionId: 'v1',
    pageId: 'holi',
    type: 'BUILT_IN',
    templateId: 'holi',
    metadata: {
      name: 'Holi Colors',
      description: 'Vibrant color splashes, rainbow bell pepper crusts, buy 2 get 1 free deals.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'holi_ribbon',
        type: 'COUNTDOWN',
        isHidden: false,
        config: {
          headline: '🎨 HOLI FESTIVAL SPECIAL: Buy 2 Large Pizzas, Get 1 Medium 100% FREE + Complimentary Thandai',
          subtitle: 'Celebration Deal Active Today',
          animationType: 'Fade Down',
          styleOverrides: { backgroundColor: '#BE123C', textColor: '#FEF08A' }
        }
      },
      {
        id: 'holi_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'A Splash of Delicious Flavor! 🎨🍕',
          subtitle: 'Celebrate the festival of colors with rainbow cheese pulls, spicy makhani paneer, and joyful treats.',
          mediaUrl: 'https://lh3.googleusercontent.com/aida/AP1WRLuo2Yen88JROm6l7I5sX8tAQbxUINwkttGus4UDHRUMXCWWFfRcW3DezuoHFZ1NoR478K8--geymCBUbTnVvbmUkfJ2cOCJIYyfQY86JnSWWXs83wPAOvHw-r-ofjClIEmVXb2aEdDA22NUZpJ0KHQY3ldrNPwW_-zv4uMgsYMioqXKMcXwxLOgVYEARagHinyD0iIUl7PQYbHKkwdCwMr9Ic-U-hijRv-L61TD5MmR12WSbZcMus1MDZM',
          animationType: 'Floating',
          buttonText: 'ORDER HOLI SPECIAL DEAL',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#4C0519', textColor: '#FFF1F2' }
        }
      },
      {
        id: 'cravings',
        type: 'CRAVINGS',
        isHidden: false,
        config: { headline: 'COLORFUL CRAVINGS', subtitle: 'Rainbow Veggie Sizzlers & Makhani Splashes' }
      },
      {
        id: 'featured',
        type: 'FEATURED',
        isHidden: false,
        config: { headline: '🎨 Holi Favorite Pizzas', subtitle: 'Loaded with colorful fresh gourmet toppings' }
      },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🎨 Holi Coupon Code: HOLI2026' } },
      { id: 'testimonials', type: 'TESTIMONIALS', isHidden: false, config: {} }
    ]
  },

  // 4. New Year Party — Midnight Countdown
  {
    versionId: 'v1',
    pageId: 'new_year',
    type: 'BUILT_IN',
    templateId: 'new_year',
    metadata: {
      name: 'New Year Party',
      description: 'Midnight countdown excitement, squad party boxes, and grand year-end deals.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'ny_countdown',
        type: 'COUNTDOWN',
        isHidden: false,
        config: {
          headline: '🎉 NEW YEAR MIDNIGHT PARTY: Flat 40% OFF On All Jumbo Party Boxes (Countdown to 00:00)',
          subtitle: 'Non-Stop Midnight Delivery Active',
          animationType: 'Stagger',
          styleOverrides: { backgroundColor: '#0369A1', textColor: '#FFFFFF' }
        }
      },
      {
        id: 'ny_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Ring in the New Year with Olive Pizza ✨🍕',
          subtitle: 'Midnight Party Boxes, Cheesy Garlic Platters, and Mega Year-End Savings.',
          mediaUrl: 'https://images.unsplash.com/photo-1544982503-9f984c14501a?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Fade Up',
          buttonText: 'ORDER MIDNIGHT PARTY BOX',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#080D1A', textColor: '#38BDF8' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'PARTY CRUST CRAVINGS', subtitle: 'Jumbo Slices & Party Platters' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: { headline: '🎉 Party Box Specials' } },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '✨ New Year Promo Code: NY2026' } },
      { id: 'testimonials', type: 'TESTIMONIALS', isHidden: false, config: {} }
    ]
  },

  // 5. Navratri Sattvic Feast — 100% Pure Veg
  {
    versionId: 'v1',
    pageId: 'navratri',
    type: 'BUILT_IN',
    templateId: 'navratri',
    metadata: {
      name: 'Navratri Sattvic Feast',
      description: '100% Pure Vegetarian, Jain-friendly options, and gourmet paneer creations.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'navratri_ribbon',
        type: 'COUNTDOWN',
        isHidden: false,
        config: {
          headline: '🌺 SHUBH NAVRATRI: 100% Pure Veg Kitchen Guarantee • Free Beverage with Every Gourmet Pizza',
          subtitle: 'Made with Divine Care & Pure Ingredients',
          animationType: 'Fade Down',
          styleOverrides: { backgroundColor: '#86198F', textColor: '#FDF4FF' }
        }
      },
      {
        id: 'navratri_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Shubh Navratri Sattvic Feast 🌺🙏',
          subtitle: '100% Pure Vegetarian gourmet artisan pizzas made with pure mozzarella, fresh paneer, and rich herbs.',
          mediaUrl: 'https://images.unsplash.com/photo-1593560708920-61dd98c46a4e?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Floating',
          buttonText: 'EXPLORE PURE VEG MENU',
          buttonAction: { type: 'OPEN_MENU' },
          styleOverrides: { backgroundColor: '#3B0764', textColor: '#FDF4FF' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'PURE VEG & PANNER CREATIONS', subtitle: 'Jain & Fasting Friendly Selections' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: { headline: '🧀 Premium Paneer & Veggie Sizzlers' } },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🌺 Navratri Coupon: PUREVEG30' } }
    ]
  },

  // 6. Ganesh Chaturthi Special
  {
    versionId: 'v1',
    pageId: 'ganesh_chaturthi',
    type: 'BUILT_IN',
    templateId: 'ganesh_chaturthi',
    metadata: {
      name: 'Ganesh Chaturthi Special',
      description: 'Auspicious festival celebration with sweet dessert pizzas and family feasts.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'ganesh_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Ganpati Bappa Morya! 🙏✨',
          subtitle: 'Celebrate the auspicious blessings with Grand Family Feast Combos and complimentary Choco Lava Cake.',
          mediaUrl: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Pop',
          buttonText: 'ORDER FAMILY FEAST',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#451A03', textColor: '#FFEDD5' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'AUSPICIOUS FAMILY FEASTS', subtitle: 'Curated for Sharing & Celebration' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: {} },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🙏 Festival Promo Code: BAPPA40' } }
    ]
  },

  // 7. Dussehra Victory Feast
  {
    versionId: 'v1',
    pageId: 'dussehra',
    type: 'BUILT_IN',
    templateId: 'dussehra',
    metadata: {
      name: 'Dussehra Victory Feast',
      description: 'Celebrate the victory of good taste with jumbo pizza boxes and garlic bread combos.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'dussehra_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Happy Dussehra Celebrations 🏹🔥',
          subtitle: 'Victory feast combos with complimentary Cheesy Garlic Bread on all orders above ₹499.',
          mediaUrl: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Fade Up',
          buttonText: 'CLAIM VICTORY COMBO',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#1E1B4B', textColor: '#E0E7FF' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'VICTORY COMBOS', subtitle: 'Cheesy overloaded pizzas for holiday dining' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: {} },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🏹 Dussehra Code: VICTORY50' } }
    ]
  },

  // 8. Raksha Bandhan Treats
  {
    versionId: 'v1',
    pageId: 'raksha_bandhan',
    type: 'BUILT_IN',
    templateId: 'raksha_bandhan',
    metadata: {
      name: 'Raksha Bandhan Treats',
      description: 'Sweet sibling memories with duo pizza combos and choco lava treats.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'rakhi_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Celebrate the Sweetest Bond 🎁🍕',
          subtitle: 'Sibling Duo Combos: 2 Medium Pizzas + Molten Choco Lava Cake at an unbeatable 35% discount!',
          mediaUrl: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Floating',
          buttonText: 'ORDER SIBLING DUO',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#4A044E', textColor: '#FAE8FF' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'SIBLING DUO SPECIALS', subtitle: 'Pairings designed for 2' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: {} },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🎁 Sibling Code: RAKHI2026' } }
    ]
  },

  // 9. Friendship Day Squad Box
  {
    versionId: 'v1',
    pageId: 'friendship_day',
    type: 'BUILT_IN',
    templateId: 'friendship_day',
    metadata: {
      name: 'Friendship Day Squad Box',
      description: 'Squad sharing packs, buy 2 get 1 offers, and cheesy group platters.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'friends_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Best Friends Share Pizza 🍕🤝',
          subtitle: 'Gather your squad! Buy 2 Large Pizzas and get 1 Medium Pizza 100% FREE.',
          mediaUrl: 'https://images.unsplash.com/photo-1590947132387-155cc02f3212?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Slide',
          buttonText: 'GRAB SQUAD DEAL',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#064E3B', textColor: '#ECFDF5' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'SQUAD FAVORITES', subtitle: 'Extra cheese, extra toppings, extra fun' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: {} },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '🤝 Squad Deal Code: FRIENDS3' } }
    ]
  },

  // 10. Valentine's Romance — Love at First Slice
  {
    versionId: 'v1',
    pageId: 'valentines_day',
    type: 'BUILT_IN',
    templateId: 'valentines_day',
    metadata: {
      name: "Valentine's Romance",
      description: 'Candlelight romantic pairings, heart-shaped pizza specials, and decadent lava cakes.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'val_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'Love at First Slice ❤️🍕',
          subtitle: 'Romantic date night combos with artisan heart crust pizzas, garlic bread, and molten chocolate cake.',
          mediaUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=1200&auto=format&fit=crop',
          animationType: 'Pop',
          buttonText: 'ORDER DATE NIGHT COMBO',
          buttonAction: { type: 'OPEN_OFFERS' },
          styleOverrides: { backgroundColor: '#881337', textColor: '#FFE4E6' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'ROMANTIC PAIRINGS', subtitle: 'Handcrafted with passion & gourmet perfection' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: { headline: '❤️ Date Night Specials' } },
      { id: 'coupons', type: 'COUPONS', isHidden: false, config: { headline: '❤️ Romantic Promo Code: LOVEPIZZA' } }
    ]
  },

  // 11. Blank Draft Template
  {
    versionId: 'v1',
    pageId: 'draft_template',
    type: 'BUILT_IN',
    templateId: 'draft_template',
    metadata: {
      name: 'Draft Template',
      description: 'Blank customizable canvas to build a completely custom homepage from scratch.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'custom_hero',
        type: 'HERO',
        isHidden: false,
        config: {
          headline: 'New Campaign Headline',
          subtitle: 'Add your custom campaign description here.',
          animationType: 'Fade Up',
          buttonText: 'ORDER NOW',
          buttonAction: { type: 'OPEN_MENU' }
        }
      },
      { id: 'cravings', type: 'CRAVINGS', isHidden: false, config: { headline: 'FEATURED CREATIONS', subtitle: 'Choose from our artisan menu.' } },
      { id: 'featured', type: 'FEATURED', isHidden: false, config: {} }
    ]
  }
];

export const getTemplateById = (pageId: string): BuiltInPageSchema | undefined => {
  return PREDEFINED_TEMPLATES.find(t => t.pageId === pageId);
};
