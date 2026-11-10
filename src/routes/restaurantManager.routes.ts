import { Router, Response } from 'express';
import crypto from 'crypto';
import { adminDb, adminAuth } from '../config/firebase.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { FranchisePinService } from '../services/franchise/FranchisePinService.js';

const router = Router();

async function logManagerAudit(
  branchId: string,
  actorUid: string,
  actorEmail: string,
  action: string,
  managerId: string,
  managerEmail: string,
  details: any
) {
  try {
    await adminDb.collection('restaurant_audit_logs').add({
      branchId: branchId || 'unassigned',
      actorUid,
      actorEmail,
      actionType: action,
      targetId: managerId,
      targetEmail: managerEmail,
      details,
      timestamp: new Date().toISOString(),
      source: 'manager_account_service'
    });
  } catch (err) {
    console.warn('[RestaurantManagerAudit] Warning logging audit:', err);
  }
}

router.use(verifyToken);

// 1. GET / - List Manager Accounts
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userRole = req.user?.role || 'customer';
    const isOwnerOrAdmin = ['owner', 'admin', 'developer'].includes(userRole);
    const callerBranch = isOwnerOrAdmin ? (req.query.branchId as string | undefined) : req.user?.branchId;

    if (!isOwnerOrAdmin && userRole !== 'restaurant_manager' && userRole !== 'manager') {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions to view manager directory' });
      return;
    }

    if (!isOwnerOrAdmin && !callerBranch) {
      res.status(403).json({ error: 'AUTHORIZED_BRANCH_SCOPE_REQUIRED: Your account is not assigned to a branch.' });
      return;
    }

    let snap;
    if (isOwnerOrAdmin) {
      const branchFilter = req.query.branchId as string | undefined;
      if (branchFilter && branchFilter !== 'all') {
        snap = await adminDb.collection('users')
          .where('role', 'in', ['restaurant_manager', 'manager'])
          .where('branchId', '==', branchFilter)
          .get()
          .catch(() => ({ docs: [] }));
      } else {
        snap = await adminDb.collection('users')
          .where('role', 'in', ['restaurant_manager', 'manager'])
          .get()
          .catch(() => ({ docs: [] }));
      }
    } else {
      snap = await adminDb.collection('users')
        .where('role', 'in', ['restaurant_manager', 'manager'])
        .where('branchId', '==', callerBranch)
        .get()
        .catch(() => ({ docs: [] }));
    }

    const managers: any[] = [];
    snap.docs.forEach((doc: any) => {
      const d = doc.data();
      managers.push({
        id: doc.id,
        uid: doc.id,
        name: d.name || d.displayName || 'Restaurant Manager',
        email: d.email || '',
        phone: d.phone || d.phoneNumber || '',
        role: d.role || 'restaurant_manager',
        branchId: d.branchId || null,
        branchName: d.branchName || (d.branchId ? `Branch ${d.branchId}` : 'Unassigned Branch'),
        isActive: d.isActive !== false,
        permissions: d.permissions || [
          'dashboard.view',
          'orders.live',
          'orders.history',
          'notifications.send',
          'email.send',
          'delivery.view'
        ],
        createdAt: d.createdAt || '',
        lastLogin: d.lastLogin || d.updatedAt || ''
      });
    });

    res.json({ success: true, managers });
  } catch (error: any) {
    console.error('[RestaurantManagers] Error listing managers:', error);
    res.status(500).json({ error: error.message || 'Failed to list restaurant managers' });
  }
});

// 2. GET /me - Manager Profile & Permissions
router.get('/me', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userDoc = await adminDb.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      res.status(404).json({ error: 'Manager account record not found' });
      return;
    }

    const data = userDoc.data()!;
    if (data.isActive === false) {
      res.status(403).json({ error: 'Forbidden: Account has been deactivated by owner' });
      return;
    }

    res.json({
      success: true,
      manager: {
        uid,
        name: data.name || data.displayName || 'Manager',
        email: data.email || req.user?.email || '',
        phone: data.phone || '',
        role: data.role || 'restaurant_manager',
        branchId: data.branchId || null,
        branchName: data.branchName || (data.branchId ? `Branch ${data.branchId}` : 'Unassigned Branch'),
        isActive: data.isActive !== false,
        permissions: data.permissions || [
          'dashboard.view',
          'orders.live',
          'orders.history',
          'notifications.send',
          'email.send',
          'delivery.view'
        ]
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch manager context' });
  }
});

// 3. POST / - Create / Provision Manager Account
router.post('/', requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, branchId, branchName, permissions } = req.body;

    if (!email || !name) {
      res.status(400).json({ error: 'Manager name and email are required' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const selectedBranch = branchId || req.user?.branchId;
    if (!selectedBranch) {
      res.status(400).json({ error: 'branchId is required to provision a Restaurant Manager' });
      return;
    }
    const finalPermissions = permissions || [
      'dashboard.view',
      'orders.live',
      'orders.history',
      'notifications.send',
      'email.send',
      'delivery.view'
    ];

    let targetUid: string = '';

    // Clean phone number (only attach to Auth if valid E.164 format with + prefix)
    const cleanedPhone = phone ? phone.trim().replace(/[^\d+]/g, '') : '';
    const validE164Phone = cleanedPhone && cleanedPhone.startsWith('+') && cleanedPhone.length >= 10 ? cleanedPhone : undefined;

    // 1. Try resolving or creating user in Firebase Auth
    try {
      const existingAuth = await adminAuth.getUserByEmail(normalizedEmail);
      targetUid = existingAuth.uid;
      // Update display name
      await adminAuth.updateUser(targetUid, {
        displayName: name.trim()
      }).catch(() => {});
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        const secureRandomPassword = password || `${crypto.randomBytes(12).toString('base64url')}!OP9`;
        const createPayload: any = {
          email: normalizedEmail,
          password: secureRandomPassword,
          displayName: name.trim()
        };
        if (validE164Phone) {
          createPayload.phoneNumber = validE164Phone;
        }
        const createdAuth = await adminAuth.createUser(createPayload);
        targetUid = createdAuth.uid;
      } else {
        console.warn('[RestaurantManagers] Auth lookup notice, generating document ID fallback:', err.message);
        targetUid = `mgr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      }
    }

    // 2. Set custom claims in Firebase Auth if available
    try {
      if (targetUid && !targetUid.startsWith('mgr_')) {
        await adminAuth.setCustomUserClaims(targetUid, {
          role: 'restaurant_manager',
          branchId: selectedBranch,
          permissions: finalPermissions
        });
      }
    } catch (claimsErr) {
      console.warn('[RestaurantManagers] Custom claims warning:', claimsErr);
    }

    // 3. Upsert Firestore records
    const managerData = {
      uid: targetUid,
      id: targetUid,
      name: name.trim(),
      displayName: name.trim(),
      email: normalizedEmail,
      phone: phone || '',
      role: 'restaurant_manager',
      branchId: selectedBranch,
      branchName: branchName || `Branch ${selectedBranch}`,
      permissions: finalPermissions,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.user?.uid || 'owner',
      createdByEmail: req.user?.email || 'owner@olivepizza.in'
    };

    await adminDb.collection('users').doc(targetUid).set(managerData, { merge: true });
    await adminDb.collection('restaurant_managers').doc(targetUid).set(managerData, { merge: true });

    // 4. Audit Log
    await logManagerAudit(
      selectedBranch,
      req.user?.uid || 'owner',
      req.user?.email || 'owner@olivepizza.in',
      'MANAGER_ACCOUNT_CREATED',
      targetUid,
      normalizedEmail,
      { name, branchId: selectedBranch, permissions: finalPermissions }
    );

    res.status(201).json({
      success: true,
      message: 'Restaurant Manager account created successfully',
      manager: managerData
    });
  } catch (error: any) {
    console.error('[RestaurantManagers] Error creating manager:', error);
    res.status(500).json({ error: error.message || 'Failed to create manager account' });
  }
});

// 4. PATCH /:id - Update Manager
router.patch('/:id', requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetUid = req.params.id;
    const { name, phone, branchId, branchName, permissions } = req.body;

    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'owner'
    };

    if (name) {
      updates.name = name.trim();
      updates.displayName = name.trim();
    }
    if (phone !== undefined) updates.phone = phone;
    if (branchId) updates.branchId = branchId;
    if (branchName) updates.branchName = branchName;
    if (permissions) updates.permissions = permissions;

    await adminDb.collection('users').doc(targetUid).set(updates, { merge: true });
    await adminDb.collection('restaurant_managers').doc(targetUid).set(updates, { merge: true });

    if (!targetUid.startsWith('mgr_')) {
      try {
        const existingUser = await adminDb.collection('users').doc(targetUid).get();
        const currentData = existingUser.data() || {};
        await adminAuth.setCustomUserClaims(targetUid, {
          role: currentData.role || 'restaurant_manager',
          branchId: branchId || currentData.branchId || null,
          permissions: permissions || currentData.permissions || []
        });
      } catch (claimsErr) {
        console.warn('[RestaurantManagers] Claims update warning:', claimsErr);
      }
    }

    await logManagerAudit(
      branchId || 'unassigned',
      req.user?.uid || 'owner',
      req.user?.email || 'owner@olivepizza.in',
      'MANAGER_ACCOUNT_UPDATED',
      targetUid,
      updates.email || '',
      updates
    );

    res.json({ success: true, message: 'Manager account updated successfully', updates });
  } catch (error: any) {
    console.error('[RestaurantManagers] Error updating manager:', error);
    res.status(500).json({ error: error.message || 'Failed to update manager account' });
  }
});

// 5. PATCH /:id/status - Toggle Status
router.patch('/:id/status', requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetUid = req.params.id;
    const { isActive } = req.body;

    if (isActive === undefined) {
      res.status(400).json({ error: 'isActive boolean flag is required' });
      return;
    }

    const updates = {
      isActive: Boolean(isActive),
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.uid || 'owner'
    };

    await adminDb.collection('users').doc(targetUid).set(updates, { merge: true });
    await adminDb.collection('restaurant_managers').doc(targetUid).set(updates, { merge: true });

    if (!isActive && !targetUid.startsWith('mgr_')) {
      try {
        await adminAuth.revokeRefreshTokens(targetUid);
      } catch (err) {
        console.warn('[RestaurantManagers] Token revocation warning:', err);
      }
    }

    const userDoc = await adminDb.collection('users').doc(targetUid).get();
    const managerEmail = userDoc.data()?.email || '';
    const branchId = userDoc.data()?.branchId || '';

    await logManagerAudit(
      branchId,
      req.user?.uid || 'owner',
      req.user?.email || 'owner@olivepizza.in',
      isActive ? 'MANAGER_ACCOUNT_ENABLED' : 'MANAGER_ACCOUNT_DISABLED',
      targetUid,
      managerEmail,
      { isActive: Boolean(isActive) }
    );

    res.json({
      success: true,
      message: `Manager account ${isActive ? 'enabled' : 'disabled'} successfully`,
      isActive: Boolean(isActive)
    });
  } catch (error: any) {
    console.error('[RestaurantManagers] Error toggling status:', error);
    res.status(500).json({ error: error.message || 'Failed to toggle status' });
  }
});

// 6. POST /verify-pin - Verify Restaurant Manager 4-digit PIN
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

    let userDoc = await adminDb.collection('restaurant_managers').doc(uid).get();
    if (!userDoc.exists && email) {
      const qSnap = await adminDb.collection('restaurant_managers').where('email', '==', email.toLowerCase()).limit(1).get();
      if (!qSnap.empty) userDoc = qSnap.docs[0];
    }

    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'Restaurant Manager record not found' });
      return;
    }

    const userData = userDoc.data() as any;
    const pinHash = userData?.pinHash;
    const failedAttempts = userData?.failedPinAttempts || 0;
    const lockedUntil = userData?.pinLockedUntil;

    if (FranchisePinService.isAccountLocked(failedAttempts, lockedUntil)) {
      const remainingMinutes = Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / (60 * 1000));
      res.status(423).json({
        success: false,
        isLocked: true,
        error: `Account locked due to too many failed attempts. Try again in ${remainingMinutes} minute(s).`
      });
      return;
    }

    if (!pinHash) {
      res.status(400).json({
        success: false,
        requiresPinSetup: true,
        error: 'No PIN has been configured for this account.'
      });
      return;
    }

    const isMatch = await FranchisePinService.verifyPin(String(pin).trim(), pinHash);
    if (!isMatch) {
      const nextAttempts = failedAttempts + 1;
      const isNowLocked = nextAttempts >= FranchisePinService.MAX_ATTEMPTS;
      const lockExpiry = isNowLocked ? FranchisePinService.getLockoutExpiry() : null;

      await adminDb.collection('restaurant_managers').doc(userDoc.id).set({
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

    // Success
    await adminDb.collection('restaurant_managers').doc(userDoc.id).set({
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
    console.error('[RestaurantManagers] Error verifying PIN:', error);
    res.status(500).json({ success: false, error: 'Failed to verify PIN' });
  }
});

export default router;
