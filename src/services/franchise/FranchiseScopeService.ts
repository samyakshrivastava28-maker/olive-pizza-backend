import { adminDb } from '../../config/firebase.js';

export interface ScopeContext {
  organizationId: string;
  franchiseId: string;
  branchId: string;
  branchIds: string[]; // multi-branch access if assigned
  role: string;
  permissions: string[];
  terminalId?: string;       // POS terminal binding, set for cashier role
  isGlobalOwner: boolean;
  isFranchiseOwner: boolean;
  isBranchScoped: boolean;
}

/**
 * Canonical Olive Pizza roles (v2.1)
 *  1. customer           — End consumer
 *  2. platform_owner     — Highest privilege; same as 'owner'
 *  3. franchise_owner    — Cross-branch visibility within own franchise
 *  4. restaurant_manager — Branch-scoped operational management
 *  5. kitchen_staff      — Branch-scoped kitchen queue viewer
 *  6. delivery_partner   — Branch-scoped rider
 *  7. cashier            — Branch+terminal-scoped POS operator
 *  8. developer          — Treated as platform_owner for support access
 */
export const CANONICAL_ROLES = [
  'customer',
  'platform_owner',
  'franchise_owner',
  'restaurant_manager',
  'kitchen_staff',
  'delivery_partner',
  'cashier',
  'developer'
] as const;

export type CanonicalRole = typeof CANONICAL_ROLES[number];

export class FranchiseScopeService {
  public static DEFAULT_ORG_ID = 'org_olive_pizza';
  public static DEFAULT_FRANCHISE_ID = 'fra_primary';
  public static DEFAULT_BRANCH_ID = 'main_branch';

  /**
   * Resolve scope context for an authenticated user from claims and Firestore
   */
  public static resolveScope(user: any): ScopeContext {
    const role = (user?.role || 'customer').toLowerCase();

    // Global owners: platform_owner, owner (legacy alias), developer, admin (legacy alias),
    // platform_admin (legacy alias), and the two authorized internal emails.
    const isGlobalOwner = FranchiseScopeService.isGlobalOwner(user?.email, role);

    const isFranchiseOwner = role === 'franchise_owner';


    // Branch-scoped roles — cannot query across branches
    const isBranchScoped = [
      'restaurant_manager',
      'manager',       // legacy alias
      'kitchen_staff',
      'delivery_partner',
      'delivery',      // legacy alias
      'cashier'
    ].includes(role);

    const organizationId = user?.organizationId || this.DEFAULT_ORG_ID;
    const franchiseId = user?.franchiseId || (isGlobalOwner ? this.DEFAULT_FRANCHISE_ID : '');
    const branchId = user?.branchId || (isGlobalOwner ? this.DEFAULT_BRANCH_ID : '');
    const branchIds =
      user?.branchIds && Array.isArray(user.branchIds) && user.branchIds.length > 0
        ? user.branchIds
        : (branchId ? [branchId] : []);

    const permissions = user?.permissions || [];
    const terminalId = user?.terminalId;

    return {
      organizationId,
      franchiseId,
      branchId,
      branchIds,
      role,
      permissions,
      terminalId,
      isGlobalOwner,
      isFranchiseOwner,
      isBranchScoped
    };
  }

  /**
   * Check if a user's scope includes a specific permission string.
   * Global owners always return true regardless of their permissions array.
   */
  public static hasPermission(scope: ScopeContext, permission: string): boolean {
    if (!scope) return false;
    if (scope.isGlobalOwner) return true;
    return Boolean(scope.permissions && scope.permissions.includes(permission));
  }

  /**
   * Determine if a user or role/email is a global platform owner.
   */
  public static isGlobalOwner(emailOrUser?: string | any, role?: string): boolean {
    if (!emailOrUser && !role) return false;
    let userRole = '';
    if (typeof emailOrUser === 'object') {
      userRole = (emailOrUser?.role || role || '').toLowerCase();
    } else {
      userRole = (role || '').toLowerCase();
    }

    return userRole === 'platform_owner' || userRole === 'owner';
  }
  /**
   * Check if a caller is authorized to access or mutate a target branch
   */
  public static isAuthorizedForBranch(scope: ScopeContext, targetBranchId?: string): boolean {
    if (!targetBranchId || targetBranchId === 'all') {
      return false;
    }

    if (scope.isGlobalOwner) return true;
    if (scope.isFranchiseOwner) {
      if (!scope.franchiseId) return false;
      if (scope.branchIds && scope.branchIds.length > 0) {
        return scope.branchIds.includes(targetBranchId) || scope.branchId === targetBranchId;
      }
      if (scope.branchId && scope.branchId !== 'all') {
        return scope.branchId === targetBranchId;
      }
      return false;
    }

    // Branch-scoped staff must match targetBranchId explicitly (never allow wildcard 'all')
    if (scope.branchIds && scope.branchIds.length > 0) {
      return scope.branchIds.includes(targetBranchId);
    }
    return Boolean(scope.branchId && scope.branchId !== 'all' && scope.branchId === targetBranchId);
  }

  /**
   * Enforce and resolve the effective branchId for a query or mutation.
   * If caller is branch-scoped, strictly overrides any client-supplied branchId.
   */
  public static getEffectiveBranchId(scope: ScopeContext, requestedBranchId?: string): string {
    if (scope.isGlobalOwner) {
      return requestedBranchId && requestedBranchId !== 'all' ? requestedBranchId : 'all';
    }

    if (scope.isFranchiseOwner) {
      return requestedBranchId && requestedBranchId !== 'all' ? requestedBranchId : 'all';
    }

    // Branch-scoped staff CANNOT spoof another branch
    if (!scope.branchId) {
      const error: any = new Error('Access denied: Caller has no assigned branch scope');
      error.status = 403;
      throw error;
    }
    return scope.branchId;
  }

  /**
   * Asserts that a caller has access to a target branch. Throws an Error with 403 status if unauthorized.
   */
  public static assertBranchAccess(scope: ScopeContext, targetBranchId?: string): void {
    if (!targetBranchId || targetBranchId === 'all') {
      if (scope.isGlobalOwner || scope.isFranchiseOwner) return;
      const error: any = new Error('Access denied: Multi-branch access requires franchise owner or global owner privilege');
      error.status = 403;
      throw error;
    }
    if (!this.isAuthorizedForBranch(scope, targetBranchId)) {
      const error: any = new Error(`Forbidden: You are not authorized to access or modify branch "${targetBranchId}"`);
      error.status = 403;
      throw error;
    }
  }

  /**
   * Asserts that a caller has access to a target franchise. Throws an Error with 403 status if unauthorized.
   */
  public static assertFranchiseAccess(scope: ScopeContext, targetFranchiseId: string): void {
    if (scope.isGlobalOwner) return;
    if (scope.franchiseId !== targetFranchiseId) {
      const error: any = new Error(`Forbidden: Cross-franchise access denied. Your scope is restricted to "${scope.franchiseId}"`);
      error.status = 403;
      throw error;
    }
  }

  /**
   * Asserts that a caller has access to a specific order.
   */
  public static assertOrderAccess(scope: ScopeContext, orderData: any, callerUid: string): void {
    if (scope.isGlobalOwner) return;

    // Customer can only access their own order
    if (scope.role === 'customer') {
      const orderCustomerUid = orderData.userId || orderData.firebaseUid || orderData.customerFirebaseUid;
      if (orderCustomerUid && orderCustomerUid !== callerUid) {
        const error: any = new Error('Forbidden: You do not own this order');
        error.status = 403;
        throw error;
      }
      return;
    }

    // Delivery partner can only access assigned order or ready unassigned order in their branch
    if (scope.role === 'delivery_partner' || scope.role === 'delivery') {
      const riderUid = orderData.deliveryPartnerId || orderData.deliveryPartnerFirebaseUid;
      const orderBranch = orderData.branchId || this.DEFAULT_BRANCH_ID;
      if (riderUid && riderUid !== callerUid && riderUid !== scope.terminalId) {
        const error: any = new Error('Forbidden: This order is assigned to another delivery partner');
        error.status = 403;
        throw error;
      }
      if (!this.isAuthorizedForBranch(scope, orderBranch)) {
        const error: any = new Error(`Forbidden: Order belongs to branch "${orderBranch}" outside your assigned territory`);
        error.status = 403;
        throw error;
      }
      return;
    }

    // Restaurant staff / Cashier can only access orders in their branch
    if (scope.isBranchScoped) {
      const orderBranch = orderData.branchId || this.DEFAULT_BRANCH_ID;
      if (!this.isAuthorizedForBranch(scope, orderBranch)) {
        const error: any = new Error(`Forbidden: Order belongs to branch "${orderBranch}" outside your branch scope`);
        error.status = 403;
        throw error;
      }
      return;
    }

    // Franchise owner can only access orders in their franchise
    if (scope.isFranchiseOwner) {
      const orderFranchise = orderData.franchiseId || this.DEFAULT_FRANCHISE_ID;
      this.assertFranchiseAccess(scope, orderFranchise);
    }
  }

  /**
   * Log an audited franchise action
   */
  public static async logFranchiseAudit(params: {
    organizationId?: string;
    franchiseId?: string;
    branchId?: string;
    actorUid: string;
    actorEmail?: string;
    actionType: string;
    entityType: string;
    entityId?: string;
    details?: any;
  }) {
    try {
      await adminDb.collection('franchise_audit_logs').add({
        organizationId: params.organizationId || this.DEFAULT_ORG_ID,
        franchiseId: params.franchiseId || this.DEFAULT_FRANCHISE_ID,
        branchId: params.branchId || this.DEFAULT_BRANCH_ID,
        actorUid: params.actorUid,
        actorEmail: params.actorEmail || 'staff@olivepizza.in',
        actionType: params.actionType,
        entityType: params.entityType,
        entityId: params.entityId || '',
        details: params.details || {},
        timestamp: new Date().toISOString(),
        source: 'franchise_scope_service'
      });
    } catch (err) {
      console.warn('[FranchiseScopeService] Warning logging audit:', err);
    }
  }
}
