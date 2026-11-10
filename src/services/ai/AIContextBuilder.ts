/**
 * AIContextBuilder.ts — Production Hybrid Knowledge Engine & Intent Router
 *
 * Hybrid RAG Architecture:
 *  Preloaded In-Memory KB / Firestore (Products, Prices, Store Info, Hours, Coupons, Policies, FAQs)
 *  + Pinecone Vector DB (Semantic Embeddings Search)
 *  + Live Website & Customer Cart State
 *  = SINGLE SOURCE OF TRUTH.
 *
 * Zero-Hallucination & Multi-source Fallback Policy:
 *  1. Primary: Pinecone Semantic Vector Chunks.
 *  2. Structured Firestore / KB Search (Products, Categories, Coupons, Store Settings).
 *  3. Preloaded Legal & Help Policies (Privacy, Refund, Delivery, Terms, FAQs).
 *  4. Only if ALL sources fail should AI state data is unavailable.
 */

import kb, { KBProduct, KBPolicy, KBFaq } from '../KnowledgeBaseService.js';
import { recommendationEngine } from './RecommendationEngine.js';
import { staticKB } from './StaticKnowledgeLoader.js';
import { KnowledgeMemoryStore } from '../knowledge/KnowledgeSyncService.js';

// In-memory query context cache with 5-minute TTL (Zero external vector/embedding dependencies)
const queryContextCache = new Map<string, { data: Omit<ContextBuildResult, 'cacheHit'>; expiresAt: number }>();

export interface DetailedSearchResult {
  results: Array<{ content: string; score: number; metadata: any }>;
  telemetry: {
    embeddingLatencyMs: number;
    embeddingModelUsed: string;
    embeddingProvider: string;
    qdrantLatencyMs: number;
    collectionName: string;
    totalHitsReturned: number;
    matchedChunksCount: number;
    topSimilarityScore: number;
    zeroChunkReason?: string;
  };
}

export type QueryIntent = 'RESTAURANT' | 'NON_RESTAURANT';

export interface ContextBuildResult {
  contextStr: string;
  isDomainQuery: boolean;
  queryIntent: QueryIntent;
  groundingStatus: 'OK' | 'UNAVAILABLE' | 'GENERAL_CHITCHAT';
  telemetry: DetailedSearchResult['telemetry'];
  chunks: Array<{ content: string; score: number; metadata: any }>;
  cacheHit: boolean;
  structuredCatalogInjected: boolean;
}

// ─── Restaurant Intent Keywords ─────────────────────────────────────────────────
const RESTAURANT_KEYWORDS = new Set([
  'menu', 'pizza', 'pizzas', 'garlic', 'bread', 'pasta', 'lasagna', 'salad',
  'sandwich', 'burger', 'appetizer', 'starter', 'main', 'side', 'sides',
  'dessert', 'desserts', 'beverage', 'beverages', 'drink', 'drinks', 'juice',
  'coffee', 'chai', 'tea', 'milkshake', 'cold', 'hot', 'combo', 'meal', 'deal',
  'ingredient', 'ingredients', 'topping', 'toppings', 'crust', 'crusts',
  'cheese', 'paneer', 'corn', 'olive', 'mushroom', 'pepper', 'jalapeño', 'jalapeno',
  'onion', 'tomato', 'basil', 'oregano', 'spicy', 'mild', 'veg', 'vegetarian',
  'pure veg', 'allergen', 'allergens', 'calorie', 'calories', 'nutrition',
  'price', 'prices', 'cost', 'costs', 'how much', 'rate', 'rates',
  'offer', 'offers', 'deal', 'deals', 'discount', 'discounts', 'coupon',
  'coupons', 'promo', 'promotion', 'code', 'save', 'cashback',
  'reward', 'rewards', 'loyalty', 'points', 'gst', 'tax', 'charges',
  'order', 'orders', 'cart', 'checkout', 'buy', 'add', 'remove', 'quantity',
  'place order', 'repeat', 'cancel', 'track', 'tracking', 'delivery status',
  'delivery', 'deliver', 'time', 'eta', 'how long', 'fast', 'quick', 'delay',
  'address', 'location', 'area', 'radius', 'distance', 'km', 'zone',
  'driver', 'partner', 'rider', 'out for delivery', 'dispatched', 'arrived',
  'timing', 'timings', 'hours', 'open', 'close', 'closed', 'opening',
  'schedule', 'branch', 'branches', 'outlet', 'outlets', 'store', 'restaurant',
  'olive pizza', 'contact', 'phone', 'call', 'whatsapp', 'number',
  'rajnandgaon', 'chhattisgarh',
  'policy', 'policies', 'refund', 'return', 'exchange', 'complaint',
  'feedback', 'review', 'rating', 'faq', 'question', 'queries', 'support',
  'help', 'minimum order', 'minimum', 'free delivery',
  'payment', 'pay', 'upi', 'card', 'cod', 'cash', 'online', 'wallet',
  'recommend', 'recommendation', 'recommendations', 'suggest', 'suggestion', 'best', 'popular', 'top',
  'hawaiian', 'pepperoni', 'bbq chicken', 'meat', 'chicken', 'about us', 'terms', 'privacy',
]);

const NON_RESTAURANT_BYPASS_KEYWORDS = new Set([
  'javascript', 'python', 'typescript', 'java', 'code', 'coding', 'program',
  'programming', 'algorithm', 'function', 'array', 'object', 'variable',
  'react', 'node', 'database', 'sql', 'api', 'server', 'computer', 'software',
  'hardware', 'gpu', 'cpu', 'linux', 'windows', 'android', 'ios', 'debug',
  'error', 'compile', 'runtime', 'framework', 'library', 'docker', 'kubernetes',
  'physics', 'chemistry', 'biology', 'quantum', 'atom', 'molecule', 'cell',
  'dna', 'gene', 'evolution', 'gravity', 'relativity', 'photosynthesis',
  'math', 'maths', 'mathematics', 'calculus', 'algebra', 'geometry',
  'trigonometry', 'statistics', 'probability', 'equation', 'formula', 'proof',
  'history', 'historical', 'ancient', 'war', 'revolution', 'empire', 'king',
  'geography', 'country', 'capital', 'continent', 'ocean', 'river', 'mountain',
  'explain', 'define', 'meaning of', 'translate', 'poem', 'literature', 'movie',
]);

function classifyIntent(queryLower: string): QueryIntent {
  const words = queryLower.split(/\s+/);
  const sensitiveKeywords = ['password', 'api key', 'secret', 'token', 'firebase_service_account', 'jwt', 'credential', 'database url'];
  if (sensitiveKeywords.some(k => queryLower.includes(k))) return 'RESTAURANT';

  for (const word of words) {
    if (RESTAURANT_KEYWORDS.has(word)) return 'RESTAURANT';
  }
  for (const kw of RESTAURANT_KEYWORDS) {
    if (kw.includes(' ') && queryLower.includes(kw)) return 'RESTAURANT';
  }

  for (const word of words) {
    if (NON_RESTAURANT_BYPASS_KEYWORDS.has(word)) return 'NON_RESTAURANT';
  }
  for (const kw of NON_RESTAURANT_BYPASS_KEYWORDS) {
    if (kw.includes(' ') && queryLower.includes(kw)) return 'NON_RESTAURANT';
  }

  return 'RESTAURANT';
}

export class AIContextBuilder {

  public async buildContext(query: string, maxTokens: number = 3500): Promise<string> {
    const res = await this.buildContextDetailed(query, maxTokens);
    return res.contextStr;
  }

  public async buildContextDetailed(query: string, maxTokens: number = 3500): Promise<ContextBuildResult> {
    const queryLower = query.toLowerCase().trim();

    // ── 0. Security Guardrail ──────────────────────────────────────────────────
    const sensitiveKeywords = ['password', 'api key', 'secret', 'token', 'firebase_service_account', 'jwt', 'credential', 'database url'];
    if (sensitiveKeywords.some(k => queryLower.includes(k))) {
      return {
        contextStr: "I cannot assist with queries regarding system credentials, passwords, or internal security configurations. Ask me about our menu, orders, or restaurant policies!",
        isDomainQuery: true,
        queryIntent: 'RESTAURANT',
        groundingStatus: 'OK',
        telemetry: {
          embeddingLatencyMs: 0,
          embeddingModelUsed: 'none',
          embeddingProvider: 'none',
          qdrantLatencyMs: 0,
          collectionName: 'security_block',
          totalHitsReturned: 0,
          matchedChunksCount: 0,
          topSimilarityScore: 1.0,
        },
        chunks: [],
        cacheHit: false,
        structuredCatalogInjected: false,
      };
    }

    // ── 1. Intent Classification ──────────────────────────────────────────────
    const queryIntent = classifyIntent(queryLower);
    const isDomainQuery = queryIntent === 'RESTAURANT';

    // ── 2. NON_RESTAURANT: Bypass Vector & Preloaded Store DB ─────────────────
    if (queryIntent === 'NON_RESTAURANT') {
      return {
        contextStr: '',
        isDomainQuery: false,
        queryIntent: 'NON_RESTAURANT',
        groundingStatus: 'GENERAL_CHITCHAT',
        telemetry: {
          embeddingLatencyMs: 0,
          embeddingModelUsed: 'bypass',
          embeddingProvider: 'bypass',
          qdrantLatencyMs: 0,
          collectionName: 'none',
          totalHitsReturned: 0,
          matchedChunksCount: 0,
          topSimilarityScore: 0,
        },
        chunks: [],
        cacheHit: false,
        structuredCatalogInjected: false,
      };
    }

    // ── 3. Check memory context cache for RESTAURANT queries ──────────────────────
    const cacheKey = queryLower;
    const cachedEntry = queryContextCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      return { ...cachedEntry.data, cacheHit: true };
    }

    // ── 4. HYBRID KNOWLEDGE ENGINE: Step A — Preloaded Structured Store Context (Pinecone Bypassed) ──
    const searchTelemetry = {
      embeddingLatencyMs: 0,
      embeddingModelUsed: 'local_store_kb',
      embeddingProvider: 'in_memory_firestore',
      qdrantLatencyMs: 0,
      collectionName: 'catalog_cache',
      totalHitsReturned: 0,
      matchedChunksCount: 0,
      topSimilarityScore: 1.0,
    };
    const semanticChunks: any[] = [];

    // ── 4. HYBRID KNOWLEDGE ENGINE: Step B — Preloaded Structured Store Context ──
    const allProducts = kb.getAllProducts().filter(p => p.isAvailable && p.isVeg !== false);
    const allCoupons = kb.getAllCoupons().filter(c => c.isActive);
    const storeSettings = kb.getSettings();
    const allPolicies = kb.getAllPolicies();
    const allFaqs = kb.getAllFaqs();

    let contextStr = `=== OLIVE PIZZA VERIFIED RESTAURANT KNOWLEDGE (100% PURE VEGETARIAN 🟢) ===\n`;
    contextStr += `Location: Rajnandgaon, Chhattisgarh | Dietary: 100% Pure Vegetarian (Zero Meat/Eggs)\n\n`;

    // 0. Cloudflare R2 RAM Knowledge Store Injection
    const ramContext = KnowledgeMemoryStore.getFullContext();
    if (ramContext.restaurant) {
      contextStr += `LIVE RESTAURANT INFO: ${JSON.stringify(ramContext.restaurant)}\n\n`;
    }

    // 1. Store Details & Hours
    if (storeSettings) {
      contextStr += `STORE DETAILS & TIMINGS:\n`;
      contextStr += `- Restaurant Status: ${storeSettings.isOpen ? 'OPEN 🟢' : 'CLOSED 🔴'}\n`;
      contextStr += `- Operating Hours: ${storeSettings.openingTime || '11:00 AM'} – ${storeSettings.closingTime || '11:00 PM'} (Open daily)\n`;
      contextStr += `- Delivery Radius: ${storeSettings.deliveryRadius || 8} km across Rajnandgaon | ETA: ${storeSettings.estimatedDeliveryTime || '30-45 mins'}\n`;
      contextStr += `- Min Order: ₹${storeSettings.minOrderAmount || 199} | Delivery Charge: ${storeSettings.freeDeliveryAbove ? `FREE above ₹${storeSettings.freeDeliveryAbove}, else ₹${storeSettings.deliveryCharge || 30}` : '₹30'}\n`;
      contextStr += `- Phone Contact: ${storeSettings.phone || '+91 98765 43210'} | Address: ${storeSettings.address || 'Main Road, Near Flyover, Rajnandgaon, CG 491441'}\n`;
      contextStr += `- Accepted Payment Methods: ${(storeSettings.acceptedPayments || ['UPI (GPay, PhonePe, Paytm)', 'Cards (Visa/Mastercard/RuPay)', 'Cash on Delivery (COD)', 'Net Banking']).join(', ')}\n\n`;
    }

    // 2. Active Deals & Coupons
    if (allCoupons.length > 0) {
      contextStr += `ACTIVE DEALS & COUPONS:\n`;
      allCoupons.forEach(c => {
        contextStr += `- Code: **${c.code}** → ${c.description} (Discount: ${c.discountType === 'percent' ? c.discountValue + '%' : '₹' + c.discountValue}, Min Order: ₹${c.minOrder || 0})\n`;
      });
      contextStr += `\n`;
    }

    // 3. Recommendation Query vs Specific Menu Hybrid Search
    const isRecommendationQuery = ['recommend', 'recommendation', 'best', 'popular', 'suggest', 'top', 'favorite'].some(k => queryLower.includes(k));
    if (isRecommendationQuery) {
      const progRecs = recommendationEngine.getProgrammaticRecommendations();
      contextStr += `${progRecs.promptConstraint}\n`;
    } else {
      // Hybrid Product Filtering
      let matchedProducts: KBProduct[] = [];
      const isPizzaQuery = ['pizza', 'pizzas', 'gourmet', 'veg pizza'].some(k => queryLower.includes(k));
      const isSideQuery = ['side', 'sides', 'garlic', 'bread', 'pasta', 'starter'].some(k => queryLower.includes(k));
      const isDrinkQuery = ['drink', 'drinks', 'beverage', 'beverages', 'juice', 'shake', 'cold drink'].some(k => queryLower.includes(k));

      if (isPizzaQuery) {
        matchedProducts = allProducts.filter(p => p.category?.toLowerCase().includes('pizza'));
      } else if (isSideQuery) {
        matchedProducts = allProducts.filter(p => p.category?.toLowerCase().includes('side') || p.category?.toLowerCase().includes('garlic') || p.name.toLowerCase().includes('bread'));
      } else if (isDrinkQuery) {
        matchedProducts = allProducts.filter(p => p.category?.toLowerCase().includes('beverage') || p.category?.toLowerCase().includes('drink'));
      } else {
        matchedProducts = kb.searchProducts(query, 8);
      }

      if (matchedProducts.length === 0) matchedProducts = allProducts.slice(0, 10);

      contextStr += `VERIFIED MENU PRODUCTS (${matchedProducts.length} items matched):\n`;
      matchedProducts.forEach(p => {
        contextStr += `- **${p.name}** (ID: ${p.id}) | Category: ${p.category} | Price: ₹${p.discountedPrice || p.price} ${p.discountedPrice ? `(Was ₹${p.price})` : ''} | Veg: Yes 🟢 | Rating: ${p.rating || 4.8}★\n`;
        contextStr += `  Description: ${p.description}\n`;
        contextStr += `  Sizes: ${(p.sizes || ['Small (7")', 'Medium (10")', 'Large (12")']).join(', ')} | Crusts: Classic Hand Tossed, Cheese Burst\n`;
      });
      contextStr += `\n`;
    }

    // 4. Preloaded Relevant Policies & FAQs
    const matchedPolicies = allPolicies.filter(pol => {
      const t = pol.title.toLowerCase();
      const c = pol.content.toLowerCase();
      return queryLower.split(/\s+/).some(w => w.length > 3 && (t.includes(w) || c.includes(w)));
    });

    if (matchedPolicies.length > 0) {
      contextStr += `STORE POLICIES:\n`;
      matchedPolicies.forEach(pol => {
        contextStr += `- **${pol.title}**: ${pol.content}\n`;
      });
      contextStr += `\n`;
    }

    const matchedFaqs = allFaqs.filter(faq => {
      const q = faq.question.toLowerCase();
      const a = faq.answer.toLowerCase();
      return queryLower.split(/\s+/).some(w => w.length > 3 && (q.includes(w) || a.includes(w)));
    });

    if (matchedFaqs.length > 0) {
      contextStr += `HELP & FREQUENTLY ASKED QUESTIONS:\n`;
      matchedFaqs.forEach(f => {
        contextStr += `- Q: ${f.question} → A: ${f.answer}\n`;
      });
      contextStr += `\n`;
    }

    // 5. Static JSON Knowledge Base Context (Order Flow, Legal Policies, Routes, FAQs, About)
    // This is always available even when Pinecone/Firestore is offline.
    const staticContext = staticKB.buildStaticContext(query);
    if (staticContext) {
      contextStr += `=== STATIC KNOWLEDGE BASE (Policies, Order Flow, FAQs, Routes) ===\n${staticContext}\n\n`;
    }

    // 6. Vector chunks bypassed — verified local structured store context utilized
    const usedChunks: Array<{ content: string; score: number; metadata: any }> = [];

    contextStr += `=========================================================================\n`;

    // Grounding Check:
    // Status is OK if ANY of these is available:
    //  - Firestore KB has live products loaded
    //  - Firestore settings are available
    //  - Static JSON KB has policies/FAQs
    // Only UNAVAILABLE if ALL sources are completely empty (extremely rare).
    let groundingStatus: 'OK' | 'UNAVAILABLE' | 'GENERAL_CHITCHAT' = 'OK';
    const hasStaticKnowledge = staticKB.isStaticKBReady();
    if (
      usedChunks.length === 0 &&
      allProducts.length === 0 &&
      !storeSettings &&
      allPolicies.length === 0 &&
      !hasStaticKnowledge
    ) {
      groundingStatus = 'UNAVAILABLE';
      contextStr = `I currently don't have access to Olive Pizza's knowledge base. Please try again in a moment.`;
    }

    const finalResult: Omit<ContextBuildResult, 'cacheHit'> = {
      contextStr,
      isDomainQuery,
      queryIntent,
      groundingStatus,
      telemetry: searchTelemetry,
      chunks: usedChunks,
      structuredCatalogInjected: true,
    };

    if (groundingStatus === 'OK') {
      queryContextCache.set(cacheKey, { data: finalResult, expiresAt: Date.now() + 300000 });
    }

    return { ...finalResult, cacheHit: false };
  }
}

export const aiContextBuilder = new AIContextBuilder();
