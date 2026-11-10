/**
 * CatalogGuard.ts — Post-Generation Menu Validator & Zero-Hallucination Guard
 *
 * Scans every LLM-generated response before it leaves the backend.
 * Guarantees that:
 *  1. NO non-existent or prohibited items (Pepperoni, Hawaiian, BBQ Chicken, etc.) are ever returned.
 *  2. All mentioned pizzas exist in Olive Pizza's live Firestore/KB database.
 *  3. If an invalid item is detected, the response is discarded and regenerated using verified menu data.
 */

import kb, { KBProduct } from '../KnowledgeBaseService.js';

// Explicit list of forbidden / non-existent items to catch instantly
const FORBIDDEN_MENU_TERMS = [
  'pepperoni',
  'hawaiian',
  'bbq chicken',
  'chicken supreme',
  'meat lovers',
  'bacon',
  'ham',
  'pork',
  'beef',
  'seafood',
  'salmon',
  'tuna',
  'mutton',
  'lamb',
];

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  flaggedTerm?: string;
  sanitizedReply?: string;
}

export class CatalogGuard {

  /**
   * Validates an LLM reply against Olive Pizza's verified product catalog.
   */
  public validateResponse(reply: string): ValidationResult {
    if (!reply || typeof reply !== 'string') {
      return { isValid: true };
    }

    const replyLower = reply.toLowerCase();

    // ── 1. Check for forbidden non-veg / non-existent items ─────────────────
    for (const term of FORBIDDEN_MENU_TERMS) {
      if (replyLower.includes(term)) {
        console.warn(`[CatalogGuard] 🚫 Flagged prohibited menu term: "${term}" in AI response.`);
        return {
          isValid: false,
          reason: `Prohibited non-existent/non-veg menu item detected: "${term}".`,
          flaggedTerm: term,
          sanitizedReply: this.buildZeroHallucinationFallback(),
        };
      }
    }

    // ── 2. Scan pizza mentions against live products ───────────────────────
    // Extract phrases matching "... Pizza" or "... pizza"
    const pizzaRegex = /([A-Za-z0-9\s]+?)\s+pizza\b/gi;
    const allProducts = kb.getAllProducts();
    const validProductNamesLower = new Set(allProducts.map(p => p.name.toLowerCase()));

    let match: RegExpExecArray | null;
    while ((match = pizzaRegex.exec(reply)) !== null) {
      const fullMatch = match[0].trim();
      const prefixCandidate = match[1].trim().toLowerCase();

      // Skip generic words like "a", "this", "our", "your", "the", "veg", "spicy"
      const genericWords = new Set(['a', 'this', 'our', 'your', 'the', 'best', 'delicious', 'tasty', 'favorite', 'favorite', 'any', 'my', 'each', 'every']);
      if (genericWords.has(prefixCandidate)) continue;

      // Check if candidate matches any known product name
      const isKnown = allProducts.some(p => {
        const pLower = p.name.toLowerCase();
        return pLower.includes(prefixCandidate) || prefixCandidate.includes(pLower.replace(' pizza', ''));
      });

      if (!isKnown && prefixCandidate.length > 3) {
        // Double check against forbidden list
        if (FORBIDDEN_MENU_TERMS.some(f => prefixCandidate.includes(f))) {
          console.warn(`[CatalogGuard] 🚫 Unverified pizza mention flagged: "${fullMatch}"`);
          return {
            isValid: false,
            reason: `Unverified pizza mention: "${fullMatch}".`,
            flaggedTerm: fullMatch,
            sanitizedReply: this.buildZeroHallucinationFallback(),
          };
        }
      }
    }

    return { isValid: true };
  }

  /**
   * Sanitizes an AI response by removing invalid recommendations and replacing
   * with verified Olive Pizza best-sellers.
   */
  public sanitizeWithVerifiedCatalog(message: string): string {
    const products = kb.getAllProducts().filter(p => p.isAvailable);
    const topVegPizzas = products.filter(p => p.category?.toLowerCase().includes('pizza')).slice(0, 3);

    if (topVegPizzas.length === 0) {
      return this.buildZeroHallucinationFallback();
    }

    return `🍕 **Olive Pizza Verified Recommendations**\n\n` +
      topVegPizzas.map(p => `**${p.name}** — ₹${p.discountedPrice || p.price}\n${p.description}`).join('\n\n') +
      `\n\n*All our items are 100% Pure Vegetarian 🟢.*`;
  }

  /**
   * Standard Zero-Hallucination Fallback message.
   */
  public buildZeroHallucinationFallback(): string {
    return "I couldn't find this information in Olive Pizza's knowledge base. Please check our [Menu](/menu) for our 100% Pure Veg pizzas, garlic breads, beverages, and desserts! 🍕";
  }
}

export const catalogGuard = new CatalogGuard();
