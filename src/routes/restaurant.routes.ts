import { Router, Request, Response } from 'express';
import { adminDb, adminAuth } from '../config/firebase.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { redisService } from '../services/redis/RedisService.js';

const router = Router();

// Helper to compute effective operating status combining Owner Schedule + Manager Manual Override
export function computeEffectiveStatus(data: any): { 
  isScheduleOpen: boolean; 
  isManagerOpen: boolean; 
  effectiveOpen: boolean; 
  effectiveReason: string;
  scheduleText: string;
} {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayKey = days[new Date().getDay()];
  const todayHours = data.operatingHours?.[todayKey] || { open: '10:00', close: '23:00', isOpen: true };
  
  let isScheduleOpen = Boolean(todayHours.isOpen !== false);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  if (todayHours.open && todayHours.close) {
    const [openH, openM] = todayHours.open.split(':').map(Number);
    const [closeH, closeM] = todayHours.close.split(':').map(Number);
    const openMinutes = openH * 60 + (openM || 0);
    const closeMinutes = closeH * 60 + (closeM || 0);

    if (openMinutes <= closeMinutes) {
      isScheduleOpen = isScheduleOpen && currentMinutes >= openMinutes && currentMinutes < closeMinutes;
    } else {
      // Overnight span (e.g. 18:00 to 02:00)
      isScheduleOpen = isScheduleOpen && (currentMinutes >= openMinutes || currentMinutes < closeMinutes);
    }
  }

  // Manager Manual Override Precedence:
  // If Manager manually closed (isOpen === false or isManualClose === true): strictly CLOSED.
  // If Manager explicitly opened: OPEN only if schedule permits or manager override is active.
  const isManagerOpen = data.isOpen !== false && data.acceptingOrders !== false;
  
  let effectiveOpen = false;
  let effectiveReason = '';

  if (!isManagerOpen) {
    effectiveOpen = false;
    effectiveReason = data.closeReason || 'Restaurant was temporarily closed by manager.';
  } else if (!isScheduleOpen) {
    effectiveOpen = false;
    effectiveReason = `Outside operating hours (${todayHours.open || '10:00'} - ${todayHours.close || '23:00'}).`;
  } else {
    effectiveOpen = true;
    effectiveReason = 'Restaurant is open and accepting orders.';
  }

  const scheduleText = `${todayHours.open || '10:00'} - ${todayHours.close || '23:00'}`;

  return {
    isScheduleOpen,
    isManagerOpen,
    effectiveOpen,
    effectiveReason,
    scheduleText
  };
}

const statusUpdateTimestamps = new Map<string, number[]>();

function checkStatusRateLimit(branchId: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxUpdates = 10;
  const timestamps = (statusUpdateTimestamps.get(branchId) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxUpdates) {
    return false;
  }
  timestamps.push(now);
  statusUpdateTimestamps.set(branchId, timestamps);
  return true;
}

// ============================================================================
// PUBLIC & PROTECTED GET: Restaurant Operational Status & Settings
// ============================================================================
router.get('/status', async (req: Request, res: Response) => {
  try {
    const branchId = (req.query.branchId as string) || 'main_branch';
    const statusData = await redisService.fetchWithStampedeProtection(
      `cache:restaurant_status:${branchId}`,
      async () => {
        const docRef = adminDb?.collection('restaurant_settings').doc(branchId);
        let snap = null;
        try {
          if (docRef) {
            snap = await Promise.race([
              docRef.get(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 2000))
            ]);
          }
        } catch (fsErr) {
          console.warn('[RestaurantRoutes] Firestore read failed or timed out:', fsErr?.message);
        }

        if (!snap || !snap.exists) {
          // Default initial operational state
          const defaultState = {
            branchId,
            franchiseId: 'olive_pizza_hq',
            restaurantName: 'Olive Pizza — Rajnandgaon',
            isOpen: true,
            acceptingOrders: true,
            closeReason: '',
            currentPrepTime: 25,
            services: {
              delivery: true,
              takeaway: true,
              dineIn: true
            },
            deliverySettings: {
              radiusKm: 12,
              minOrderAmount: 199,
              baseDeliveryFee: 40,
              freeDeliveryThreshold: 499,
              estimatedDeliveryMins: 30
            },
            paymentSettings: {
              cashOnDelivery: true,
              upi: true,
              cards: true,
              onlineGateway: true
            },
            taxAndCharges: {
              gstPercentage: 5,
              packagingCharge: 20,
              serviceChargePercentage: 0
            },
            operatingHours: {
              monday: { open: '10:00', close: '23:00', isOpen: true },
              tuesday: { open: '10:00', close: '23:00', isOpen: true },
              wednesday: { open: '10:00', close: '23:00', isOpen: true },
              thursday: { open: '10:00', close: '23:00', isOpen: true },
              friday: { open: '10:00', close: '23:30', isOpen: true },
              saturday: { open: '10:00', close: '23:30', isOpen: true },
              sunday: { open: '10:00', close: '23:30', isOpen: true }
            },
            specialHours: [],
            updatedAt: new Date().toISOString(),
            updatedBy: 'system'
          };

          if (docRef) { docRef.set(defaultState).catch(() => {}); }
          const effective = computeEffectiveStatus(defaultState);
          return { ...defaultState, effective };
        }

        const data = snap.data() || {};
        const effective = computeEffectiveStatus(data);
        return { ...data, effective };
      },
      { ttlSeconds: 60, jitterSeconds: 15 }
    );

    res.json({ success: true, data: statusData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper for audit logging
async function logAudit(
  branchId: string, 
  actorUid: string, 
  actorEmail: string, 
  actionType: string, 
  fieldName: string, 
  oldValue: any, 
  newValue: any, 
  notes?: string
) {
  try {
    await adminDb.collection('restaurant_audit_logs').add({
      branchId,
      actorUid,
      actorEmail,
      actionType,
      fieldName,
      oldValue: oldValue !== undefined ? oldValue : null,
      newValue,
      notes: notes || '',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.warn('[RestaurantAudit] Audit log write notice:', e);
  }
}

// ============================================================================
// PROTECTED ROUTES: Require authentication + manager, owner, or admin role
// ============================================================================
router.use(verifyToken);
router.use(requireRole(['owner', 'admin', 'manager', 'restaurant_manager', 'developer', 'platform_owner']));

function resolveBranchId(req: AuthRequest, bodyBranchId?: string, queryBranchId?: string): string {
  const userRole = req.user?.role || '';
  const isGlobal = ['owner', 'admin', 'developer', 'platform_owner'].includes(userRole);
  if (isGlobal) {
    return bodyBranchId || queryBranchId || (req.user as any)?.branchId || 'main_branch';
  }
  return (req.user as any)?.branchId || (req.user as any)?.scope?.branchId || 'main_branch';
}

// 1. UPDATE OPERATIONAL STATUS (Open/Close, Accepting Orders, Reason)
router.put('/status', async (req: AuthRequest, res: Response) => {
  try {
    const userRole = req.user?.role || '';
    const isGlobal = ['owner', 'admin', 'developer', 'platform_owner'].includes(userRole);
    const userBranch = (req.user as any)?.branchId || 'main_branch';

    // Strict branch isolation: Managers can only modify their assigned branch
    if (!isGlobal && req.body.branchId && req.body.branchId !== userBranch) {
      res.status(403).json({ success: false, error: 'Forbidden: You are not authorized to modify another branch.' });
      return;
    }

    const branchId = resolveBranchId(req, req.body.branchId);

    // Rate-limiting check (max 10 updates per minute per branch)
    if (!checkStatusRateLimit(branchId)) {
      res.status(429).json({ success: false, error: 'Too many status updates. Please wait a minute before updating again.' });
      return;
    }

    const { isOpen, acceptingOrders, closeReason, currentPrepTime } = req.body;
    
    const docRef = adminDb.collection('restaurant_settings').doc(branchId);
    const prevSnap = await docRef.get();
    const prevData = prevSnap.data() || {};

    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager',
      updatedByEmail: req.user?.email || 'manager@olivepizza.in'
    };

    if (isOpen !== undefined) updates.isOpen = Boolean(isOpen);
    if (acceptingOrders !== undefined) updates.acceptingOrders = Boolean(acceptingOrders);
    if (closeReason !== undefined) updates.closeReason = String(closeReason);
    if (currentPrepTime !== undefined) updates.currentPrepTime = Number(currentPrepTime);
    const nextIsOpen = updates.isOpen ?? (prevData.isOpen !== false);
    const nextAcceptingOrders = updates.acceptingOrders ?? (prevData.acceptingOrders !== false);
    if (closeReason === undefined && nextIsOpen && nextAcceptingOrders) updates.closeReason = '';

    // Keep the branch record used by order creation in sync with restaurant settings.
    // Otherwise an owner-created branch marked closed for launch checks could remain
    // permanently blocked in orders even after a manager opens it from the restaurant app.
    const branchRef = adminDb.collection('franchises').doc(branchId);
    await adminDb.runTransaction(async (transaction) => {
      const branchSnap = await transaction.get(branchRef);
      transaction.set(docRef, updates, { merge: true });
      if (branchSnap.exists) {
        const branchUpdates: Record<string, any> = {
          updatedAt: updates.updatedAt,
          updatedBy: updates.updatedBy
        };
        if (isOpen !== undefined) branchUpdates.isOpen = Boolean(isOpen);
        if (acceptingOrders !== undefined) branchUpdates.acceptingOrders = Boolean(acceptingOrders);
        if (closeReason !== undefined) branchUpdates.closeReason = String(closeReason);
        transaction.set(branchRef, branchUpdates, { merge: true });
      }
    });
    await redisService.del(`cache:restaurant_status:${branchId}`);

    // Record audit log
    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'STATUS_CHANGE',
      'operational_status',
      { isOpen: prevData.isOpen, acceptingOrders: prevData.acceptingOrders, closeReason: prevData.closeReason },
      { isOpen: updates.isOpen, acceptingOrders: updates.acceptingOrders, closeReason: updates.closeReason },
      updates.closeReason ? `Reason: ${updates.closeReason}` : 'Status toggle'
    );

    // Realtime notification / EventBus
    try {
      const { appEventBus } = await import('../services/eventBus/AppEventBus.js');
      appEventBus.emit('restaurant:status_changed', { branchId, updates });
    } catch {}

    res.json({ success: true, message: 'Operational status updated successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. RESTAURANT PROFILE (Profile info, Address, Location, Contact)
router.get('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, undefined, req.query.branchId as string);
    const snap = await adminDb.collection('restaurant_profiles').doc(branchId).get();
    
    if (!snap.exists) {
      const defaultProfile = {
        branchId,
        restaurantName: 'Olive Pizza',
        legalName: 'Olive Pizza Food & Beverages Pvt. Ltd.',
        fssaiNumber: '20524078000123',
        gstNumber: '22AAAAA0000A1Z5',
        phone: '+91 91799 91234',
        email: 'olivepizzarjn@gmail.com',
        addressLine: 'Dongargaon Road, Near Gurudwara',
        landmark: 'Near Forest Office Colony',
        city: 'Rajnandgaon',
        state: 'Chhattisgarh',
        pincode: '491441',
        latitude: 21.0974,
        longitude: 81.0378,
        logoUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=200',
        coverUrl: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=1200'
      };
      await adminDb.collection('restaurant_profiles').doc(branchId).set(defaultProfile);
      return res.json({ success: true, profile: defaultProfile });
    }

    res.json({ success: true, profile: snap.data() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const profileData = {
      ...req.body,
      branchId,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    };

    await adminDb.collection('restaurant_profiles').doc(branchId).set(profileData, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'PROFILE_UPDATE',
      'restaurant_profile',
      null,
      profileData
    );

    res.json({ success: true, message: 'Restaurant profile updated successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. OPERATING HOURS
router.put('/hours', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { operatingHours } = req.body;
    
    if (!operatingHours) {
      return res.status(400).json({ success: false, error: 'operatingHours object is required' });
    }

    await adminDb.collection('restaurant_settings').doc(branchId).set({
      operatingHours,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    }, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'HOURS_UPDATE',
      'operatingHours',
      null,
      operatingHours
    );

    res.json({ success: true, message: 'Weekly operating hours saved successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. SPECIAL / HOLIDAY HOURS
router.post('/special-hours', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { date, name, isClosed, openTime, closeTime } = req.body;

    const specialEntry = {
      id: `special_${Date.now().toString(36)}`,
      date,
      name,
      isClosed: Boolean(isClosed),
      openTime: openTime || '10:00',
      closeTime: closeTime || '23:00',
      createdAt: new Date().toISOString(),
      createdBy: req.user?.uid || 'manager'
    };

    const docRef = adminDb.collection('restaurant_settings').doc(branchId);
    const snap = await docRef.get();
    const existing = snap.data()?.specialHours || [];

    const updated = [...existing.filter((s: any) => s.date !== date), specialEntry];
    await docRef.set({ specialHours: updated }, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'SPECIAL_HOURS_ADD',
      'specialHours',
      null,
      specialEntry
    );

    res.json({ success: true, specialEntry });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/special-hours/:id', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, undefined, req.query.branchId as string);
    const docRef = adminDb.collection('restaurant_settings').doc(branchId);
    const snap = await docRef.get();
    const existing = snap.data()?.specialHours || [];

    const updated = existing.filter((s: any) => s.id !== req.params.id);
    await docRef.set({ specialHours: updated }, { merge: true });

    res.json({ success: true, deletedId: req.params.id });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. SERVICE AVAILABILITY (Delivery, Takeaway, Dine-In)
router.put('/services', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { services, currentPrepTime } = req.body;

    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    };

    if (services) updates.services = services;
    if (currentPrepTime !== undefined) updates.currentPrepTime = Number(currentPrepTime);

    await adminDb.collection('restaurant_settings').doc(branchId).set(updates, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'SERVICES_UPDATE',
      'services',
      null,
      updates
    );

    res.json({ success: true, message: 'Service availability updated successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. DELIVERY SETTINGS
router.put('/delivery-settings', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { deliverySettings } = req.body;

    if (!deliverySettings) return res.status(400).json({ success: false, error: 'deliverySettings required' });

    await adminDb.collection('restaurant_settings').doc(branchId).set({
      deliverySettings,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    }, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'DELIVERY_SETTINGS_UPDATE',
      'deliverySettings',
      null,
      deliverySettings
    );

    res.json({ success: true, message: 'Delivery settings saved successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. PAYMENT SETTINGS
router.put('/payment-settings', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { paymentSettings } = req.body;

    if (!paymentSettings) return res.status(400).json({ success: false, error: 'paymentSettings required' });

    await adminDb.collection('restaurant_settings').doc(branchId).set({
      paymentSettings,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    }, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'PAYMENT_SETTINGS_UPDATE',
      'paymentSettings',
      null,
      paymentSettings
    );

    res.json({ success: true, message: 'Payment settings saved successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. TAX & CHARGES
router.put('/tax-charges', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, req.body.branchId);
    const { taxAndCharges } = req.body;

    if (!taxAndCharges) return res.status(400).json({ success: false, error: 'taxAndCharges required' });

    await adminDb.collection('restaurant_settings').doc(branchId).set({
      taxAndCharges,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'manager'
    }, { merge: true });

    await logAudit(
      branchId,
      req.user?.uid || 'manager',
      req.user?.email || 'manager',
      'TAX_CHARGES_UPDATE',
      'taxAndCharges',
      null,
      taxAndCharges
    );

    res.json({ success: true, message: 'Tax & charges configuration saved' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. STAFF & ROLES DIRECTORY
router.get('/staff', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = resolveBranchId(req, undefined, req.query.branchId as string);
    const snap = await adminDb.collection('users')
      .where('role', 'in', ['owner', 'admin', 'manager', 'kitchen', 'cashier', 'delivery', 'staff'])
      .get()
      .catch(() => ({ docs: [] }));

    const staff: any[] = [];
    snap.docs.forEach((doc: any) => {
      const data = doc.data();
      staff.push({
        id: doc.id,
        name: data.name || data.displayName || 'Staff Member',
        email: data.email || '',
        phone: data.phone || data.phoneNumber || '',
        role: data.role || 'staff',
        isActive: data.isActive !== false,
        branchId: data.branchId || branchId,
        lastLogin: data.lastLogin || data.updatedAt || data.createdAt || ''
      });
    });

    res.json({ success: true, staff });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const VALID_ROLES = ['customer', 'delivery_partner', 'cashier', 'kitchen_staff', 'restaurant_manager', 'franchise_owner', 'admin', 'owner'];
const MANAGER_ASSIGNABLE_ROLES = ['cashier', 'kitchen_staff'];
const FRANCHISE_ASSIGNABLE_ROLES = ['cashier', 'kitchen_staff', 'restaurant_manager', 'delivery_partner'];

router.put('/staff/:id/role', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { role, isActive, branchId } = req.body;
    const targetUid = req.params.id;
    const caller = req.user;

    if (!caller) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const callerRole = (caller.role || '').toLowerCase();
    const isGlobalOwner = caller.scope?.isGlobalOwner || callerRole === 'owner' || callerRole === 'admin';
    const isFranchiseOwner = callerRole === 'franchise_owner';
    const isManager = callerRole === 'restaurant_manager' || callerRole === 'manager';

    if (role) {
      if (!VALID_ROLES.includes(role)) {
        res.status(400).json({ success: false, error: `Invalid role '${role}'. Allowed roles: ${VALID_ROLES.join(', ')}` });
        return;
      }

      // Hierarchy validation
      if (!isGlobalOwner) {
        if (isFranchiseOwner && !FRANCHISE_ASSIGNABLE_ROLES.includes(role)) {
          res.status(403).json({ success: false, error: `Franchise owners can only assign: ${FRANCHISE_ASSIGNABLE_ROLES.join(', ')}` });
          return;
        }
        if (isManager && !MANAGER_ASSIGNABLE_ROLES.includes(role)) {
          res.status(403).json({ success: false, error: `Restaurant managers can only assign: ${MANAGER_ASSIGNABLE_ROLES.join(', ')}` });
          return;
        }
        if (!isFranchiseOwner && !isManager) {
          res.status(403).json({ success: false, error: 'Forbidden: Insufficient privileges to change roles' });
          return;
        }
      }

      // Prevent self-role modification for non-global-owners
      if (!isGlobalOwner && caller.uid === targetUid) {
        res.status(403).json({ success: false, error: 'Cannot modify your own role' });
        return;
      }
    }

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    if (role) updates.role = role;
    if (isActive !== undefined) updates.isActive = Boolean(isActive);
    if (branchId) updates.branchId = branchId;

    await adminDb.collection('users').doc(targetUid).set(updates, { merge: true });

    if (role) {
      await adminAuth.setCustomUserClaims(targetUid, { role }).catch(() => {});
    }

    await logAudit(
      branchId || caller.branchId || 'main_branch',
      caller.uid,
      caller.email || 'staff',
      'STAFF_ROLE_CHANGE',
      'role',
      null,
      { targetUid, role, isActive }
    );

    res.json({ success: true, message: 'Staff member updated successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 10. AUDIT LOGS
router.get('/audit-logs', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = (req.query.branchId as string) || 'main_branch';
    const limitCount = Number(req.query.limit) || 50;

    const snap = await adminDb.collection('restaurant_audit_logs')
      .where('branchId', '==', branchId)
      .orderBy('timestamp', 'desc')
      .limit(limitCount)
      .get()
      .catch(async () => {
        // Fallback without composite index
        return await adminDb.collection('restaurant_audit_logs').limit(limitCount).get();
      });

    const logs: any[] = [];
    snap.docs.forEach((doc: any) => {
      logs.push({ id: doc.id, ...doc.data() });
    });

    logs.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    res.json({ success: true, logs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
