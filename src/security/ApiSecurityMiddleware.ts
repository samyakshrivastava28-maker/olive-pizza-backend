/**
 * ApiSecurityMiddleware.ts — Central Security Gate & Parameter Tampering Defense
 * Validates Application Boundaries, blocks privilege escalation, strips injected claims,
 * and sanitizes error responses.
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware.js';
import { AppTarget, isUserAuthorizedForApp, AuthenticatedSecurityUser } from './SecurityContext.js';
import { SecurityAuditService } from './SecurityAuditService.js';

export class ApiSecurityMiddleware {
  /**
   * Enforces that the authenticated user has permission to access the target application API.
   * Example: enforceAppBoundary('OWNER_APP')
   * Example: enforceAppBoundary('POS_APP')
   */
  public static enforceAppBoundary(targetApp: AppTarget) {
    return (req: AuthRequest, res: Response, next: NextFunction): void => {
      const user = req.user;
      if (!user) {
        res.status(401).json({ success: false, error: 'Unauthorized: Authentication required', code: 'UNAUTHORIZED' });
        return;
      }

      const securityUser: AuthenticatedSecurityUser = {
        uid: user.uid,
        email: user.email,
        phone_number: user.phone_number,
        role: user.role,
        organizationId: user.organizationId || 'org_olive_pizza',
        franchiseId: user.franchiseId || '',
        branchId: user.branchId || '',
        branchIds: user.branchIds || (user.branchId ? [user.branchId] : []),
        permissions: user.permissions || [],
        terminalId: user.terminalId,
        isActive: user.isActive !== false,
        isGlobalOwner: Boolean(user.scope?.isGlobalOwner),
        isFranchiseOwner: Boolean(user.scope?.isFranchiseOwner),
        isBranchScoped: Boolean(user.scope?.isBranchScoped)
      };

      if (!isUserAuthorizedForApp(securityUser, targetApp)) {
        SecurityAuditService.logSecurityEvent({
          type: 'APP_ACCESS_DENIED',
          action: 'cross_app_boundary_violation',
          route: req.originalUrl,
          method: req.method,
          ip: req.ip,
          uid: user.uid,
          email: user.email,
          role: user.role,
          details: { targetApp, attemptedRoute: req.originalUrl }
        });

        res.status(403).json({
          success: false,
          error: `Forbidden: Your account does not have access to the ${targetApp} interface.`,
          code: 'FORBIDDEN_APP_BOUNDARY'
        });
        return;
      }

      next();
    };
  }

  /**
   * Defense-in-depth Parameter Tampering Filter.
   * Strips or rejects client-injected role, isAdmin, permissions, franchiseId, and branchId.
   */
  /**
   * Core parameter tampering validation and sanitization.
   * Returns true if request should proceed; returns false if response was terminated (e.g. 403 Forbidden).
   */
  public static validateAndSanitize(req: AuthRequest, res: Response): boolean {
    const user = req.user;
    if (!user) {
      return true;
    }

    const isGlobalOwner = Boolean(user.scope?.isGlobalOwner);

    // 1. Check Body for Privilege Escalation attempts & IDOR tampering
    if (req.body && typeof req.body === 'object') {
      const sensitiveKeys = ['role', 'isAdmin', 'isOwner', 'permissions', 'customClaims'];
      for (const key of sensitiveKeys) {
        if (req.body[key] !== undefined && !isGlobalOwner) {
          SecurityAuditService.logSecurityEvent({
            type: 'PRIVILEGE_ESCALATION_ATTEMPT',
            action: `injected_${key}_in_body`,
            route: req.originalUrl,
            method: req.method,
            ip: req.ip,
            uid: user.uid,
            details: { injectedField: key, value: req.body[key] }
          });

          // Strip the dangerous property
          delete req.body[key];
        }
      }

      // Customer IDOR / BOLA Prevention: Never trust client-supplied userId/customerId in body over verified token UID
      if (user.role === 'customer') {
        if (req.body.userId && req.body.userId !== user.uid) {
          SecurityAuditService.logSecurityEvent({
            type: 'IDOR_ATTEMPT',
            action: 'injected_foreign_userId_in_body',
            route: req.originalUrl,
            method: req.method,
            ip: req.ip,
            uid: user.uid,
            details: { attemptedUserId: req.body.userId, verifiedUid: user.uid }
          });
          req.body.userId = user.uid; // Enforce server-side authoritative identity
        }
        if (req.body.customerId && req.body.customerId !== user.uid) {
          SecurityAuditService.logSecurityEvent({
            type: 'IDOR_ATTEMPT',
            action: 'injected_foreign_customerId_in_body',
            route: req.originalUrl,
            method: req.method,
            ip: req.ip,
            uid: user.uid,
            details: { attemptedCustomerId: req.body.customerId, verifiedUid: user.uid }
          });
          req.body.customerId = user.uid;
        }
      }

      // Cross-Franchise Spoofing Defense
      if (req.body.franchiseId && !isGlobalOwner && user.role !== 'customer') {
        if (user.franchiseId && req.body.franchiseId !== user.franchiseId) {
          SecurityAuditService.logSecurityEvent({
            type: 'PARAMETER_TAMPERING_ATTEMPT',
            action: 'injected_foreign_franchise_id',
            route: req.originalUrl,
            method: req.method,
            ip: req.ip,
            uid: user.uid,
            franchiseId: user.franchiseId,
            details: { attemptedFranchiseId: req.body.franchiseId }
          });

          res.status(403).json({
            success: false,
            error: 'Forbidden: You cannot specify a franchiseId outside your assigned franchise scope',
            code: 'FORBIDDEN_FRANCHISE_TAMPERING'
          });
          return false;
        }
      }

      // Cross-Branch Spoofing Defense for branch-scoped staff
      if (req.body.branchId && user.scope?.isBranchScoped) {
        const authorizedBranches = user.branchIds || (user.branchId ? [user.branchId] : []);
        if (!authorizedBranches.includes(req.body.branchId)) {
          SecurityAuditService.logSecurityEvent({
            type: 'PARAMETER_TAMPERING_ATTEMPT',
            action: 'injected_foreign_branch_id',
            route: req.originalUrl,
            method: req.method,
            ip: req.ip,
            uid: user.uid,
            branchId: user.branchId,
            details: { attemptedBranchId: req.body.branchId }
          });

          res.status(403).json({
            success: false,
            error: 'Forbidden: You cannot perform operations on a branch outside your authorized scope',
            code: 'FORBIDDEN_BRANCH_TAMPERING'
          });
          return false;
        }
      }
    }

    // 2. Check Query Params for Cross-Scope Spoofing & Customer IDOR
    if (req.query && typeof req.query === 'object') {
      if (user.role === 'customer') {
        if (req.query.userId && req.query.userId !== user.uid) {
          req.query.userId = user.uid;
        }
        if (req.query.customerId && req.query.customerId !== user.uid) {
          req.query.customerId = user.uid;
        }
      }

      if (req.query.franchiseId && !isGlobalOwner && user.role !== 'customer') {
        if (user.franchiseId && req.query.franchiseId !== user.franchiseId) {
          res.status(403).json({
            success: false,
            error: 'Forbidden: Query franchiseId outside assigned scope',
            code: 'FORBIDDEN_FRANCHISE_TAMPERING'
          });
          return false;
        }
      }

      if (req.query.branchId && user.scope?.isBranchScoped) {
        const authorizedBranches = user.branchIds || (user.branchId ? [user.branchId] : []);
        if (!authorizedBranches.includes(req.query.branchId as string)) {
          res.status(403).json({
            success: false,
            error: 'Forbidden: Query branchId outside assigned scope',
            code: 'FORBIDDEN_BRANCH_TAMPERING'
          });
          return false;
        }
      }
    }

    // 3. Check Route Params for Scope Tampering
    if (req.params && typeof req.params === 'object') {
      if (req.params.franchiseId && !isGlobalOwner && user.role !== 'customer') {
        if (user.franchiseId && req.params.franchiseId !== user.franchiseId) {
          res.status(403).json({
            success: false,
            error: 'Forbidden: Route parameter franchiseId outside assigned scope',
            code: 'FORBIDDEN_FRANCHISE_TAMPERING'
          });
          return false;
        }
      }

      if (req.params.branchId && user.scope?.isBranchScoped) {
        const authorizedBranches = user.branchIds || (user.branchId ? [user.branchId] : []);
        if (!authorizedBranches.includes(req.params.branchId as string)) {
          res.status(403).json({
            success: false,
            error: 'Forbidden: Route parameter branchId outside assigned scope',
            code: 'FORBIDDEN_BRANCH_TAMPERING'
          });
          return false;
        }
      }
    }

    return true;
  }

  public static rejectParameterTampering() {
    return (req: AuthRequest, res: Response, next: NextFunction): void => {
      const ok = ApiSecurityMiddleware.validateAndSanitize(req, res);
      if (ok) next();
    };
  }

  /**
   * Production Safe Error Handler — Never exposes database stacks or sensitive server paths
   */
  public static safeErrorHandler(err: any, req: AuthRequest, res: Response, _next: NextFunction): void {
    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;

    console.error(`[API ERROR] ${req.method} ${req.originalUrl}:`, err?.message || err);

    res.status(status).json({
      success: false,
      error: isClientError ? (err.message || 'Client error') : 'Internal server error occurred. Please try again.',
      code: err.code || (isClientError ? 'CLIENT_ERROR' : 'INTERNAL_ERROR')
    });
  }
}
