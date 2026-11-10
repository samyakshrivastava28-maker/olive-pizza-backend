/**
 * RecommendationEngine — Customer Intelligence & Role-Based Context Builder
 *
 * Builds AI context from ONLY the authenticated user's own data.
 * Uses verified JWT UID from backend — never trusts frontend UID.
 * Strict data isolation: Customer A can NEVER see Customer B data.
 */

import { adminDb } from '../../config/firebase.js';
import kb from '../KnowledgeBaseService.js';

export class RecommendationEngine {

  /**
   * Full customer intelligence context.
   * Loads: order history, favorites, preferred categories, addresses,
   * active cart, active order, loyalty points, applied coupons, recent searches.
   */
  public async getUserProfileContext(userId: string): Promise<string> {
    if (!userId) return '';

    try {
      // ── Fetch last 20 orders for this user only (strictly filtered by userId) ──
      const ordersSnap = await adminDb
        .collection('orders')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();

      // ── Fetch user profile doc (preferences, addresses, loyalty) ─────────────
      const userDoc = await adminDb.collection('users').doc(userId).get();
      const userProfile = userDoc.exists ? userDoc.data() || {} : {};

      // ── Fetch active cart ─────────────────────────────────────────────────────
      let cartContext = '';
      try {
        const cartSnap = await adminDb
          .collection('users')
          .doc(userId)
          .collection('cart')
          .get();

        if (!cartSnap.empty) {
          let cartTotal = 0;
          const cartItems = cartSnap.docs.map(d => {
            const item = d.data();
            cartTotal += (item.price || 0) * (item.quantity || 1);
            return `${item.quantity || 1}x ${item.name || 'Item'} (${item.size || 'Medium'})`;
          });
          cartContext = `
ACTIVE CART: User has ${cartSnap.size} item(s) pending in cart.
- Items: ${cartItems.join(', ')}
- Estimated Total: ₹${cartTotal.toFixed(0)}
If user asks about their cart or checkout, reference this. Remind them to complete their order.`;
        }
      } catch { /* cart collection may not exist for new users */ }

      // ── New user path ─────────────────────────────────────────────────────────
      if (ordersSnap.empty) {
        return `USER PROFILE: This is a new customer — no order history yet.
Recommended Strategy:
- Suggest popular signature items and best-sellers.
- Highlight new customer offers or first-order coupons if available.
- Encourage them to try their first order.
${cartContext}`;
      }

      // ── Build order analytics ─────────────────────────────────────────────────
      const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];

      let totalSpent = 0;
      const productCounts: Record<string, number> = {};
      const categoryCounts: Record<string, number> = {};
      const crustCounts: Record<string, number> = {};
      const sizeCounts: Record<string, number> = {};
      const addonCounts: Record<string, number> = {};
      let activeOrder: any = null;
      let lastOrderDate = '';
      let lastOrderStatus = '';
      let completedOrders = 0;
      let cancelledOrders = 0;

      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        if (i === 0) {
          lastOrderDate = o.createdAt
            ? (typeof o.createdAt.toDate === 'function'
                ? o.createdAt.toDate().toLocaleDateString('en-IN')
                : new Date(o.createdAt).toLocaleDateString('en-IN'))
            : 'Recently';
          lastOrderStatus = o.status || 'unknown';
        }

        if (['pending', 'accepted', 'preparing', 'out_for_delivery'].includes(o.status)) {
          if (!activeOrder) activeOrder = o; // Track most recent active order
        }
        if (['delivered', 'completed'].includes(o.status)) completedOrders++;
        if (o.status === 'cancelled') cancelledOrders++;

        totalSpent += o.totalAmount || 0;

        (o.items || []).forEach((item: any) => {
          const name = item.name || '';
          const category = item.category || '';
          const crust = item.crust || '';
          const size = item.size || item.variant || '';
          const addons = item.addons || [];

          if (name) productCounts[name] = (productCounts[name] || 0) + (item.quantity || 1);
          if (category) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
          if (crust) crustCounts[crust] = (crustCounts[crust] || 0) + 1;
          if (size) sizeCounts[size] = (sizeCounts[size] || 0) + 1;
          if (Array.isArray(addons)) {
            addons.forEach((a: string) => {
              addonCounts[a] = (addonCounts[a] || 0) + 1;
            });
          }
        });
      }

      const avgSpending = completedOrders > 0 ? Math.round(totalSpent / completedOrders) : 0;

      const topProducts = Object.entries(productCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
      const topCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
      const preferredCrust = Object.entries(crustCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const preferredSize = Object.entries(sizeCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const topAddons = Object.entries(addonCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);

      // ── Saved addresses ───────────────────────────────────────────────────────
      const savedAddresses: string[] = [];
      if (userProfile.addresses && Array.isArray(userProfile.addresses)) {
        userProfile.addresses.slice(0, 2).forEach((a: any) => {
          if (a.label && a.address) savedAddresses.push(`${a.label}: ${a.address}`);
          else if (a.address) savedAddresses.push(a.address);
        });
      }

      // ── Loyalty points ────────────────────────────────────────────────────────
      const loyaltyPoints = userProfile.loyaltyPoints || 0;

      // ── Recently used coupons ─────────────────────────────────────────────────
      const recentCoupons: string[] = (userProfile.usedCoupons || []).slice(0, 3);

      // ── Language preference ───────────────────────────────────────────────────
      const preferredLang = userProfile.preferredLanguage || 'en';

      // ── Build final context block ─────────────────────────────────────────────
      let context = `USER PROFILE (STRICTLY PRIVATE — ONLY FOR THIS USER's SESSION):
- Total Orders: ${orders.length} (${completedOrders} completed, ${cancelledOrders} cancelled)
- Average Order Value: ₹${avgSpending}
- Total Spent: ₹${Math.round(totalSpent)}
- Loyalty Points: ${loyaltyPoints} pts
- Last Order: ${lastOrderDate} (Status: ${lastOrderStatus})
- Favourite Items: ${topProducts.join(', ') || 'None yet'}
- Favourite Categories: ${topCategories.join(', ') || 'None yet'}
- Preferred Crust: ${preferredCrust || 'No clear preference'}
- Preferred Size: ${preferredSize || 'No clear preference'}
- Favourite Add-ons: ${topAddons.join(', ') || 'None tracked'}
- Preferred Language: ${preferredLang}
${savedAddresses.length > 0 ? `- Saved Addresses: ${savedAddresses.join(' | ')}` : ''}
${recentCoupons.length > 0 ? `- Recently Used Coupons: ${recentCoupons.join(', ')}` : ''}

PERSONALIZATION RULES:
- When asked for recommendations, suggest items matching Favourite Items & Categories.
- If user mentions a past order or asks to repeat, use the repeat_order tool.
- If loyalty points are sufficient for a reward, mention it proactively.
- Do NOT expose the numeric userId, Firestore doc IDs, or internal system data.
`;

      // ── Active order alert ────────────────────────────────────────────────────
      if (activeOrder) {
        const eta = activeOrder.estimatedDeliveryTime || '30-45 minutes';
        context += `
ACTIVE RUNNING ORDER (ALERT):
- Order ID: #${activeOrder.id.slice(0, 8).toUpperCase()}
- Status: ${activeOrder.status}
- Total: ₹${activeOrder.totalAmount || 0}
- ETA: ${eta}
If user asks about delivery or their order, reference this order. Do NOT share delivery partner's phone or internal notes.
`;
      }

      if (cartContext) {
        context += `\n${cartContext}\n`;
      }

      return context;
    } catch (err: any) {
      console.error('[RecommendationEngine] Failed to build user profile:', err.message);
      return '';
    }
  }

  /**
   * Context for Delivery Partner — shows only their assigned active deliveries.
   */
  public async getDeliveryPartnerContext(partnerId: string): Promise<string> {
    if (!partnerId) return '';
    try {
      const activeSnap = await adminDb
        .collection('orders')
        .where('deliveryPartnerId', '==', partnerId)
        .where('status', 'in', ['accepted', 'out_for_delivery'])
        .orderBy('createdAt', 'desc')
        .get();

      const deliveries = activeSnap.docs.map(d => {
        const data = d.data();
        return {
          orderId: d.id.slice(0, 8).toUpperCase(),
          customerAddress: data.deliveryAddress || 'Address pending',
          status: data.status,
          totalAmount: data.totalAmount || 0,
        };
      });

      return `DELIVERY PARTNER CONTEXT:
Active Assigned Deliveries: ${deliveries.length}
${deliveries.map((d, i) => `  ${i + 1}. Order #${d.orderId} → ${d.customerAddress} (${d.status}) — ₹${d.totalAmount}`).join('\n')}

POLICY: You may help the partner navigate, update delivery status, or understand policies.
Do NOT reveal customer phone numbers, full addresses beyond what is needed for delivery, or financial details.`;
    } catch (err) {
      return '';
    }
  }

  /**
   * Owner/Admin Context — business analytics and system health.
   */
  public async getOwnerContext(): Promise<string> {
    const stats = kb.getStats();
    let todayRevenue = 0;
    let todayOrders = 0;

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const snap = await adminDb
        .collection('orders')
        .where('createdAt', '>=', today)
        .where('status', 'in', ['delivered', 'completed', 'accepted', 'preparing', 'out_for_delivery'])
        .get();
      todayOrders = snap.size;
      snap.forEach(d => { todayRevenue += d.data().totalAmount || 0; });
    } catch { /* may fail without composite index */ }

    return `OWNER / ADMIN CONTEXT:
You are speaking to the restaurant owner/admin. Provide business-relevant insights.

Today's Live Stats:
- Orders Today: ${todayOrders}
- Revenue Today: ₹${Math.round(todayRevenue)}

Knowledge Base:
- Indexed Products: ${stats.productCount}
- Active Coupons: ${stats.couponCount}

You can help the owner with:
- Sales analytics and revenue trends
- Menu optimization suggestions
- Customer feedback analysis
- Operational insights and efficiency tips`;
  }

  /**
   * Developer Context — system diagnostics.
   */
  public getDeveloperContext(): string {
    return `DEVELOPER CONTEXT:
You are speaking to a developer with full system access.
Provide technical diagnostics, AI system status, and debugging guidance.
You may discuss:
- AI pipeline latency and model performance
- Qdrant vector database status
- Embedding provider health
- Tool execution traces
- System architecture questions`;
  }
  /**
   * Programmatic Recommendation Ranker (Phase 16).
   * Programmatically selects, ranks, and formats verified menu products from Firestore/KB.
   * The LLM is ONLY responsible for natural phrasing — NEVER for choosing products.
   */
  public getProgrammaticRecommendations(userFavorites: string[] = []): {
    rankedProducts: any[];
    promptConstraint: string;
  } {
    const allProducts = kb.getAllProducts().filter(p => p.isAvailable && p.isVeg !== false);

    if (allProducts.length === 0) {
      return {
        rankedProducts: [],
        promptConstraint: `NO PRODUCTS AVAILABLE: Tell the user that our kitchen is preparing fresh ingredients and to check back shortly.`,
      };
    }

    // Rank products: 1. User favorites, 2. Highest rating, 3. Discounted items
    const scoredProducts = allProducts.map(p => {
      let score = (p.rating || 4.5) * 10;
      if (userFavorites.includes(p.name)) score += 50; // Heavy boost for user favorites
      if (p.discountedPrice && p.discountedPrice < p.price) score += 15; // Boost offers
      if (p.category?.toLowerCase().includes('pizza')) score += 20; // Pizza priority
      return { product: p, score };
    });

    scoredProducts.sort((a, b) => b.score - a.score);
    const topRanked = scoredProducts.slice(0, 5).map(s => s.product);

    let promptConstraint = `=== PROGRAMMATICALLY VERIFIED MENU RECOMMENDATIONS (STRICT CATALOG LOCK) ===\n`;
    promptConstraint += `You MUST ONLY recommend or mention items from this exact list of verified Olive Pizza products:\n\n`;

    topRanked.forEach((p, idx) => {
      promptConstraint += `${idx + 1}. **${p.name}** (ID: ${p.id})\n`;
      promptConstraint += `   - Price: ₹${p.discountedPrice || p.price} ${p.discountedPrice ? `(Original: ₹${p.price})` : ''}\n`;
      promptConstraint += `   - Category: ${p.category} | Rating: ${p.rating || 4.8}★\n`;
      promptConstraint += `   - Description: ${p.description}\n`;
      promptConstraint += `   - Available Sizes: ${(p.sizes || ['Small', 'Medium', 'Large']).join(', ')}\n`;
      promptConstraint += `   - Available Crusts: ${(p.toppings || ['Classic Hand Tossed', 'Cheese Burst']).join(', ')}\n\n`;
    });

    promptConstraint += `CRITICAL MANDATE: You are FORBIDDEN from suggesting, naming, or inventing any other pizza or food item outside this list (e.g. NEVER mention Pepperoni, Hawaiian, BBQ Chicken, or any non-existent item).\n`;
    promptConstraint += `=========================================================================\n`;

    return {
      rankedProducts: topRanked,
      promptConstraint,
    };
  }
}

export const recommendationEngine = new RecommendationEngine();
