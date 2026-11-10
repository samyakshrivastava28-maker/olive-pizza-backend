import kb from '../KnowledgeBaseService.js';
import { adminDb } from '../../config/firebase.js';

export interface ResolvedProductContext {
  productId: string;
  name: string;
  category: string;
  basePrice: number;
  availableSizes: string[];
  availableCrusts: string[];
  availableAddons: string[];
  constraintBlock: string;
}

/**
 * Normalizes array data (whether strings or object with .name property) into string array
 */
function normalizeNames(items: any[] | undefined): string[] {
  if (!items || !Array.isArray(items)) return [];
  return items.map(item => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object' && item.name) return item.name.trim();
    return String(item);
  }).filter(Boolean);
}

/**
 * Resolves exact product details from Firestore & KnowledgeBase for strict LLM prompt constraint
 */
export async function resolveProductContext(queryText: string): Promise<{
  resolvedProducts: ResolvedProductContext[];
  strictPromptBlock: string;
}> {
  try {
    const matchedKBProducts = kb.searchProducts(queryText, 5);
    const resolvedProducts: ResolvedProductContext[] = [];

    for (const prod of matchedKBProducts) {
      let sizes = normalizeNames(prod.sizes);
      let crusts = normalizeNames(prod.toppings);
      let addons: string[] = [];

      // Try fetching latest document directly from Firestore for real-time accuracy
      try {
        const docRef = await adminDb.collection('products').doc(prod.id).get();
        if (!docRef.exists) {
          const menuDocRef = await adminDb.collection('menu_items').doc(prod.id).get();
          if (menuDocRef.exists) {
            const data = menuDocRef.data() || {};
            sizes = normalizeNames(data.variants || data.sizes || sizes);
            crusts = normalizeNames(data.crusts || data.crust_options || crusts);
            addons = normalizeNames(data.addons || []);
          }
        } else {
          const data = docRef.data() || {};
          sizes = normalizeNames(data.variants || data.sizes || sizes);
          crusts = normalizeNames(data.crusts || data.crust_options || crusts);
          addons = normalizeNames(data.addons || []);
        }
      } catch (err) {
        // Fallback to KB values if Firestore direct fetch fails
      }

      if (sizes.length === 0) sizes = ['Small', 'Medium', 'Large'];
      if (crusts.length === 0) crusts = ['Classic Hand Tossed', 'Cheese Burst', 'Thin Crust'];
      if (addons.length === 0) addons = ['Extra Cheese', 'Fresh Tomato', 'Black Olives', 'Paneer Cubes', 'Golden Corn'];

      const constraintBlock = `
=== STRICT PRODUCT CONSTRAINT FOR "${prod.name}" ===
Available Sizes: ${sizes.join(', ')}
Available Crust Options: ${crusts.join(', ')}
Available Addons / Toppings: ${addons.join(', ')}
CRITICAL RULE: Do NOT suggest, offer, or accept any sizes, crusts, or toppings outside this exact list for this item.
=====================================================`;

      resolvedProducts.push({
        productId: prod.id,
        name: prod.name,
        category: prod.category,
        basePrice: prod.discountedPrice || prod.price,
        availableSizes: sizes,
        availableCrusts: crusts,
        availableAddons: addons,
        constraintBlock,
      });
    }

    const strictPromptBlock = resolvedProducts.map(p => p.constraintBlock).join('\n');
    return { resolvedProducts, strictPromptBlock };
  } catch (error) {
    console.error('[productContextResolver] Error resolving context:', error);
    return { resolvedProducts: [], strictPromptBlock: '' };
  }
}
