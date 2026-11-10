import { adminDb } from '../../config/firebase.js';
import { aiCache } from './AICacheService.js';

export class AIContextService {
  /**
   * Fetches the current menu. Utilizes 5m cache.
   */
  static async getMenuContext(): Promise<string> {
    const cached = aiCache.get<string>('menu_context');
    if (cached) return cached;

    try {
      const snapshot = await adminDb.collection('menu').where('isAvailable', '==', true).get();
      const menuItems = snapshot.docs.map(doc => doc.data());
      const context = menuItems.map(item => 
        `- ${item.name}: ₹${item.basePrice} (${item.category}, ${item.isVegetarian ? 'Veg' : 'Non-Veg'})`
      ).join('\n');

      aiCache.set('menu_context', context, 'menu');
      return context;
    } catch (e) {
      console.warn('Failed to fetch menu context for AI:', e);
      return '- Margherita: ₹299 (pizza, Veg)\n- Farmhouse: ₹399 (pizza, Veg)\n- Pepperoni: ₹499 (pizza, Non-Veg)';
    }
  }

  /**
   * Fetches active coupons. Utilizes 2m cache.
   */
  static async getCouponContext(): Promise<string> {
    const cached = aiCache.get<string>('coupon_context');
    if (cached) return cached;

    try {
      const snapshot = await adminDb.collection('coupons').where('isActive', '==', true).get();
      const coupons = snapshot.docs.map(doc => doc.data());
      const context = coupons.map(c => 
        `- CODE: ${c.code} (${c.discountType === 'percentage' ? c.discountValue + '%' : '₹' + c.discountValue} OFF. Min order: ₹${c.minOrderValue})`
      ).join('\n');

      aiCache.set('coupon_context', context, 'coupon');
      return context;
    } catch (e) {
      console.warn('Failed to fetch coupon context for AI:', e);
      return '- CODE: FIRST50 (50% OFF. Min order: ₹200)';
    }
  }

  /**
   * Fetches basic restaurant settings. Utilizes 30m cache.
   */
  static async getSettingsContext(): Promise<string> {
    const cached = aiCache.get<string>('settings_context');
    if (cached) return cached;

    try {
      const doc = await adminDb.collection('settings').doc('restaurant').get();
      if (doc.exists) {
        const d = doc.data();
        const context = `Restaurant Name: ${d?.name || 'Olive Pizza'}
Support Email: ${d?.supportEmail || 'support@olivepizza.app'}
Support Phone: ${d?.supportPhone || ''}
Delivery Radius: ${d?.deliveryRadiusKm || 5} km
Min Order: ₹${d?.minOrderAmount || 0}`;
        aiCache.set('settings_context', context, 'settings');
        return context;
      }
    } catch(e) {}
    
    return "Default Olive Pizza Settings active.";
  }

  /**
   * Unified contextual builder for standard user interactions
   */
  static async buildUserContext(userId?: string, frontendContext?: any): Promise<string> {
    const [menu, coupons, settings] = await Promise.all([
      this.getMenuContext(),
      this.getCouponContext(),
      this.getSettingsContext()
    ]);

    let userContext = '';
    if (userId) {
      // Potentially fetch recent orders / cart if userId is present.
      // Caching user context for 1 min
      const cachedUser = aiCache.get<string>(`user_${userId}`);
      if (cachedUser) {
        userContext = cachedUser;
      } else {
        try {
          const userDoc = await adminDb.collection('users').doc(userId).get();
          if (userDoc.exists) {
            userContext = `\nCustomer Name: ${userDoc.data()?.name || 'Unknown'}\nRole: ${userDoc.data()?.role || 'customer'}`;
          }
          aiCache.set(`user_${userId}`, userContext, 'user_context');
        } catch(e) {}
      }
    }

    const liveFrontendState = frontendContext ? `
=== LIVE FRONTEND STATE ===
Current Page: ${frontendContext.route}
User Role: ${frontendContext.role}
Cart Total: ₹${frontendContext.cart?.total || 0}
Cart Items: ${frontendContext.cart?.items?.length ? frontendContext.cart.items.join(', ') : 'Empty'}
` : '';

    return `
=== SYSTEM CONTEXT ===
${settings}
${liveFrontendState}
=== ACTIVE MENU ===
${menu}

=== ACTIVE COUPONS ===
${coupons}

=== CUSTOMER PROFILE ===
${userContext || 'Guest User'}
`;
  }
}
