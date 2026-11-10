import { ActionPayload, ApprovedActionType } from '../types/PageSchema.js';

export class ActionRegistry {
  private static readonly APPROVED_ACTIONS: Set<ApprovedActionType> = new Set([
    'OPEN_MENU',
    'OPEN_CART',
    'ADD_TO_CART',
    'OPEN_CHECKOUT',
    'LOGIN',
    'OPEN_OFFERS',
    'OPEN_PROFILE',
    'EXTERNAL_LINK'
  ]);

  /**
   * Validates if a given action payload is strictly permitted.
   */
  static validate(payload: any): payload is ActionPayload {
    if (!payload || typeof payload !== 'object') return false;
    
    if (!this.APPROVED_ACTIONS.has(payload.type as ApprovedActionType)) {
      return false;
    }
    
    // Additional validation for specific action types
    if (payload.type === 'EXTERNAL_LINK') {
      if (!payload.url || typeof payload.url !== 'string') return false;
      // Must be http or https
      if (!payload.url.startsWith('http://') && !payload.url.startsWith('https://')) return false;
    }
    
    if (payload.type === 'ADD_TO_CART') {
      if (!payload.productId || typeof payload.productId !== 'string') return false;
    }
    
    return true;
  }
}
