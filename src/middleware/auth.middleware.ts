import { Request, Response, NextFunction } from 'express';
import { adminAuth, adminDb } from '../config/firebase.js';
import { query } from '../config/postgres.js';
import { FranchiseScopeService, ScopeContext } from '../services/franchise/FranchiseScopeService.js';
import { ApiSecurityMiddleware } from '../security/ApiSecurityMiddleware.js';
import { sanitizeError, redactSensitiveData } from '../utils/logSanitizer.js';

export async function logSecurityEventServer(params: {
  action: string;
  route: string;
  uid?: string;
  email?: string;
  role?: string;
  branchId?: string;
  ip?: string;
}) {
  try {
    const sanitizedParams = redactSensitiveData(params);
    await adminDb.collection('security_logs').add({
      ...sanitizedParams,
      timestamp: new Date().toISOString(),
      source: 'backend_api'
    });
  } catch (error) {
    const safeErr = sanitizeError(error);
    console.error('Failed to log security event on server:', safeErr.message);
  }
}

export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    email_verified?: boolean;
    phone_number?: string;
    role: string;
    organizationId?: string;
    franchiseId?: string;
    branchId?: string;
    branchIds?: string[];
    permissions?: string[];
    isActive?: boolean;
    terminalId?: string;       // POS terminal scope — populated for cashier role
    scope?: ScopeContext;
    allowedApps?: string[];
    isOwnerMode?: boolean;
    isGlobalOwner?: boolean;
    admin?: boolean;
  };
}

export const verifyToken = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  // PHASE 91: Tokens must NEVER be passed via query string (?token=...). Only Authorization: Bearer <token>.
  if (req.query && (req.query.token || req.query.idToken || req.query.access_token || req.query.auth)) {
    res.status(400).json({
      error: 'Bad Request: Passing authentication tokens in query strings is forbidden for security. Use Authorization: Bearer <token> header.',
      code: 'TOKEN_IN_QUERY_FORBIDDEN'
    });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1].trim() : undefined;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }
  try {
    // SECURITY: Always verify through Firebase Admin SDK with checkRevoked = true first.
    // When an account is replaced or revoked, revokeRefreshTokens invalidates existing tokens immediately.
    let decodedToken: any;
    try {
      decodedToken = await adminAuth.verifyIdToken(token, true);
    } catch (err: any) {
      if (err.code === 'auth/id-token-revoked' || err.message?.includes('revoked')) {
        res.status(403).json({ error: 'Forbidden: Account has been revoked', code: 'ACCOUNT_REVOKED' });
        return;
      }
      // If checkRevoked failed due to network timeout or quota exhaustion, fall back to signature verification
      try {
        decodedToken = await adminAuth.verifyIdToken(token, false);
      } catch (innerErr: any) {
        res.status(401).json({ error: 'Unauthorized: Invalid token signature', code: 'INVALID_TOKEN' });
        return;
      }
    }
    const uid = decodedToken.uid;

    if (decodedToken.role === 'REVOKED' || decodedToken.status === 'REVOKED') {
      res.status(403).json({ error: 'Forbidden: Account has been revoked', code: 'ACCOUNT_REVOKED' });
      return;
    }
    
    let role = (decodedToken.role as string) || 'customer';
    let organizationId = (decodedToken.organizationId as string) || FranchiseScopeService.DEFAULT_ORG_ID;
    let franchiseId = (decodedToken.franchiseId as string) || FranchiseScopeService.DEFAULT_FRANCHISE_ID;
    let branchId = (decodedToken.branchId as string) || FranchiseScopeService.DEFAULT_BRANCH_ID;
    let branchIds: string[] = (decodedToken.branchIds as string[]) || [branchId];
    let permissions = (decodedToken.permissions as string[]) || [];
    let isActive = true;

    // Resolve terminalId for POS cashier sessions
    let terminalId: string | undefined;

    const emailLower = decodedToken.email ? decodedToken.email.toLowerCase().trim() : '';
    let dbResolved = false;

    let allowedApps: string[] = Array.isArray(decodedToken.allowedApps) ? (decodedToken.allowedApps as string[]) : [];

    // 1. Authoritative Database Indexed Lookup (PostgreSQL app_users & delivery_partners)
    // Indexes: idx_app_users_lower_email, app_users_pkey, idx_delivery_partners_lower_email
    const phoneRaw = (decodedToken.phone_number || '').trim();
    const phoneDigits = phoneRaw.replace(/\D/g, '');
    const phoneLast10 = phoneDigits.slice(-10);

    try {
      // Deterministic Query Priority: 1. By Firebase UID
      let pgUserRes = await query(
        `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata
         FROM app_users 
         WHERE id = $1
         LIMIT 1`,
        [uid]
      );

      // 2. By Email (if not found by UID) - strictly require verified email to prevent unverified account takeover
      if (pgUserRes.rows.length === 0 && emailLower && decodedToken.email_verified === true) {
        pgUserRes = await query(
          `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata
           FROM app_users 
           WHERE email IS NOT NULL AND LOWER(email) = LOWER($1)
           LIMIT 1`,
          [emailLower]
        );
      }

      // 3. By Phone (if not found by UID or Email)
      if (pgUserRes.rows.length === 0 && phoneRaw) {
        pgUserRes = await query(
          `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata
           FROM app_users 
           WHERE phone IS NOT NULL AND (phone = $1 OR RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2)
           LIMIT 1`,
          [phoneRaw, phoneLast10]
        );
      }

      if (pgUserRes.rows.length > 0) {
        const pgUser = pgUserRes.rows[0];
        if (pgUser.is_active === false || pgUser.status === 'REVOKED' || pgUser.status === 'SUSPENDED' || pgUser.status === 'DISABLED' || pgUser.status === 'REJECTED') {
          res.status(403).json({ error: 'Forbidden: Account has been deactivated or revoked in system database', code: 'ACCOUNT_REVOKED' });
          return;
        }

        // AUTHORITATIVE: PostgreSQL allowed_apps strictly governs application access.
        // DO NOT merge with unexpired JWT claims to ensure instantaneous revocation.
        allowedApps = Array.isArray(pgUser.allowed_apps) ? [...pgUser.allowed_apps] : [];

        if (pgUser.role && pgUser.role !== 'customer') {
          role = pgUser.role;
        }
        dbResolved = true;

        if (pgUser.franchise_id) franchiseId = pgUser.franchise_id;
        if (pgUser.branch_id) branchId = pgUser.branch_id;
        branchIds = branchId ? [branchId] : branchIds;
        isActive = pgUser.is_active !== false;
      }
    } catch (pgErr: any) {
      console.error('[verifyToken] PostgreSQL app_users lookup failure (fail-closed):', pgErr.message);
      res.status(503).json({
        error: 'Service temporarily unavailable: Unable to verify authorization against authoritative database',
        code: 'AUTH_DATABASE_UNAVAILABLE'
      });
      return;
    }

        // Check delivery_partners in database if not already resolved as staff or owner
    if (!dbResolved || role === 'customer') {
      try {
        const dpRes = await query(
          `SELECT id, name, phone, email, status, is_online, branch_id, franchise_id 
           FROM delivery_partners 
           WHERE (email IS NOT NULL AND LOWER(email) = LOWER($1)) 
              OR id = $2 
              OR ($3 <> '' AND phone IS NOT NULL AND (phone = $3 OR RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $4))
           LIMIT 1`,
          [emailLower, uid, phoneRaw, phoneLast10]
        );
        if (dpRes.rows.length > 0) {
          const dp = dpRes.rows[0];
          if (dp.status === 'REVOKED' || dp.status === 'TERMINATED' || dp.status === 'DISABLED') {
            res.status(403).json({ error: 'Forbidden: Delivery partner account has been revoked', code: 'ACCOUNT_REVOKED' });
            return;
          }
          if (dp.status === 'APPROVED' || dp.is_online === true) {
            role = 'delivery_partner';
            if (dp.branch_id) branchId = dp.branch_id;
            if (dp.franchise_id) franchiseId = dp.franchise_id;
            allowedApps = Array.from(new Set([...allowedApps, 'DELIVERY']));
            dbResolved = true;
          }
        }
      } catch (dpErr: any) {
        console.error('[verifyToken] PostgreSQL delivery_partners lookup failure (fail-closed):', dpErr.message);
        res.status(503).json({
          error: 'Service temporarily unavailable: Unable to verify delivery authorization against authoritative database',
          code: 'AUTH_DATABASE_UNAVAILABLE'
        });
        return;
      }
    }

    // Fallback to Firestore only if not found in PostgreSQL database
    if (!dbResolved) {
      try {
        let userData: any = null;
        const userDoc = await adminDb.collection('users').doc(uid).get().catch(() => null);
        if (userDoc && userDoc.exists) {
          userData = userDoc.data()!;
        } else if (emailLower) {
          const q = await adminDb.collection('users').where('email', '==', emailLower).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
          if (!q.empty) {
            userData = q.docs[0].data();
          }
        }

        if (userData) {
          if (userData.isActive === false || userData.status === 'REVOKED' || userData.role === 'REVOKED' || userData.status === 'suspended') {
            res.status(403).json({ error: 'Forbidden: Account has been deactivated or revoked', code: 'ACCOUNT_REVOKED' });
            return;
          }

          const isOwnerMode = userData.isOwnerMode === true || 
                              userData.isGlobalOwner === true || 
                              userData.admin === true || 
                              (userData.role || '').toLowerCase() === 'owner' || 
                              (userData.role || '').toLowerCase() === 'platform_owner';

          if (isOwnerMode) {
            role = 'owner';
            allowedApps = Array.from(new Set(['OWNER', 'CUSTOMER', ...allowedApps]));
            permissions = ['*'];
            dbResolved = true;
          } else if (userData.role && userData.role !== 'customer') {
            role = userData.role;
            dbResolved = true;
          }

          if (Array.isArray(userData.allowedApps)) {
            allowedApps = Array.from(new Set([...allowedApps, ...userData.allowedApps]));
          }
          if (userData.applicationAccess) {
            if (userData.applicationAccess.app_pos) allowedApps.push('POS');
            if (userData.applicationAccess.app_restaurant_management) allowedApps.push('RESTAURANT_MANAGER');
            if (userData.applicationAccess.app_franchise_management) allowedApps.push('FRANCHISE_MANAGER');
            if (userData.applicationAccess.app_delivery) allowedApps.push('DELIVERY');
            allowedApps = Array.from(new Set(allowedApps));
          }

          if (userData.organizationId) organizationId = userData.organizationId;
          if (userData.franchiseId) franchiseId = userData.franchiseId;
          if (userData.branchId) branchId = userData.branchId;
          if (userData.branchIds && Array.isArray(userData.branchIds)) branchIds = userData.branchIds;
          if (userData.permissions && permissions.length === 0) permissions = userData.permissions;
          if (userData.allowedApps && Array.isArray(userData.allowedApps)) {
            allowedApps = Array.from(new Set([...allowedApps, ...userData.allowedApps]));
          }
          if (userData.isActive !== undefined) isActive = userData.isActive;
          // POS terminal binding — stored in Firestore user record for cashier role
          if (userData.terminalId) terminalId = userData.terminalId as string;
        }
      } catch (fsErr: any) {
        console.warn('[verifyToken] Firestore read fallback notice:', fsErr.message);
      }
    }

    // Secondary fallback: if user role is still 'customer' and not resolved in DB, check role-specific operational collections
    if (!dbResolved && (role === 'customer' || !role)) {
      try {
        const emailLower = decodedToken.email ? decodedToken.email.toLowerCase().trim() : '';

          // Check restaurant_managers by UID and Email fallback
          let rmData: any = null;
          const rmDoc = await adminDb.collection('restaurant_managers').doc(uid).get().catch(() => null);
          if (rmDoc && rmDoc.exists) {
            rmData = rmDoc.data();
          } else if (emailLower) {
            const rmSnap = await adminDb.collection('restaurant_managers').where('email', '==', emailLower).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
            if (!rmSnap.empty) {
              rmData = rmSnap.docs[0].data();
            }
          }

          if (rmData) {
            if (rmData.isActive === false || rmData.status === 'REVOKED' || rmData.status === 'TERMINATED') {
              res.status(403).json({ error: 'Forbidden: Restaurant manager account has been revoked', code: 'ACCOUNT_REVOKED' });
              return;
            }
            if (rmData.status === 'APPROVED' || rmData.isActive === true) {
              role = rmData.role || 'restaurant_manager';
              if (rmData.branchId) branchId = rmData.branchId;
              if (rmData.franchiseId) franchiseId = rmData.franchiseId;
              if (rmData.permissions) permissions = rmData.permissions;
              allowedApps = Array.from(new Set([...allowedApps, 'RESTAURANT_MANAGER']));
            }
          }

          // Check delivery_partners by UID and Email fallback
          if (role === 'customer' || !role) {
            let dpData: any = null;
            const dpDoc = await adminDb.collection('delivery_partners').doc(uid).get().catch(() => null);
            if (dpDoc && dpDoc.exists) {
              dpData = dpDoc.data();
            } else if (emailLower) {
              const dpSnap = await adminDb.collection('delivery_partners').where('email', '==', emailLower).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
              if (!dpSnap.empty) {
                dpData = dpSnap.docs[0].data();
              }
            }

            if (dpData) {
              if (dpData.isActive === false || dpData.status === 'REVOKED' || dpData.status === 'INACTIVE' || dpData.status === 'BLOCKED') {
                res.status(403).json({ error: 'Forbidden: Delivery partner account has been revoked or deactivated', code: 'ACCOUNT_REVOKED' });
                return;
              }
              if (dpData.status === 'approved' || dpData.status === 'APPROVED' || dpData.isActive === true) {
                role = dpData.role || 'delivery_partner';
                if (dpData.branchId) branchId = dpData.branchId;
                if (dpData.franchiseId) franchiseId = dpData.franchiseId;
                allowedApps = Array.from(new Set([...allowedApps, 'DELIVERY']));
              }
            }
          }

          // Check franchise_users by UID and Email fallback
          if (role === 'customer' || !role) {
            let fuData: any = null;
            const fuDoc = await adminDb.collection('franchise_users').doc(uid).get().catch(() => null);
            if (fuDoc && fuDoc.exists) {
              fuData = fuDoc.data();
            } else if (emailLower) {
              const fuSnap = await adminDb.collection('franchise_users').where('email', '==', emailLower).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
              if (!fuSnap.empty) {
                fuData = fuSnap.docs[0].data();
              }
            }

            if (fuData) {
              if (fuData.isActive === false || fuData.status === 'REVOKED' || fuData.status === 'SUSPENDED') {
                res.status(403).json({ error: 'Forbidden: Franchise manager account has been revoked', code: 'ACCOUNT_REVOKED' });
                return;
              }
              if (fuData.status === 'APPROVED' || fuData.isActive === true) {
                role = fuData.role || 'franchise_manager';
                if (fuData.franchiseId) franchiseId = fuData.franchiseId;
                if (fuData.branchIds) branchIds = fuData.branchIds;
                allowedApps = Array.from(new Set([...allowedApps, 'FRANCHISE_MANAGER']));
              }
            }
          }

          // Check pos_accounts by UID and Email fallback
          if (role === 'customer' || !role) {
            let posData: any = null;
            const posDoc = await adminDb.collection('pos_accounts').doc(uid).get().catch(() => null);
            if (posDoc && posDoc.exists) {
              posData = posDoc.data();
            } else if (emailLower) {
              const posSnap = await adminDb.collection('pos_accounts').where('email', '==', emailLower).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
              if (!posSnap.empty) {
                posData = posSnap.docs[0].data();
              }
            }

            if (posData) {
              if (posData.isActive === false || posData.status === 'REVOKED' || posData.status === 'DEACTIVATED' || posData.status === 'REJECTED') {
                res.status(403).json({ error: 'Forbidden: POS terminal account has been revoked', code: 'ACCOUNT_REVOKED' });
                return;
              }
              if (posData.status === 'APPROVED' || posData.status === 'ACTIVE' || posData.isActive === true) {
                role = posData.role || 'pos_operator';
                if (posData.franchiseId) franchiseId = posData.franchiseId;
                if (posData.branchId) branchId = posData.branchId;
                if (posData.terminalId) terminalId = posData.terminalId;
                allowedApps = Array.from(new Set([...allowedApps, 'POS']));
              }
            }
          }
      } catch (dbErr) {
        console.warn('[AuthMiddleware] Failed to read fallback role from Firestore:', dbErr);
      }
    }

    const scope = FranchiseScopeService.resolveScope({
      role,
      organizationId,
      franchiseId,
      branchId,
      branchIds,
      permissions,
      email: decodedToken.email
    });

    const isOwnerByRole = role === 'owner' || role === 'platform_owner';

    req.user = {
      uid,
      email: decodedToken.email,
      email_verified: decodedToken.email_verified,
      phone_number: decodedToken.phone_number,
      role,
      organizationId,
      franchiseId,
      branchId,
      branchIds,
      permissions,
      isActive,
      terminalId,
      scope,
      allowedApps,
      isOwnerMode: isOwnerByRole,
      isGlobalOwner: isOwnerByRole
    };
    
    // Immediately execute parameter tampering & privilege escalation defenses upon authentication
    const passed = ApiSecurityMiddleware.validateAndSanitize(req, res);
    if (!passed) return;

    next();
  } catch (error: any) {
    const safeErr = sanitizeError(error);
    console.error('Token verification error:', safeErr.message, safeErr.code ? `[${safeErr.code}]` : '');
    if (error?.code === 'auth/id-token-revoked' || error?.message?.includes('revoked')) {
      res.status(401).json({ error: 'Unauthorized: Token has been revoked', code: 'TOKEN_REVOKED' });
      return;
    }
    res.status(401).json({ error: 'Unauthorized: Invalid token', code: error?.code || 'INVALID_TOKEN' });
  }
};

export const requireRole = (allowedRoles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      await logSecurityEventServer({
        action: 'api_unauthorized_no_user',
        route: req.originalUrl,
        ip: req.ip
      });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    
    const userRole = req.user.role || '';
    const isOwnerOrAdminRequested = allowedRoles.includes('owner') || allowedRoles.includes('admin') || allowedRoles.includes('platform_admin');
    
    const isDeliveryEquivalent = (r: string) => r === 'delivery' || r === 'delivery_partner' || r === 'rider';
    const isManagerEquivalent = (r: string) => r === 'manager' || r === 'restaurant_manager';
    const isFranchiseOwnerEquivalent = (r: string) => r === 'franchise_owner' || r === 'franchise_manager';
    const isPosEquivalent = (r: string) => r === 'pos' || r === 'pos_operator' || r === 'cashier';

    const isOwner = userRole === 'owner' ||
                    userRole === 'platform_owner' ||
                    (req.user as any)?.isOwnerMode === true ||
                    (req.user as any)?.isGlobalOwner === true ||
                    (req.user as any)?.admin === true;

    const userAllowedApps: string[] = (req.user as any)?.allowedApps || [];
    const isAllowedByApp = allowedRoles.some(r => {
      if (['restaurant_manager', 'manager', 'kitchen_staff'].includes(r) && userAllowedApps.includes('RESTAURANT_MANAGER')) return true;
      if (['pos_operator', 'cashier', 'pos'].includes(r) && userAllowedApps.includes('POS')) return true;
      if (['franchise_manager', 'franchise_owner'].includes(r) && userAllowedApps.includes('FRANCHISE_MANAGER')) return true;
      if (['delivery_partner', 'delivery', 'rider'].includes(r) && userAllowedApps.includes('DELIVERY')) return true;
      return false;
    });

    const hasRole = (isOwner && isOwnerOrAdminRequested) ||
      isAllowedByApp ||
      allowedRoles.includes(userRole) || 
      (isDeliveryEquivalent(userRole) && allowedRoles.some(isDeliveryEquivalent)) ||
      (isManagerEquivalent(userRole) && allowedRoles.some(isManagerEquivalent)) ||
      (isFranchiseOwnerEquivalent(userRole) && allowedRoles.some(isFranchiseOwnerEquivalent)) ||
      (isPosEquivalent(userRole) && allowedRoles.some(isPosEquivalent));

    if (!hasRole) {
      await logSecurityEventServer({
         action: 'api_forbidden_insufficient_permissions',
         route: req.originalUrl,
         uid: req.user.uid,
         email: req.user.email,
         role: req.user.role,
         branchId: req.user.branchId,
         ip: req.ip
      });
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }
    next();
  };
};

export const requireApp = (requiredApp: 'OWNER' | 'RESTAURANT_MANAGER' | 'DELIVERY' | 'POS' | 'FRANCHISE_MANAGER' | 'CUSTOMER') => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required', code: 'UNAUTHORIZED' });
      return;
    }
    const allowed = Array.isArray(req.user.allowedApps) ? req.user.allowedApps : [];
    if (!allowed.includes(requiredApp)) {
      await logSecurityEventServer({
        action: 'api_forbidden_missing_app_grant',
        route: req.originalUrl,
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        branchId: req.user.branchId,
        ip: req.ip
      });
      res.status(403).json({
        error: `Forbidden: Your account does not have active access to the ${requiredApp} application.`,
        code: 'APP_ACCESS_DENIED'
      });
      return;
    }
    next();
  };
};

export const requireBranchScope = (targetBranchExtractor?: (req: AuthRequest) => string | undefined) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || !req.user.scope) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const targetBranch = targetBranchExtractor 
      ? targetBranchExtractor(req) 
      : (req.params.branchId || req.query.branchId as string || req.body?.branchId);

    const isAllowed = FranchiseScopeService.isAuthorizedForBranch(req.user.scope, targetBranch);
    if (!isAllowed) {
      await logSecurityEventServer({
        action: 'cross_branch_access_denied',
        route: req.originalUrl,
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        branchId: targetBranch,
        ip: req.ip
      });
      res.status(403).json({ error: `Forbidden: You do not have access to branch ${targetBranch}` });
      return;
    }

    next();
  };
};

export const requireAuth = verifyToken;

/**
 * requirePermission — Granular permission guard.
 * Requires the authenticated user to have ALL of the specified permission strings
 * in their resolved permissions array, OR be a global owner/developer.
 *
 * Example: requirePermission('orders.manage')
 * Example: requirePermission('pos.manage')
 */
export const requirePermission = (...requiredPerms: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const scope = req.user.scope;
    // Global owners and developers bypass granular permission checks
    if (scope?.isGlobalOwner) {
      next();
      return;
    }

    const userPerms = req.user.permissions || [];
    const missingPerms = requiredPerms.filter((p) => !userPerms.includes(p));

    if (missingPerms.length > 0) {
      await logSecurityEventServer({
        action: 'api_forbidden_missing_permission',
        route: req.originalUrl,
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        branchId: req.user.branchId,
        ip: req.ip
      });
      res.status(403).json({
        error: `Forbidden: Missing required permission(s): ${missingPerms.join(', ')}`
      });
      return;
    }

    next();
  };
};

/**
 * requireTerminalScope — POS Terminal authentication guard.
 * Ensures the cashier's authenticated session is bound to a specific terminal
 * in their authorized branch. Prevents cross-terminal and cross-branch billing abuse.
 *
 * The terminalId is resolved from the user's Firestore document during verifyToken
 * and compared against the terminalId provided in the request body.
 */
export const requireTerminalScope = () => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const scope = req.user.scope;
    // Global owners and developers can act across any terminal for support
    if (scope?.isGlobalOwner) {
      next();
      return;
    }

    const requestedTerminalId: string | undefined = req.body?.terminalId || req.headers['x-terminal-id'] as string;
    const authenticatedTerminalId = req.user.terminalId;

    if (!authenticatedTerminalId) {
      await logSecurityEventServer({
        action: 'pos_terminal_unbound_session',
        route: req.originalUrl,
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        branchId: req.user.branchId,
        ip: req.ip
      });
      res.status(403).json({
        error: 'Forbidden: Your account is not bound to a POS terminal. Contact your branch manager.'
      });
      return;
    }

    if (requestedTerminalId && requestedTerminalId !== authenticatedTerminalId) {
      await logSecurityEventServer({
        action: 'pos_terminal_scope_violation',
        route: req.originalUrl,
        uid: req.user.uid,
        email: req.user.email,
        role: req.user.role,
        branchId: req.user.branchId,
        ip: req.ip
      });
      res.status(403).json({
        error: `Forbidden: You are not authorized to operate terminal ${requestedTerminalId}.`
      });
      return;
    }

    next();
  };
};

export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  // PHASE 91: Reject tokens in query strings
  if (req.query && (req.query.token || req.query.idToken || req.query.access_token || req.query.auth)) {
    res.status(400).json({
      error: 'Bad Request: Passing authentication tokens in query strings is forbidden for security. Use Authorization: Bearer <token> header.',
      code: 'TOKEN_IN_QUERY_FORBIDDEN'
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.split('Bearer ')[1]?.trim();

  try {
    let decodedToken: any;
    try {
      decodedToken = await adminAuth.verifyIdToken(token, true);
    } catch (err: any) {
      if (err.code === 'auth/id-token-revoked' || err.message?.includes('revoked')) {
        res.status(403).json({ error: 'Forbidden: Account has been revoked', code: 'ACCOUNT_REVOKED' });
        return;
      }
      decodedToken = await adminAuth.verifyIdToken(token, false);
    }

    if (decodedToken.role === 'REVOKED' || decodedToken.status === 'REVOKED') {
      res.status(403).json({ error: 'Forbidden: Account has been revoked', code: 'ACCOUNT_REVOKED' });
      return;
    }

    const uid = decodedToken.uid;
    let role = (decodedToken.role as string) || 'customer';
    const emailLower = decodedToken.email ? decodedToken.email.toLowerCase().trim() : '';

    try {
      const pgRes = await query(
        `SELECT role, status, is_active FROM app_users WHERE id = $1 OR ($2 <> '' AND LOWER(email) = LOWER($2)) LIMIT 1`,
        [uid, emailLower]
      );
      if (pgRes.rows.length > 0) {
        const u = pgRes.rows[0];
        if (u.is_active === false || ['REVOKED', 'SUSPENDED', 'DISABLED', 'REJECTED'].includes(u.status)) {
          res.status(403).json({ error: 'Forbidden: Account has been deactivated or revoked', code: 'ACCOUNT_REVOKED' });
          return;
        }
        if (u.role && u.role !== 'customer') role = u.role;
      }
    } catch {
      // Optional auth proceeds with Firebase claims if PG check is transiently unavailable
    }

    req.user = {
      uid,
      email: decodedToken.email,
      role
    };
    next();
  } catch (error) {
    next();
  }
};
