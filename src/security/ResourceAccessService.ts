/**
 * ResourceAccessService.ts — Authoritative Object-Level Authorization (IDOR Prevention)
 * Enforces strict ownership, franchise scoping, and branch scoping on every resource ID.
 * Prevents attackers from changing URL or body IDs to view or mutate another user's or branch's data.
 */

import { AuthenticatedSecurityUser } from './SecurityContext.js';
import { SecurityAuditService } from './SecurityAuditService.js';

export class ResourceAccessService {
  /**
   * Authorize access to a user profile or account record (IDOR Protection)
   */
  public static authorizeUserAccess(
    caller: AuthenticatedSecurityUser,
    targetUserId: string,
    route: string = '/api/users/:id'
  ): void {
    if (!caller) {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    if (caller.isGlobalOwner) return;

    if (caller.uid !== targetUserId) {
      SecurityAuditService.logSecurityEvent({
        type: 'IDOR_ATTEMPT',
        action: 'unauthorized_user_lookup',
        route,
        uid: caller.uid,
        email: caller.email,
        role: caller.role,
        targetResourceId: targetUserId,
        details: { targetUserId, callerUid: caller.uid }
      });

      const err: any = new Error('Forbidden: You do not have permission to view or modify this user account');
      err.status = 403;
      err.code = 'FORBIDDEN_IDOR';
      throw err;
    }
  }

  /**
   * Authorize access to an order record (IDOR Protection)
   */
  public static authorizeOrderAccess(
    caller: AuthenticatedSecurityUser,
    orderData: any,
    targetOrderId: string,
    route: string = '/api/orders/:id'
  ): void {
    if (!caller) {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    if (caller.isGlobalOwner) return;

    const normalizedRole = (caller.role || 'customer').toLowerCase();

    // 1. Customer: Can ONLY access their own order
    if (normalizedRole === 'customer') {
      const orderCustomerUid = orderData.customerId || orderData.userId || orderData.firebaseUid || orderData.customerFirebaseUid;
      if (orderCustomerUid !== caller.uid) {
        SecurityAuditService.logSecurityEvent({
          type: 'IDOR_ATTEMPT',
          action: 'cross_customer_order_access',
          route,
          uid: caller.uid,
          email: caller.email,
          role: caller.role,
          targetResourceId: targetOrderId,
          details: { orderCustomerUid, callerUid: caller.uid }
        });

        const err: any = new Error('Forbidden: You do not own this order');
        err.status = 403;
        err.code = 'FORBIDDEN_ORDER_ACCESS';
        throw err;
      }
      return;
    }

    // 2. Delivery Partner: Can only access orders assigned to them within their branch
    if (normalizedRole === 'delivery_partner' || normalizedRole === 'delivery') {
      const riderUid = orderData.deliveryPartnerId || orderData.deliveryPartnerFirebaseUid;
      const orderBranch = orderData.branchId || '';

      if (riderUid && riderUid !== caller.uid && riderUid !== caller.terminalId) {
        SecurityAuditService.logSecurityEvent({
          type: 'IDOR_ATTEMPT',
          action: 'cross_rider_order_access',
          route,
          uid: caller.uid,
          targetResourceId: targetOrderId,
          details: { assignedRider: riderUid, callerUid: caller.uid }
        });

        const err: any = new Error('Forbidden: This order is assigned to another delivery partner');
        err.status = 403;
        err.code = 'FORBIDDEN_RIDER_ORDER';
        throw err;
      }

      if (orderBranch && !this.isBranchAuthorized(caller, orderBranch)) {
        const err: any = new Error(`Forbidden: Order belongs to branch "${orderBranch}" outside your territory`);
        err.status = 403;
        err.code = 'FORBIDDEN_BRANCH_SCOPE';
        throw err;
      }
      return;
    }

    // 3. Branch-scoped staff (Manager, Kitchen, Cashier)
    if (caller.isBranchScoped) {
      const orderBranch = orderData.branchId || '';
      if (orderBranch && !this.isBranchAuthorized(caller, orderBranch)) {
        SecurityAuditService.logSecurityEvent({
          type: 'CROSS_BRANCH_DENIED',
          action: 'staff_cross_branch_order_access',
          route,
          uid: caller.uid,
          branchId: caller.branchId,
          targetResourceId: targetOrderId,
          details: { orderBranch, callerBranchId: caller.branchId }
        });

        const err: any = new Error(`Forbidden: Order belongs to branch "${orderBranch}" outside your authorized branch`);
        err.status = 403;
        err.code = 'FORBIDDEN_BRANCH_SCOPE';
        throw err;
      }
      return;
    }

    // 4. Franchise Owner
    if (caller.isFranchiseOwner) {
      const orderFranchise = orderData.franchiseId || '';
      if (orderFranchise && caller.franchiseId !== orderFranchise) {
        SecurityAuditService.logSecurityEvent({
          type: 'CROSS_FRANCHISE_DENIED',
          action: 'cross_franchise_order_access',
          route,
          uid: caller.uid,
          franchiseId: caller.franchiseId,
          targetResourceId: targetOrderId,
          details: { orderFranchise, callerFranchiseId: caller.franchiseId }
        });

        const err: any = new Error('Forbidden: Order belongs to a different franchise');
        err.status = 403;
        err.code = 'FORBIDDEN_FRANCHISE_SCOPE';
        throw err;
      }
    }
  }

  /**
   * Authorize access to a franchise and prevent accessing deleted/deactivated franchises
   */
  public static authorizeFranchiseAccess(
    caller: AuthenticatedSecurityUser,
    targetFranchiseId: string,
    franchiseData?: any,
    route: string = '/api/franchises/:id'
  ): void {
    if (!caller) {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    // Check deleted/suspended status
    if (franchiseData) {
      const status = String(franchiseData.status || '').toLowerCase();
      const isDeactivated = franchiseData.isActive === false || status === 'deleted' || status === 'deactivated' || status === 'suspended';
      if (isDeactivated && !caller.isGlobalOwner) {
        SecurityAuditService.logSecurityEvent({
          type: 'DELETED_FRANCHISE_ACCESS_BLOCKED',
          action: 'access_deactivated_franchise',
          route,
          uid: caller.uid,
          targetResourceId: targetFranchiseId,
          details: { franchiseStatus: status }
        });

        const err: any = new Error('Forbidden: This franchise is currently inactive or deleted');
        err.status = 403;
        err.code = 'FRANCHISE_INACTIVE';
        throw err;
      }
    }

    if (caller.isGlobalOwner) return;

    if (caller.franchiseId !== targetFranchiseId) {
      SecurityAuditService.logSecurityEvent({
        type: 'CROSS_FRANCHISE_DENIED',
        action: 'cross_franchise_tampering',
        route,
        uid: caller.uid,
        franchiseId: caller.franchiseId,
        targetResourceId: targetFranchiseId
      });

      const err: any = new Error(`Forbidden: You do not have access to franchise "${targetFranchiseId}"`);
      err.status = 403;
      err.code = 'FORBIDDEN_CROSS_FRANCHISE';
      throw err;
    }
  }

  /**
   * Authorize access to a branch
   */
  public static authorizeBranchAccess(
    caller: AuthenticatedSecurityUser,
    targetBranchId: string,
    route: string = '/api/branches/:id'
  ): void {
    if (!caller) {
      const err: any = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    if (caller.isGlobalOwner) return;

    if (!this.isBranchAuthorized(caller, targetBranchId)) {
      SecurityAuditService.logSecurityEvent({
        type: 'CROSS_BRANCH_DENIED',
        action: 'cross_branch_tampering',
        route,
        uid: caller.uid,
        branchId: caller.branchId,
        targetResourceId: targetBranchId
      });

      const err: any = new Error(`Forbidden: You do not have access to branch "${targetBranchId}"`);
      err.status = 403;
      err.code = 'FORBIDDEN_CROSS_BRANCH';
      throw err;
    }
  }

  private static isBranchAuthorized(caller: AuthenticatedSecurityUser, targetBranchId: string): boolean {
    if (caller.isGlobalOwner) return true;
    if (caller.isFranchiseOwner) {
      if (caller.branchIds && caller.branchIds.length > 0) {
        return caller.branchIds.includes(targetBranchId) || caller.branchId === targetBranchId;
      }
      return true; // Franchise owner has access to all branches within their franchise
    }
    return caller.branchIds.includes(targetBranchId) || caller.branchId === targetBranchId;
  }
}
