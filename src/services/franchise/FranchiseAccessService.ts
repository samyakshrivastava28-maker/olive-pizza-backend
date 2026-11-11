import { adminDb, adminAuth } from '../../config/firebase.js';
import { FranchiseScopeService } from './FranchiseScopeService.js';
import { query } from '../../config/postgres.js';
import { withTimeout } from '../../lib/utils.js';


export interface FranchiseAccessEntry {
  franchiseId: string;
  branchId: string;
  role: string;
  applications: {
    restaurantManagement: boolean;
    franchiseManagement: boolean;
    pos: boolean;
    delivery: boolean;
  };
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  createdAt?: string;
  updatedAt: string;
}

export interface ResolveAppAuthorizationParams {
  uid: string;
  email?: string;
  phoneNumber?: string;
  emailVerified?: boolean;
  targetApp: 'POS' | 'RESTAURANT_MANAGER' | 'FRANCHISE_MANAGER' | 'DELIVERY' | 'OWNER' | 'CUSTOMER';
  requestedBranchId?: string;
  terminalId?: string;
}

export interface AppAuthorizationResult {
  authorized: boolean;
  code?: string;
  reason?: string;
  requiresPin?: boolean;
  isProfileComplete?: boolean;
  user?: {
    uid: string;
    email: string;
    name: string;
    role: string;
    branchId: string;
    branchName: string;
    branchIds: string[];
    franchiseId: string;
    terminalId?: string | null;
    permissions: string[];
    allowedApps: string[];
    applicationAccess: Record<string, boolean>;
    phone?: string;
    phoneNumber?: string;
    vehicleType?: string;
    vehicleNumber?: string;
  };
}

export class FranchiseAccessService {
  /**
   * Updates an account's franchise-scoped access across the canonical users collection
   * and role-specific operational collections (restaurant_managers, pos_accounts, franchise_users, delivery_partners).
   */
  public static async updateFranchiseAccess(params: {
    targetUserId: string;
    franchiseId: string;
    branchId?: string;
    targetRole?: string;
    applicationAccess: {
      app_restaurant_management?: boolean;
      app_franchise_management?: boolean;
      app_pos?: boolean;
      app_delivery?: boolean;
    };
    accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    permissions?: string[];
    actorUid: string;
    actorEmail: string;
  }): Promise<{ success: boolean; message: string; accessEntry: FranchiseAccessEntry }> {
    const {
      targetUserId,
      franchiseId,
      branchId,
      targetRole = 'staff',
      applicationAccess,
      accountStatus = 'ACTIVE',
      permissions = [],
      actorUid,
      actorEmail
    } = params;

    const now = new Date().toISOString();
    if (!adminDb) throw new Error('Database service unavailable');

    // 1. Resolve user email and UID
    let email = targetUserId.includes('@') ? targetUserId.toLowerCase().trim() : '';
    let targetUid = targetUserId;

    const pgLookup = await query(
      `SELECT id, firebase_uid, email, name, phone, role, branch_id, franchise_id, metadata
       FROM app_users
       WHERE id = $1 OR firebase_uid = $1 OR ($2 <> '' AND LOWER(email) = LOWER($2))
       LIMIT 1`,
      [targetUserId, email]
    ).catch(() => ({ rows: [] as any[] }));
    const pgExisting = pgLookup.rows[0] || null;
    if (pgExisting?.email && !email) email = String(pgExisting.email).toLowerCase().trim();
    if (pgExisting?.firebase_uid && targetUserId.includes('@')) targetUid = pgExisting.firebase_uid;

    let userDocRef = adminDb.collection('users').doc(targetUid);
    let userDocSnap: any = await withTimeout(userDocRef.get(), 'access.userDocRead', 1200).catch(() => ({ exists: false, data: () => ({}) }));

    if (userDocSnap.exists) {
      email = (userDocSnap.data()?.email || email || '').toLowerCase().trim();
    } else {
      if (targetUserId.includes('@')) {
        email = targetUserId.toLowerCase().trim();
        const q = await withTimeout(adminDb.collection('users').where('email', '==', email).limit(1).get(), 'access.userEmailRead', 1200).catch(() => ({ empty: true, docs: [] }));
        if (!q.empty) {
          userDocRef = adminDb.collection('users').doc(q.docs[0].id);
          userDocSnap = q.docs[0];
          targetUid = q.docs[0].id;
        } else if (adminAuth) {
          const authUser = await withTimeout(adminAuth.getUserByEmail(email), 'access.authByEmail', 1200).catch(() => null);
          if (authUser) {
            targetUid = authUser.uid;
            userDocRef = adminDb.collection('users').doc(targetUid);
            userDocSnap = await withTimeout(userDocRef.get(), 'access.authUserDocRead', 1200).catch(() => ({ exists: false, data: () => ({}) }));
          }
        }
      } else {
        const rmDoc = await withTimeout(adminDb.collection('restaurant_managers').doc(targetUserId).get(), 'access.rmRead', 1000).catch(() => ({ exists: false, data: () => ({}) }));
        if (rmDoc.exists && rmDoc.data()?.email) {
          email = (rmDoc.data()?.email || '').toLowerCase().trim();
        } else {
          const posDoc = await withTimeout(adminDb.collection('pos_accounts').doc(targetUserId).get(), 'access.posRead', 1000).catch(() => ({ exists: false, data: () => ({}) }));
          if (posDoc.exists && posDoc.data()?.email) {
            email = (posDoc.data()?.email || '').toLowerCase().trim();
          }
        }
      }
    }

    if (!email && adminAuth && !targetUid.includes('@')) {
      const authUser = await withTimeout(adminAuth.getUser(targetUid), 'access.authByUid', 1200).catch(() => null);
      if (authUser?.email) {
        email = authUser.email.toLowerCase().trim();
      }
    }

    if (userDocSnap.exists && !email && userDocSnap.data()?.email) {
      email = (userDocSnap.data()?.email || '').toLowerCase().trim();
    }

    let effectiveBranchId = branchId || pgExisting?.branch_id || (userDocSnap.exists ? userDocSnap.data()?.branchId : undefined);
    if (!effectiveBranchId) {
      if (franchiseId === 'fra_rajnandgaon' || franchiseId === 'fra_primary') {
        effectiveBranchId = 'main_branch';
      } else {
        throw new Error(`Explicit branchId is required for franchise '${franchiseId}'`);
      }
    }

    const isOwnerRole = targetRole === 'owner' || targetRole === 'platform_owner';
    const accessEntry: FranchiseAccessEntry = {
      franchiseId,
      branchId: effectiveBranchId,
      role: targetRole,
      applications: isOwnerRole
        ? { restaurantManagement: false, franchiseManagement: false, pos: false, delivery: false }
        : {
            restaurantManagement: Boolean(applicationAccess.app_restaurant_management),
            franchiseManagement: Boolean(applicationAccess.app_franchise_management),
            pos: Boolean(applicationAccess.app_pos),
            delivery: Boolean(applicationAccess.app_delivery)
          },
      status: accountStatus,
      updatedAt: now
    };

    const allowedApps: string[] = [];
    if (isOwnerRole) {
      allowedApps.push('OWNER');
    } else {
      if (accessEntry.applications.franchiseManagement) allowedApps.push('FRANCHISE_MANAGER');
      if (accessEntry.applications.restaurantManagement) allowedApps.push('RESTAURANT_MANAGER');
      if (accessEntry.applications.pos) allowedApps.push('POS');
      if (accessEntry.applications.delivery) allowedApps.push('DELIVERY');
    }

    if (!isOwnerRole && accountStatus === 'ACTIVE' && allowedApps.length > 1) {
      const err: any = new Error(
        `Single-app isolation violation: an account cannot hold multiple operational applications simultaneously (${allowedApps.join(', ')}).`
      );
      err.statusCode = 400;
      throw err;
    }

    // 1. Authoritative PostgreSQL persistence FIRST (resilient even when Firestore quota is exhausted)
    const allowedAppsJson = JSON.stringify(allowedApps);
    const existingMeta = (pgExisting?.metadata && typeof pgExisting.metadata === 'object') ? { ...pgExisting.metadata } : {};
    if (accessEntry.applications.pos && accountStatus === 'ACTIVE') {
      const termList = Array.isArray(existingMeta.allowed_terminals) && existingMeta.allowed_terminals.length > 0
        ? existingMeta.allowed_terminals
        : [ (userDocSnap.exists ? userDocSnap.data()?.terminalId : null) || 'POS-01' ];
      existingMeta.allowed_terminals = termList;
      existingMeta.terminalId = termList[0];
    }

    await query(
      `INSERT INTO app_users (id, firebase_uid, email, name, phone, role, status, franchise_id, branch_id, allowed_apps, metadata, is_active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         firebase_uid = COALESCE(EXCLUDED.firebase_uid, app_users.firebase_uid),
         email = COALESCE(EXCLUDED.email, app_users.email),
         name = COALESCE(EXCLUDED.name, app_users.name),
         phone = COALESCE(EXCLUDED.phone, app_users.phone),
         role = EXCLUDED.role,
         status = EXCLUDED.status,
         franchise_id = EXCLUDED.franchise_id,
         branch_id = EXCLUDED.branch_id,
         allowed_apps = EXCLUDED.allowed_apps,
         metadata = EXCLUDED.metadata,
         is_active = EXCLUDED.is_active,
         updated_at = NOW()`,
      [
        targetUid,
        targetUid && !targetUid.includes('@') ? targetUid : null,
        email || null,
        pgExisting?.name || (userDocSnap.exists ? (userDocSnap.data()?.name || userDocSnap.data()?.displayName) : null) || (email ? email.split('@')[0] : 'Staff User'),
        pgExisting?.phone || (userDocSnap.exists ? (userDocSnap.data()?.phone || userDocSnap.data()?.phoneNumber) : null) || null,
        targetRole,
        accountStatus === 'ACTIVE' ? 'APPROVED' : 'DISABLED',
        franchiseId,
        effectiveBranchId,
        allowedAppsJson,
        JSON.stringify(existingMeta),
        accountStatus === 'ACTIVE'
      ]
    );
    if (email) {
      await query(
        `UPDATE app_users
         SET role = $2, status = $3, franchise_id = $4, branch_id = $5, allowed_apps = $6::jsonb, metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb, is_active = $8, updated_at = NOW()
         WHERE email IS NOT NULL AND LOWER(email) = LOWER($1) AND id <> $9`,
        [
          email,
          targetRole,
          accountStatus === 'ACTIVE' ? 'APPROVED' : 'DISABLED',
          franchiseId,
          effectiveBranchId,
          allowedAppsJson,
          JSON.stringify(existingMeta),
          accountStatus === 'ACTIVE',
          targetUid
        ]
      ).catch(() => {});
    }

    if (accessEntry.applications.delivery && accountStatus === 'ACTIVE') {
      await query(
        `INSERT INTO delivery_partners (id, user_id, name, email, phone, status, is_online, branch_id, franchise_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'APPROVED', true, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           user_id = COALESCE(EXCLUDED.user_id, delivery_partners.user_id),
           email = COALESCE(EXCLUDED.email, delivery_partners.email),
           status = 'APPROVED',
           branch_id = EXCLUDED.branch_id,
           franchise_id = EXCLUDED.franchise_id,
           updated_at = NOW()`,
        [
          targetUid,
          targetUid && !targetUid.includes('@') ? targetUid : null,
          pgExisting?.name || (userDocSnap.exists ? (userDocSnap.data()?.name || userDocSnap.data()?.displayName) : null) || 'Delivery Partner',
          email || null,
          pgExisting?.phone || (userDocSnap.exists ? (userDocSnap.data()?.phone || userDocSnap.data()?.phoneNumber) : null) || null,
          effectiveBranchId,
          franchiseId
        ]
      ).catch((dpPgErr: any) => console.warn('[FranchiseAccessService] delivery_partners sync notice:', dpPgErr.message));
    } else {
      await query(
        `UPDATE delivery_partners SET status = 'DISABLED', is_online = false, updated_at = NOW() WHERE id = $1 OR user_id = $1`,
        [targetUid]
      ).catch(() => {});
    }

    // 2. Best-effort Firestore synchronization (bounded timeouts)
    const existingFranchiseAccess: FranchiseAccessEntry[] = (userDocSnap.exists && Array.isArray(userDocSnap.data()?.franchiseAccess))
      ? userDocSnap.data()?.franchiseAccess
      : [];

    const otherAccess = existingFranchiseAccess.filter(fa => fa.franchiseId !== franchiseId);
    otherAccess.push(accessEntry);

    const userUpdates: Record<string, any> = {
      role: targetRole,
      status: accountStatus,
      isActive: accountStatus === 'ACTIVE',
      branchId: effectiveBranchId,
      franchiseId,
      allowedApps,
      applicationAccess: {
        app_restaurant_management: accessEntry.applications.restaurantManagement,
        app_franchise_management: accessEntry.applications.franchiseManagement,
        app_pos: accessEntry.applications.pos,
        app_delivery: accessEntry.applications.delivery
      },
      franchiseAccess: otherAccess,
      permissions: permissions.length > 0 ? permissions : (userDocSnap.exists ? userDocSnap.data()?.permissions : []),
      updatedAt: now,
      updatedBy: actorEmail || actorUid
    };

    if (email) userUpdates.email = email;
    if (accountStatus === 'ACTIVE') {
      userUpdates.status = 'ACTIVE';
      userUpdates.isActive = true;
      userUpdates.role = targetRole;
      userUpdates.branchId = effectiveBranchId;
      userUpdates.franchiseId = franchiseId;
      if (accessEntry.applications.pos) {
        userUpdates.terminalId = (userDocSnap.exists ? userDocSnap.data()?.terminalId : null) || 'POS-01';
      }
    } else {
      userUpdates.status = accountStatus;
      userUpdates.isActive = false;
    }

    await withTimeout(userDocRef.set(userUpdates, { merge: true }), 'access.userDocWrite', 1200).catch(() => {});

    // 3. Synchronize operational collections (bounded)
    const rmDocRef = adminDb.collection('restaurant_managers').doc(targetUid);
    if (accessEntry.applications.restaurantManagement && accountStatus === 'ACTIVE') {
      await withTimeout(rmDocRef.set({
        id: targetUid,
        email,
        role: 'restaurant_manager',
        branchId: effectiveBranchId,
        franchiseId,
        status: 'APPROVED',
        isActive: true,
        permissions: permissions.length > 0 ? permissions : ['dashboard.view', 'orders.live', 'orders.history', 'inventory.view', 'notifications.send', 'delivery.view'],
        updatedAt: now
      }, { merge: true }), 'access.rmWrite', 1000).catch(() => {});
    } else {
      await withTimeout(rmDocRef.set({
        isActive: false,
        status: accountStatus === 'ACTIVE' ? 'REVOKED' : accountStatus,
        updatedAt: now
      }, { merge: true }), 'access.rmRevokeWrite', 1000).catch(() => {});
    }

    // 4. Synchronize to pos_accounts collection
    const posDocRef = adminDb.collection('pos_accounts').doc(targetUid);
    if (accessEntry.applications.pos && accountStatus === 'ACTIVE') {
      await withTimeout(posDocRef.set({
        id: targetUid,
        email,
        franchiseId,
        branchId: effectiveBranchId,
        status: 'APPROVED',
        isActive: true,
        updatedAt: now
      }, { merge: true }), 'access.posWrite', 1000).catch(() => {});
    } else {
      await withTimeout(posDocRef.set({
        isActive: false,
        status: 'REVOKED',
        updatedAt: now
      }, { merge: true }), 'access.posRevokeWrite', 1000).catch(() => {});
    }

    // 5. Synchronize to franchise_users collection
    const fuDocRef = adminDb.collection('franchise_users').doc(targetUid);
    if (accessEntry.applications.franchiseManagement && accountStatus === 'ACTIVE') {
      await withTimeout(fuDocRef.set({
        id: targetUid,
        email,
        franchiseId,
        role: targetRole === 'franchise_owner' ? 'franchise_owner' : 'franchise_manager',
        status: 'APPROVED',
        isActive: true,
        updatedAt: now
      }, { merge: true }), 'access.fuWrite', 1000).catch(() => {});
    } else {
      await withTimeout(fuDocRef.set({
        isActive: false,
        status: 'DEACTIVATED',
        updatedAt: now
      }, { merge: true }), 'access.fuRevokeWrite', 1000).catch(() => {});
    }

    // 6. Synchronize to delivery_partners collection
    const dpDocRef = adminDb.collection('delivery_partners').doc(targetUid);
    if (accessEntry.applications.delivery && accountStatus === 'ACTIVE') {
      await withTimeout(dpDocRef.set({
        id: targetUid,
        email,
        franchiseId,
        branchId: effectiveBranchId,
        status: 'approved',
        isActive: true,
        updatedAt: now
      }, { merge: true }), 'access.dpWrite', 1000).catch(() => {});
    } else {
      await withTimeout(dpDocRef.set({
        isActive: false,
        status: 'suspended',
        updatedAt: now
      }, { merge: true }), 'access.dpRevokeWrite', 1000).catch(() => {});
    }

    // 7. Synchronize Firebase Auth custom claims (bounded)
    if (accountStatus !== 'ACTIVE' || allowedApps.length === 0) {
      if (adminAuth && targetUid && !targetUid.includes('@')) {
        await withTimeout(adminAuth.revokeRefreshTokens(targetUid), 'access.revokeTokens', 1200).catch(() => {});
      }
    } else if (adminAuth && targetUid && !targetUid.includes('@')) {
      try {
        await withTimeout(adminAuth.setCustomUserClaims(targetUid, {
          role: targetRole,
          allowedApps,
          branchId: effectiveBranchId,
          franchiseId,
          isOwnerMode: isOwnerRole,
          admin: isOwnerRole || targetRole === 'admin',
          permissions: permissions.length > 0 ? permissions : ['*']
        }), 'access.setClaims', 1200);
      } catch (claimsErr: any) {
        console.warn('[FranchiseAccessService] Error setting custom claims:', claimsErr.message);
      }
    }

    // 8. Audit log (best-effort)
    await withTimeout(FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId,
      branchId: effectiveBranchId,
      actorUid,
      actorEmail,
      actionType: 'FRANCHISE_ACCESS_UPDATED',
      entityType: 'user_franchise_access',
      entityId: targetUid,
      details: {
        email,
        accessEntry,
        allowedApps,
        accountStatus
      }
    }), 'access.auditLog', 1000).catch(() => {});

    return {
      success: true,
      message: 'Franchise access synchronized successfully across all operational systems',
      accessEntry
    };
  }

  /**
   * Authoritative multi-app authorization resolver
   * Checks platform owner, canonical franchiseAccess, franchises document assignment,
   * subcollections, and ensures franchise status is not deleted.
   */
  public static async resolveAuthorization(
    params: ResolveAppAuthorizationParams
  ): Promise<AppAuthorizationResult> {
    const { uid, email, phoneNumber, emailVerified, targetApp, requestedBranchId, terminalId } = params;
    const emailLower = (email || '').toLowerCase().trim();

    // ── STAGE 1: POSTGRESQL ACCOUNT CONFIRMATION (Authoritative Identity & Lifecycle) ──
    const phoneRaw = (phoneNumber || '').trim();
    const phoneDigits = phoneRaw.replace(/\D/g, '');
    const phoneLast10 = phoneDigits.slice(-10);

    let pgUserData: any = null;

    try {
      // 1. Primary Deterministic Lookup by verified Firebase UID
      const uidRes = await query(
        `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata, created_at, updated_at
         FROM app_users
         WHERE id = $1
         LIMIT 1`,
        [uid]
      );

      if (uidRes.rows.length > 0) {
        pgUserData = uidRes.rows[0];
      } else {
        // 2. UID lookup yielded 0 rows -> Ambiguity and Conflict Detection
        const unlinkedRes = await query(
          `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata
           FROM app_users
           WHERE (email IS NOT NULL AND email <> '' AND LOWER(email) = LOWER($1))
              OR ($2 <> '' AND phone IS NOT NULL AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $3)`,
          [emailLower, phoneRaw, phoneLast10]
        );

        if (unlinkedRes.rows.length > 1) {
          // Multiple records share contact info -> Fail closed immediately (No role ranking!)
          console.warn(`[FranchiseAccessService] Security Alert: Ambiguous identity conflict for email "${emailLower}" / phone "${phoneRaw}". Matching accounts: ${unlinkedRes.rows.map(r => r.id).join(', ')}`);
          return {
            authorized: false,
            code: 'IDENTITY_CONFLICT_AMBIGUOUS',
            reason: 'Multiple accounts detected matching this email/phone. Explicit administrative account linking is required.'
          };
        } else if (unlinkedRes.rows.length === 1) {
          // Exactly 1 unlinked legacy account exists -> Explicit linking required
          return {
            authorized: false,
            code: 'ACCOUNT_LINKING_REQUIRED',
            reason: 'Account exists under a legacy identifier. Explicit cryptographic identity linking to this Firebase UID is required.'
          };
        } else {
          // 0 matching records found
          if (targetApp === 'CUSTOMER') {
            // Idempotent safe customer auto-registration (Insert-Only: ON CONFLICT (id) DO NOTHING)
            try {
              await query(
                `INSERT INTO app_users (
                   id, email, phone, name, role, status, is_active, allowed_apps, created_at, updated_at
                 ) VALUES (
                   $1, $2, $3, $4, 'customer', 'APPROVED', true, '["CUSTOMER"]'::jsonb, NOW(), NOW()
                 )
                 ON CONFLICT (id) DO NOTHING`,
                [uid, emailLower || null, phoneRaw || null, emailLower ? emailLower.split('@')[0] : 'Customer']
              );

              const newCustRes = await query(
                `SELECT id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, metadata
                 FROM app_users
                 WHERE id = $1
                 LIMIT 1`,
                [uid]
              );
              if (newCustRes.rows.length > 0) {
                pgUserData = newCustRes.rows[0];
              }
            } catch (custInsertErr: any) {
              console.error('[FranchiseAccessService] Customer insert-only registration error:', custInsertErr.message);
              return {
                authorized: false,
                code: 'DATABASE_UNAVAILABLE',
                reason: 'Failed to provision customer profile in authoritative database'
              };
            }
          } else {
            // Management apps: Strict fail-closed. Unregistered accounts cannot access staff portals.
            return {
              authorized: false,
              code: 'NOT_REGISTERED',
              reason: `Account is not registered for ${targetApp} in the authoritative system database. Please contact your administrator.`
            };
          }
        }
      }
    } catch (pgErr: any) {
      console.error('[FranchiseAccessService] PostgreSQL Stage 1 lookup failure (fail-closed):', pgErr.message);
      return {
        authorized: false,
        code: 'DATABASE_UNAVAILABLE',
        reason: 'Authoritative database temporarily unavailable'
      };
    }

    if (!pgUserData) {
      return {
        authorized: false,
        code: 'NOT_REGISTERED',
        reason: `Account is not registered for ${targetApp} in the authoritative system database.`
      };
    }

    // 3. Stage 1 Lifecycle Status Evaluation
    if (pgUserData.status === 'PENDING_APPROVAL') {
      return {
        authorized: false,
        code: 'ACCOUNT_PENDING_APPROVAL',
        reason: 'Your account is pending administrator approval.'
      };
    }

    if (pgUserData.status === 'REJECTED') {
      return {
        authorized: false,
        code: 'ACCOUNT_REJECTED',
        reason: 'Your account request was rejected by administration.'
      };
    }

    if (pgUserData.is_active === false || ['REVOKED', 'SUSPENDED', 'DISABLED'].includes(pgUserData.status)) {
      return {
        authorized: false,
        code: 'ACCOUNT_REVOKED',
        reason: 'Account has been deactivated or revoked in system database.'
      };
    }

    // ── STAGE 2: APPLICATION AUTHORIZATION (Role, App Grants & Operational Scope) ──
    const userRole = (pgUserData.role || '').toLowerCase();
    const isOwner = userRole === 'owner' || userRole === 'platform_owner';

    let allowedApps: string[] = [];
    if (Array.isArray(pgUserData.allowed_apps)) {
      allowedApps = pgUserData.allowed_apps;
    } else if (typeof pgUserData.allowed_apps === 'string') {
      try {
        const parsed = JSON.parse(pgUserData.allowed_apps);
        if (Array.isArray(parsed)) allowedApps = parsed;
      } catch {}
    }

    let metadataObj: any = pgUserData.metadata || {};
    if (typeof metadataObj === 'string') {
      try {
        metadataObj = JSON.parse(metadataObj);
      } catch {
        metadataObj = {};
      }
    }

    // A. OWNER Application Authorization
    if (targetApp === 'OWNER') {
      if (!isOwner) {
        return {
          authorized: false,
          code: 'ACCESS_DENIED',
          reason: 'This account is not authorized to access the Olive Pizza Owner Command Center.'
        };
      }

      const hasOwnerGrant = allowedApps.some(a => (a || '').toString().trim().toUpperCase() === 'OWNER');
      if (!hasOwnerGrant) {
        return {
          authorized: false,
          code: 'APP_ACCESS_DENIED',
          reason: 'Account possesses owner role but lacks an explicit OWNER grant in allowed_apps.'
        };
      }

      if (isOwner) {
        return {
          authorized: true,
          requiresPin: false,
          isProfileComplete: true,
          user: {
            uid: pgUserData.id || uid,
            email: pgUserData.email || emailLower,
            name: pgUserData.name || 'Olive Pizza Owner',
            role: 'owner',
            phone: pgUserData.phone || '',
            phoneNumber: pgUserData.phone || '',
            branchId: pgUserData.branch_id || 'main_branch',
            branchName: 'Olive Pizza',
            branchIds: ['all'],
            franchiseId: pgUserData.franchise_id || 'fra_rajnandgaon',
            terminalId: terminalId || undefined,
            permissions: ['*'],
            allowedApps: ['OWNER'],
            applicationAccess: {
              app_restaurant_management: false,
              app_delivery: false,
              app_pos: false,
              app_franchise_management: false,
              app_owner: true
            }
          }
        };
      } else {
        return {
          authorized: false,
          code: 'ACCESS_DENIED',
          reason: 'This account is not authorized to access the Olive Pizza Owner Command Center.'
        };
      }
    }

    // B. Customer Application Authorization
    if (targetApp === 'CUSTOMER') {
      return {
        authorized: true,
        requiresPin: false,
        isProfileComplete: true,
        user: {
          uid: pgUserData.id || uid,
          email: pgUserData.email || emailLower,
          name: pgUserData.name || (emailLower ? emailLower.split('@')[0] : 'Customer'),
          role: 'customer',
          branchId: requestedBranchId || 'main_branch',
          branchName: 'Olive Pizza',
          branchIds: ['main_branch'],
          franchiseId: 'fra_rajnandgaon',
          permissions: ['customer.order'],
          allowedApps: ['CUSTOMER'],
          applicationAccess: {}
        }
      };
    }

    // C. Management Apps (POS, RESTAURANT_MANAGER, FRANCHISE_MANAGER, DELIVERY)
    // Rule: Owner role grants OWNER only. Access to operational apps requires an explicit grant in allowed_apps!
    const isPosStaff = ['pos_operator', 'cashier'].includes(userRole);
    const isManagerStaff = ['restaurant_manager', 'store_manager'].includes(userRole);
    const isFranchiseStaff = ['franchise_manager', 'franchise_owner'].includes(userRole);
    const isDeliveryStaff = ['delivery_partner', 'delivery'].includes(userRole);

    const hasExplicitAppGrant = allowedApps.some(a => (a || '').toString().trim().toUpperCase() === targetApp.toUpperCase());

    const hasAppAccess =
      hasExplicitAppGrant ||
      (targetApp === 'POS' && isPosStaff) ||
      (targetApp === 'RESTAURANT_MANAGER' && isManagerStaff) ||
      (targetApp === 'FRANCHISE_MANAGER' && isFranchiseStaff) ||
      (targetApp === 'DELIVERY' && isDeliveryStaff);

    if (!hasAppAccess) {
      if (isOwner) {
        return {
          authorized: false,
          code: 'STAFF_GRANT_REQUIRED',
          reason: `Platform owner account requires an explicit staff grant and branch scope to access the ${targetApp} application.`
        };
      }
      return {
        authorized: false,
        code: 'APP_ACCESS_DENIED',
        reason: `Your account does not have an active grant for the ${targetApp} application.`
      };
    }

    // D. POS Terminal Authoritative Validation and Derivation
    let resolvedTerminal = (terminalId || pgUserData.terminal_id || metadataObj.terminalId || metadataObj.terminal_id || '').trim();
    if (targetApp === 'POS') {
      const allowedTerminals: string[] = metadataObj.allowed_terminals || metadataObj.allowedTerminals || [];

      // 1. Zero Allowed Terminals in Database -> UNCONDITIONAL REJECTION
      // A client-supplied ID must never be accepted merely because allowedTerminals is empty!
      if (!Array.isArray(allowedTerminals) || allowedTerminals.length === 0) {
        return {
          authorized: false,
          code: 'TERMINAL_NOT_PROVISIONED',
          reason: 'Operator has zero assigned POS terminals provisioned in the system database. Access denied.'
        };
      }

      // 2. Client supplied a terminal ID -> MUST match assigned list
      if (resolvedTerminal) {
        if (!allowedTerminals.includes(resolvedTerminal)) {
          return {
            authorized: false,
            code: 'TERMINAL_NOT_PERMITTED',
            reason: `Terminal "${resolvedTerminal}" is not permitted for this operator. Allowed terminals: ${allowedTerminals.join(', ')}.`
          };
        }
      } else {
        // 3. Client omitted terminal ID -> Server derives if and only if exactly 1 terminal is assigned
        if (allowedTerminals.length === 1) {
          resolvedTerminal = allowedTerminals[0];
        } else {
          return {
            authorized: false,
            code: 'TERMINAL_REQUIRED',
            reason: 'Multiple terminals are assigned to this operator. Explicit terminal selection is required.'
          };
        }
      }
    }

    // E. Delivery Partner Fleet Validation
    let deliveryPartnerRecord: any = null;
    if (targetApp === 'DELIVERY') {
      try {
        const riderRes = await query(
          `SELECT id, name, phone, email, status, is_online, branch_id, franchise_id, vehicle_type, vehicle_number
           FROM delivery_partners
           WHERE id = $1
           LIMIT 1`,
          [pgUserData.id]
        );

        if (riderRes.rows.length === 0) {
          return {
            authorized: false,
            code: 'DELIVERY_ASSIGNMENT_REQUIRED',
            reason: 'No delivery partner fleet record is linked to this authenticated account.'
          };
        }

        deliveryPartnerRecord = riderRes.rows[0];

        if (['REVOKED', 'TERMINATED', 'DISABLED'].includes(deliveryPartnerRecord.status)) {
          return {
            authorized: false,
            code: 'ACCOUNT_REVOKED',
            reason: 'Delivery partner account has been revoked or disabled in the fleet database.'
          };
        }

        if (deliveryPartnerRecord.status !== 'APPROVED') {
          return {
            authorized: false,
            code: 'NOT_APPROVED',
            reason: 'Your delivery partner account is not active or approved.'
          };
        }
      } catch (riderErr: any) {
        console.error('[FranchiseAccessService] PostgreSQL delivery_partners lookup failure (fail-closed):', riderErr.message);
        return {
          authorized: false,
          code: 'DATABASE_UNAVAILABLE',
          reason: 'Authoritative database temporarily unavailable'
        };
      }
    }

    // F. Branch and Franchise Scope Validation
    let resolvedBranch = pgUserData.branch_id || (deliveryPartnerRecord ? deliveryPartnerRecord.branch_id : undefined);
    let resolvedFranchise = pgUserData.franchise_id || (deliveryPartnerRecord ? deliveryPartnerRecord.franchise_id : undefined);

    if (resolvedFranchise === 'fra_primary') {
      resolvedFranchise = 'fra_rajnandgaon';
    }
    if (resolvedBranch === 'fra_primary') {
      resolvedBranch = 'main_branch';
    }

    // Strict multi-tenant isolation: non-owner staff must fail closed if branch or franchise is missing
    if (!isOwner) {
      if (!resolvedBranch || !resolvedFranchise) {
        return {
          authorized: false,
          code: 'BRANCH_SCOPE_REQUIRED',
          reason: 'Staff account must be explicitly assigned to an active branch and franchise scope in the system database.'
        };
      }

      if (isFranchiseStaff && targetApp === 'FRANCHISE_MANAGER') {
        // Franchise managers can scope to any branch within their assigned franchise
        if (requestedBranchId && requestedBranchId !== resolvedFranchise && requestedBranchId !== 'all') {
          resolvedBranch = requestedBranchId;
        }
      } else {
        // Branch-scoped staff (POS cashier, Restaurant Manager, Delivery) are locked to their assigned branch
        if (requestedBranchId && requestedBranchId !== resolvedBranch && requestedBranchId !== resolvedFranchise) {
          return {
            authorized: false,
            code: 'BRANCH_SCOPE_VIOLATION',
            reason: `Forbidden: Your account is authorized for branch "${resolvedBranch}", not "${requestedBranchId}".`
          };
        }
      }
    } else {
      // Strict Single-App Policy (A1): Owner accounts ONLY access OWNER portal (or Customer consumer portal),
      // never operational management portals (POS, Restaurant Manager, Franchise Manager, Delivery).
      if (['POS', 'RESTAURANT_MANAGER', 'FRANCHISE_MANAGER', 'DELIVERY'].includes(targetApp)) {
        return {
          authorized: false,
          code: 'OWNER_PORTAL_ONLY',
          reason: `Owner accounts cannot log into ${targetApp}. Use a dedicated branch/franchise staff account, or view all franchises in the Owner Portal.`
        };
      }
      if (requestedBranchId) {
        resolvedBranch = requestedBranchId;
      } else if (!resolvedBranch) {
        resolvedBranch = 'main_branch';
      }
      if (!resolvedFranchise) {
        resolvedFranchise = 'fra_rajnandgaon';
      }
    }

    // G. Administrative Branch Status Validation (Decoupled from kitchen operating hours)
    if (resolvedBranch && resolvedBranch !== 'all') {
      try {
        const bRes = await query(
          `SELECT b.id, b.name, b.franchise_id, b.metadata, f.status as franchise_status
           FROM restaurant_branches b
           JOIN franchises f ON b.franchise_id = f.id
           WHERE b.id = $1
           LIMIT 1`,
          [resolvedBranch]
        );

        if (bRes.rows.length === 0) {
          return {
            authorized: false,
            code: 'BRANCH_NOT_FOUND',
            reason: `Assigned branch "${resolvedBranch}" does not exist in system database.`
          };
        }

        const bRow = bRes.rows[0];

        // 1. Franchise Administrative Status Check
        if (bRow.franchise_status !== 'ACTIVE') {
          return {
            authorized: false,
            code: 'FRANCHISE_INACTIVE',
            reason: `Franchise for branch "${resolvedBranch}" is currently deactivated.`
          };
        }

        // 2. Branch Administrative Lifecycle Check
        let branchMeta: any = bRow.metadata || {};
        if (typeof branchMeta === 'string') {
          try { branchMeta = JSON.parse(branchMeta); } catch { branchMeta = {}; }
        }
        if (['DECOMMISSIONED', 'DISABLED', 'REVOKED'].includes(branchMeta.status)) {
          return {
            authorized: false,
            code: 'BRANCH_DECOMMISSIONED',
            reason: `Branch "${resolvedBranch}" has been decommissioned by administration.`
          };
        }

        // Note: is_open: boolean and operating_hours are customer ordering toggles only.
        // They NEVER block staff or cashiers from logging in outside public ordering hours.

        // 3. Multi-Tenant Cross-Franchise Isolation Check
        const branchFranchise = bRow.franchise_id === 'fra_primary' ? 'fra_rajnandgaon' : bRow.franchise_id;
        if (isOwner) {
          resolvedFranchise = branchFranchise;
        } else {
          const userFranchise = resolvedFranchise === 'fra_primary' ? 'fra_rajnandgaon' : resolvedFranchise;
          if (userFranchise && userFranchise !== 'all' && branchFranchise !== userFranchise) {
            return {
              authorized: false,
              code: 'CROSS_FRANCHISE_VIOLATION',
              reason: `Branch "${resolvedBranch}" does not belong to user franchise "${resolvedFranchise}".`
            };
          }
        }
      } catch (dbErr: any) {
        console.error('[FranchiseAccessService] Branch validation error (fail-closed):', dbErr.message);
        return {
          authorized: false,
          code: 'DATABASE_UNAVAILABLE',
          reason: 'Failed to validate branch assignment.'
        };
      }
    }

    const roleMap = {
      OWNER: 'owner',
      RESTAURANT_MANAGER: 'restaurant_manager',
      DELIVERY: 'delivery_partner',
      POS: 'pos_operator',
      FRANCHISE_MANAGER: 'franchise_manager',
      CUSTOMER: 'customer'
    };

    const effectiveAllowedApps = Array.from(new Set([targetApp, ...(Array.isArray(pgUserData.allowed_apps) ? pgUserData.allowed_apps : [])]));
    const appAccess = {
      app_restaurant_management: effectiveAllowedApps.includes('RESTAURANT_MANAGER'),
      app_delivery: effectiveAllowedApps.includes('DELIVERY'),
      app_pos: effectiveAllowedApps.includes('POS'),
      app_franchise_management: effectiveAllowedApps.includes('FRANCHISE_MANAGER'),
      app_owner: isOwner || effectiveAllowedApps.includes('OWNER')
    };
    const defaultPermissions = {
      RESTAURANT_MANAGER: ['dashboard.view', 'orders.live', 'orders.history', 'notifications.send', 'delivery.view', 'inventory.view'],
      POS: ['pos.billing', 'orders.create', 'orders.view'],
      FRANCHISE_MANAGER: ['franchise.dashboard', 'reports.view', 'staff.manage'],
      DELIVERY: ['delivery.orders', 'delivery.location']
    };

    return {
      authorized: true,
      requiresPin: false,
      isProfileComplete: Boolean(pgUserData.name),
      user: {
        uid: pgUserData.id || uid,
        email: pgUserData.email || emailLower,
        name: pgUserData.name || (deliveryPartnerRecord ? deliveryPartnerRecord.name : 'Olive Pizza Staff'),
        role: isOwner ? (roleMap[targetApp] || 'staff') : (userRole || roleMap[targetApp] || 'staff'),
        phone: pgUserData.phone || (deliveryPartnerRecord ? deliveryPartnerRecord.phone : ''),
        phoneNumber: pgUserData.phone || (deliveryPartnerRecord ? deliveryPartnerRecord.phone : ''),
        branchId: resolvedBranch,
        branchName: 'Olive Pizza',
        branchIds: ['all', resolvedBranch],
        franchiseId: resolvedFranchise,
        terminalId: resolvedTerminal,
        permissions: isOwner ? ['*'] : (defaultPermissions[targetApp] || ['*']),
        allowedApps: effectiveAllowedApps,
        applicationAccess: appAccess,
        vehicleType: deliveryPartnerRecord?.vehicle_type,
        vehicleNumber: deliveryPartnerRecord?.vehicle_number
      }
    };
  }
}
