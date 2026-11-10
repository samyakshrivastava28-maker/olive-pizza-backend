/**
 * KnowledgeBaseService.ts
 * 
 * Zero-downtime, auto-learning AI Knowledge Base for Olive Pizza.
 * Automatically indexes all Firestore data and supports semantic search
 * with no external AI providers needed for menu/policy/FAQ queries.
 */

import crypto from 'crypto';
import { adminDb } from '../config/firebase.js';
import { staticKB } from './ai/StaticKnowledgeLoader.js';

export interface KBProduct {
  id: string;
  name: string;
  nameLower: string;
  description: string;
  price: number;
  discountedPrice?: number;
  category: string;
  subcategory?: string;
  tags: string[];
  isAvailable: boolean;
  isVeg?: boolean;
  isSpicy?: boolean;
  ingredients?: string;
  imageUrl?: string;
  rating?: number;
  preparationTime?: number;
  sizes?: string[];
  toppings?: string[];
  _indexedAt: number;
}

export interface KBCategory {
  id: string;
  name: string;
  description?: string;
  _indexedAt: number;
}

export interface KBCoupon {
  id: string;
  code: string;
  description: string;
  discountType: 'flat' | 'percent';
  discountValue: number;
  minOrder?: number;
  maxUses?: number;
  isActive: boolean;
  expiresAt?: any;
  _indexedAt: number;
}

export interface KBSettings {
  restaurantName: string;
  address: string;
  phone: string;
  email?: string;
  openingTime?: string;
  closingTime?: string;
  isOpen?: boolean;
  deliveryRadius?: number;
  minOrderAmount?: number;
  deliveryCharge?: number;
  freeDeliveryAbove?: number;
  estimatedDeliveryTime?: string;
  acceptedPayments?: string[];
  _indexedAt: number;
}

export interface KBPolicy {
  id: string;
  title: string;
  content: string;
  _indexedAt: number;
}

export interface KBFaq {
  id: string;
  question: string;
  answer: string;
  category?: string;
  _indexedAt: number;
}

export interface KBCacheInfo {
  version: number;
  lastSyncTime: number;
  lastProductUpdate: number;
  lastSettingsUpdate: number;
  lastPolicyUpdate: number;
  productCount: number;
  categoryCount: number;
  couponCount: number;
  faqCount: number;
  indexSizeBytes: number;
  totalQueries: number;
  localHits: number;
  failedQueries: number;
  recoveryCount: number;
}

// ─── Synonyms for fuzzy semantic understanding ───────────────────────────────
const SYNONYMS: Record<string, string[]> = {
  spicy: ['hot', 'tangy', 'peri', 'chilli', 'pepper', 'fiery', 'schezwan'],
  veg: ['vegetarian', 'veggie', 'vegetable', 'plant-based', 'meatless'],
  'non-veg': ['chicken', 'meat', 'non veg', 'nonveg', 'mutton', 'prawn'],
  cheesy: ['cheese', 'extra cheese', 'double cheese', 'mozzarella', 'cheddar'],
  kids: ['kid', 'child', 'children', 'small', 'mini', 'junior'],
  combo: ['meal deal', 'bundle', 'family pack', 'deal', 'offer'],
  drink: ['beverage', 'cold drink', 'soda', 'juice', 'water', 'cola', 'pepsi', 'coke', 'sprite'],
  dessert: ['sweet', 'ice cream', 'brownie', 'cake', 'pastry', 'lava cake'],
  bread: ['garlic bread', 'breadstick', 'toast'],
  coupon: ['discount', 'promo', 'code', 'offer', 'deal', 'voucher'],
  refund: ['return', 'money back', 'cancellation', 'cancel', 'refund policy'],
  delivery: ['shipping', 'delivery time', 'how long', 'when will', 'delivery charge'],
  payment: ['pay', 'upi', 'cash', 'card', 'online payment', 'gpay', 'phonepe', 'paytm'],
};

const STATIC_POLICIES: KBPolicy[] = [
  {
    id: 'privacy',
    title: 'Privacy Policy',
    content: 'Olive Pizza collects your name, phone, email, and delivery location only for order processing. We do not sell your data. You can request deletion at any time by contacting support. We use cookies for analytics and smooth app experience. Your payment info is processed securely by our payment partners—we never store card numbers.',
    _indexedAt: Date.now(),
  },
  {
    id: 'refund',
    title: 'Refund Policy',
    content: 'If your order is incorrect, damaged, or of poor quality, we will issue a full refund or replacement. Refund requests must be raised within 2 hours of delivery. Refunds are processed within 3-5 business days to your original payment method. Cancellations before preparation begins are fully refunded. Once preparation starts, cancellations may not be possible.',
    _indexedAt: Date.now(),
  },
  {
    id: 'delivery',
    title: 'Delivery Policy',
    content: 'Olive Pizza delivers within our coverage area in Rajnandgaon. Delivery times are estimated at 30–45 minutes from order confirmation depending on distance and kitchen load. Delivery charges apply based on your distance from the restaurant. Free delivery may be available above a minimum order amount. We do not deliver outside our service zone.',
    _indexedAt: Date.now(),
  },
  {
    id: 'terms',
    title: 'Terms & Conditions',
    content: 'By using Olive Pizza, you agree to provide accurate delivery information, be available to receive your order, and use the platform only for lawful purposes. Olive Pizza reserves the right to cancel fraudulent orders. Repeated fake orders may result in account suspension.',
    _indexedAt: Date.now(),
  },
  {
    id: 'cancellation',
    title: 'Cancellation Policy',
    content: 'Orders can be cancelled within 5 minutes of placement. Once the kitchen begins preparation, cancellation may not be possible. For issues after delivery, contact our support team immediately.',
    _indexedAt: Date.now(),
  },
];

const STATIC_FAQ: KBFaq[] = [
  { id: 'faq-1', question: 'How do I track my order?', answer: 'Go to Orders in your dashboard or visit the Order Tracking page with your order ID. You will see live status updates.', _indexedAt: Date.now() },
  { id: 'faq-2', question: 'What payment methods do you accept?', answer: 'We accept UPI (GPay, PhonePe, Paytm), Cash on Delivery, Credit/Debit cards, and net banking.', _indexedAt: Date.now() },
  { id: 'faq-3', question: 'How long does delivery take?', answer: 'Typically 30–45 minutes depending on your location and current order volume.', _indexedAt: Date.now() },
  { id: 'faq-4', question: 'Can I change my order after placing it?', answer: 'Orders can be modified within 5 minutes of placing. Contact support immediately if you need changes.', _indexedAt: Date.now() },
  { id: 'faq-5', question: 'Do you have veg options?', answer: 'Yes! We have a wide selection of vegetarian pizzas, sides, and combos. Use the Veg filter on our menu page.', _indexedAt: Date.now() },
  { id: 'faq-6', question: 'Is there a minimum order amount?', answer: 'Yes, there is a minimum order amount for delivery. You can see the exact amount at checkout or in the cart.', _indexedAt: Date.now() },
  { id: 'faq-7', question: 'How do I apply a coupon?', answer: 'Go to Cart, scroll to the coupon section, enter your code and click Apply. Valid coupons are automatically applied to your total.', _indexedAt: Date.now() },
  { id: 'faq-8', question: 'How do I contact support?', answer: 'Visit our Contact page or call us directly. You can also reach us via WhatsApp at the number listed on our Contact page.', _indexedAt: Date.now() },
];

const WEBSITE_PAGES = [
  { path: '/', name: 'Home', description: 'The main homepage with featured products, offers, and restaurant info.' },
  { path: '/menu', name: 'Menu', description: 'Browse our full menu with filters for category, veg/non-veg, and search.' },
  { path: '/cart', name: 'Cart', description: 'View your selected items, apply coupons, and proceed to checkout.' },
  { path: '/checkout', name: 'Checkout', description: 'Enter delivery address, choose payment, and place your order.' },
  { path: '/dashboard', name: 'My Dashboard', description: 'View your order history, rewards, wallet, saved addresses, and profile.' },
  { path: '/order-tracking/:id', name: 'Order Tracking', description: 'Track your current order status in real time.' },
  { path: '/assistant', name: 'AI Assistant', description: 'Chat with our AI to find menu items, get help, or navigate the app.' },
  { path: '/login', name: 'Login', description: 'Sign in to your account.' },
  { path: '/register', name: 'Register', description: 'Create a new account.' },
  { path: '/about', name: 'About Us', description: 'Learn about Olive Pizza, our story, and our team.' },
  { path: '/contact', name: 'Contact Us', description: 'Get in touch with our support team.' },
  { path: '/faq', name: 'FAQ', description: 'Frequently asked questions about orders, delivery, and more.' },
  { path: '/privacy-policy', name: 'Privacy Policy', description: 'How we handle your personal data.' },
  { path: '/refund-policy', name: 'Refund Policy', description: 'Our refund and return policies.' },
  { path: '/terms', name: 'Terms & Conditions', description: 'Legal terms for using Olive Pizza.' },
  { path: '/cancellation-policy', name: 'Cancellation Policy', description: 'How to cancel orders and what happens when you do.' },
  { path: '/delivery-policy', name: 'Delivery Policy', description: 'Delivery zones, charges, and timelines.' },
];

// ─── Knowledge Base Class ─────────────────────────────────────────────────────
class KnowledgeBaseService {
  private products: Map<string, KBProduct> = new Map();
  private categories: Map<string, KBCategory> = new Map();
  private coupons: Map<string, KBCoupon> = new Map();
  private faqs: Map<string, KBFaq> = new Map();
  private policies: Map<string, KBPolicy> = new Map();
  private settings: KBSettings | null = null;

  private stats: KBCacheInfo = {
    version: 1,
    lastSyncTime: 0,
    lastProductUpdate: 0,
    lastSettingsUpdate: 0,
    lastPolicyUpdate: 0,
    productCount: 0,
    categoryCount: 0,
    couponCount: 0,
    faqCount: 0,
    indexSizeBytes: 0,
    totalQueries: 0,
    localHits: 0,
    failedQueries: 0,
    recoveryCount: 0,
  };

  private unsubscribers: Array<() => void> = [];
  private isInitialized = false;

  // ─── Initialization ────────────────────────────────────────────────────────
  async initialize() {
    if (this.isInitialized) return;
    console.log('[KB] Initializing Knowledge Base...');

    // 1. Pre-warm static JSON knowledge base
    staticKB.preload();

    // 2. Seed static policies from JSON files (richer content than the inline STATIC_POLICIES)
    const jsonPolicies = staticKB.getAllStaticPolicies();
    if (jsonPolicies.length > 0) {
      // JSON policies override inline STATIC_POLICIES for the same IDs
      jsonPolicies.forEach(p => this.policies.set(p.id, { ...p, _indexedAt: Date.now() }));
      console.log(`[KB] Seeded ${jsonPolicies.length} policies from static JSON knowledge base`);
    } else {
      // Fallback to inline static policies
      STATIC_POLICIES.forEach(p => this.policies.set(p.id, p));
    }

    // 3. Seed static FAQs from JSON files (merged at runtime with Firestore FAQs)
    const jsonFaqs = staticKB.getAllStaticFaqs();
    jsonFaqs.forEach(f => this.faqs.set(f.id, { ...f, _indexedAt: Date.now() }));
    if (jsonFaqs.length > 0) {
      console.log(`[KB] Seeded ${jsonFaqs.length} FAQs from static JSON knowledge base`);
    } else {
      STATIC_FAQ.forEach(f => this.faqs.set(f.id, f));
    }

    await this.fullSync();
    this.attachFirestoreListeners();
    this.isInitialized = true;
    console.log(`[KB] ✅ Initialized — ${this.products.size} products, ${this.categories.size} categories, ${this.faqs.size} FAQs, ${this.policies.size} policies`);
  }

  // ─── Full Sync from Firestore ─────────────────────────────────────────────
  async fullSync() {
    try {
      const [productsSnap, categoriesSnap, couponsSnap, settingsSnap, faqsSnap] = await Promise.allSettled([
        adminDb.collection('products').get(),
        adminDb.collection('categories').get(),
        adminDb.collection('coupons').where('isActive', '==', true).get(),
        adminDb.collection('settings').doc('store').get(),
        adminDb.collection('faqs').get(),
      ]);

      if (productsSnap.status === 'fulfilled') {
        this.products.clear();
        productsSnap.value.docs.forEach(doc => {
          const data = doc.data();
          if (!data.isDeleted) this.indexProduct(doc.id, data);
        });
      }

      if (categoriesSnap.status === 'fulfilled') {
        this.categories.clear();
        categoriesSnap.value.docs.forEach(doc => {
          const data = doc.data();
          this.categories.set(doc.id, { id: doc.id, name: data.name, description: data.description, _indexedAt: Date.now() });
        });
      }

      if (couponsSnap.status === 'fulfilled') {
        this.coupons.clear();
        couponsSnap.value.docs.forEach(doc => {
          const data = doc.data();
          this.coupons.set(doc.id, {
            id: doc.id, code: data.code, description: data.description || '',
            discountType: data.discountType || 'flat', discountValue: data.discountValue || 0,
            minOrder: data.minOrderAmount, isActive: data.isActive, expiresAt: data.expiresAt,
            _indexedAt: Date.now(),
          });
        });
      }

      if (settingsSnap.status === 'fulfilled' && settingsSnap.value.exists) {
        this.indexSettings(settingsSnap.value.data()!);
      }

      if (faqsSnap.status === 'fulfilled') {
        faqsSnap.value.docs.forEach(doc => {
          const data = doc.data();
          this.faqs.set(doc.id, {
            id: doc.id, question: data.question || '', answer: data.answer || '',
            category: data.category, _indexedAt: Date.now(),
          });
        });
      }

      this.updateStats();
      this.stats.lastSyncTime = Date.now();
      this.stats.version++;
      console.log(`[KB] Full sync complete — ${this.products.size} products indexed`);
    } catch (err: any) {
      console.error('[KB] Full sync error:', err.message);
      this.stats.recoveryCount++;
    }
  }

  // ─── Firestore Real-Time Listeners ───────────────────────────────────────
  private attachFirestoreListeners() {
    // Products listener
    const unsubProducts = adminDb.collection('products').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const data = change.doc.data();
        if (change.type === 'removed' || data.isDeleted) {
          this.products.delete(change.doc.id);
          console.log(`[KB] Product removed: ${change.doc.id}`);
        } else {
          this.indexProduct(change.doc.id, data);
          console.log(`[KB] Product updated: ${data.name}`);
        }
      });
      this.stats.lastProductUpdate = Date.now();
      this.updateStats();
    }, err => console.warn('[KB] Products listener error:', err.message));

    // Categories listener
    const unsubCategories = adminDb.collection('categories').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const data = change.doc.data();
        if (change.type === 'removed') {
          this.categories.delete(change.doc.id);
        } else {
          this.categories.set(change.doc.id, { id: change.doc.id, name: data.name, description: data.description, _indexedAt: Date.now() });
        }
      });
      this.updateStats();
    }, err => console.warn('[KB] Categories listener error:', err.message));

    // Settings listener
    const unsubSettings = adminDb.collection('settings').doc('store').onSnapshot(snap => {
      if (snap.exists) {
        const data = snap.data()!;
        this.indexSettings(data);
        this.stats.lastSettingsUpdate = Date.now();
        console.log('[KB] Settings updated');
      }
    }, err => console.warn('[KB] Settings listener error:', err.message));

    // Coupons listener
    const unsubCoupons = adminDb.collection('coupons').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const data = change.doc.data();
        if (change.type === 'removed' || !data.isActive) {
          this.coupons.delete(change.doc.id);
        } else {
          this.coupons.set(change.doc.id, {
            id: change.doc.id, code: data.code, description: data.description || '',
            discountType: data.discountType || 'flat', discountValue: data.discountValue || 0,
            minOrder: data.minOrderAmount, isActive: data.isActive, expiresAt: data.expiresAt,
            _indexedAt: Date.now(),
          });
        }
      });
      this.updateStats();
    }, err => console.warn('[KB] Coupons listener error:', err.message));

    // FAQs listener
    const unsubFaqs = adminDb.collection('faqs').onSnapshot(snap => {
      snap.docChanges().forEach(change => {
        const data = change.doc.data();
        if (change.type === 'removed') {
          this.faqs.delete(change.doc.id);
        } else {
          this.faqs.set(change.doc.id, {
            id: change.doc.id, question: data.question || '', answer: data.answer || '',
            category: data.category, _indexedAt: Date.now(),
          });
        }
      });
      this.updateStats();
    }, err => console.warn('[KB] FAQs listener error:', err.message));

    this.unsubscribers.push(unsubProducts, unsubCategories, unsubSettings, unsubCoupons, unsubFaqs);
  }

  // ─── Indexers ──────────────────────────────────────────────────────────────
  private indexProduct(id: string, data: any) {
    const tags: string[] = [];
    const nameLower = (data.name || '').toLowerCase();
    const descLower = (data.description || '').toLowerCase();

    if (data.isVeg) tags.push('veg', 'vegetarian');
    if (!data.isVeg) tags.push('non-veg', 'chicken', 'meat');
    if (nameLower.includes('spicy') || descLower.includes('spicy')) tags.push('spicy', 'hot');
    if (nameLower.includes('cheese') || descLower.includes('cheese')) tags.push('cheesy', 'cheese');
    if (nameLower.includes('garlic')) tags.push('garlic', 'bread');
    if (data.category) tags.push(data.category.toLowerCase());
    if (data.subcategory) tags.push(data.subcategory.toLowerCase());

    this.products.set(id, {
      id,
      name: data.name || '',
      nameLower,
      description: data.description || '',
      price: data.price || 0,
      discountedPrice: data.discountedPrice,
      category: data.category || '',
      subcategory: data.subcategory,
      tags,
      isAvailable: data.isAvailable !== false,
      isVeg: data.isVeg,
      isSpicy: data.isSpicy || nameLower.includes('spicy'),
      ingredients: data.ingredients,
      imageUrl: data.imageUrl || data.image,
      rating: data.rating,
      preparationTime: data.preparationTime,
      sizes: data.sizes,
      toppings: data.toppings,
      _indexedAt: Date.now(),
    });
  }

  private indexSettings(data: any) {
    this.settings = {
      restaurantName: data.restaurantName || data.name || 'Olive Pizza',
      address: data.address || data.restaurantAddress || '',
      phone: data.phone || data.contactPhone || '',
      email: data.email || data.contactEmail,
      openingTime: data.openingTime || data.openTime,
      closingTime: data.closingTime || data.closeTime,
      isOpen: data.isOpen,
      deliveryRadius: data.deliveryRadius,
      minOrderAmount: data.minOrderAmount,
      deliveryCharge: data.deliveryCharge,
      freeDeliveryAbove: data.freeDeliveryAbove,
      estimatedDeliveryTime: data.estimatedDeliveryTime || '30-45 minutes',
      acceptedPayments: data.acceptedPayments || ['UPI', 'Cash on Delivery', 'Credit Card', 'Debit Card'],
      _indexedAt: Date.now(),
    };
  }

  private updateStats() {
    const productsJson = JSON.stringify([...this.products.values()]);
    this.stats.productCount = this.products.size;
    this.stats.categoryCount = this.categories.size;
    this.stats.couponCount = this.coupons.size;
    this.stats.faqCount = this.faqs.size;
    this.stats.indexSizeBytes = Buffer.byteLength(productsJson, 'utf8');
  }

  // ─── Search Engine ─────────────────────────────────────────────────────────
  searchProducts(query: string, maxResults = 6): KBProduct[] {
    this.stats.totalQueries++;
    const q = query.toLowerCase().trim();
    const available = [...this.products.values()].filter(p => p.isAvailable);

    // Price filter: "under ₹300", "below 200"
    const priceMatch = q.match(/(?:under|below|less than|upto|up to|<)\s*[₹rs]?\s*(\d+)/i);
    let maxPrice: number | null = null;
    if (priceMatch) maxPrice = parseInt(priceMatch[1], 10);

    // Expand synonyms
    const expandedTerms = new Set<string>([q]);
    Object.entries(SYNONYMS).forEach(([key, syns]) => {
      if (q.includes(key) || syns.some(s => q.includes(s))) {
        expandedTerms.add(key);
        syns.forEach(s => expandedTerms.add(s));
      }
    });

    const scored = available.map(p => {
      let score = 0;
      const effectivePrice = p.discountedPrice ?? p.price;

      // Exact name match
      if (p.nameLower === q) score += 100;
      else if (p.nameLower.includes(q)) score += 50;

      // Fuzzy term matching
      expandedTerms.forEach(term => {
        if (p.nameLower.includes(term)) score += 30;
        if (p.description.toLowerCase().includes(term)) score += 15;
        if (p.tags.some(t => t.includes(term))) score += 20;
        if (p.category.toLowerCase().includes(term)) score += 10;
        if (p.ingredients?.toLowerCase().includes(term)) score += 10;
      });

      // Price filter
      if (maxPrice !== null && effectivePrice > maxPrice) score = -1;

      return { product: p, score };
    });

    this.stats.localHits++;
    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.product);
  }

  // ─── Policy Lookup ─────────────────────────────────────────────────────────
  searchPolicies(query: string): KBPolicy | null {
    const q = query.toLowerCase();
    for (const [, policy] of this.policies) {
      const title = policy.title.toLowerCase();
      if (q.includes(title) || title.split(' ').some(w => q.includes(w))) return policy;
    }
    // Synonym matching
    if (q.includes('refund') || q.includes('return') || q.includes('money back')) return this.policies.get('refund') || null;
    if (q.includes('cancel')) return this.policies.get('cancellation') || null;
    if (q.includes('privacy') || q.includes('data')) return this.policies.get('privacy') || null;
    if (q.includes('delivery') || q.includes('shipping')) return this.policies.get('delivery') || null;
    if (q.includes('terms')) return this.policies.get('terms') || null;
    return null;
  }

  // ─── FAQ Lookup ────────────────────────────────────────────────────────────
  searchFaqs(query: string): KBFaq | null {
    const q = query.toLowerCase();
    let best: { faq: KBFaq; score: number } | null = null;

    for (const [, faq] of this.faqs) {
      const qLower = faq.question.toLowerCase();
      let score = 0;
      q.split(' ').forEach(word => {
        if (word.length > 2 && qLower.includes(word)) score++;
      });
      if (score > 0 && (!best || score > best.score)) {
        best = { faq, score };
      }
    }
    return best?.faq || null;
  }

  // ─── Navigation Lookup ─────────────────────────────────────────────────────
  findPage(query: string): typeof WEBSITE_PAGES[0] | null {
    const q = query.toLowerCase();
    return WEBSITE_PAGES.find(p =>
      p.name.toLowerCase().includes(q) ||
      q.includes(p.name.toLowerCase()) ||
      p.description.toLowerCase().includes(q) ||
      q.includes(p.path.slice(1))
    ) || null;
  }

  // ─── Quick Rule-Based Answers ─────────────────────────────────────────────
  quickAnswer(query: string): string | null {
    const q = query.toLowerCase();

    // Store status
    if (q.includes('open') || q.includes('close') || q.includes('hours') || q.includes('timing')) {
      if (this.settings?.isOpen !== undefined) {
        const statusText = this.settings.isOpen ? '🟢 **Open**' : '🔴 **Closed**';
        const hours = this.settings.openingTime && this.settings.closingTime
          ? ` We're open from **${this.settings.openingTime}** to **${this.settings.closingTime}**.`
          : '';
        return `Olive Pizza is currently ${statusText}.${hours}`;
      }
    }

    // Delivery charges
    if (q.includes('delivery charge') || q.includes('delivery fee') || q.includes('delivery cost')) {
      if (this.settings?.deliveryCharge !== undefined) {
        const free = this.settings.freeDeliveryAbove ? ` Free delivery on orders above ₹${this.settings.freeDeliveryAbove}.` : '';
        return `Delivery charge is ₹${this.settings.deliveryCharge}.${free}`;
      }
    }

    // Minimum order
    if (q.includes('minimum order') || q.includes('min order')) {
      if (this.settings?.minOrderAmount) {
        return `The minimum order amount is ₹${this.settings.minOrderAmount}.`;
      }
    }

    // Delivery time
    if (q.includes('how long') || q.includes('delivery time') || q.includes('how much time')) {
      return `Estimated delivery time is ${this.settings?.estimatedDeliveryTime || '30–45 minutes'} 🛵`;
    }

    // Contact
    if (q.includes('contact') || q.includes('phone') || q.includes('call')) {
      if (this.settings?.phone) {
        return `You can reach us at 📞 **${this.settings.phone}**. Or visit our [Contact page](/contact).`;
      }
    }

    // Payment
    if (q.includes('payment') || q.includes('pay') || q.includes('upi') || q.includes('cash')) {
      const methods = this.settings?.acceptedPayments?.join(', ') || 'UPI, Cash on Delivery, Credit/Debit Card';
      return `We accept: **${methods}** 💳`;
    }

    // Active coupons
    if (q.includes('coupon') || q.includes('discount') || q.includes('promo')) {
      const activeCoupons = [...this.coupons.values()].filter(c => c.isActive).slice(0, 3);
      if (activeCoupons.length > 0) {
        const list = activeCoupons.map(c => `**${c.code}** — ${c.description || `${c.discountValue}${c.discountType === 'percent' ? '%' : '₹'} off`}`).join('\n');
        return `🎟️ Active coupons:\n${list}`;
      }
      return `Check your account dashboard or the cart for available coupons!`;
    }

    return null;
  }

  // ─── Context Builder (for AI prompt injection) ────────────────────────────
  buildContextForQuery(query: string): string {
    const q = query.toLowerCase();
    const sections: string[] = [];

    // Relevant products
    const products = this.searchProducts(query, 5);
    if (products.length > 0) {
      sections.push('RELEVANT PRODUCTS:\n' + products.map(p =>
        `- ${p.name}: ₹${p.discountedPrice ?? p.price}${p.discountedPrice ? ` (was ₹${p.price})` : ''}. ${p.description}. Category: ${p.category}. Available: ${p.isAvailable ? 'Yes' : 'No'}.`
      ).join('\n'));
    }

    // Settings
    if (this.settings) {
      sections.push(`RESTAURANT INFO:\nName: ${this.settings.restaurantName}\nStatus: ${this.settings.isOpen ? 'Open' : 'Closed'}\nHours: ${this.settings.openingTime || 'N/A'} - ${this.settings.closingTime || 'N/A'}\nDelivery charge: ₹${this.settings.deliveryCharge || 0}\nMin order: ₹${this.settings.minOrderAmount || 0}\nEstimated delivery: ${this.settings.estimatedDeliveryTime || '30-45 min'}\nPayments: ${this.settings.acceptedPayments?.join(', ')}`);
    }

    // Policy
    const policy = this.searchPolicies(query);
    if (policy) {
      sections.push(`POLICY — ${policy.title}:\n${policy.content}`);
    }

    // FAQ
    const faq = this.searchFaqs(query);
    if (faq) {
      sections.push(`FAQ:\nQ: ${faq.question}\nA: ${faq.answer}`);
    }

    // Navigation
    if (q.includes('where') || q.includes('how to') || q.includes('page') || q.includes('go to') || q.includes('navigate')) {
      const page = this.findPage(query);
      if (page) sections.push(`NAVIGATION: "${page.name}" is at ${page.path}. ${page.description}`);
    }

    return sections.length > 0 ? sections.join('\n\n') : '';
  }

  // ─── Getters ───────────────────────────────────────────────────────────────
  getStats(): KBCacheInfo { return { ...this.stats }; }
  getProductCount() { return this.products.size; }
  getAllCategories() { return [...this.categories.values()]; }
  getAllCoupons() { return [...this.coupons.values()].filter(c => c.isActive); }
  getAllProducts() { return [...this.products.values()]; }
  getAllPolicies() { return [...this.policies.values()]; }
  getAllFaqs() { return [...this.faqs.values()]; }
  getSettings() { return this.settings; }
  isReady() { return this.isInitialized; }

  // ─── Self-Heal: Manual Rebuild ─────────────────────────────────────────────
  async forceRebuild() {
    console.log('[KB] Force rebuild initiated...');
    this.stats.recoveryCount++;
    await this.fullSync();
    console.log('[KB] Rebuild complete.');
    return this.getStats();
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────
  destroy() {
    this.unsubscribers.forEach(u => u());
    this.unsubscribers = [];
  }
}

// Singleton export
export const kb = new KnowledgeBaseService();
export default kb;
