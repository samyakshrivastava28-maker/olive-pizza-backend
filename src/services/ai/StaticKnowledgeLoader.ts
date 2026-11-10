/**
 * StaticKnowledgeLoader.ts
 *
 * Loads and indexes all static JSON knowledge base files at startup.
 * Provides rich AI context for:
 *  - Legal policies (Privacy, Refund, Cancellation, Delivery, Terms, Payment)
 *  - Order flow guide (step-by-step ordering instructions)
 *  - Website routes & page descriptions
 *  - Restaurant info (About Olive Pizza)
 *  - Static FAQs (merged with live Firestore FAQs)
 *  - Menu metadata (crust types, sizes, toppings schema)
 *
 * IMPORTANT: Actual product prices, availability, and coupons come from
 * Firestore live via KnowledgeBaseService — NOT from these JSON files.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KB_DIR = join(__dirname, '../../data/knowledge_base');

function loadJson<T>(filename: string, fallback: T): T {
  try {
    const filepath = join(KB_DIR, filename);
    if (!existsSync(filepath)) {
      console.warn(`[StaticKB] File not found: ${filename}`);
      return fallback;
    }
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: any) {
    console.warn(`[StaticKB] Failed to load ${filename}:`, err.message);
    return fallback;
  }
}

// ─── Loaded Data ─────────────────────────────────────────────────────────────
let _policies: any = null;
let _orderFlow: any = null;
let _routes: any = null;
let _about: any = null;
let _faqs: any = null;
let _menuMeta: any = null;
let _isLoaded = false;

function ensureLoaded() {
  if (_isLoaded) return;
  console.log('[StaticKB] Loading static JSON knowledge base files...');
  _policies  = loadJson('legal_policies.json', { policies: [] });
  _orderFlow = loadJson('order_flow_guide.json', { order_flow: { steps: [] } });
  _routes    = loadJson('website_routes.json', { routes: [] });
  _about     = loadJson('about_olive_pizza.json', { brand: {}, delivery: {} });
  _faqs      = loadJson('faqs.json', { faqs: [] });
  _menuMeta  = loadJson('menu_catalog.json', { crust_options: [], size_options: [] });
  _isLoaded  = true;
  console.log(`[StaticKB] ✅ Loaded: ${_policies.policies?.length} policies, ${_faqs.faqs?.length} FAQs, ${_routes.routes?.length} routes`);
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

/** Find matching policy by keyword */
function findPolicy(query: string): any | null {
  ensureLoaded();
  const q = query.toLowerCase();
  const policies: any[] = _policies.policies || [];
  return policies.find((p: any) => {
    const titleWords = p.title.toLowerCase().split(' ');
    return titleWords.some((w: string) => q.includes(w)) || q.includes(p.id);
  }) || null;
}

/** Search FAQs by keyword relevance */
function searchFaqs(query: string, max = 3): any[] {
  ensureLoaded();
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter((w: string) => w.length > 2);
  const faqs: any[] = _faqs.faqs || [];
  const scored = faqs.map((faq: any) => {
    const qText = (faq.question + ' ' + faq.answer + ' ' + faq.category).toLowerCase();
    const score = words.filter((w: string) => qText.includes(w)).length;
    return { faq, score };
  });
  return scored
    .filter((s: any) => s.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, max)
    .map((s: any) => s.faq);
}

/** Find matching route by keyword */
function findRoute(query: string): any | null {
  ensureLoaded();
  const q = query.toLowerCase();
  const routes: any[] = _routes.routes || [];
  return routes.find((r: any) =>
    q.includes(r.name.toLowerCase()) ||
    r.name.toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().split(' ').some((w: string) => w.length > 3 && q.includes(w))
  ) || null;
}

/** Get full ordering guide step for a particular step or topic */
function getOrderFlowContext(query: string): string {
  ensureLoaded();
  const q = query.toLowerCase();
  const steps: any[] = _orderFlow.order_flow?.steps || [];

  // Keywords mapped to steps
  const stepKeywords: Record<string, number[]> = {
    browse:   [1], menu: [1, 2], customis: [2], customize: [2], size: [2], crust: [2], topping: [2],
    'add to cart': [3], cart: [3, 4], coupon: [5], promo: [5], discount: [5], code: [5],
    address: [6], checkout: [6, 7, 8], payment: [7], pay: [7], upi: [7], cod: [7], cash: [7],
    place: [8], confirm: [8], order: [8], track: [9], tracking: [9], deliver: [9, 6],
  };

  const matchedStepNums = new Set<number>();
  Object.entries(stepKeywords).forEach(([kw, nums]) => {
    if (q.includes(kw)) nums.forEach(n => matchedStepNums.add(n));
  });

  const matchedSteps = matchedStepNums.size > 0
    ? steps.filter((s: any) => matchedStepNums.has(s.step))
    : [];

  if (matchedSteps.length === 0) return '';

  return matchedSteps.map((s: any) => {
    let text = `ORDERING GUIDE — Step ${s.step}: ${s.title}\n${s.description}`;
    if (s.tips?.length) text += `\nTips: ${s.tips.join(' | ')}`;
    if (s.activeCoupons?.length) {
      text += `\nActive Coupons: ${s.activeCoupons.map((c: any) => `${c.code} — ${c.benefit}`).join(', ')}`;
    }
    if (s.statuses?.length) {
      text += `\nOrder Statuses: ${s.statuses.map((st: any) => `${st.emoji} ${st.status}: ${st.description}`).join(' | ')}`;
    }
    return text;
  }).join('\n\n');
}

/** Get common issue solution */
function getCommonIssueSolution(query: string): string {
  ensureLoaded();
  const q = query.toLowerCase();
  const issues: any[] = _orderFlow.common_issues || [];
  const match = issues.find((i: any) =>
    q.includes(i.issue.toLowerCase()) ||
    i.issue.toLowerCase().split(' ').some((w: string) => w.length > 3 && q.includes(w))
  );
  return match ? `Issue: ${match.issue}\nSolution: ${match.solution}` : '';
}

/** Get restaurant info and delivery coverage */
function getAboutContext(): string {
  ensureLoaded();
  const brand = _about.brand || {};
  const delivery = _about.delivery || {};
  const hours = _about.operating_hours || {};
  const dietary = _about.dietary_policy || {};

  return [
    brand.name ? `Restaurant: ${brand.name} — ${brand.tagline || ''}` : '',
    brand.dietary_commitment || '',
    brand.story ? `About: ${brand.story}` : '',
    delivery.coverage_radius_km ? `Delivery: ${delivery.coverage_radius_km} km radius around Rajnandgaon` : '',
    delivery.estimated_time_minutes ? `Delivery Time: ${delivery.estimated_time_minutes} minutes` : '',
    delivery.areas_covered?.length ? `Covered Areas: ${delivery.areas_covered.join(', ')}` : '',
    hours.days ? `Hours: ${hours.days}, ${hours.hours}` : '',
    dietary.description || '',
  ].filter(Boolean).join('\n');
}

/** Get crust and size metadata for menu context */
function getMenuMetadata(): string {
  ensureLoaded();
  const crusts: any[] = _menuMeta.crust_options || [];
  const sizes: any[] = _menuMeta.size_options || [];
  const toppings: any[] = _menuMeta.extra_toppings || [];

  let text = '';
  if (crusts.length) {
    text += `AVAILABLE CRUSTS:\n${crusts.filter((c: any) => c.available !== false).map((c: any) => `- ${c.name}${c.extraCharge ? ` (+₹${c.extraCharge})` : ' (included)'}: ${c.description}`).join('\n')}\n\n`;
  }
  if (sizes.length) {
    text += `AVAILABLE SIZES:\n${sizes.map((s: any) => `- ${s.name} (${s.inches}"): ${s.servings} — ${s.description}`).join('\n')}\n\n`;
  }
  if (toppings.length) {
    text += `EXTRA TOPPINGS AVAILABLE:\n${toppings.map((t: any) => `- ${t.name} (${t.priceRange})`).join(', ')}\n`;
  }
  return text;
}

/**
 * Main method: Build static KB context string for a given query.
 * Returns only the relevant sections — policies, FAQs, order flow, routes, about.
 */
function buildStaticContext(query: string): string {
  ensureLoaded();
  const sections: string[] = [];

  // 1. Policy match
  const policy = findPolicy(query);
  if (policy) {
    sections.push(`=== ${policy.title.toUpperCase()} ===\n${policy.content}\n\nKey Points:\n${(policy.keyPoints || []).map((p: string) => `• ${p}`).join('\n')}`);
  }

  // 2. FAQ match
  const matchedFaqs = searchFaqs(query, 3);
  if (matchedFaqs.length > 0) {
    sections.push(`FREQUENTLY ASKED QUESTIONS:\n${matchedFaqs.map((f: any) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')}`);
  }

  // 3. Order flow / how to order
  const orderFlowCtx = getOrderFlowContext(query);
  if (orderFlowCtx) {
    sections.push(orderFlowCtx);
  }

  // 4. Common issue solutions
  const issueSolution = getCommonIssueSolution(query);
  if (issueSolution) {
    sections.push(issueSolution);
  }

  // 5. Route navigation
  const q = query.toLowerCase();
  if (q.includes('where') || q.includes('how to') || q.includes('page') || q.includes('navigate') || q.includes('go to') || q.includes('open') || q.includes('route')) {
    const route = findRoute(query);
    if (route) {
      sections.push(`NAVIGATION: "${route.name}" is at ${route.path}.\n${route.description}\n${route.aiNavigation || ''}`);
    }
  }

  // 6. Menu metadata (sizes, crusts, toppings) — for customization queries
  if (q.includes('size') || q.includes('crust') || q.includes('topping') || q.includes('customis') || q.includes('customize') || q.includes('how big') || q.includes('inch')) {
    const menuMeta = getMenuMetadata();
    if (menuMeta) sections.push(menuMeta);
  }

  // 7. About restaurant — for general "about", location, delivery zone, hours queries
  if (q.includes('about') || q.includes('who are') || q.includes('where are you') || q.includes('location') || q.includes('area') || q.includes('zone') || q.includes('cover') || q.includes('story') || q.includes('opening') || q.includes('timing') || q.includes('hour')) {
    sections.push(getAboutContext());
  }

  return sections.join('\n\n---\n\n');
}

/** Check if static knowledge is loaded */
function isStaticKBReady(): boolean {
  ensureLoaded();
  return _isLoaded;
}

/** Get all static policies as array (for seeding KnowledgeBaseService) */
function getAllStaticPolicies(): Array<{ id: string; title: string; content: string }> {
  ensureLoaded();
  return (_policies.policies || []).map((p: any) => ({
    id: p.id,
    title: p.title,
    content: p.content,
  }));
}

/** Get all static FAQs as array (for seeding KnowledgeBaseService) */
function getAllStaticFaqs(): Array<{ id: string; question: string; answer: string; category?: string }> {
  ensureLoaded();
  return (_faqs.faqs || []).map((f: any) => ({
    id: f.id,
    question: f.question,
    answer: f.answer,
    category: f.category,
  }));
}

// ─── Singleton-style export ───────────────────────────────────────────────────
export const staticKB = {
  buildStaticContext,
  findPolicy,
  searchFaqs,
  findRoute,
  getOrderFlowContext,
  getAboutContext,
  getMenuMetadata,
  getAllStaticPolicies,
  getAllStaticFaqs,
  isStaticKBReady,
  /** Pre-warm the loader (call at server startup) */
  preload: () => ensureLoaded(),
};
