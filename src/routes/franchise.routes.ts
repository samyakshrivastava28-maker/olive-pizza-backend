import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { adminDb, adminAuth } from '../config/firebase.js';
import { query } from '../config/postgres.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { FranchiseLifecycleService } from '../services/franchise/FranchiseLifecycleService.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';
import { FranchisePinService } from '../services/franchise/FranchisePinService.js';
import { FranchiseGoogleSheetsService } from '../services/reports/FranchiseGoogleSheetsService.js';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';
import { PosAccountService } from '../services/auth/PosAccountService.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';

const router = Router();

async function generateUniquePosActivationCode(reservedCodes: Set<string> = new Set<string>()): Promise<string> {
  // POS activation looks up a terminal by this code, so it must be unique across the collection.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = String(crypto.randomInt(100000, 1000000));
    if (reservedCodes.has(candidate)) continue;
    const duplicate = await adminDb.collection('pos_terminals')
      .where('activationCode', '==', candidate)
      .limit(1)
      .get();
    if (duplicate.empty) {
      reservedCodes.add(candidate);
      return candidate;
    }
  }
  throw new Error('Could not allocate a unique POS activation code. Retry terminal provisioning.');
}

// ============================================================================
// PUBLIC ORDERING CONTEXT & DELIVERY RADIUS RESOLUTION (CUSTOMER APP)
// ============================================================================

const handleOrderingContextResolve = async (req: Request, res: Response): Promise<void> => {
  try {
    const { customerId, lat, lng, addressLine } = req.body;
    const custId = customerId || (req as any).user?.uid || 'guest';

    const resolution = await CustomerOrderingContextService.resolveOrderingContext({
      customerId: custId,
      lat: Number(lat),
      lng: Number(lng),
      addressLine
    });

    if (!resolution.isServiceable) {
      res.status(400).json({
        success: false,
        isServiceable: false,
        error: resolution.error || "We currently don't deliver to this location.",
        code: resolution.code || 'OUT_OF_DELIVERY_ZONE'
      });
      return;
    }

    res.json({
      success: true,
      isServiceable: true,
      context: resolution.context
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error resolving ordering context:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

router.post('/ordering-context/resolve', handleOrderingContextResolve);
router.post('/service-area/resolve', handleOrderingContextResolve);

// ============================================================================
// OPERATIONAL APP SCOPE & AUTHORIZATION RESOLUTION ALIAS (/api/franchises/auth/resolve)
// ============================================================================
router.all('/auth/resolve', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ authorized: false, reason: 'Authentication required' });
      return;
    }

    const targetApp = (req.body?.targetApp || req.query?.targetApp || req.headers['x-app-target'] || 'FRANCHISE_MANAGER') as any;
    const requestedBranchId = (req.body?.requestedBranchId || req.query?.requestedBranchId || req.headers['x-branch-id']) as string;
    const terminalId = (req.body?.terminalId || req.query?.terminalId) as string;

    const resolution = await FranchiseAccessService.resolveAuthorization({
      uid: user.uid,
      email: user.email,
      phoneNumber: user.phone_number,
      emailVerified: user.email_verified,
      targetApp,
      requestedBranchId,
      terminalId
    });

    if (!resolution.authorized) {
      res.status(403).json(resolution);
      return;
    }

    res.json(resolution);
  } catch (err: any) {
    console.error('[FranchiseRoutes] Error in /auth/resolve:', err);
    res.status(500).json({ authorized: false, reason: err.message || 'Internal server error' });
  }
});

const DEFAULT_ORGANIZATION = {
  id: 'org_olive_pizza',
  name: 'Olive Pizza India',
  legalName: 'Olive Pizza Foodworks Private Limited',
  contactEmail: 'olivepizzarjn@gmail.com',
  contactPhone: '+91 91799 44445',
  currency: 'INR',
  country: 'IN',
  createdAt: new Date().toISOString()
};

export interface FranchiseEntity {
  id: string;
  slug: string;
  organizationId: string;
  name: string;
  code: string;
  region: string;
  city: string;
  contactEmail: string;
  contactPhone: string;
  franchiseOwnerName?: string;
  franchiseOwnerEmail?: string;
  restaurantManagerName?: string;
  restaurantManagerEmail?: string;
  mainBranchId: string;
  isActive: boolean;
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  businessHours?: {
    openingTime: string;
    closingTime: string;
    isOpenToday: boolean;
  };
  deliverySettings?: {
    maxDeliveryRadiusKm: number;
    deliveryFee: number;
    freeDeliveryThreshold: number;
    minOrderAmount: number;
  };
  createdAt: string;
  updatedAt: string;
}

// ── No hardcoded default franchises or branches.
// Franchises and branches are created exclusively via the Provisioning Wizard
// (POST /api/franchises/provision) and stored in Firestore.
// The owner must use the wizard to create real franchises.

router.use(verifyToken);

// ─── 0. GET ALL FRANCHISES & BRANCHES (DEFAULT ENTRYPOINT) ───────────────────
router.get('/', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);

    // Fetch franchise entities from Firestore
    const entitySnap = await adminDb.collection('franchise_entities').get();
    let franchiseEntities: any[] = entitySnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    // Fetch branches from Firestore
    const branchSnap = await adminDb.collection('franchises').get();
    let branches: any[] = branchSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    // If non-global owner, scope records
    if (!scope.isGlobalOwner) {
      franchiseEntities = franchiseEntities.filter(f => f.id === scope.franchiseId || f.slug === scope.franchiseId);
      const allowedBranchIds = branches
        .filter(b => b.franchiseId === scope.franchiseId || (scope.franchiseId === 'fra_rajnandgaon' && b.id === 'main_branch'))
        .map(b => b.id);
      branches = branches.filter(b => allowedBranchIds.includes(b.id));
    }

    // Merge entity meta into branch records if missing
    branches = branches.map(b => {
      const parentEntity = franchiseEntities.find(fe => 
        fe.id === b.franchiseId || 
        (fe.id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')) ||
        fe.mainBranchId === b.id ||
        fe.slug === (b.slug || b.id.replace('fra_', '').replace('_branch', ''))
      );
      return {
        ...b,
        slug: parentEntity?.slug || b.slug || (b.id === 'main_branch' ? 'rajnandgaon' : b.id.replace('fra_', '').replace('_branch', '')),
        franchiseName: b.name || parentEntity?.name || 'Olive Pizza',
        franchiseOwnerName: b.franchiseOwnerName || parentEntity?.franchiseOwnerName || 'Olive Pizza Master Owner',
        franchiseOwnerEmail: b.franchiseOwnerEmail || parentEntity?.franchiseOwnerEmail || parentEntity?.contactEmail || 'olivepizzarjn@gmail.com',
        restaurantManagerEmail: b.restaurantManagerEmail || parentEntity?.restaurantManagerEmail || '',
        restaurantManagerName: b.restaurantManagerName || parentEntity?.restaurantManagerName || 'Branch Manager'
      };
    });

    // Exclude soft-deleted branches/franchises by default unless explicitly requested
    const includeDeleted = req.query.includeDeleted === 'true';
    if (!includeDeleted) {
      branches = branches.filter(b => b.status !== 'deleted' && !(b.isActive === false && b.deletedAt));
      franchiseEntities = franchiseEntities.filter(f => f.status !== 'deleted' && !(f.isActive === false && f.deletedAt));
    }

    res.json({
      success: true,
      branches,
      franchises: franchiseEntities
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error in GET /:', error);
    res.status(500).json({ error: 'Failed to retrieve franchises and branches' });
  }
});

// ─── 0.05 FASTEST GROWING FRANCHISE ANALYTICS ──────────────────────────────
router.get('/analytics/fastest-growing', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const now = new Date();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const currentPeriodStart = new Date(now.getTime() - thirtyDaysMs);
    const previousPeriodStart = new Date(now.getTime() - 2 * thirtyDaysMs);

    const [entitySnap, branchSnap, orderSnap] = await Promise.all([
      adminDb.collection('franchise_entities').get(),
      adminDb.collection('franchises').get(),
      adminDb.collection('orders').limit(1000).get()
    ]);

    let franchises: any[] = entitySnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    const branches: any[] = branchSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    const orders: any[] = orderSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    if (!scope.isGlobalOwner) {
      franchises = franchises.filter(f => f.id === scope.franchiseId || f.slug === scope.franchiseId);
    }

    const results = franchises.map(f => {
      const fId = f.id;
      const associatedBranchIds = branches
        .filter(b => b.franchiseId === fId || (fId === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')))
        .map(b => b.id);
      if (!associatedBranchIds.includes(fId)) associatedBranchIds.push(fId);

      let current30dRevenue = 0;
      let previous30dRevenue = 0;
      let current30dOrders = 0;
      let previous30dOrders = 0;

      orders.forEach(o => {
        const bId = o.branchId || 'main_branch';
        const isFranchiseOrder = o.franchiseId === fId || associatedBranchIds.includes(bId) ||
          (fId === 'fra_rajnandgaon' && (!o.franchiseId || o.franchiseId === 'fra_primary' || bId === 'main_branch'));

        if (!isFranchiseOrder) return;
        const status = (o.status || '').toLowerCase();
        if (status === 'cancelled' || status === 'rejected') return;

        const amt = Number(o.totalAmount || 0);
        let createdAtDate = new Date();
        if (o.createdAt) {
          if (o.createdAt.toDate && typeof o.createdAt.toDate === 'function') createdAtDate = o.createdAt.toDate();
          else if (o.createdAt._seconds) createdAtDate = new Date(o.createdAt._seconds * 1000);
          else if (typeof o.createdAt === 'string' || typeof o.createdAt === 'number') createdAtDate = new Date(o.createdAt);
        }

        const t = createdAtDate.getTime();
        if (t >= currentPeriodStart.getTime() && t <= now.getTime()) {
          current30dRevenue += amt;
          current30dOrders++;
        } else if (t >= previousPeriodStart.getTime() && t < currentPeriodStart.getTime()) {
          previous30dRevenue += amt;
          previous30dOrders++;
        }
      });

      // Safe Growth Rate Calculation
      let growthRatePct = 0;
      let growthStatus: 'positive' | 'negative' | 'flat' | 'new_baseline' = 'flat';

      if (previous30dRevenue === 0) {
        if (current30dRevenue === 0) {
          growthRatePct = 0;
          growthStatus = 'flat';
        } else {
          growthRatePct = 100;
          growthStatus = 'new_baseline';
        }
      } else {
        growthRatePct = Math.round(((current30dRevenue - previous30dRevenue) / previous30dRevenue) * 10000) / 100;
        growthStatus = growthRatePct > 0 ? 'positive' : (growthRatePct < 0 ? 'negative' : 'flat');
      }

      return {
        franchiseId: fId,
        franchiseName: f.name || fId,
        city: f.city || '',
        current30dRevenue: Math.round(current30dRevenue),
        previous30dRevenue: Math.round(previous30dRevenue),
        current30dOrders,
        previous30dOrders,
        revenueDelta: Math.round(current30dRevenue - previous30dRevenue),
        growthRatePct,
        growthStatus,
      };
    });

    results.sort((a, b) => b.growthRatePct - a.growthRatePct);

    res.json({
      success: true,
      comparisonPeriod: {
        currentWindow: { start: currentPeriodStart.toISOString(), end: now.toISOString() },
        previousWindow: { start: previousPeriodStart.toISOString(), end: currentPeriodStart.toISOString() }
      },
      fastestGrowing: results.length > 0 ? results[0] : null,
      rankings: results
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error in GET /analytics/fastest-growing:', error);
    res.status(500).json({ error: 'Failed to calculate fastest growing franchise' });
  }
});

// ─── 0.08 FRANCHISE LIFECYCLE MANAGEMENT (SOFT-DELETE, HISTORY, RECOVER, PERMANENT DELETE) ───

// GET /api/franchises/history/deleted - List all soft-deleted franchises with metadata
router.get('/history/deleted', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const deletedFranchises = await FranchiseLifecycleService.listDeletedFranchises();
    res.json({
      success: true,
      deletedFranchises,
      count: deletedFranchises.length
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing deleted franchises:', error);
    res.status(500).json({ error: error.message || 'Failed to list deleted franchises' });
  }
});

// GET /api/franchises/:id/history - Read-only historical snapshot of a franchise
router.get('/:id/history', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const history = await FranchiseLifecycleService.getFranchiseHistory(id);
    res.json({
      success: true,
      history
    });
  } catch (error: any) {
    console.error(`[FranchiseRoutes] Error getting franchise history for ${req.params.id}:`, error);
    res.status(error.message?.includes('not found') ? 404 : 500).json({ error: error.message || 'Failed to retrieve franchise history' });
  }
});

// POST /api/franchises/:id/recover - Recover a soft-deleted franchise
router.post('/:id/recover', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const recoveredBy = req.user?.email || req.user?.uid || 'owner';
    const result = await FranchiseLifecycleService.recoverFranchise({ franchiseId: id, recoveredBy });
    res.json(result);
  } catch (error: any) {
    console.error(`[FranchiseRoutes] Error recovering franchise ${req.params.id}:`, error);
    res.status(error.message?.includes('not found') ? 404 : 500).json({ error: error.message || 'Failed to recover franchise' });
  }
});

// DELETE /api/franchises/:id/permanent - Permanently delete franchise operational data (Owner only)
router.delete('/:id/permanent', requireRole(['owner', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const confirmFranchiseName = req.body?.confirmFranchiseName || req.body?.franchiseName || '';
    if (!confirmFranchiseName) {
      res.status(400).json({ error: 'Confirmation franchise name is required in confirmFranchiseName field' });
      return;
    }
    const deletedBy = req.user?.email || req.user?.uid || 'owner';
    const result = await FranchiseLifecycleService.permanentDeleteFranchise({
      franchiseId: id,
      confirmFranchiseName,
      deletedBy
    });
    res.json(result);
  } catch (error: any) {
    console.error(`[FranchiseRoutes] Error permanently deleting franchise ${req.params.id}:`, error);
    res.status(error.message?.includes('not match') ? 400 : (error.message?.includes('not found') ? 404 : 500)).json({ error: error.message || 'Failed to permanently delete franchise' });
  }
});

// DELETE /api/franchises/:id - Soft-delete a franchise (Owner only)
router.delete('/:id', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const reason = req.body?.reason || req.body?.deletionReason || 'Soft-deleted by Owner';
    const deletedBy = req.user?.email || req.user?.uid || 'owner';

    const result = await FranchiseLifecycleService.softDeleteFranchise({
      franchiseId: id,
      deletedBy,
      reason
    });
    res.json(result);
  } catch (error: any) {
    console.error(`[FranchiseRoutes] Error soft-deleting franchise ${req.params.id}:`, error);
    res.status(error.message?.includes('not found') ? 404 : 500).json({ error: error.message || 'Failed to soft delete franchise' });
  }
});

// ─── 0.1 UPDATE FRANCHISE / BRANCH DETAILS ──────────────────────────────────
router.patch('/:id', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const body = req.body;
    const now = new Date().toISOString();

    // 1. Locate branch in franchises
    let branchRef = adminDb.collection('franchises').doc(id);
    let branchDoc = await branchRef.get();

    if (!branchDoc.exists) {
      // Look up by franchiseId
      const bSnap = await adminDb.collection('franchises').where('franchiseId', '==', id).limit(1).get();
      if (!bSnap.empty) {
        branchRef = adminDb.collection('franchises').doc(bSnap.docs[0].id);
        branchDoc = bSnap.docs[0];
      }
    }

    // 2. Locate target entity in franchise_entities
    let targetEntityRef: any = null;
    const candidateEntityIds = [
      branchDoc.exists ? branchDoc.data()?.franchiseId : null,
      id === 'main_branch' ? 'fra_rajnandgaon' : null,
      id.startsWith('fra_') ? id : `fra_${id}`,
      id,
      id.replace('_branch', '').startsWith('fra_') ? id.replace('_branch', '') : `fra_${id.replace('_branch', '')}`
    ].filter(Boolean);

    for (const candId of candidateEntityIds) {
      const eRef = adminDb.collection('franchise_entities').doc(candId!);
      const eSnap = await eRef.get();
      if (eSnap.exists) {
        targetEntityRef = eRef;
        break;
      }
    }

    if (!targetEntityRef) {
      const allEntities = await adminDb.collection('franchise_entities').get();
      const matched = allEntities.docs.find(d => {
        const data = d.data();
        return d.id === id || data.slug === id || data.mainBranchId === id || data.city?.toLowerCase() === id.toLowerCase().replace(/[^a-z0-9]/g, '');
      });
      if (matched) {
        targetEntityRef = adminDb.collection('franchise_entities').doc(matched.id);
      }
    }

    // Auto-heal: If branch exists but no entity exists in franchise_entities, create it!
    if (branchDoc.exists && !targetEntityRef) {
      const bData = branchDoc.data() || {};
      const cityName = (bData.city || id.replace('_branch', '')).trim();
      const slug = cityName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const fId = `fra_${cityName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      const newEntityRef = adminDb.collection('franchise_entities').doc(fId);
      await newEntityRef.set({
        id: fId,
        slug,
        organizationId: bData.organizationId || FranchiseScopeService.DEFAULT_ORG_ID,
        name: bData.name || `Olive Pizza — ${cityName}`,
        code: bData.code || `OP-${cityName.slice(0, 3).toUpperCase()}-01`,
        region: bData.state || 'Chhattisgarh',
        city: cityName,
        contactEmail: bData.email || `franchise.${slug}@olivepizza.in`,
        contactPhone: bData.phone || '+91 91799 44445',
        franchiseOwnerName: bData.franchiseOwnerName || 'Franchise Partner',
        franchiseOwnerEmail: bData.franchiseOwnerEmail || undefined,
        restaurantManagerName: bData.restaurantManagerName || undefined,
        restaurantManagerEmail: bData.restaurantManagerEmail || undefined,
        mainBranchId: branchDoc.id,
        isActive: bData.isActive !== false,
        status: bData.isActive !== false ? 'ACTIVE' : 'SUSPENDED',
        createdAt: bData.createdAt || now,
        updatedAt: now
      }, { merge: true });
      targetEntityRef = newEntityRef;
      await branchRef.set({ franchiseId: fId }, { merge: true });
    }

    if (!branchDoc.exists && !targetEntityRef) {
      res.status(404).json({ error: `Franchise/branch with id '${id}' not found in database`, code: 'NOT_FOUND' });
      return;
    }

    const updateData: Record<string, any> = {
      updatedAt: now,
      updatedBy: req.user?.email || req.user?.uid || 'owner'
    };

    const allowedFields = [
      'name', 'code', 'city', 'state', 'region', 'address', 'phone', 'email',
      'contactPhone', 'contactEmail', 'franchiseOwnerName', 'franchiseOwnerEmail',
      'restaurantManagerName', 'restaurantManagerEmail', 'maxDeliveryRadiusKm',
      'openingTime', 'closingTime', 'posTerminalCount', 'isActive', 'isHeadquarters'
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        if (['maxDeliveryRadiusKm', 'posTerminalCount'].includes(field)) {
          updateData[field] = Number(body[field]);
        } else if (['isActive', 'isHeadquarters'].includes(field)) {
          updateData[field] = Boolean(body[field]);
        } else {
          updateData[field] = typeof body[field] === 'string' ? body[field].trim() : body[field];
        }
      }
    }

    if (body.lat !== undefined) updateData.lat = Number(body.lat);
    if (body.lng !== undefined) updateData.lng = Number(body.lng);

    if (body.openingTime || body.closingTime) {
      updateData.businessHours = {
        openingTime: body.openingTime || '12:00',
        closingTime: body.closingTime || '23:59',
        isOpenToday: true
      };
    }

    if (body.maxDeliveryRadiusKm !== undefined) {
      updateData.deliverySettings = {
        maxDeliveryRadiusKm: Number(body.maxDeliveryRadiusKm),
        deliveryFee: 30,
        freeDeliveryThreshold: 299,
        minOrderAmount: 99
      };
    }

    // Account replacement & revocation when restaurantManagerEmail is updated
    if (body.restaurantManagerEmail && branchDoc.exists) {
      const oldManagerEmail = branchDoc.data()?.restaurantManagerEmail;
      const newManagerEmail = body.restaurantManagerEmail.trim().toLowerCase();
      const PROTECTED_EMAILS = ['olivepizzarjn@gmail.com', 'webhub2811@gmail.com', 'olivepizzamaker@gmail.com'];
      if (oldManagerEmail && oldManagerEmail.toLowerCase() !== newManagerEmail && !PROTECTED_EMAILS.includes(oldManagerEmail.toLowerCase())) {
        try {
          const oldUser = await adminAuth.getUserByEmail(oldManagerEmail).catch(() => null);
          const oldRole = oldUser ? String(((await adminDb.collection('users').doc(oldUser.uid).get()).data()?.role) || '').toLowerCase() : '';
          if (oldUser && !['owner', 'platform_owner', 'admin', 'developer'].includes(oldRole)) {
            await adminAuth.revokeRefreshTokens(oldUser.uid);
            await adminAuth.setCustomUserClaims(oldUser.uid, { role: 'REVOKED', revokedAt: now });
            await adminDb.collection('users').doc(oldUser.uid).set({
              status: 'REVOKED',
              role: 'REVOKED',
              isActive: false,
              revokedAt: now,
              revokedReason: `Replaced by new manager ${newManagerEmail}`
            }, { merge: true });
          }
          const mgrDocs = await adminDb.collection('restaurant_managers').where('email', '==', oldManagerEmail.toLowerCase()).get();
          for (const mDoc of mgrDocs.docs) {
            await mDoc.ref.set({ isActive: false, status: 'REVOKED', revokedAt: now }, { merge: true });
          }
        } catch (revErr) {
          console.warn('[FranchiseRoutes] Error revoking replaced manager account:', revErr);
        }
      }

      // Automatically provision/approve new restaurant manager in users & restaurant_managers
      const targetFId = targetEntityRef ? targetEntityRef.id : id;
      const targetBId = branchDoc.exists ? branchDoc.id : id;
      await FranchiseAccessService.updateFranchiseAccess({
        targetUserId: newManagerEmail,
        franchiseId: targetFId,
        branchId: targetBId,
        targetRole: 'restaurant_manager',
        applicationAccess: {
          app_restaurant_management: true
        },
        accountStatus: 'ACTIVE',
        actorUid: req.user?.uid || 'owner',
        actorEmail: req.user?.email || 'owner@olivepizza.in'
      }).catch(err => console.warn('[FranchiseRoutes] Auto-syncing new restaurant manager access:', err));
    }

    // Account replacement & revocation when franchiseOwnerEmail is updated (protecting platform owner)
    if (body.franchiseOwnerEmail && branchDoc.exists) {
      const oldOwnerEmail = branchDoc.data()?.franchiseOwnerEmail;
      const newOwnerEmail = body.franchiseOwnerEmail.trim().toLowerCase();
      if (oldOwnerEmail && oldOwnerEmail.toLowerCase() !== newOwnerEmail && oldOwnerEmail.toLowerCase() !== 'olivepizzarjn@gmail.com') {
        try {
          const oldUser = await adminAuth.getUserByEmail(oldOwnerEmail).catch(() => null);
          if (oldUser) {
            await adminAuth.revokeRefreshTokens(oldUser.uid);
            await adminAuth.setCustomUserClaims(oldUser.uid, { role: 'REVOKED', revokedAt: now });
            await adminDb.collection('users').doc(oldUser.uid).set({
              status: 'REVOKED',
              role: 'REVOKED',
              isActive: false,
              revokedAt: now,
              revokedReason: `Replaced by new franchise owner ${newOwnerEmail}`
            }, { merge: true });
          }
        } catch (revErr) {
          console.warn('[FranchiseRoutes] Error revoking replaced franchise owner account:', revErr);
        }
      }

      // Automatically provision/approve new franchise owner in users, franchise_users & pos_accounts
      const targetFId = targetEntityRef ? targetEntityRef.id : id;
      const targetBId = branchDoc.exists ? branchDoc.id : id;
      await FranchiseAccessService.updateFranchiseAccess({
        targetUserId: newOwnerEmail,
        franchiseId: targetFId,
        branchId: targetBId,
        targetRole: 'franchise_manager',
        applicationAccess: {
          app_franchise_management: true,
          app_pos: true
        },
        accountStatus: 'ACTIVE',
        actorUid: req.user?.uid || 'owner',
        actorEmail: req.user?.email || 'owner@olivepizza.in'
      }).catch(err => console.warn('[FranchiseRoutes] Auto-syncing new franchise owner access:', err));
    }

    // Atomically persist to franchises collection
    if (branchDoc.exists) {
      await branchRef.set(updateData, { merge: true });
    }

    // Atomically persist to franchise_entities collection
    if (targetEntityRef) {
      await targetEntityRef.set(updateData, { merge: true });
    }

    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: targetEntityRef ? targetEntityRef.id : id,
      branchId: branchDoc.exists ? branchDoc.id : id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'FRANCHISE_UPDATED',
      entityType: 'franchise_branch',
      entityId: id,
      details: updateData
    });

    const refreshedDoc = branchDoc.exists ? await branchRef.get() : (await targetEntityRef?.get());
    res.json({
      success: true,
      message: 'Franchise details updated successfully',
      branch: { id: branchDoc.exists ? branchDoc.id : id, ...(refreshedDoc?.data() || updateData) }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error updating franchise:', error);
    res.status(500).json({ error: error.message || 'Failed to update franchise details' });
  }
});

// ─── 0.2 TOGGLE FRANCHISE / BRANCH STATUS ───────────────────────────────────
router.patch('/:id/status', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive boolean flag is required' });
      return;
    }

    const now = new Date().toISOString();
    const branchRef = adminDb.collection('franchises').doc(id);
    const branchDoc = await branchRef.get();

    const entityRef = adminDb.collection('franchise_entities').doc(id.startsWith('fra_') ? id : `fra_${id}`);
    const altEntityRef = adminDb.collection('franchise_entities').doc(branchDoc.exists ? (branchDoc.data()?.franchiseId || id) : id);
    const entityDoc = await entityRef.get();
    const targetEntityRef = entityDoc.exists ? entityRef : (await altEntityRef.get()).exists ? altEntityRef : null;

    if (branchDoc.exists) {
      await branchRef.set({ isActive, updatedAt: now }, { merge: true });
    }
    if (targetEntityRef) {
      await targetEntityRef.set({
        isActive,
        status: isActive ? 'ACTIVE' : 'SUSPENDED',
        updatedAt: now
      }, { merge: true });
    }

    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: targetEntityRef ? targetEntityRef.id : id,
      branchId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: isActive ? 'FRANCHISE_ACTIVATED' : 'FRANCHISE_DEACTIVATED',
      entityType: 'franchise_branch',
      entityId: id,
      details: { isActive }
    });

    res.json({ success: true, message: `Franchise ${isActive ? 'activated' : 'deactivated'} successfully`, isActive });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error updating franchise status:', error);
    res.status(500).json({ error: error.message || 'Failed to update franchise status' });
  }
});

// ─── 1. LIST ALL FRANCHISES (FOR GLOBAL OWNER OR FRANCHISE OWNER) ───────────
router.get('/list', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const snap = await adminDb.collection('franchise_entities').get();
    let franchises: FranchiseEntity[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as FranchiseEntity));

    // Filter if restricted franchise owner
    if (!scope.isGlobalOwner) {
      franchises = franchises.filter(f => f.id === scope.franchiseId || f.slug === scope.franchiseId);
    }

    // Augment with live branch and terminal counts
    const bSnap = await adminDb.collection('franchises').get().catch(() => ({ docs: [] } as any));
    const allBranches: any[] = bSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const posSnap = await adminDb.collection('pos_terminals').get().catch(() => ({ docs: [] } as any));
    const allTerminals: any[] = posSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const mgrSnap = await adminDb.collection('restaurant_managers').get().catch(() => ({ docs: [] } as any));
    const allMgrs: any[] = mgrSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const riderSnap = await adminDb.collection('delivery_partners').get().catch(() => ({ docs: [] } as any));
    const allRiders: any[] = riderSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const augmented = franchises.map(f => {
      const branches = allBranches.filter(b => b.franchiseId === f.id || (f.id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')));
      const branchIds = branches.map(b => b.id);
      const terminals = allTerminals.filter(t => t.franchiseId === f.id || branchIds.includes(t.branchId));
      const managers = allMgrs.filter(m => m.franchiseId === f.id || branchIds.includes(m.branchId));
      const riders = allRiders.filter(r => r.franchiseId === f.id || branchIds.includes(r.branchId));

      return {
        ...f,
        branchCount: branches.length,
        terminalCount: terminals.length,
        managerCount: managers.length,
        riderCount: riders.length,
        mainBranch: branches[0]?.name || null,
        mainBranchId: branches[0]?.id || f.mainBranchId,
      };
    });

    res.json({ success: true, franchises: augmented });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing franchises:', error);
    res.status(500).json({ error: 'Failed to list franchises' });
  }
});

// ─── 2. RESOLVE FRANCHISE BY SLUG (AUTHORITATIVE SERVER SCOPING) ───────────
router.get('/by-slug/:slug', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { slug } = req.params;
    const cleanSlug = slug.toLowerCase().trim();
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);

    const snap = await adminDb.collection('franchise_entities').get();
    let franchise = snap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) } as FranchiseEntity))
      .find(f => f.slug === cleanSlug || f.id === cleanSlug || f.id === `fra_${cleanSlug}` || (cleanSlug === 'rajnandgaon' && f.id === 'fra_rajnandgaon'));

    // Auto-heal if not in franchise_entities but exists in franchises
    if (!franchise) {
      const bSnap = await adminDb.collection('franchises').get();
      const matchingBranch = bSnap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .find(b => {
          const bSlug = (b.slug || b.city || b.id.replace('fra_', '').replace('_branch', '')).toLowerCase();
          return bSlug === cleanSlug || b.id === cleanSlug || b.id === `${cleanSlug}_branch`;
        });

      if (matchingBranch) {
        const cityName = matchingBranch.city || cleanSlug;
        const fId = `fra_${cleanSlug.replace(/[^a-z0-9]/g, '_')}`;
        const newEntity: FranchiseEntity = {
          id: fId,
          slug: cleanSlug,
          organizationId: matchingBranch.organizationId || FranchiseScopeService.DEFAULT_ORG_ID,
          name: matchingBranch.name || `Olive Pizza — ${cityName}`,
          code: matchingBranch.code || `OP-${cleanSlug.slice(0, 3).toUpperCase()}-01`,
          region: matchingBranch.state || 'Chhattisgarh',
          city: cityName,
          contactEmail: matchingBranch.email || `franchise.${cleanSlug}@olivepizza.in`,
          contactPhone: matchingBranch.phone || '+91 91799 44445',
          franchiseOwnerName: matchingBranch.franchiseOwnerName || 'Franchise Partner',
          franchiseOwnerEmail: matchingBranch.franchiseOwnerEmail || undefined,
          restaurantManagerName: matchingBranch.restaurantManagerName || undefined,
          restaurantManagerEmail: matchingBranch.restaurantManagerEmail || undefined,
          mainBranchId: matchingBranch.id,
          isActive: matchingBranch.isActive !== false,
          status: matchingBranch.isActive !== false ? 'ACTIVE' : 'SUSPENDED',
          createdAt: matchingBranch.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await adminDb.collection('franchise_entities').doc(fId).set(newEntity, { merge: true });
        await adminDb.collection('franchises').doc(matchingBranch.id).set({ franchiseId: fId }, { merge: true });
        franchise = newEntity;
      }
    }

    if (!franchise) {
      res.status(404).json({ error: `Franchise with slug '${cleanSlug}' not found`, code: 'NOT_FOUND' });
      return;
    }

    // Backend scope enforcement
    if (!scope.isGlobalOwner && scope.franchiseId !== franchise.id && scope.franchiseId !== franchise.slug) {
      res.status(403).json({ error: 'Unauthorized: You do not have permission to access this franchise', code: 'FORBIDDEN' });
      return;
    }

    // Fetch associated branches
    const bSnap = await adminDb.collection('franchises').get();
    const branches = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => 
        b.franchiseId === franchise!.id || 
        b.franchiseId === `fra_${franchise!.slug}` ||
        b.id === franchise!.mainBranchId ||
        (franchise!.id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary'))
      );

    res.json({
      success: true,
      franchise: {
        ...franchise,
        branches
      }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error resolving franchise slug:', error);
    res.status(500).json({ error: 'Failed to resolve franchise' });
  }
});

// ─── 2.5 GET FRANCHISE OR BRANCH BY ID ─────────────────────────────────────
router.get('/:id', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'franchise_manager', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);

    // 1. Check in 'franchises' collection (branch-level)
    let docSnap = await adminDb.collection('franchises').doc(id).get();
    let data: any = docSnap.exists ? { id: docSnap.id, ...docSnap.data() } : null;

    // 2. Check by franchiseId field in 'franchises' if not found
    if (!data) {
      const snap = await adminDb.collection('franchises').where('franchiseId', '==', id).limit(1).get();
      if (!snap.empty) {
        data = { id: snap.docs[0].id, ...snap.docs[0].data() };
      }
    }

    // 3. Check in 'franchise_entities' collection
    if (!data) {
      const entitySnap = await adminDb.collection('franchise_entities').doc(id).get();
      if (entitySnap.exists) {
        data = { id: entitySnap.id, ...entitySnap.data() };
      }
    }

    if (!data) {
      res.status(404).json({ error: `Franchise or branch '${id}' not found`, code: 'NOT_FOUND' });
      return;
    }

    // Scope check
    if (!scope.isGlobalOwner && scope.franchiseId !== data.franchiseId && scope.franchiseId !== data.id && scope.franchiseId !== 'fra_rajnandgaon') {
      res.status(403).json({ error: 'Access denied to this franchise', code: 'FORBIDDEN' });
      return;
    }

    res.json({
      success: true,
      ...data
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error in GET /:id:', error);
    res.status(500).json({ error: 'Failed to retrieve franchise details' });
  }
});

// ─── 3. FRANCHISE DASHBOARD METRICS ─────────────────────────────────────────
router.get('/:id/dashboard', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const branchFilter = req.query.branchId as string;
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);

    if (!scope.isGlobalOwner && scope.franchiseId !== id && scope.franchiseId !== `fra_${id}`) {
      res.status(403).json({ error: 'Unauthorized: Scope mismatch', code: 'FORBIDDEN' });
      return;
    }

    // Fetch branches for this franchise
    const bSnap = await adminDb.collection('franchises').get();
    const branches: any[] = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => 
        b.franchiseId === id || 
        b.franchiseId === `fra_${id}` || 
        b.id === id || 
        b.id === `${id}_branch` || 
        (id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary'))
      );

    const targetBranchIds = branchFilter && branchFilter !== 'all'
      ? [branchFilter]
      : (branches.length > 0 ? branches.map(b => b.id) : [id]);

    // Fetch orders for metrics
    const orderSnap = await adminDb.collection('orders').where('franchiseId', '==', id).get().catch(async () => await adminDb.collection('orders').get().catch(() => ({ docs: [] } as any)));
    const allOrders: any[] = orderSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    const scopedOrders = allOrders.filter(o => {
      const bId = o.branchId || 'main_branch';
      return targetBranchIds.includes(bId) || o.franchiseId === id || (id === 'fra_rajnandgaon' && (!o.franchiseId || o.franchiseId === 'fra_primary'));
    });

    let todaySales = 0;
    let posSales = 0;
    let onlineSales = 0;
    let activeOrdersCount = 0;
    let completedOrdersCount = 0;
    let cancelledOrdersCount = 0;
    let cashSales = 0;
    let upiSales = 0;
    let cardSales = 0;
    let dineInCount = 0;
    let takeawayCount = 0;
    let deliveryCount = 0;

    scopedOrders.forEach(o => {
      const amt = Number(o.totalAmount || 0);
      const status = (o.status || 'pending').toLowerCase();
      const source = (o.orderSource || 'website').toLowerCase();
      const pMethod = (o.paymentMethod || 'online').toLowerCase();
      const fType = (o.fulfillmentType || o.deliveryType || 'delivery').toLowerCase();

      if (status !== 'cancelled' && status !== 'rejected') {
        todaySales += amt;
        if (source === 'pos') posSales += amt;
        else onlineSales += amt;

        if (pMethod === 'cash') cashSales += amt;
        else if (pMethod === 'upi') upiSales += amt;
        else cardSales += amt;

        if (fType.includes('dine')) dineInCount++;
        else if (fType.includes('take')) takeawayCount++;
        else deliveryCount++;
      }

      if (['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'].includes(status)) {
        activeOrdersCount++;
      } else if (status === 'delivered' || status === 'completed') {
        completedOrdersCount++;
      } else if (status === 'cancelled' || status === 'rejected') {
        cancelledOrdersCount++;
      }
    });

    // POS & Rider counts
    const posSnap = await adminDb.collection('pos_terminals').get().catch(() => ({ docs: [] } as any));
    const activeTerminals: any[] = posSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(t => targetBranchIds.includes(t.branchId) && t.isActive !== false);

    const riderSnap = await adminDb.collection('delivery_partners').get().catch(() => ({ docs: [] } as any));
    const activeRiders: any[] = riderSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(r => (r.franchiseId === id || targetBranchIds.includes(r.branchId)) && r.isActive !== false);

    res.json({
      success: true,
      dashboard: {
        franchiseId: id,
        branchCount: targetBranchIds.length,
        todaySales,
        totalOrders: scopedOrders.length,
        activeOrders: activeOrdersCount,
        completedOrders: completedOrdersCount,
        cancelledOrders: cancelledOrdersCount,
        avgOrderValue: scopedOrders.length > 0 ? Math.round(todaySales / Math.max(1, scopedOrders.length)) : 0,
        posSales,
        onlineSales,
        cashSales,
        upiSales,
        cardSales,
        dineInCount,
        takeawayCount,
        deliveryCount,
        activeBranchesCount: targetBranchIds.length,
        activePosTerminalsCount: activeTerminals.length,
        activeRidersCount: activeRiders.length,
        lowStockAlertsCount: 0,
        operationalAlertsCount: 0,
        syncTimestamp: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error loading dashboard:', error);
    res.status(500).json({ error: 'Failed to load franchise dashboard' });
  }
});

// ─── 4. FRANCHISE-SCOPED BRANCHES (GET / POST / PATCH) ───────────────────────
router.get('/:id/branches', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const bSnap = await adminDb.collection('franchises').get();
    const branches: any[] = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => b.franchiseId === id || (id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')));

    res.json({ success: true, branches });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list franchise branches' });
  }
});

router.post('/:id/branches', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, code, city, state, address, lat, lng, phone, email, maxDeliveryRadiusKm, openingTime, closingTime } = req.body;

    if (!name || !city) {
      res.status(400).json({ error: 'Branch name and city are required' });
      return;
    }

    const branchId = code 
      ? code.toLowerCase().replace(/[^a-z0-9]/g, '_') 
      : `${city.toLowerCase().replace(/[^a-z0-9]/g, '_')}_branch_${Date.now().toString().slice(-4)}`;

    const branchData = {
      id: branchId,
      franchiseId: id,
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      name: name.trim(),
      code: code ? code.trim().toUpperCase() : `OP-${city.slice(0, 3).toUpperCase()}-02`,
      city: city.trim(),
      state: state ? state.trim() : 'Chhattisgarh',
      address: address ? address.trim() : `${city}, Chhattisgarh`,
      lat: Number(lat) || 21.0810244,
      lng: Number(lng) || 81.0123793,
      phone: phone || '+91 91799 44445',
      email: email || `branch.${branchId}@olivepizza.in`,
      maxDeliveryRadiusKm: Number(maxDeliveryRadiusKm) || 12,
      openingTime: openingTime || '12:00',
      closingTime: closingTime || '23:59',
      isActive: true,
      isHeadquarters: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.user?.uid || 'owner'
    };

    await adminDb.collection('franchises').doc(branchId).set(branchData, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      organizationId: branchData.organizationId,
      franchiseId: id,
      branchId: branchData.id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'BRANCH_CREATED',
      entityType: 'franchise_branch',
      entityId: branchId,
      details: branchData
    });

    res.status(201).json({ success: true, branch: branchData });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create branch' });
  }
});

// ─── 5. RESTAURANT MANAGERS SCOPED TO FRANCHISE ─────────────────────────────
router.get('/:id/managers', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const bSnap = await adminDb.collection('franchises').get();
    const branchIds = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => b.franchiseId === id || (id === 'fra_rajnandgaon' && b.id === 'main_branch'))
      .map(b => b.id);

    const mgrSnap = await adminDb.collection('restaurant_managers').get();
    const managers: any[] = mgrSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(m => m.franchiseId === id || branchIds.includes(m.branchId))
      .map(({ pinHash, ...safe }) => safe);

    res.json({ success: true, managers });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list restaurant managers' });
  }
});

// GET /:id/restaurant-managers/pending - Owner Approval Queue
router.get('/:id/restaurant-managers/pending', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const snap = await adminDb.collection('restaurant_managers').where('status', '==', 'PENDING_OWNER_APPROVAL').get();
    let pending = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    if (id !== 'all') {
      pending = pending.filter(m => m.franchiseId === id);
    }
    const safePending = pending.map(({ pinHash, ...safe }) => safe);
    res.json({ success: true, pending: safePending });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch pending managers' });
  }
});

// POST /:id/restaurant-managers/:managerId/approve - Owner Approves Restaurant Manager
router.post('/:id/restaurant-managers/:managerId/approve', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, managerId } = req.params;
    const mgrRef = adminDb.collection('restaurant_managers').doc(managerId);
    const mgrDoc = await mgrRef.get();

    if (!mgrDoc.exists) {
      res.status(404).json({ error: 'Restaurant Manager record not found' });
      return;
    }

    const now = new Date().toISOString();
    await mgrRef.set({
      status: 'APPROVED',
      approvedAt: now,
      approvedByUid: req.user?.uid || 'owner',
      approvedByEmail: req.user?.email || 'owner@olivepizza.in',
      updatedAt: now
    }, { merge: true });

    // Also update users collection if exists
    const uid = mgrDoc.data()?.uid || managerId;
    await adminDb.collection('users').doc(uid).set({
      role: 'restaurant_manager',
      status: 'APPROVED',
      isActive: true,
      updatedAt: now
    }, { merge: true }).catch(() => {});

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'RESTAURANT_MANAGER_APPROVED',
      entityType: 'restaurant_manager',
      entityId: managerId,
      details: { managerId, email: mgrDoc.data()?.email }
    });

    res.json({ success: true, message: 'Restaurant Manager approved successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to approve restaurant manager' });
  }
});

// POST /:id/restaurant-managers/:managerId/reject - Owner Rejects Restaurant Manager
router.post('/:id/restaurant-managers/:managerId/reject', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, managerId } = req.params;
    const { reason } = req.body;
    const mgrRef = adminDb.collection('restaurant_managers').doc(managerId);
    const mgrDoc = await mgrRef.get();

    if (!mgrDoc.exists) {
      res.status(404).json({ error: 'Restaurant Manager record not found' });
      return;
    }

    const now = new Date().toISOString();
    await mgrRef.set({
      status: 'REJECTED',
      rejectionReason: reason || 'Application rejected by platform owner',
      rejectedAt: now,
      rejectedByUid: req.user?.uid || 'owner',
      rejectedByEmail: req.user?.email || 'owner@olivepizza.in',
      updatedAt: now
    }, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'RESTAURANT_MANAGER_REJECTED',
      entityType: 'restaurant_manager',
      entityId: managerId,
      details: { managerId, reason }
    });

    res.json({ success: true, message: 'Restaurant Manager request rejected' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to reject restaurant manager' });
  }
});

// POST /:id/managers - Provision Restaurant Manager (Max 1 per franchise)
router.post('/:id/managers', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const { name, email, phone, branchId, permissions, pin } = req.body;

    if (!name || !email) {
      res.status(400).json({ error: 'Manager name and email are required' });
      return;
    }

    if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
      res.status(400).json({ error: 'A 4-digit PIN is strictly required' });
      return;
    }

    let pinHash: string;
    try {
      pinHash = await FranchisePinService.hashPin(String(pin).trim());
    } catch (pinErr: any) {
      res.status(400).json({ error: pinErr.message || 'Invalid PIN' });
      return;
    }

    // Atomic Uniqueness Constraint: Max 1 active/pending Restaurant Manager account per franchise
    const existingMgrsSnap = await adminDb.collection('restaurant_managers')
      .where('franchiseId', '==', id)
      .get();
    const existingActive = existingMgrsSnap.docs.filter(d => {
      const data = d.data();
      return data.isActive !== false && ['APPROVED', 'PENDING_OWNER_APPROVAL'].includes(data.status || 'APPROVED');
    });

    if (existingActive.length > 0) {
      res.status(409).json({
        error: 'A Restaurant Manager account already exists for this franchise. Maximum 1 account permitted.',
        code: 'LIMIT_EXCEEDED'
      });
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const mgrId = `mgr_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`;
    const now = new Date().toISOString();

    let targetUid = mgrId;
    try {
      const existingAuth = await adminAuth.getUserByEmail(cleanEmail);
      targetUid = existingAuth.uid;
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        const secureRandomPassword = crypto.randomBytes(12).toString('base64url') + '!OP9';
        const createdAuth = await adminAuth.createUser({
          email: cleanEmail,
          password: secureRandomPassword,
          displayName: name.trim()
        });
        targetUid = createdAuth.uid;
      }
    }

    const initialStatus = isOwner ? 'APPROVED' : 'PENDING_OWNER_APPROVAL';

    const managerData: Record<string, any> = {
      id: mgrId,
      uid: targetUid,
      name: name.trim(),
      email: cleanEmail,
      phone: phone || '',
      role: 'restaurant_manager',
      status: initialStatus,
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: id,
      branchId: branchId || 'main_branch',
      permissions: permissions || ['dashboard.view', 'orders.live', 'orders.history', 'inventory.view', 'notifications.send'],
      isActive: true,
      hasPin: true,
      pinHash,
      failedPinAttempts: 0,
      createdAt: now,
      updatedAt: now,
      invitedBy: req.user?.uid || 'franchise_manager',
      invitedByEmail: req.user?.email || 'manager@olivepizza.in'
    };

    await adminDb.collection('restaurant_managers').doc(mgrId).set(managerData, { merge: true });
    if (targetUid !== mgrId) {
      await adminDb.collection('restaurant_managers').doc(targetUid).set(managerData, { merge: true });
    }

    await adminDb.collection('users').doc(targetUid).set({
      uid: targetUid,
      name: managerData.name,
      email: cleanEmail,
      role: 'restaurant_manager',
      status: initialStatus,
      franchiseId: id,
      branchId: managerData.branchId,
      isActive: true,
      updatedAt: now
    }, { merge: true }).catch(() => {});

    await FranchiseScopeService.logFranchiseAudit({
      organizationId: managerData.organizationId,
      franchiseId: id,
      branchId: managerData.branchId,
      actorUid: req.user?.uid || 'franchise_manager',
      actorEmail: req.user?.email || 'manager@olivepizza.in',
      actionType: 'MANAGER_PROVISIONED',
      entityType: 'restaurant_manager',
      entityId: mgrId,
      details: { name: managerData.name, email: cleanEmail, status: initialStatus, branchId: managerData.branchId }
    });

    const { pinHash: _omitted, ...safeManagerData } = managerData;
    res.status(201).json({ success: true, manager: safeManagerData });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to provision restaurant manager' });
  }
});

// ─── 5.1 SET / UPDATE MANAGER PIN (POST /:id/managers/:managerId/set-pin) ──
router.post('/:id/managers/:managerId/set-pin', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, managerId } = req.params;
    const { pin } = req.body;

    if (!pin) {
      res.status(400).json({ success: false, error: 'PIN is required' });
      return;
    }

    let pinHash: string;
    try {
      pinHash = await FranchisePinService.hashPin(pin);
    } catch (pinErr: any) {
      res.status(400).json({ success: false, error: pinErr.message || 'Invalid PIN' });
      return;
    }

    const now = new Date().toISOString();
    const pinPayload = {
      pinHash,
      hasPin: true,
      failedPinAttempts: 0,
      pinLockedUntil: null,
      pinUpdatedAt: now,
      updatedAt: now,
      updatedBy: req.user?.email || 'owner'
    };

    // Update in restaurant_managers
    const mgrRef = adminDb.collection('restaurant_managers').doc(managerId);
    const mgrDoc = await mgrRef.get();
    if (mgrDoc.exists) {
      await mgrRef.set(pinPayload, { merge: true });
    }

    // Update in franchise_users
    const fuRef = adminDb.collection('franchise_users').doc(managerId);
    const fuDoc = await fuRef.get();
    if (fuDoc.exists) {
      await fuRef.set(pinPayload, { merge: true });
    }

    // Update in users collection if exists
    const uRef = adminDb.collection('users').doc(managerId);
    const uDoc = await uRef.get();
    if (uDoc.exists) {
      await uRef.set(pinPayload, { merge: true });
    }

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'MANAGER_PIN_SET',
      entityType: 'restaurant_manager',
      entityId: managerId,
      details: { managerId, updatedBy: req.user?.email }
    });

    res.json({ success: true, message: 'Manager PIN updated successfully' });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error setting manager PIN:', error);
    res.status(500).json({ success: false, error: 'Failed to set manager PIN' });
  }
});

// ─── 5.2 SERVER-SIDE PIN VERIFICATION (POST /verify-pin) ────────────────────
router.post('/verify-pin', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { pin } = req.body;
    const uid = req.user?.uid;
    const email = req.user?.email;

    if (!pin) {
      res.status(400).json({ success: false, error: 'PIN is required' });
      return;
    }

    if (!uid) {
      res.status(401).json({ success: false, error: 'User must be authenticated' });
      return;
    }

    // Lookup user record in Firestore (restaurant_managers, franchise_users, or users)
    let userDoc = await adminDb.collection('franchise_users').doc(uid).get();
    let collectionName = 'franchise_users';

    if (!userDoc.exists) {
      userDoc = await adminDb.collection('restaurant_managers').doc(uid).get();
      collectionName = 'restaurant_managers';
    }
    if (!userDoc.exists) {
      userDoc = await adminDb.collection('users').doc(uid).get();
      collectionName = 'users';
    }

    // Also check query by email if not found by UID
    if (!userDoc.exists && email) {
      const qSnap = await adminDb.collection('restaurant_managers').where('email', '==', email.toLowerCase()).limit(1).get();
      if (!qSnap.empty) {
        userDoc = qSnap.docs[0];
        collectionName = 'restaurant_managers';
      }
    }

    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'Manager account record not found' });
      return;
    }

    const userData = userDoc.data() as any;
    const pinHash = userData?.pinHash;
    const failedAttempts = userData?.failedPinAttempts || 0;
    const lockedUntil = userData?.pinLockedUntil;

    // Check account lockout
    if (FranchisePinService.isAccountLocked(failedAttempts, lockedUntil)) {
      const remainingMinutes = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / (60 * 1000));
      res.status(423).json({
        success: false,
        isLocked: true,
        error: `Account is locked due to too many failed PIN attempts. Try again in ${remainingMinutes} minute(s).`
      });
      return;
    }

    if (!pinHash) {
      res.status(400).json({
        success: false,
        requiresPinSetup: true,
        error: 'No PIN has been configured for this account. Please ask the franchise owner to set your PIN.'
      });
      return;
    }

    // Constant-time bcrypt verify
    const isMatch = await FranchisePinService.verifyPin(pin.trim(), pinHash);

    if (!isMatch) {
      const nextAttempts = failedAttempts + 1;
      const isNowLocked = nextAttempts >= FranchisePinService.MAX_ATTEMPTS;
      const lockExpiry = isNowLocked ? FranchisePinService.getLockoutExpiry() : null;

      await adminDb.collection(collectionName).doc(userDoc.id).set({
        failedPinAttempts: nextAttempts,
        pinLockedUntil: lockExpiry,
        lastFailedPinAt: new Date().toISOString()
      }, { merge: true });

      if (isNowLocked) {
        res.status(423).json({
          success: false,
          isLocked: true,
          error: `Too many failed attempts. Account locked for ${FranchisePinService.LOCKOUT_MINUTES} minutes.`
        });
        return;
      }

      res.status(401).json({
        success: false,
        error: 'Incorrect PIN',
        attemptsRemaining: FranchisePinService.MAX_ATTEMPTS - nextAttempts
      });
      return;
    }

    // Success — reset failed counter
    await adminDb.collection(collectionName).doc(userDoc.id).set({
      failedPinAttempts: 0,
      pinLockedUntil: null,
      lastSuccessfulPinAt: new Date().toISOString()
    }, { merge: true });

    res.json({
      success: true,
      message: 'PIN verified successfully',
      franchiseId: userData?.franchiseId,
      branchId: userData?.branchId
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error verifying PIN:', error);
    res.status(500).json({ success: false, error: 'Failed to verify PIN' });
  }
});

// ─── 6. DELIVERY PARTNERS SCOPED TO FRANCHISE ───────────────────────────────
router.get('/:id/riders', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const riderSnap = await adminDb.collection('delivery_partners').get();
    const riders: any[] = riderSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(r => r.franchiseId === id || (id === 'fra_rajnandgaon' && (!r.franchiseId || r.branchId === 'main_branch')));

    res.json({ success: true, riders });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list delivery partners' });
  }
});

router.post('/:id/riders', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const { name, email, phone, branchId, vehicleNumber } = req.body;

    if (!name || !phone) {
      res.status(400).json({ error: 'Rider name and phone number are required' });
      return;
    }

    const cleanPhone = phone.trim().replace(/[^\d+]/g, '');
    const cleanEmail = email ? email.trim().toLowerCase() : `rider.${cleanPhone.replace(/\D/g, '')}@olivepizza.in`;
    const riderId = `rider_${cleanPhone.replace(/\D/g, '').slice(-6)}_${Date.now().toString().slice(-4)}`;
    const now = new Date().toISOString();

    let targetUid = riderId;
    try {
      const existingAuth = await adminAuth.getUserByEmail(cleanEmail);
      targetUid = existingAuth.uid;
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        const secureRandomPassword = crypto.randomBytes(12).toString('base64url') + '!OP9';
        const createdAuth = await adminAuth.createUser({
          email: cleanEmail,
          password: secureRandomPassword,
          displayName: name.trim()
        });
        targetUid = createdAuth.uid;
      }
    }

    const riderData = {
      id: riderId,
      uid: targetUid,
      name: name.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      role: 'delivery_partner',
      phoneVerified: true,
      franchiseId: id,
      branchId: branchId || 'main_branch',
      vehicleNumber: vehicleNumber || '',
      isActive: true,
      status: 'ACTIVE',
      isOnline: false,
      rating: 5.0,
      totalDeliveries: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.uid || 'franchise_manager',
      createdByEmail: req.user?.email || 'manager@olivepizza.in'
    };

    await adminDb.collection('delivery_partners').doc(riderId).set(riderData, { merge: true });
    if (targetUid !== riderId) {
      await adminDb.collection('delivery_partners').doc(targetUid).set(riderData, { merge: true });
    }

    await adminDb.collection('users').doc(targetUid).set({
      uid: targetUid,
      name: riderData.name,
      email: cleanEmail,
      phone: cleanPhone,
      phoneVerified: true,
      role: 'delivery_partner',
      franchiseId: id,
      branchId: riderData.branchId,
      isActive: true,
      vehicleNumber: riderData.vehicleNumber,
      updatedAt: now
    }, { merge: true }).catch(() => {});

    // Set active Firebase custom claims
    try {
      await adminAuth.setCustomUserClaims(targetUid, {
        role: 'delivery_partner',
        allowedApps: ['DELIVERY'],
        franchiseId: id,
        branchId: riderData.branchId
      });
    } catch (claimErr: any) {
      console.warn('[FranchiseRoutes] Custom claims warning on rider provision:', claimErr.message);
    }

    // Synchronize to PostgreSQL delivery_partners and app_users tables
    try {
      await query(
        `INSERT INTO delivery_partners (id, name, phone, email, franchise_id, branch_id, status, is_online, vehicle_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', false, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           franchise_id = EXCLUDED.franchise_id,
           branch_id = EXCLUDED.branch_id,
           status = 'APPROVED',
           vehicle_number = EXCLUDED.vehicle_number,
           updated_at = NOW()`,
        [targetUid, riderData.name, cleanPhone, cleanEmail, id, riderData.branchId, riderData.vehicleNumber]
      );
      await query(
        `INSERT INTO app_users (id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active, updated_at)
         VALUES ($1, $2, $3, $4, 'delivery_partner', 'APPROVED', $5, $6, '["DELIVERY"]'::jsonb, true, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           role = 'delivery_partner',
           status = 'APPROVED',
           franchise_id = EXCLUDED.franchise_id,
           branch_id = EXCLUDED.branch_id,
           allowed_apps = '["DELIVERY"]'::jsonb,
           is_active = true,
           updated_at = NOW()`,
        [targetUid, cleanEmail, cleanPhone, riderData.name, id, riderData.branchId]
      );
    } catch (pgSyncErr: any) {
      console.warn('[FranchiseRoutes] PostgreSQL rider sync notice:', pgSyncErr.message);
    }

    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: id,
      branchId: riderData.branchId,
      actorUid: req.user?.uid || 'franchise_manager',
      actorEmail: req.user?.email || 'manager@olivepizza.in',
      actionType: 'RIDER_PROVISIONED',
      entityType: 'delivery_partner',
      entityId: riderId,
      details: { name: riderData.name, email: cleanEmail, phone: cleanPhone, franchiseId: id }
    });

    res.status(201).json({ success: true, rider: riderData });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to provision delivery partner' });
  }
});

// PATCH /:id/riders/:riderId/status - Toggle Rider Status
router.patch('/:id/riders/:riderId/status', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, riderId } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const { isActive } = req.body;
    const now = new Date().toISOString();

    await adminDb.collection('delivery_partners').doc(riderId).set({
      isActive: Boolean(isActive),
      status: isActive ? 'ACTIVE' : 'INACTIVE',
      updatedAt: now,
      updatedBy: req.user?.email || 'manager'
    }, { merge: true });

    if (!isActive) {
      try {
        await adminAuth.revokeRefreshTokens(riderId);
        await adminAuth.setCustomUserClaims(riderId, { role: 'REVOKED', revokedAt: now });
        await adminDb.collection('users').doc(riderId).set({
          isActive: false,
          status: 'REVOKED',
          role: 'REVOKED',
          revokedAt: now,
          revokedReason: 'Deactivated by franchise manager'
        }, { merge: true });
      } catch (revErr) {
        console.warn('[FranchiseRoutes] Rider revocation warning:', revErr);
      }
    }

    // Synchronize PostgreSQL delivery_partners and app_users
    try {
      const nextStatus = isActive ? 'APPROVED' : 'DISABLED';
      await query(
        `UPDATE delivery_partners
         SET status = $2, is_online = $3, updated_at = NOW()
         WHERE id = $1`,
        [riderId, nextStatus, false]
      );
      await query(
        `UPDATE app_users
         SET status = $2, is_active = $3, updated_at = NOW()
         WHERE id = $1`,
        [riderId, nextStatus, Boolean(isActive)]
      );
    } catch (pgErr: any) {
      console.warn('[FranchiseRoutes] PostgreSQL rider status update notice:', pgErr.message);
    }

    res.json({ success: true, message: `Rider ${isActive ? 'activated' : 'deactivated'} successfully` });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update rider status' });
  }
});

// DELETE /:id/riders/:riderId - Delete Rider
router.delete('/:id/riders/:riderId', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, riderId } = req.params;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    const now = new Date().toISOString();
    try {
      await adminAuth.revokeRefreshTokens(riderId);
      await adminAuth.setCustomUserClaims(riderId, { role: 'REVOKED', revokedAt: now });
      await adminDb.collection('users').doc(riderId).set({
        isActive: false,
        status: 'REVOKED',
        role: 'REVOKED',
        revokedAt: now,
        revokedReason: 'Deleted by franchise manager'
      }, { merge: true });
    } catch (revErr) {
      console.warn('[FranchiseRoutes] Rider deletion revocation warning:', revErr);
    }

    await adminDb.collection('delivery_partners').doc(riderId).delete();

    // Synchronize PostgreSQL deletion/revocation
    try {
      await query(
        `UPDATE delivery_partners
         SET status = 'TERMINATED', is_online = false, updated_at = NOW()
         WHERE id = $1`,
        [riderId]
      );
      await query(
        `UPDATE app_users
         SET status = 'REVOKED', is_active = false, updated_at = NOW()
         WHERE id = $1`,
        [riderId]
      );
    } catch (pgErr: any) {
      console.warn('[FranchiseRoutes] PostgreSQL rider deletion notice:', pgErr.message);
    }

    res.json({ success: true, message: 'Rider deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete rider' });
  }
});

// PUT /:id/riders/:riderId/reassign - Reassign Rider to Branch/Franchise
router.put('/:id/riders/:riderId/reassign', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, riderId } = req.params;
    const { targetFranchiseId, targetBranchId, reason } = req.body;

    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);
    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    // Non-owners can only reassign to branches within their own franchise
    const destFranchise = targetFranchiseId || id;
    if (!isOwner && destFranchise !== id) {
      res.status(403).json({ error: 'Franchise managers cannot reassign riders to a different franchise without owner authorization' });
      return;
    }

    const destBranch = targetBranchId || 'main_branch';
    const now = new Date().toISOString();

    // 1. Update Firestore delivery_partners & users
    await adminDb.collection('delivery_partners').doc(riderId).set({
      franchiseId: destFranchise,
      branchId: destBranch,
      updatedAt: now,
      reassignedAt: now,
      reassignedBy: req.user?.email || 'manager',
      reassignmentReason: reason || 'Operational reassignment'
    }, { merge: true });

    await adminDb.collection('users').doc(riderId).set({
      franchiseId: destFranchise,
      branchId: destBranch,
      updatedAt: now
    }, { merge: true }).catch(() => {});

    // 2. Synchronize PostgreSQL delivery_partners and app_users
    try {
      await query(
        `UPDATE delivery_partners
         SET franchise_id = $2, branch_id = $3, is_online = false, updated_at = NOW()
         WHERE id = $1`,
        [riderId, destFranchise, destBranch]
      );
      await query(
        `UPDATE app_users
         SET franchise_id = $2, branch_id = $3, updated_at = NOW()
         WHERE id = $1`,
        [riderId, destFranchise, destBranch]
      );
    } catch (pgErr: any) {
      console.warn('[FranchiseRoutes] PostgreSQL rider reassignment notice:', pgErr.message);
    }

    // 3. Invalidate/revoke existing tokens & set updated custom claims
    try {
      await adminAuth.revokeRefreshTokens(riderId);
      await adminAuth.setCustomUserClaims(riderId, {
        role: 'delivery_partner',
        allowedApps: ['DELIVERY'],
        franchiseId: destFranchise,
        branchId: destBranch
      });
    } catch (authErr: any) {
      console.warn('[FranchiseRoutes] Rider reassignment token revocation notice:', authErr.message);
    }

    // 4. Audit Trail
    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: id,
      branchId: destBranch,
      actorUid: req.user?.uid || 'manager',
      actorEmail: req.user?.email || 'manager@olivepizza.in',
      actionType: 'RIDER_REASSIGNED',
      entityType: 'delivery_partner',
      entityId: riderId,
      details: {
        fromFranchiseId: id,
        toFranchiseId: destFranchise,
        toBranchId: destBranch,
        reason: reason || 'Operational reassignment'
      }
    });

    res.json({
      success: true,
      message: `Rider successfully reassigned to branch ${destBranch}`,
      franchiseId: destFranchise,
      branchId: destBranch
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to reassign delivery partner' });
  }
});

// ─── 7. POS TERMINAL MANAGEMENT (REGISTER / GENERATE CODE / REVOKE) ────────
router.get('/:id/pos-terminals', requireRole(['owner', 'admin', 'developer', 'franchise_owner', 'franchise_manager', 'manager', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const bSnap = await adminDb.collection('franchises').get();
    const branchIds = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => b.franchiseId === id || (id === 'fra_rajnandgaon' && b.id === 'main_branch'))
      .map(b => b.id);

    const posSnap = await adminDb.collection('pos_terminals').get();
    let terminals: any[] = posSnap.docs
      .map(d => {
        const data = d.data() as any;
        const { activationCode, ...safeData } = data;
        return { id: d.id, ...safeData };
      })
      .filter(t => t.franchiseId === id || branchIds.includes(t.branchId));

    res.json({ success: true, franchiseId: id, terminals });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list POS terminals' });
  }
});

router.post('/:id/pos-terminals/register', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const terminalName = typeof req.body?.terminalName === 'string' ? req.body.terminalName.trim() : '';
    const branchId = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';

    if (!terminalName || terminalName.length > 40 || !branchId) {
      res.status(400).json({ success: false, error: 'A terminal name (1–40 characters) and branch assignment are required.' });
      return;
    }

    const branchSnap = await adminDb.collection('franchises').doc(branchId).get();
    if (!branchSnap.exists || branchSnap.data()?.franchiseId !== id) {
      res.status(400).json({ success: false, code: 'BRANCH_NOT_IN_FRANCHISE', error: 'Select an existing branch belonging to this franchise.' });
      return;
    }

    // A franchise may have up to ten active/pending counters, matching the creation wizard.
    const posSnap = await adminDb.collection('pos_terminals').where('franchiseId', '==', id).get();
    const activeTerminals = posSnap.docs.filter(d => {
      const data = d.data();
      const state = String(data.status || data.activationStatus || '').toUpperCase();
      return data.isActive !== false && state !== 'REVOKED' && state !== 'DEACTIVATED';
    });

    if (activeTerminals.length >= 10) {
      res.status(409).json({
        success: false,
        error: 'This franchise has reached the limit of 10 active or pending POS terminals. Revoke an unused terminal before registering another.',
        code: 'LIMIT_EXCEEDED'
      });
      return;
    }

    const termId = `POS-${branchId.toUpperCase().slice(0, 18)}-${crypto.randomInt(1000, 10000)}`;
    const termRef = adminDb.collection('pos_terminals').doc(termId);
    if ((await termRef.get()).exists) {
      res.status(409).json({ success: false, code: 'TERMINAL_ID_CONFLICT', error: 'Terminal ID collision. Retry registration.' });
      return;
    }

    const activationCode = await generateUniquePosActivationCode();
    const activationCodeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const terminalData = {
      id: termId,
      terminalId: termId,
      terminalName,
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: id,
      branchId,
      branchName: branchSnap.data()?.name || branchId,
      activationCode,
      activationCodeExpiresAt,
      status: 'PENDING_ACTIVATION',
      activationStatus: 'PENDING_ACTIVATION',
      isActive: true,
      isOnline: false,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.uid
    };

    await termRef.create(terminalData);

    const warnings: string[] = [];
    try {
      await FranchiseScopeService.logFranchiseAudit({
        organizationId: terminalData.organizationId,
        franchiseId: id,
        branchId,
        actorUid: req.user?.uid || 'owner',
        actorEmail: req.user?.email || 'owner@olivepizza.in',
        actionType: 'POS_REGISTERED',
        entityType: 'pos_terminal',
        entityId: termId,
        details: { terminalName, activationExpiresAt: activationCodeExpiresAt }
      });
    } catch (auditError: any) {
      console.error('[POSRegister] Audit write failed after terminal creation:', auditError?.message);
      warnings.push('Terminal registered, but its audit event could not be saved. Review backend audit storage.');
    }

    res.status(201).json({
      success: true,
      terminal: { ...terminalData, activationCode: undefined },
      activationCode,
      activationCodeExpiresAt,
      warnings
    });
  } catch (error: any) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({ success: false, error: error.message || 'Failed to register POS terminal' });
  }
});

// POST /:id/pos-terminals/:termId/activate - Franchise Manager activates Owner-provisioned POS with PIN
router.post('/:id/pos-terminals/:termId/activate', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, termId } = req.params;
    const { pin } = req.body;
    const isOwner = FranchiseScopeService.isGlobalOwner(req.user?.email, req.user?.role);

    if (!isOwner && req.user?.franchiseId && req.user.franchiseId !== id) {
      res.status(403).json({ error: 'Cross-franchise access denied' });
      return;
    }

    if (!pin || !/^\d{4}$/.test(String(pin).trim())) {
      res.status(400).json({ error: 'Franchise 4-digit PIN is required to activate POS' });
      return;
    }

    // Verify caller's PIN
    const callerUid = req.user!.uid;
    let userDoc = await adminDb.collection('franchise_users').doc(callerUid).get();
    if (!userDoc.exists) {
      userDoc = await adminDb.collection('restaurant_managers').doc(callerUid).get();
    }
    if (!userDoc.exists) {
      userDoc = await adminDb.collection('users').doc(callerUid).get();
    }
    if (!userDoc.exists && req.user?.email) {
      const snap = await adminDb.collection('franchise_users').where('email', '==', req.user.email.toLowerCase()).limit(1).get();
      if (!snap.empty) userDoc = snap.docs[0];
      else {
        const uSnap = await adminDb.collection('users').where('email', '==', req.user.email.toLowerCase()).limit(1).get();
        if (!uSnap.empty) userDoc = uSnap.docs[0];
      }
    }

    if (!userDoc.exists) {
      res.status(404).json({ error: 'Franchise manager account not found' });
      return;
    }

    const pinHash = userDoc.data()?.pinHash;
    if (!pinHash) {
      res.status(400).json({ error: 'No PIN configured for your account. Please set a PIN first.' });
      return;
    }

    const isMatch = await FranchisePinService.verifyPin(String(pin).trim(), pinHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Incorrect Franchise PIN' });
      return;
    }

    const termRef = adminDb.collection('pos_terminals').doc(termId);
    const termDoc = await termRef.get();
    if (!termDoc.exists) {
      res.status(404).json({ error: 'POS terminal not found' });
      return;
    }

    const now = new Date().toISOString();
    await termRef.set({
      activationStatus: 'ACTIVATED',
      isActive: true,
      activatedAt: now,
      activatedByUid: callerUid,
      activatedByEmail: req.user?.email || '',
      updatedAt: now
    }, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: callerUid,
      actorEmail: req.user?.email || 'manager@olivepizza.in',
      actionType: 'POS_ACTIVATED',
      entityType: 'pos_terminal',
      entityId: termId,
      details: { activatedAt: now }
    });

    res.json({ success: true, message: 'POS Terminal activated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to activate POS terminal' });
  }
});

router.post('/:id/pos-terminals/:termId/revoke', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, termId } = req.params;
    const now = new Date().toISOString();

    await adminDb.collection('pos_terminals').doc(termId).set({
      isActive: false,
      activationStatus: 'REVOKED',
      revokedAt: now,
      revokedBy: req.user?.uid || 'owner'
    }, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'POS_REVOKED',
      entityType: 'pos_terminal',
      entityId: termId,
      details: { status: 'REVOKED' }
    });

    res.json({ success: true, message: 'POS terminal revoked successfully' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to revoke POS terminal' });
  }
});

// ─── 8. LIVE & HISTORICAL ORDERS FOR THIS FRANCHISE ─────────────────────────
router.get('/:id/orders/live', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    if (!scope.isGlobalOwner && scope.franchiseId !== id && scope.franchiseId !== `fra_${id}`) {
      res.status(403).json({ error: 'Unauthorized: Scope mismatch', code: 'FORBIDDEN' });
      return;
    }
    const bSnap = await adminDb.collection('franchises').get();
    const branchIds = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => b.franchiseId === id || (id === 'fra_rajnandgaon' && b.id === 'main_branch'))
      .map(b => b.id);

    const orderSnap = await adminDb.collection('orders').limit(100).get();
    const activeStatuses = ['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'];

    const liveOrders = orderSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(o => {
        const bId = o.branchId || 'main_branch';
        const s = (o.status || 'pending').toLowerCase();
        return (branchIds.includes(bId) || (id === 'fra_rajnandgaon' && bId === 'main_branch')) && activeStatuses.includes(s);
      });

    res.json({ success: true, orders: liveOrders });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch live orders for franchise' });
  }
});

// ─── 9. FRANCHISE REPORTS & MONTHLY ACCOUNTING ──────────────────────────────
router.get('/:id/reports', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    if (!scope.isGlobalOwner && scope.franchiseId !== id && scope.franchiseId !== `fra_${id}`) {
      res.status(403).json({ error: 'Unauthorized: Scope mismatch', code: 'FORBIDDEN' });
      return;
    }
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthStart = `${currentMonth}-01T00:00:00.000Z`;
    const monthEnd = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)).toISOString();

    // 1. Resolve branch IDs belonging to this franchise
    const bSnap = await adminDb.collection('franchises').get().catch(() => ({ docs: [] } as any));
    const branchIds = bSnap.docs
      .map((d: any) => ({ id: d.id, ...(d.data() as any) }))
      .filter((b: any) => 
        b.franchiseId === id || 
        b.franchiseId === `fra_${id}` || 
        b.id === id || 
        b.id === `${id}_branch` || 
        (id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary'))
      )
      .map((b: any) => b.id);
    if (!branchIds.includes(id)) branchIds.push(id);

    // 2. Query orders
    const orderSnap = await adminDb.collection('orders').where('franchiseId', '==', id).get().catch(async () => await adminDb.collection('orders').get().catch(() => ({ docs: [] } as any)));

    const parseOrderIso = (val: any): string => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (val.toDate && typeof val.toDate === 'function') return val.toDate().toISOString();
      if (typeof val._seconds === 'number') return new Date(val._seconds * 1000).toISOString();
      if (typeof val.seconds === 'number') return new Date(val.seconds * 1000).toISOString();
      if (val instanceof Date) return val.toISOString();
      return '';
    };

    let grossRevenue = 0;
    let totalOrders = 0;
    let posSales = 0;
    let onlineSales = 0;
    let taxCgst = 0;
    let taxSgst = 0;
    let discountsGiven = 0;
    let refunds = 0;

    orderSnap.docs.forEach((d: any) => {
      const o = d.data() as any;
      const bId = o.branchId || 'main_branch';
      const isFranchiseOrder = 
        o.franchiseId === id || 
        o.franchiseId === `fra_${id}` || 
        branchIds.includes(bId) || 
        (id === 'fra_rajnandgaon' && (!o.franchiseId || o.franchiseId === 'fra_primary' || bId === 'main_branch' || bId === 'branch_rjn'));

      if (!isFranchiseOrder) return;

      const oDate = parseOrderIso(o.createdAt);
      if (oDate && (oDate < monthStart || oDate >= monthEnd)) return;

      const amt = Number(o.totalAmount || 0);
      const status = (o.status || '').toLowerCase();
      if (status === 'cancelled' || status === 'rejected') return;

      grossRevenue += amt;
      totalOrders++;

      const source = (o.orderSource || '').toLowerCase();
      if (source === 'pos' || source.startsWith('pos_')) posSales += amt;
      else onlineSales += amt;

      taxCgst += Number(o.cgst || (o.taxAmount ? Number(o.taxAmount || 0) / 2 : 0));
      taxSgst += Number(o.sgst || (o.taxAmount ? Number(o.taxAmount || 0) / 2 : 0));
      discountsGiven += Number(o.discountAmount || 0);
      if (status === 'refunded') refunds += amt;
    });

    const netSales = grossRevenue - discountsGiven - refunds;

    // Get Google Sheets status for this franchise
    let sheetsStatus: any = { status: 'UNKNOWN' };
    try {
      sheetsStatus = await FranchiseGoogleSheetsService.getFranchiseSheetsStatus(id) || { status: 'PROVISIONING_PENDING' };
    } catch { /* Sheets may not be configured */ }

    res.json({
      success: true,
      reports: {
        franchiseId: id,
        currentMonth,
        googleSheetsStatus: {
          status: sheetsStatus.status || 'UNKNOWN',
          workbookName: sheetsStatus.spreadsheetName || `Olive Pizza — ${id.toUpperCase()} — ${currentMonth}`,
          lastSyncTime: sheetsStatus.lastSyncedAt || null,
          pendingRecords: sheetsStatus.pendingSyncCount || 0,
          failedRecords: sheetsStatus.failedSyncCount || 0
        },
        monthlySalesSummary: {
          grossRevenue: Math.round(grossRevenue),
          netSales: Math.round(netSales),
          totalOrders,
          posSales: Math.round(posSales),
          onlineSales: Math.round(onlineSales),
          taxCgst: Math.round(taxCgst),
          taxSgst: Math.round(taxSgst),
          discountsGiven: Math.round(discountsGiven),
          refunds: Math.round(refunds)
        }
      }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error in GET /:id/reports:', error);
    res.status(500).json({ error: 'Failed to fetch franchise reports' });
  }
});

// ─── 10. FRANCHISE AUDIT LOGS ───────────────────────────────────────────────
router.get('/:id/audit-logs', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    if (!scope.isGlobalOwner && scope.franchiseId !== id && scope.franchiseId !== `fra_${id}`) {
      res.status(403).json({ error: 'Unauthorized: Scope mismatch', code: 'FORBIDDEN' });
      return;
    }
    const snap = await adminDb.collection('franchise_audit_logs').limit(50).get().catch(() => ({ docs: [] } as any));
    const logs = snap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(l => l.franchiseId === id || !l.franchiseId);

    res.json({ success: true, auditLogs: logs });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ─── 11. FRANCHISE SETTINGS UPDATE (PATCH /:id/settings) ─────────────────────
router.patch('/:id/settings', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { businessHours, deliverySettings, contactPhone, contactEmail } = req.body;

    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'owner'
    };

    if (businessHours) updates.businessHours = businessHours;
    if (deliverySettings) updates.deliverySettings = deliverySettings;
    if (contactPhone) updates.contactPhone = contactPhone;
    if (contactEmail) updates.contactEmail = contactEmail;

    await adminDb.collection('franchise_entities').doc(id).set(updates, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'SETTINGS_UPDATED',
      entityType: 'franchise_settings',
      entityId: id,
      details: updates
    });

    res.json({ success: true, message: 'Franchise settings updated successfully', updates });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update franchise settings' });
  }
});

// ─── 12. FRANCHISE PROVISIONING WIZARD ────────────────────────────────────────
router.post('/provision', requireRole(['owner', 'admin', 'developer', 'platform_admin', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
    const validEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
    const validTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    const problems: string[] = [];

    const name = cleanString(body.name);
    const city = cleanString(body.city);
    const state = cleanString(body.state);
    const address = cleanString(body.address);
    const phone = cleanString(body.phone);
    const contactEmail = cleanString(body.email).toLowerCase();
    const requestedCode = cleanString(body.code).toUpperCase();
    const franchiseOwnerEmail = cleanString(body.franchiseOwnerEmail).toLowerCase();
    const restaurantManagerEmail = cleanString(body.restaurantManagerEmail).toLowerCase();
    const franchiseOwnerName = cleanString(body.franchiseOwnerName);
    const restaurantManagerName = cleanString(body.restaurantManagerName);
    const openingTime = cleanString(body.openingTime);
    const closingTime = cleanString(body.closingTime);
    const acceptingOrders = body.acceptingOrders === true;
    const radiusInput = body.maxDeliveryRadiusKm === undefined ? 12 : Number(body.maxDeliveryRadiusKm);
    const deliveryFee = body.deliveryFee === undefined ? 30 : Number(body.deliveryFee);
    const freeDeliveryThreshold = body.freeDeliveryThreshold === undefined ? 299 : Number(body.freeDeliveryThreshold);
    const minOrderAmount = body.minOrderAmount === undefined ? 99 : Number(body.minOrderAmount);
    const terminalCount = body.posTerminalCount === undefined ? 1 : Number(body.posTerminalCount);
    const lat = Number(body.lat);
    const lng = Number(body.lng);

    if (!name || name.length > 120) problems.push('Franchise name is required and must be at most 120 characters.');
    if (!city || city.length > 80) problems.push('City is required and must be at most 80 characters.');
    if (!state || state.length > 80) problems.push('State is required and must be at most 80 characters.');
    if (address.length < 5 || address.length > 280) problems.push('A full street address is required (5–280 characters).');
    if (body.lat === undefined || body.lat === null || !Number.isFinite(lat) || lat < -90 || lat > 90) problems.push('A valid map latitude is required.');
    if (body.lng === undefined || body.lng === null || !Number.isFinite(lng) || lng < -180 || lng > 180) problems.push('A valid map longitude is required.');
    if (phone && (!/^[+\d()\-\s]{7,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15)) problems.push('Store phone must contain 7–15 digits and only standard phone punctuation.');
    if (contactEmail && !validEmail(contactEmail)) problems.push('Store contact email is invalid.');
    if (franchiseOwnerEmail && !validEmail(franchiseOwnerEmail)) problems.push('Franchise-owner email is invalid.');
    if (restaurantManagerEmail && !validEmail(restaurantManagerEmail)) problems.push('Restaurant-manager email is invalid.');
    if (franchiseOwnerEmail && restaurantManagerEmail && franchiseOwnerEmail === restaurantManagerEmail) problems.push('Use different accounts for franchise owner and restaurant manager.');
    if (!validTime(openingTime) || !validTime(closingTime)) problems.push('Opening and closing times must use valid 24-hour HH:MM values.');
    if (!Number.isFinite(radiusInput) || radiusInput < 1 || radiusInput > 50) problems.push('Delivery radius must be between 1 and 50 km.');
    if (![deliveryFee, freeDeliveryThreshold, minOrderAmount].every(value => Number.isFinite(value) && value >= 0 && value <= 1000000)) problems.push('Delivery fee, free-delivery threshold, and minimum order must be finite values from ₹0 to ₹10,00,000.');
    if (!Number.isInteger(terminalCount) || terminalCount < 1 || terminalCount > 10) problems.push('POS terminal count must be an integer between 1 and 10.');

    const terminalNames = Array.isArray(body.posTerminalNames) ? body.posTerminalNames.map((value: unknown) => cleanString(value)) : [];
    if (terminalNames.length && (terminalNames.length !== terminalCount || terminalNames.some((value: string) => !value || value.length > 40))) {
      problems.push('Provide one non-empty POS terminal name (maximum 40 characters) for every terminal.');
    }
    if (terminalNames.length && new Set(terminalNames.map((value: string) => value.toLowerCase())).size !== terminalNames.length) {
      problems.push('POS terminal names must be unique within the new franchise.');
    }
    if (requestedCode && !/^[A-Z0-9][A-Z0-9_-]{2,19}$/.test(requestedCode)) {
      problems.push('Franchise code must be 3–20 letters, digits, hyphens, or underscores.');
    }

    if (problems.length) {
      res.status(400).json({ success: false, code: 'INVALID_FRANCHISE_INPUT', error: problems[0], errors: problems });
      return;
    }

    // Organization tenancy is server-owned; never accept it from the browser.
    const orgId = FranchiseScopeService.DEFAULT_ORG_ID;
    const cleanCode = requestedCode || `OP-${city.normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')}-${crypto.randomInt(1000, 10000)}`;
    const franchiseId = `fra_${cleanCode.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
    const branchId = `${franchiseId}_main_branch`;
    const citySlug = city.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'location';
    const slug = `${citySlug}-${cleanCode.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const branchCode = `${cleanCode}-B01`;
    const now = new Date().toISOString();
    const radius = radiusInput;
    const posNames = terminalNames.length
      ? terminalNames
      : Array.from({ length: terminalCount }, (_, index) => `Counter ${index + 1}`);

    // Validate optional access grants before writing any franchise data. Do not fabricate
    // Firestore "users" documents from email addresses; they are not Firebase identities.
    const resolvedAccounts: { uid: string; email: string; role: 'franchise_owner' | 'restaurant_manager'; name: string }[] = [];
    for (const candidate of [
      franchiseOwnerEmail ? { email: franchiseOwnerEmail, role: 'franchise_owner' as const, name: franchiseOwnerName || 'Franchise Owner' } : null,
      restaurantManagerEmail ? { email: restaurantManagerEmail, role: 'restaurant_manager' as const, name: restaurantManagerName || 'Restaurant Manager' } : null
    ]) {
      if (!candidate) continue;
      if (!adminAuth) {
        res.status(503).json({ success: false, error: 'Firebase Authentication is unavailable. No franchise records have been created; retry after authentication service recovers.' });
        return;
      }
      try {
        const authUser = await adminAuth.getUserByEmail(candidate.email);
        if (authUser.disabled) {
          res.status(422).json({ success: false, code: 'STAFF_ACCOUNT_DISABLED', error: `The account ${candidate.email} is disabled in Firebase Authentication.` });
          return;
        }
        if (!authUser.emailVerified) {
          res.status(422).json({ success: false, code: 'STAFF_EMAIL_NOT_VERIFIED', error: `Verify ${candidate.email} in Firebase Authentication before assigning franchise access, or leave the account field blank and assign it later.` });
          return;
        }
        const userSnap = await adminDb.collection('users').doc(authUser.uid).get();
        const userRecord = userSnap.data() || {};
        const currentRole = String(userRecord.role || '').toLowerCase();
        const claimRole = String((authUser.customClaims as Record<string, unknown> | undefined)?.role || '').toLowerCase();
        const protectedRoles = new Set(['owner', 'platform_owner', 'admin', 'developer', 'platform_admin']);
        if (
          authUser.uid === req.user?.uid ||
          protectedRoles.has(currentRole) ||
          protectedRoles.has(claimRole) ||
          userRecord.isOwnerMode === true ||
          userRecord.isGlobalOwner === true ||
          userRecord.admin === true
        ) {
          res.status(409).json({
            success: false,
            code: 'PROTECTED_ACCOUNT_CANNOT_BE_ASSIGNED',
            error: `${candidate.email} is a platform-level or current owner account and cannot be reassigned as franchise staff. Use a separate verified staff account.`
          });
          return;
        }
        resolvedAccounts.push({ uid: authUser.uid, email: candidate.email, role: candidate.role, name: candidate.name });
      } catch (authError: any) {
        if (authError?.code === 'auth/user-not-found') {
          res.status(422).json({ success: false, code: 'STAFF_ACCOUNT_NOT_FOUND', error: `No Firebase sign-in account exists for ${candidate.email}. Create and verify that account first, or leave the field blank and assign it later.` });
          return;
        }
        throw authError;
      }
    }

    // Explicit and generated codes must be unique across canonical franchise and branch records.
    const [entityCodeSnap, branchCodeSnap] = await Promise.all([
      adminDb.collection('franchise_entities').where('code', '==', cleanCode).limit(1).get(),
      adminDb.collection('franchises').where('code', '==', branchCode).limit(1).get()
    ]);
    if (!entityCodeSnap.empty || !branchCodeSnap.empty) {
      res.status(409).json({ success: false, code: 'FRANCHISE_CODE_CONFLICT', error: 'This franchise code is already in use. Choose a different code.' });
      return;
    }

    const deliverySettings = {
      maxDeliveryRadiusKm: radius,
      deliveryFee,
      freeDeliveryThreshold,
      minOrderAmount
    };
    const businessHours = { openingTime, closingTime, isOpenToday: true };
    const franchiseEntity: FranchiseEntity & Record<string, any> = {
      id: franchiseId,
      slug,
      organizationId: orgId,
      name,
      code: cleanCode,
      region: state,
      city,
      contactEmail,
      contactPhone: phone,
      franchiseOwnerName: franchiseOwnerName || undefined,
      franchiseOwnerEmail: franchiseOwnerEmail || undefined,
      restaurantManagerName: restaurantManagerName || undefined,
      restaurantManagerEmail: restaurantManagerEmail || undefined,
      address,
      lat,
      lng,
      mainBranchId: branchId,
      isActive: true,
      status: 'ACTIVE',
      businessHours,
      deliverySettings,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.uid
    };
    const branchData: Record<string, any> = {
      id: branchId,
      franchiseId,
      organizationId: orgId,
      name: `${name} (Main Branch)`,
      code: branchCode,
      franchiseCode: cleanCode,
      city,
      state,
      address,
      lat,
      lng,
      phone,
      email: contactEmail,
      franchiseOwnerName: franchiseOwnerName || undefined,
      franchiseOwnerEmail: franchiseOwnerEmail || undefined,
      restaurantManagerName: restaurantManagerName || undefined,
      restaurantManagerEmail: restaurantManagerEmail || undefined,
      maxDeliveryRadiusKm: radius,
      deliveryFee,
      freeDeliveryThreshold,
      minOrderAmount,
      deliverySettings,
      openingTime,
      closingTime,
      acceptingOrders,
      isOpen: acceptingOrders,
      closeReason: acceptingOrders ? '' : 'Pending franchise launch checks',
      status: 'ACTIVE',
      isActive: true,
      isHeadquarters: false,
      posTerminalCount: terminalCount,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user?.uid
    };
    const dailyHours = {
      sunday: { open: openingTime, close: closingTime, isOpen: true },
      monday: { open: openingTime, close: closingTime, isOpen: true },
      tuesday: { open: openingTime, close: closingTime, isOpen: true },
      wednesday: { open: openingTime, close: closingTime, isOpen: true },
      thursday: { open: openingTime, close: closingTime, isOpen: true },
      friday: { open: openingTime, close: closingTime, isOpen: true },
      saturday: { open: openingTime, close: closingTime, isOpen: true }
    };
    const entityRef = adminDb.collection('franchise_entities').doc(franchiseId);
    const branchRef = adminDb.collection('franchises').doc(branchId);
    const settingsRef = adminDb.collection('restaurant_settings').doc(branchId);
    const activationCodeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const reservedActivationCodes = new Set<string>();
    const terminalRefs: Array<{ id: string; name: string; activationCode: string }> = [];
    for (let index = 0; index < posNames.length; index += 1) {
      terminalRefs.push({
        id: `POS-${branchId.toUpperCase().slice(0, 18)}-${crypto.randomInt(1000, 10000)}-${index + 1}`,
        name: posNames[index],
        activationCode: await generateUniquePosActivationCode(reservedActivationCodes)
      });
    }
    const warnings: string[] = [];

    // All core records are created together. A duplicate ID/race cannot merge over an existing franchise.
    await adminDb.runTransaction(async (transaction) => {
      const [entitySnap, branchSnap, settingsSnap] = await Promise.all([
        transaction.get(entityRef),
        transaction.get(branchRef),
        transaction.get(settingsRef)
      ]);
      if (entitySnap.exists || branchSnap.exists || settingsSnap.exists) {
        const conflict: any = new Error('A franchise with this ID already exists. Choose a different franchise code.');
        conflict.status = 409;
        conflict.code = 'FRANCHISE_ID_CONFLICT';
        throw conflict;
      }
      transaction.create(entityRef, franchiseEntity);
      transaction.create(branchRef, branchData);
      transaction.create(settingsRef, {
        branchId,
        franchiseId,
        organizationId: orgId,
        restaurantName: branchData.name,
        isOpen: acceptingOrders,
        acceptingOrders,
        isManualClose: !acceptingOrders,
        closeReason: acceptingOrders ? '' : 'Pending franchise launch checks',
        currentPrepTime: 25,
        operatingHours: dailyHours,
        services: { delivery: true, takeaway: true, dineIn: true },
        deliverySettings,
        createdAt: now,
        updatedAt: now,
        createdBy: req.user?.uid
      });
    });

    // Staff access is attached to real Firebase UIDs; the platform never invents users from email text.
    for (const account of resolvedAccounts) {
      try {
        await FranchiseAccessService.updateFranchiseAccess({
          targetUserId: account.uid,
          franchiseId,
          branchId,
          targetRole: account.role,
          applicationAccess: account.role === 'franchise_owner'
            ? { app_franchise_management: true, app_pos: body.franchiseOwnerGrantPos === true }
            : { app_restaurant_management: true, app_pos: body.restaurantManagerGrantPos === true },
          accountStatus: 'ACTIVE',
          actorUid: req.user?.uid || 'owner',
          actorEmail: req.user?.email || 'owner@olivepizza.in',
          permissions: account.role === 'restaurant_manager'
            ? ['dashboard.view', 'orders.live', 'orders.history', 'inventory.view', 'delivery.view']
            : []
        });
      } catch (accessError: any) {
        console.error('[FranchiseProvision] Staff access sync failed', { franchiseId, uid: account.uid, role: account.role, message: accessError?.message });
        warnings.push(`Franchise created, but ${account.role.replace(/_/g, ' ')} access for ${account.email} needs to be assigned again from Owner > Access Management.`);
      }
    }

    // Create terminals in pending activation state. Codes are disclosed once in the creation response.
    try {
      const batch = adminDb.batch();
      for (const terminal of terminalRefs) {
        batch.create(adminDb.collection('pos_terminals').doc(terminal.id), {
          id: terminal.id,
          terminalId: terminal.id,
          organizationId: orgId,
          franchiseId,
          branchId,
          branchName: branchData.name,
          terminalName: terminal.name,
          activationCode: terminal.activationCode,
          activationCodeExpiresAt,
          status: 'PENDING_ACTIVATION',
          activationStatus: 'PENDING_ACTIVATION',
          isActive: true,
          isOnline: false,
          createdAt: now,
          createdBy: req.user?.uid
        });
      }
      await batch.commit();
    } catch (terminalError: any) {
      console.error('[FranchiseProvision] POS terminal setup failed', { franchiseId, message: terminalError?.message });
      warnings.push('Franchise created, but POS terminal records need to be created from the POS Terminals section before counters can be used.');
    }

    // Recompute active delivery/service-area branches immediately after a new branch is created.
    try {
      const { CustomerOrderingContextService } = await import('../services/order/CustomerOrderingContextService.js');
      CustomerOrderingContextService.invalidateBranchesSnapshot();
    } catch (cacheError: any) {
      console.warn('[FranchiseProvision] Branch snapshot cache invalidation notice:', cacheError?.message);
    }

    let sheetsProvisioning: any = { status: 'PROVISIONING_PENDING' };
    try {
      sheetsProvisioning = await FranchiseGoogleSheetsService.provisionFranchiseSpreadsheet(franchiseId, name, state);
      if (sheetsProvisioning?.success === false || sheetsProvisioning?.error) {
        warnings.push('Google Sheets setup did not complete. Retry it from the franchise reporting / Sheets controls.');
      }
    } catch (sheetsError: any) {
      console.warn('[FranchiseProvision] Google Sheets setup needs retry:', sheetsError?.message);
      warnings.push('Google Sheets setup did not complete. Retry it from the franchise reporting / Sheets controls.');
      sheetsProvisioning = { status: 'PROVISIONING_PENDING' };
    }

    try {
      await FranchiseScopeService.logFranchiseAudit({
        organizationId: orgId,
        franchiseId,
        branchId,
        actorUid: req.user?.uid || 'owner',
        actorEmail: req.user?.email || 'owner@olivepizza.in',
        actionType: 'FRANCHISE_PROVISIONED',
        entityType: 'franchise_full_provision',
        entityId: franchiseId,
        details: {
          code: cleanCode,
          branchCode,
          terminalCount,
          assignedAccounts: resolvedAccounts.map(account => ({ uid: account.uid, role: account.role, apps: account.role === 'franchise_owner'
            ? ['FRANCHISE_MANAGER', ...(body.franchiseOwnerGrantPos === true ? ['POS'] : [])]
            : ['RESTAURANT_MANAGER', ...(body.restaurantManagerGrantPos === true ? ['POS'] : [])] })),
          acceptingOrders,
          warnings
        }
      });
    } catch (auditError: any) {
      console.error('[FranchiseProvision] Audit write failed after successful core creation:', auditError?.message);
      warnings.push('Franchise was created, but the provisioning audit event could not be saved. Review backend audit storage.');
    }

    res.status(201).json({
      success: true,
      message: warnings.length
        ? 'Franchise and branch created; review the setup warnings before launch.'
        : 'Franchise and branch created successfully. POS terminals still require activation.',
      franchise: franchiseEntity,
      branch: branchData,
      terminalsProvisioned: warnings.some(warning => warning.includes('POS terminal')) ? 0 : terminalCount,
      // One-time codes are returned only in the successful creation response; terminal-list
      // endpoints omit activationCode. Codes expire after 24 hours and are single-use.
      posActivationCodes: warnings.some(warning => warning.includes('POS terminal'))
        ? []
        : terminalRefs.map(terminal => ({
            terminalId: terminal.id,
            terminalName: terminal.name,
            activationCode: terminal.activationCode,
            expiresAt: activationCodeExpiresAt
          })),
      sheetsProvisioning: {
        status: sheetsProvisioning?.success === false || sheetsProvisioning?.error ? 'PROVISIONING_PENDING' : (sheetsProvisioning?.status || 'PROVISIONED'),
        spreadsheetUrl: sheetsProvisioning?.spreadsheetUrl,
        spreadsheetId: sheetsProvisioning?.spreadsheetId
      },
      warnings
    });
  } catch (error: any) {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    if (status >= 500) console.error('[FranchiseProvision] Provisioning failed:', error);
    res.status(status).json({
      success: false,
      code: error?.code || 'FRANCHISE_PROVISION_FAILED',
      error: error?.message || 'Failed to provision franchise'
    });
  }
});

// Default list fallback
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const snap = await adminDb.collection('franchises').get().catch(() => ({ docs: [] } as any));
    let branches: any[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));

    if (!scope.isGlobalOwner && !scope.isFranchiseOwner) {
      branches = branches.filter(b => scope.branchIds.includes(b.id) || scope.branchId === b.id);
    }
    res.json({ success: true, branches });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load franchise data' });
  }
});


// ─── 13. INDIVIDUAL RESTAURANT/BRANCH CONTROL (GET /:id/restaurants/:restaurantSlug) ───
router.get('/:id/restaurants/:restaurantSlug', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, restaurantSlug } = req.params;
    const cleanSlug = restaurantSlug.toLowerCase().trim();

    const bSnap = await adminDb.collection('franchises').get();
    let branch = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .find(b => 
        (b.id === cleanSlug || b.id === `${cleanSlug}_branch` || b.code?.toLowerCase() === cleanSlug) &&
        (b.franchiseId === id || (id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')))
      );

    if (!branch && cleanSlug === 'main-branch') {
      branch = bSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).find(b => b.id === 'main_branch');
    }

    if (!branch) {
      res.status(404).json({ error: `Restaurant/Branch '${cleanSlug}' not found under this franchise`, code: 'NOT_FOUND' });
      return;
    }

    // Fetch assigned managers
    const mgrSnap = await adminDb.collection('restaurant_managers').get();
    const branchManagers = mgrSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(m => m.branchId === branch.id);

    // Fetch assigned POS terminals
    const posSnap = await adminDb.collection('pos_terminals').get();
    const branchTerminals = posSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(t => t.branchId === branch.id);

    // Fetch live orders count
    const orderSnap = await adminDb.collection('orders').limit(50).get();
    const activeStatuses = ['pending', 'accepted', 'preparing', 'partner_assigned', 'ready', 'picked_up', 'out_for_delivery'];
    const liveOrders = orderSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(o => (o.branchId === branch.id || (branch.id === 'main_branch' && !o.branchId)) && activeStatuses.includes((o.status || '').toLowerCase()));

    res.json({
      success: true,
      restaurant: {
        ...branch,
        managers: branchManagers.map(({ pinHash, ...safe }) => safe),
        posTerminals: branchTerminals.map(({ activationCode, ...safe }) => safe),
        liveOrdersCount: liveOrders.length,
        operationalAppUrl: process.env.MANAGER_URL || 'https://manager.olivepizza.in'
      }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error loading restaurant control:', error);
    res.status(500).json({ error: 'Failed to load restaurant control data' });
  }
});

// ─── 14. RESTAURANT SETTINGS UPDATE (PATCH /:id/restaurants/:restaurantSlug/settings) ───
router.patch('/:id/restaurants/:restaurantSlug/settings', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, restaurantSlug } = req.params;
    const { openingTime, closingTime, maxDeliveryRadiusKm, address, phone, email, isAcceptingOrders, temporaryClosure } = req.body;

    const bSnap = await adminDb.collection('franchises').get();
    const branchDoc = bSnap.docs.find(d => 
      (d.id === restaurantSlug || d.id === `${restaurantSlug}_branch`) &&
      (d.data().franchiseId === id || (id === 'fra_rajnandgaon' && d.id === 'main_branch'))
    );

    const branchId = branchDoc ? branchDoc.id : restaurantSlug;
    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'owner'
    };

    if (openingTime) updates.openingTime = openingTime;
    if (closingTime) updates.closingTime = closingTime;
    if (maxDeliveryRadiusKm !== undefined) updates.maxDeliveryRadiusKm = Number(maxDeliveryRadiusKm);
    if (address) updates.address = address;
    if (phone) updates.phone = phone;
    if (email) updates.email = email;
    if (isAcceptingOrders !== undefined) updates.isAcceptingOrders = Boolean(isAcceptingOrders);
    if (temporaryClosure !== undefined) updates.temporaryClosure = temporaryClosure;

    await adminDb.collection('franchises').doc(branchId).set(updates, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      branchId,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'RESTAURANT_SETTINGS_UPDATED',
      entityType: 'restaurant_branch',
      entityId: branchId,
      details: updates
    });

    res.json({ success: true, message: 'Restaurant settings updated successfully', updates });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update restaurant settings' });
  }
});

// ─── 15. PERMISSION MANAGEMENT (PATCH /:id/permissions) ──────────────────────
router.patch('/:id/permissions', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { targetUserId, targetRole, permissions } = req.body;

    if (!targetUserId || !Array.isArray(permissions)) {
      res.status(400).json({ error: 'targetUserId and permissions array are required' });
      return;
    }

    const updates = {
      permissions,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'owner'
    };

    if (targetRole === 'restaurant_manager') {
      await adminDb.collection('restaurant_managers').doc(targetUserId).set(updates, { merge: true });
    } else {
      await adminDb.collection('users').doc(targetUserId).set(updates, { merge: true });
    }

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'PERMISSIONS_MODIFIED',
      entityType: targetRole || 'user_permission',
      entityId: targetUserId,
      details: { permissions }
    });

    res.json({ success: true, message: 'Permissions updated successfully', permissions });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});


// ─── 16. OWNER ACCESS ACCOUNTS LISTING (GET /:id/access-accounts) ─────────────
router.get('/:id/access-accounts', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // 1. Fetch Franchise Owner & Users
    const uSnap = await adminDb.collection('users').get();
    const fUsers = uSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(u => u.franchiseId === id || u.franchiseId === 'fra_primary' || (id === 'fra_rajnandgaon' && (u.isOwnerMode || u.role === 'owner' || u.email === 'olivepizzarjn@gmail.com' || u.email === 'webhub2811@gmail.com')));

    // 2. Fetch Restaurant Managers
    const mgrSnap = await adminDb.collection('restaurant_managers').get();
    const fManagers = mgrSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(m => m.franchiseId === id || m.franchiseId === 'fra_primary' || (id === 'fra_rajnandgaon' && (!m.franchiseId || m.branchId === 'main_branch')));

    // 3. Fetch POS Accounts
    const posSnap = await adminDb.collection('pos_accounts').get();
    const fPos = posSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(p => p.franchiseId === id || p.franchiseId === 'fra_primary' || (id === 'fra_rajnandgaon' && (!p.franchiseId || p.branchId === 'main_branch')));

    // 4. Fetch Delivery Partners
    const riderSnap = await adminDb.collection('delivery_partners').get();
    const fRiders = riderSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(r => r.franchiseId === id || r.franchiseId === 'fra_primary' || (id === 'fra_rajnandgaon' && (!r.franchiseId || r.branchId === 'main_branch')));

    // Aggregate accounts with structured application access (deduplicated by email and id)
    const accounts: any[] = [];
    const seenUids = new Set<string>();
    const seenEmails = new Set<string>();

    const addAccountIfUnique = (acc: any) => {
      const emailKey = (acc.email || '').toLowerCase().trim();
      if (acc.id && seenUids.has(acc.id)) return;
      if (emailKey && seenEmails.has(emailKey)) return;
      if (acc.id) seenUids.add(acc.id);
      if (emailKey) seenEmails.add(emailKey);
      accounts.push(acc);
    };

    // Add Owner / Franchise Managers
    fUsers.forEach(u => {
      const perms = Array.isArray(u.permissions) ? u.permissions : [];
      const isOwner = u.role === 'owner' || u.isOwnerMode || u.isGlobalOwner || u.admin;
      addAccountIfUnique({
        id: u.id,
        name: u.name || u.displayName || (isOwner ? 'Olive Pizza Owner' : 'Staff Member'),
        email: u.email,
        role: u.role || (isOwner ? 'owner' : 'staff'),
        branchId: u.branchId || 'main_branch',
        accountStatus: u.isActive === false || u.status === 'REVOKED' || u.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
        applicationAccess: {
          app_franchise_management: Boolean(u.applicationAccess?.app_franchise_management ?? (isOwner || perms.includes('app_franchise_management') || u.role === 'franchise_manager')),
          app_restaurant_management: Boolean(u.applicationAccess?.app_restaurant_management ?? (isOwner || perms.includes('app_restaurant_management') || u.role === 'restaurant_manager')),
          app_pos: Boolean(u.applicationAccess?.app_pos ?? (isOwner || perms.includes('app_pos') || perms.includes('pos.billing') || u.role === 'pos_operator')),
          app_delivery: Boolean(u.applicationAccess?.app_delivery ?? (isOwner || perms.includes('app_delivery') || u.role === 'delivery_partner'))
        },
        permissions: perms,
        updatedAt: u.updatedAt || new Date().toISOString()
      });
    });

    // Add Restaurant Managers
    fManagers.forEach(m => {
      const perms = Array.isArray(m.permissions) ? m.permissions : [];
      addAccountIfUnique({
        id: m.id,
        name: m.name || 'Restaurant Manager',
        email: m.email,
        role: 'restaurant_manager',
        branchId: m.branchId || 'main_branch',
        accountStatus: m.isActive === false || m.status === 'DEACTIVATED' ? 'SUSPENDED' : 'ACTIVE',
        applicationAccess: {
          app_franchise_management: Boolean(m.applicationAccess?.app_franchise_management ?? perms.includes('app_franchise_management')),
          app_restaurant_management: Boolean(m.applicationAccess?.app_restaurant_management ?? true),
          app_pos: Boolean(m.applicationAccess?.app_pos ?? (perms.includes('app_pos') || perms.includes('pos.billing'))),
          app_delivery: Boolean(m.applicationAccess?.app_delivery ?? perms.includes('app_delivery'))
        },
        permissions: perms,
        updatedAt: m.updatedAt || new Date().toISOString()
      });
    });

    // Add POS Accounts
    fPos.forEach(p => {
      const perms = Array.isArray(p.permissions) ? p.permissions : [];
      addAccountIfUnique({
        id: p.id,
        name: p.name || p.displayName || 'POS Cashier / Operator',
        email: p.email,
        role: 'pos_operator',
        branchId: p.branchId || 'main_branch',
        accountStatus: p.isActive === false || p.status === 'REVOKED' ? 'SUSPENDED' : 'ACTIVE',
        applicationAccess: {
          app_franchise_management: Boolean(p.applicationAccess?.app_franchise_management ?? false),
          app_restaurant_management: Boolean(p.applicationAccess?.app_restaurant_management ?? false),
          app_pos: Boolean(p.applicationAccess?.app_pos ?? true),
          app_delivery: Boolean(p.applicationAccess?.app_delivery ?? false)
        },
        permissions: perms,
        updatedAt: p.updatedAt || new Date().toISOString()
      });
    });

    // Add Delivery Riders
    fRiders.forEach(r => {
      const perms = Array.isArray(r.permissions) ? r.permissions : [];
      addAccountIfUnique({
        id: r.id,
        name: r.name || 'Delivery Partner',
        email: r.email || r.phone || 'rider@olivepizza.in',
        phone: r.phone,
        role: 'delivery_partner',
        branchId: r.branchId || 'main_branch',
        accountStatus: r.isActive === false || r.status === 'suspended' ? 'SUSPENDED' : 'ACTIVE',
        applicationAccess: {
          app_franchise_management: Boolean(r.applicationAccess?.app_franchise_management ?? false),
          app_restaurant_management: Boolean(r.applicationAccess?.app_restaurant_management ?? false),
          app_pos: Boolean(r.applicationAccess?.app_pos ?? false),
          app_delivery: Boolean(r.applicationAccess?.app_delivery ?? true)
        },
        permissions: perms,
        updatedAt: r.updatedAt || new Date().toISOString()
      });
    });

    res.json({ success: true, accounts });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error loading access accounts:', error);
    res.status(500).json({ error: 'Failed to load access accounts' });
  }
});

// ─── 16b. OWNER AUTHORIZE NEW STAFF / USER ACCOUNT (POST /:id/access/authorize-account) ───────────
router.post('/:id/access/authorize-account', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { email, name, role, applicationAccess, branchId, permissions } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const cleanEmail = email.toLowerCase().trim();
    const result = await FranchiseAccessService.updateFranchiseAccess({
      targetUserId: cleanEmail,
      franchiseId: id,
      branchId: branchId || 'main_branch',
      targetRole: role || 'staff',
      applicationAccess: applicationAccess || { app_pos: true },
      accountStatus: 'ACTIVE',
      permissions: Array.isArray(permissions) ? permissions : ['*'],
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in'
    });

    res.json({
      success: true,
      message: `Account ${cleanEmail} has been authorized successfully.`,
      result
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error authorizing account:', error);
    res.status(500).json({ error: error.message || 'Failed to authorize account' });
  }
});

// ─── 17. OWNER EDIT ACCESS (POST /:id/access/edit) ───────────────────────────
router.post('/:id/access/edit', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { targetUserId, targetRole, applicationAccess, permissions, accountStatus, assignedBranchId } = req.body;

    if (!targetUserId) {
      res.status(400).json({ error: 'targetUserId is required' });
      return;
    }

    const result = await FranchiseAccessService.updateFranchiseAccess({
      targetUserId,
      franchiseId: id,
      branchId: assignedBranchId,
      targetRole: targetRole || 'staff',
      applicationAccess: applicationAccess || {},
      accountStatus: accountStatus || 'ACTIVE',
      permissions: Array.isArray(permissions) ? permissions : [],
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in'
    });

    // Log Server-Authoritative Audit Event
    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      branchId: assignedBranchId,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'ACCESS_PERMISSIONS_CHANGED',
      entityType: targetRole || 'user_account',
      entityId: targetUserId,
      details: {
        applicationAccess,
        permissions: Array.isArray(permissions) ? permissions : [],
        accountStatus,
        assignedBranchId
      }
    });

    res.json({
      success: true,
      message: result.message || `Access permissions updated successfully for ${targetUserId}`,
      targetUserId,
      applicationAccess,
      permissions: Array.isArray(permissions) ? permissions : [],
      accountStatus: accountStatus || 'ACTIVE',
      accessEntry: result.accessEntry
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error updating access:', error);
    res.status(500).json({ error: 'Failed to update access permissions' });
  }
});

// ─── 18. SECURE POS ACCESS REQUESTS & APPROVAL ──────────────────────────

// POST /api/franchises/pos-request - Franchise Manager requests POS access for their own franchise
router.post('/pos-request', requireRole(['franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const result = await PosAccountService.requestPosAccess({
      managerUid: user.uid,
      managerEmail: user.email || 'manager@olivepizza.in',
      managerName: req.body.name || user.email?.split('@')[0],
      franchiseId: user.franchiseId
    });

    if (!result.success) {
      const status = result.message.includes('already') ? 409 : 400;
      res.status(status).json({ success: false, error: result.message });
      return;
    }

    res.status(201).json({ success: true, message: result.message, request: result.request });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error creating POS access request:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to request POS access' });
  }
});

// GET /api/franchises/pos-requests - Owner: List all pending POS access requests
router.get('/pos-requests', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const requests = await PosAccountService.listPendingPosRequests();
    res.json({ success: true, requests });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing POS requests:', error);
    res.status(500).json({ success: false, error: 'Failed to list POS access requests' });
  }
});

// GET /api/franchises/pos-request/my - Franchise Manager: Get status of POS request for own franchise
router.get('/pos-request/my', requireRole(['franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    let franchiseId = user.franchiseId;
    if (!franchiseId) {
      const uDoc = await adminDb.collection('users').doc(user.uid).get();
      franchiseId = uDoc.data()?.franchiseId;
    }
    if (!franchiseId) {
      res.status(403).json({ success: false, error: 'No franchise assigned to account' });
      return;
    }

    const request = await PosAccountService.getPosRequestStatus(franchiseId);
    const fraSnap = await adminDb.collection('franchises').doc(franchiseId).get();
    const posEnabled = fraSnap.exists ? fraSnap.data()?.posEnabled === true : false;

    res.json({ success: true, posEnabled, request });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error fetching my POS request:', error);
    res.status(500).json({ success: false, error: 'Failed to get POS request status' });
  }
});

// PUT /api/franchises/pos-request/:requestId/approve - Owner approves POS request with concurrency protection
router.put('/pos-request/:requestId/approve', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { requestId } = req.params;
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PosAccountService.approvePosRequest(requestId, ownerEmail);

    if (!result.success) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error approving POS request:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to approve POS request' });
  }
});

// PUT /api/franchises/pos-request/:requestId/reject - Owner rejects POS request
router.put('/pos-request/:requestId/reject', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PosAccountService.rejectPosRequest(requestId, ownerEmail, reason);

    if (!result.success) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error rejecting POS request:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to reject POS request' });
  }
});

// GET /api/franchises/pos-accounts/pending - Owner: List all pending POS accounts across franchises
router.get('/pos-accounts/pending', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const pending = await PosAccountService.listPendingAccounts();
    res.json({ success: true, pending });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing pending POS accounts:', error);
    res.status(500).json({ error: 'Failed to list pending POS accounts' });
  }
});

// GET /api/franchises/:id/pos-accounts - List POS accounts for a specific franchise
router.get('/:id/pos-accounts', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_manager', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const accounts = await PosAccountService.listAccountsByFranchise(id);
    res.json({ success: true, accounts });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing franchise POS accounts:', error);
    res.status(500).json({ error: 'Failed to list POS accounts' });
  }
});

// POST /api/franchises/:id/pos-accounts - Franchise Manager creates POS account (Max 1 per franchise, starts PENDING_OWNER_APPROVAL)
router.post('/:id/pos-accounts', requireRole(['franchise_manager', 'franchise_owner', 'owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, email, password } = req.body;

    if (!name || !email) {
      res.status(400).json({ success: false, error: 'Terminal name and login email are required' });
      return;
    }

    const result = await PosAccountService.createPosAccount({
      franchiseId: id,
      name,
      email,
      password,
      createdBy: req.user?.email || 'manager'
    });

    if (!result.success) {
      const statusCode = result.message.includes('already exists') ? 409 : 400;
      res.status(statusCode).json({ success: false, error: result.message });
      return;
    }

    res.status(201).json({
      success: true,
      message: result.message,
      posAccount: result.posAccount
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error creating POS account:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to create POS account' });
  }
});

// PUT /api/franchises/:id/pos-accounts/:posId/approve - Owner verifies & approves POS account
router.put('/:id/pos-accounts/:posId/approve', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { posId } = req.params;
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PosAccountService.approvePosAccount(posId, ownerEmail);

    if (!result.success) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error approving POS account:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to approve POS account' });
  }
});

// PUT /api/franchises/:id/pos-accounts/:posId/reject - Owner rejects POS account
router.put('/:id/pos-accounts/:posId/reject', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { posId } = req.params;
    const { reason } = req.body;
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PosAccountService.rejectPosAccount(posId, ownerEmail, reason);

    if (!result.success) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error rejecting POS account:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to reject POS account' });
  }
});

// PUT /api/franchises/:id/pos-accounts/:posId/revoke - Owner revokes active POS account
router.put('/:id/pos-accounts/:posId/revoke', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { posId } = req.params;
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PosAccountService.revokePosAccount(posId, ownerEmail);

    if (!result.success) {
      res.status(400).json({ success: false, error: result.message });
      return;
    }

    res.json({ success: true, message: result.message });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error revoking POS account:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to revoke POS account' });
  }
});

// Deprecated legacy route: rejects with 410 Gone / migration error
router.post('/:id/pos/provide', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  res.status(410).json({
    error: 'The legacy direct POS provisioning endpoint has been deprecated. POS accounts must be requested by the Franchise Manager and verified/approved by the Owner.'
  });
});


// ─── 19. GLOBAL OWNER: ALL POS TERMINALS VIEW (GET /api/pos/all-terminals) ───
router.get('/pos/all-terminals', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isGlobalOwner = ['owner', 'admin', 'developer', 'platform_owner'].includes(req.user?.role || '') ||
      req.user?.email === 'olivepizzarjn@gmail.com' ||
      req.user?.email === 'webhub2811@gmail.com';

    const userFranchiseId = req.user?.franchiseId;

    // Fetch all franchises from Firestore
    const fSnap = await adminDb.collection('franchise_entities').get();
    const franchisesMap = new Map<string, any>();
    fSnap.docs.forEach(d => franchisesMap.set(d.id, { id: d.id, ...(d.data() as any) }));

    // Fetch all branches from Firestore
    const bSnap = await adminDb.collection('franchises').get();
    const branchesMap = new Map<string, any>();
    bSnap.docs.forEach(d => branchesMap.set(d.id, { id: d.id, ...(d.data() as any) }));

    // Fetch all POS terminals — strip activationCode before sending
    const posSnap = await adminDb.collection('pos_terminals').get();
    let terminals = posSnap.docs.map(d => {
      const data = d.data() as any;
      const { activationCode, ...safeData } = data;
      return { id: d.id, ...safeData };
    });

    // Filter by franchise if not global owner
    if (!isGlobalOwner && userFranchiseId) {
      terminals = terminals.filter(t => t.franchiseId === userFranchiseId);
    }

    // Enrich with franchise and branch details — no fake fallback values
    const enriched = terminals.map(t => {
      const fra = franchisesMap.get(t.franchiseId);
      const br = branchesMap.get(t.branchId);
      return {
        ...t,
        franchiseName: fra?.name || t.franchiseId,
        franchiseCode: fra?.code || null,
        branchName: br?.name || t.branchId,
        todaySales: t.todaySales || 0,
        todayOrders: t.todayOrders || 0,
        currentShift: t.currentShift || null,
        assignedUserName: t.assignedUserName || null
      };
    });

    res.json({
      success: true,
      terminals: enriched,
      isGlobalOwner,
      totalTerminals: enriched.length,
      activeTerminals: enriched.filter(t => t.isActive).length
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error loading all POS terminals:', error);
    res.status(500).json({ error: 'Failed to load all POS terminals' });
  }
});

// ─── 20. GLOBAL OWNER: SWITCH POS OPERATIONAL CONTEXT (POST /api/pos/owner-context/switch) ───
router.post('/pos/owner-context/switch', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { franchiseId, branchId, terminalId, previousContext } = req.body;

    if (!franchiseId || !branchId || !terminalId) {
      res.status(400).json({ error: 'franchiseId, branchId, and terminalId are required for context switch' });
      return;
    }

    // Resolve franchise
    const fSnap = await adminDb.collection('franchise_entities').doc(franchiseId).get();
    let franchiseName = fSnap.exists ? (fSnap.data() as any)?.name : `Franchise ${franchiseId}`;

    // Resolve branch
    const bSnap = await adminDb.collection('franchises').doc(branchId).get();
    let branchName = bSnap.exists ? (bSnap.data() as any)?.name : `Branch ${branchId}`;

    // Resolve terminal
    const tSnap = await adminDb.collection('pos_terminals').doc(terminalId).get();
    const terminalData = tSnap.exists ? (tSnap.data() as any) : {
      id: terminalId,
      terminalName: 'POS Billing Terminal',
      isActive: true,
      activationStatus: 'ACTIVATED'
    };

    if (tSnap.exists && terminalData.isActive === false) {
      res.status(403).json({ error: 'Cannot switch context to a revoked or deactivated POS terminal', code: 'TERMINAL_REVOKED' });
      return;
    }

    // Log Server-Authoritative Audit Event
    await FranchiseScopeService.logFranchiseAudit({
      franchiseId,
      branchId,
      actorUid: req.user?.uid || 'owner',
      actorEmail: req.user?.email || 'owner@olivepizza.in',
      actionType: 'OWNER_POS_CONTEXT_SWITCH',
      entityType: 'pos_terminal_session',
      entityId: terminalId,
      details: {
        previousContext: previousContext || null,
        newContext: {
          franchiseId,
          franchiseName,
          branchId,
          branchName,
          terminalId,
          terminalName: terminalData.terminalName
        },
        timestamp: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      message: `Owner POS context switched to ${franchiseName} ➔ ${branchName} ➔ ${terminalData.terminalName}`,
      session: {
        isOwnerMode: true,
        cashierName: `👑 Owner (${req.user?.email?.split('@')[0] || 'Master'})`,
        cashierUid: req.user?.uid || 'owner_global',
        role: 'owner',
        terminalId,
        terminalName: terminalData.terminalName || 'POS Terminal',
        branchId,
        branchName,
        franchiseId,
        franchiseName,
        organizationId: 'org_olive_pizza',
        sessionStartedAt: new Date().toISOString()
      }
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error switching owner POS context:', error);
    res.status(500).json({ error: 'Failed to switch owner POS context' });
  }
});


// ─── ALIAS ROUTE: /:id/telemetry (Maps to franchise dashboard telemetry) ───
router.get('/:id/telemetry', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Resolve franchise name from Firestore
    const fDoc = await adminDb.collection('franchise_entities').doc(id).get();
    const franchiseName = fDoc.exists ? (fDoc.data() as any)?.name : id;

    // Real order metrics
    const orderSnap = await adminDb.collection('orders').limit(200).get().catch(() => ({ docs: [] } as any));
    let todaySales = 0, todayOrders = 0, activeOrders = 0, completedOrders = 0;
    let posSales = 0, onlineSales = 0;
    const today = new Date().toISOString().slice(0, 10);
    orderSnap.docs.forEach((d: any) => {
      const o = d.data();
      if (o.franchiseId && o.franchiseId !== id) return;
      const oDate = (o.createdAt || '').slice(0, 10);
      if (oDate !== today) return;
      const status = (o.status || '').toLowerCase();
      if (status !== 'cancelled' && status !== 'rejected') {
        const amount = Number(o.totalAmount || 0);
        todaySales += amount;
        todayOrders++;
        if (o.source === 'POS' || o.orderSource === 'POS' || o.posTerminalId) {
          posSales += amount;
        } else {
          onlineSales += amount;
        }
      }
      if (['pending','accepted','preparing','ready','out_for_delivery'].includes(status)) activeOrders++;
      else if (['delivered','completed'].includes(status)) completedOrders++;
    });

    const posSnap = await adminDb.collection('pos_terminals').get().catch(() => ({ docs: [] } as any));
    const activeTerminals = posSnap.docs.filter((d: any) => {
      const t = d.data();
      return (t.franchiseId === id) && t.isActive !== false;
    }).length;

    const riderSnap = await adminDb.collection('delivery_partners').get().catch(() => ({ docs: [] } as any));
    const activeRiders = riderSnap.docs.filter((d: any) => {
      const r = d.data();
      return (r.franchiseId === id) && r.isActive !== false && r.isOnline === true;
    }).length;

    res.json({
      success: true,
      franchiseId: id,
      franchise: { id, name: franchiseName },
      telemetry: { todaySales, todayOrders, activeOrders, completedOrders, posSales, onlineSales, activeTerminals, activeRiders }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ALIAS ROUTE: /:id/restaurants (Maps to /:id/branches) ───
router.get('/:id/restaurants', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const bSnap = await adminDb.collection('franchises').get();
    const branches = bSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .filter(b => b.franchiseId === id || (id === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')));

    res.json({
      success: true,
      franchiseId: id,
      restaurants: branches,
      branches
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ALIAS ROUTE: /:id/live-orders (Maps to /:id/orders/live) ───
router.get('/:id/live-orders', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner', 'restaurant_manager']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Verify franchise access if caller is not global owner
    const scope = FranchiseScopeService.resolveScope(req.user);
    try {
      FranchiseScopeService.assertFranchiseAccess(scope, id);
    } catch (scopeErr: any) {
      res.status(403).json({ success: false, error: scopeErr.message || 'Forbidden: Access denied to this franchise orders' });
      return;
    }

    const orderSnap = await adminDb.collection('orders')
      .where('franchiseId', '==', id)
      .limit(100)
      .get()
      .catch(async () => {
        return await adminDb.collection('orders').limit(100).get();
      });

    const orders = orderSnap.docs
      .filter(d => {
        const data = d.data();
        return !data.franchiseId || data.franchiseId === id || id === 'fra_primary' || id === 'fra_rajnandgaon';
      })
      .map(d => OrderProjectionService.projectForFranchiseManager(d.data(), d.id));

    res.json({
      success: true,
      franchiseId: id,
      count: orders.length,
      orders
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// ============================================================================
// 16. DEDICATED FRANCHISE GOOGLE SHEETS MANAGEMENT & SYNC
// ============================================================================

// GET /api/franchises/:id/sheets-status — Get dedicated Google Spreadsheet status for this franchise
router.get('/:id/sheets-status', requireRole(['owner', 'admin', 'developer', 'platform_owner', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const status = await FranchiseGoogleSheetsService.getFranchiseSheetsStatus(id);
    
    if (!status) {
      res.json({
        success: true,
        franchiseId: id,
        status: 'PROVISIONING_PENDING',
        spreadsheetName: `Olive Pizza — ${id} Reports`,
        spreadsheetUrl: null,
        lastSyncedAt: new Date().toISOString(),
        currentMonthTab: FranchiseGoogleSheetsService.getMonthTabName(),
        pendingSyncCount: 0,
        failedSyncCount: 0
      });
      return;
    }

    res.json({
      success: true,
      ...status
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/franchises/:id/provision-sheets — Manually provision/recreate Google Spreadsheet for franchise
router.post('/:id/provision-sheets', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const fDoc = await adminDb.collection('franchise_entities').doc(id).get();
    const fData = fDoc.exists ? fDoc.data() : {};
    const franchiseName = fData?.name || id;
    const region = fData?.region || 'Chhattisgarh';

    const result = await FranchiseGoogleSheetsService.provisionFranchiseSpreadsheet(id, franchiseName, region);
    res.json({
      success: result.success,
      spreadsheetId: result.spreadsheetId,
      spreadsheetUrl: result.spreadsheetUrl,
      error: result.error
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/franchises/:id/sync-sheets — Manually trigger batch sync of recent orders to franchise sheet
router.post('/:id/sync-sheets', requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const ordersSnap = await adminDb.collection('orders')
      .where('franchiseId', '==', id)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
      .catch(async () => {
        return await adminDb.collection('orders').limit(50).get();
      });

    let syncedCount = 0;
    for (const doc of ordersSnap.docs) {
      const orderData = { id: doc.id, ...doc.data() };
      const ok = await FranchiseGoogleSheetsService.syncOrderToFranchise(orderData);
      if (ok) syncedCount++;
    }

    res.json({
      success: true,
      message: `Synced ${syncedCount} orders to dedicated franchise sheet`,
      syncedCount
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================================
// FRANCHISE STAFF MANAGEMENT (Role Assignment, Branch Binding, Deactivation)
// ============================================================================

// GET /api/franchises/:id/staff — List staff members scoped to this franchise
router.get('/:id/staff', verifyToken, requireRole(['franchise_owner', 'franchise_manager', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope;
    if (scope) {
      FranchiseScopeService.assertFranchiseAccess(scope, id);
    }

    const { role, branchId } = req.query;

    let queryRef: any = adminDb.collection('users').where('franchiseId', '==', id);
    if (role && typeof role === 'string') {
      queryRef = queryRef.where('role', '==', role);
    }
    if (branchId && typeof branchId === 'string' && branchId !== 'all') {
      queryRef = queryRef.where('branchId', '==', branchId);
    }

    const snap = await queryRef.get();
    const staff = snap.docs.map((doc: any) => {
      const d = doc.data();
      return {
        id: doc.id,
        uid: doc.id,
        name: d.name || d.displayName || 'Staff Member',
        email: d.email || '',
        phone: d.phone || '',
        role: d.role || 'kitchen_staff',
        franchiseId: d.franchiseId || id,
        branchId: d.branchId || 'main_branch',
        branchIds: d.branchIds || [d.branchId || 'main_branch'],
        permissions: d.permissions || [],
        isActive: d.isActive !== false,
        terminalId: d.terminalId || null,
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null
      };
    });

    res.json({
      success: true,
      franchiseId: id,
      count: staff.length,
      staff
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error listing staff:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// POST /api/franchises/:id/staff — Provision new staff account in franchise
router.post('/:id/staff', verifyToken, requireRole(['franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const scope = req.user?.scope;
    if (scope) {
      FranchiseScopeService.assertFranchiseAccess(scope, id);
    }

    const { uid, email, name, phone, role, branchId, permissions, terminalId } = req.body;
    if (!name || !role) {
      res.status(400).json({ success: false, error: 'name and role are required' });
      return;
    }

    const ALLOWED_STAFF_ROLES = ['restaurant_manager', 'kitchen_staff', 'cashier', 'delivery_partner', 'franchise_manager'];
    if (!ALLOWED_STAFF_ROLES.includes(role)) {
      res.status(400).json({ success: false, error: `Invalid role. Allowed roles: ${ALLOWED_STAFF_ROLES.join(', ')}` });
      return;
    }

    const targetBranchId = branchId || 'main_branch';
    const staffUid = uid || ('staff_' + Date.now());
    const nowIso = new Date().toISOString();

    const staffPayload = {
      uid: staffUid,
      name: name.trim(),
      displayName: name.trim(),
      email: email ? email.trim().toLowerCase() : `${staffUid}@olivepizza.in`,
      phone: phone || '',
      role,
      organizationId: 'org_olive_pizza',
      franchiseId: id,
      branchId: targetBranchId,
      branchIds: [targetBranchId],
      permissions: Array.isArray(permissions) ? permissions : [],
      terminalId: terminalId || null,
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: req.user?.email || 'franchise_owner'
    };

    await adminDb.collection('users').doc(staffUid).set(staffPayload, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      branchId: targetBranchId,
      actorUid: req.user?.uid || 'unknown',
      actorEmail: req.user?.email,
      actionType: 'STAFF_CREATED',
      entityType: 'USER',
      entityId: staffUid,
      details: { role, targetBranchId, name }
    });

    res.json({
      success: true,
      message: `Staff member "${name}" created successfully with role "${role}"`,
      staff: staffPayload
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error creating staff:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// PUT /api/franchises/:id/staff/:staffId — Update staff role, branch, permissions, or active status
router.put('/:id/staff/:staffId', verifyToken, requireRole(['franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, staffId } = req.params;
    const scope = req.user?.scope;
    if (scope) {
      FranchiseScopeService.assertFranchiseAccess(scope, id);
    }

    const staffDoc = await adminDb.collection('users').doc(staffId).get();
    if (!staffDoc.exists) {
      res.status(404).json({ success: false, error: 'Staff member not found' });
      return;
    }

    const existingData = staffDoc.data()!;
    if (existingData.franchiseId && existingData.franchiseId !== id && !scope?.isGlobalOwner) {
      res.status(403).json({ success: false, error: 'Forbidden: Staff member belongs to another franchise' });
      return;
    }

    const { name, phone, role, branchId, permissions, isActive, terminalId } = req.body;
    const nowIso = new Date().toISOString();

    const updatePayload: any = { updatedAt: nowIso, updatedBy: req.user?.email || 'franchise_owner' };
    if (name) updatePayload.name = name.trim();
    if (phone !== undefined) updatePayload.phone = phone;
    if (role) updatePayload.role = role;
    if (branchId) {
      updatePayload.branchId = branchId;
      updatePayload.branchIds = [branchId];
    }
    if (permissions && Array.isArray(permissions)) updatePayload.permissions = permissions;
    if (isActive !== undefined) updatePayload.isActive = Boolean(isActive);
    if (terminalId !== undefined) updatePayload.terminalId = terminalId;

    await adminDb.collection('users').doc(staffId).set(updatePayload, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      branchId: updatePayload.branchId || existingData.branchId,
      actorUid: req.user?.uid || 'unknown',
      actorEmail: req.user?.email,
      actionType: 'STAFF_UPDATED',
      entityType: 'USER',
      entityId: staffId,
      details: updatePayload
    });

    res.json({
      success: true,
      message: `Staff member "${staffId}" updated successfully`,
      staffId,
      updates: updatePayload
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error updating staff:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

// DELETE /api/franchises/:id/staff/:staffId — Deactivate staff member
router.delete('/:id/staff/:staffId', verifyToken, requireRole(['franchise_owner', 'owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id, staffId } = req.params;
    const scope = req.user?.scope;
    if (scope) {
      FranchiseScopeService.assertFranchiseAccess(scope, id);
    }

    const nowIso = new Date().toISOString();
    await adminDb.collection('users').doc(staffId).set({
      isActive: false,
      deactivatedAt: nowIso,
      deactivatedBy: req.user?.email || 'franchise_owner'
    }, { merge: true });

    await FranchiseScopeService.logFranchiseAudit({
      franchiseId: id,
      actorUid: req.user?.uid || 'unknown',
      actorEmail: req.user?.email,
      actionType: 'STAFF_DEACTIVATED',
      entityType: 'USER',
      entityId: staffId
    });

    res.json({
      success: true,
      message: `Staff member "${staffId}" deactivated successfully`,
      staffId
    });
  } catch (error: any) {
    console.error('[FranchiseRoutes] Error deactivating staff:', error);
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

export default router;
