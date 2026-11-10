import { Router, Request, Response } from 'express';
import { emailService } from '../lib/email.service.js';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware.js';
import { adminAuth, adminDb } from '../config/firebase.js';
import { LoyaltyService } from '../services/loyalty/LoyaltyService.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';
import { ApiSecurityMiddleware, ResponseSanitizationService } from '../security/index.js';

const router = Router();

router.use(verifyToken);
router.use(ApiSecurityMiddleware.rejectParameterTampering());

// Upsert user (Called after Firebase Auth signup/login)
router.post('/sync', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const email = req.user?.email;
    const { name } = req.body;

    if (!userId || !email) {
      res.status(400).json({ error: 'Invalid user token' });
      return;
    }

    const userRef = adminDb.collection('users').doc(userId);
    const doc = await userRef.get();
    
    let userData: any = {
      firebase_uid: userId,
      email,
      name: name || '',
      role: 'customer',
      updatedAt: new Date().toISOString()
    };

    if (!doc.exists) {
      userData.createdAt = new Date().toISOString();
      await userRef.set(userData);
      // Set default custom claim
      await adminAuth.setCustomUserClaims(userId, { role: 'customer' });
    } else {
      userData = doc.data();
      if (name) {
        userData.name = name;
        userData.updatedAt = new Date().toISOString();
        await userRef.update({ name, updatedAt: userData.updatedAt });
      }
    }

    res.json(userData);
  } catch (error) {
    console.error("User sync error", error);
    res.status(500).json({ error: 'Failed to sync user' });
  }
});

// Setup Phone
router.put('/phone', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const email = req.user?.email || '';
    const { phone } = req.body;

    if (!phone) {
      res.status(400).json({ error: 'Phone number is required' });
      return;
    }

    const userRef = adminDb.collection('users').doc(userId!);
    const doc = await userRef.get();

    let userData: any = {
      firebase_uid: userId,
      email,
      name: 'Customer',
      phone,
      phone_setup_completed: true,
      role: 'customer',
      updatedAt: new Date().toISOString()
    };

    if (!doc.exists) {
      userData.createdAt = new Date().toISOString();
      await userRef.set(userData);
      await adminAuth.setCustomUserClaims(userId!, { role: 'customer' });
    } else {
      userData = { ...doc.data(), phone, phone_setup_completed: true, updatedAt: new Date().toISOString() };
      await userRef.update({ phone, phone_setup_completed: true, updatedAt: userData.updatedAt });
    }

    res.json(userData);
  } catch (error: any) {
    console.error("Phone setup error", error);
    res.status(500).json({ error: error.message || 'Failed to save phone' });
  }
});

// Setup Location with Authoritative Delivery Radius & Franchise Resolution (Enforcement Point 1)
router.put('/location', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const email = req.user?.email;
    const { addressLine, city, state, pincode, lat, lng } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized: missing user identifier' });
      return;
    }

    const custLat = lat != null ? Number(lat) : NaN;
    const custLng = lng != null ? Number(lng) : NaN;

    // Delivery radius check: If coordinates provided, verify serviceability
    let orderingContext: any = null;
    if (!isNaN(custLat) && !isNaN(custLng)) {
      const resolution = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: userId,
        lat: custLat,
        lng: custLng,
        addressLine: addressLine || ''
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
      orderingContext = resolution.context;
    }

    const userRef = adminDb.collection('users').doc(userId);
    const doc = await userRef.get();

    let userData: any = {
      firebase_uid: userId,
      email,
      name: 'Customer',
      full_address: addressLine,
      fullAddress: addressLine,
      city,
      state,
      pincode,
      lat: custLat,
      lng: custLng,
      location_setup_completed: true,
      locationSetupCompleted: true,
      role: 'customer',
      franchiseId: orderingContext?.franchiseId,
      branchId: orderingContext?.branchId,
      updatedAt: new Date().toISOString()
    };

    if (!doc.exists) {
      userData.createdAt = new Date().toISOString();
      await userRef.set(userData);
      await adminAuth.setCustomUserClaims(userId, { role: 'customer' });
    } else {
      userData = { 
        ...doc.data(), 
        full_address: addressLine,
        fullAddress: addressLine, 
        city, 
        state, 
        pincode,
        lat: custLat, 
        lng: custLng, 
        location_setup_completed: true, 
        locationSetupCompleted: true,
        franchiseId: orderingContext?.franchiseId || doc.data()?.franchiseId,
        branchId: orderingContext?.branchId || doc.data()?.branchId,
        updatedAt: new Date().toISOString() 
      };
      await userRef.update({ 
        full_address: addressLine,
        fullAddress: addressLine, 
        city, 
        state, 
        pincode,
        lat: custLat, 
        lng: custLng, 
        location_setup_completed: true, 
        locationSetupCompleted: true,
        franchiseId: userData.franchiseId,
        branchId: userData.branchId,
        updatedAt: userData.updatedAt 
      });
    }

    // Return successful response with ordering context
    res.json({
      success: true,
      isServiceable: true,
      context: orderingContext,
      user: {
        uid: userId,
        fullAddress: addressLine,
        city,
        state,
        pincode,
        lat: custLat,
        lng: custLng
      }
    });

    // Send Welcome Email and Notify Owner
    try {
      if (email) {
        const name = userData.name || 'Customer';
        await emailService.sendWelcomeEmail(email, name);
        await emailService.sendOwnerNotification('New User Signup', `A new user ${name} (${email}) has joined and completed their profile!`);
      }
    } catch (emailErr) {
      console.error("Failed to send welcome emails", emailErr);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Location setup error", error);
    res.status(500).json({ error: 'Failed to save location' });
  }
});

// Get User Profile
router.get('/profile', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const userRef = adminDb.collection('users').doc(userId!);
    const doc = await userRef.get();
    
    if (!doc.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const u = doc.data() as any;
    const profileDTO = ResponseSanitizationService.toCustomerProfileDTO({ id: doc.id, ...u });
    res.json({
      success: true,
      user: profileDTO,
      address: {
        addressLine: u.full_address || u.fullAddress || '',
        city: u.city || '',
        state: u.state || '',
        lat: u.lat,
        lng: u.lng
      }
    });
  } catch (error) {
    console.error("Profile fetch error", error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update Customer Profile Details
router.put('/profile', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, email, photoURL } = req.body;
    const userRef = adminDb.collection('users').doc(userId);
    const docSnap = await userRef.get();

    if (!docSnap.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const updates: Record<string, any> = {
      updatedAt: new Date().toISOString()
    };

    if (typeof name === 'string' && name.trim()) {
      updates.name = name.trim();
      updates.displayName = name.trim();
    }
    if (typeof email === 'string' && email.includes('@')) {
      updates.email = email.trim().toLowerCase();
    }
    if (typeof photoURL === 'string') {
      updates.photoURL = photoURL;
      updates.photoUrl = photoURL;
    }

    await userRef.update(updates);
    const updatedDoc = await userRef.get();
    const sanitizedUser = ResponseSanitizationService.toCustomerProfileDTO({ id: updatedDoc.id, ...updatedDoc.data() });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: sanitizedUser
    });
  } catch (error: any) {
    console.error('[UserRoutes] Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get User Authoritative Loyalty Points Summary & Ledger
router.get('/loyalty', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const summary = await LoyaltyService.getLoyaltySummary(userId);
    res.json({ success: true, ...summary });
  } catch (error: any) {
    console.error('[UserRoutes] Failed to fetch loyalty summary:', error);
    res.status(500).json({ error: 'Failed to fetch loyalty points summary' });
  }
});

// Get Customer Saved Addresses
router.get('/addresses', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userDoc = await adminDb.collection('users').doc(userId).get();
    const data = userDoc.data() || {};
    const addresses = data.addresses || data.savedAddresses || data.locations || [];
    res.json({
      success: true,
      addresses,
      count: addresses.length,
      maxAllowed: 8,
      isLimitReached: addresses.length >= 8
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

// Save / Replace Customer Addresses (enforces max 8 locations)
router.put('/addresses', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const { addresses } = req.body;
    if (!userId || !Array.isArray(addresses)) {
      res.status(400).json({ error: 'Invalid addresses payload' });
      return;
    }

    if (addresses.length > 8) {
      res.status(400).json({
        success: false,
        code: 'LOCATION_LIMIT_EXCEEDED',
        error: 'Location limit reached (8/8). You can save up to 8 delivery locations. Please delete an existing location first.',
        currentCount: addresses.length,
        maxLimit: 8
      });
      return;
    }

    const now = new Date().toISOString();
    await adminDb.collection('users').doc(userId).set({
      addresses,
      savedAddresses: addresses,
      locations: addresses,
      updatedAt: now
    }, { merge: true });

    res.json({ success: true, message: 'Addresses saved successfully', addresses, count: addresses.length });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save addresses' });
  }
});

// Permanently Delete Customer Address
router.delete('/addresses/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    const locationId = req.params.id;

    if (!userId || !locationId) {
      res.status(400).json({ success: false, error: 'User ID and Location ID required' });
      return;
    }

    const userRef = adminDb.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const data = userDoc.data() || {};
    const existing: any[] = data.addresses || data.savedAddresses || data.locations || [];
    const remaining = existing.filter((a) => a.id !== locationId);

    // 1. Delete from subcollection
    await userRef.collection('saved_locations').doc(locationId).delete().catch(() => {});

    // 2. Update user document
    await userRef.update({
      addresses: remaining,
      savedAddresses: remaining,
      locations: remaining,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Address permanently deleted from database',
      deletedId: locationId,
      remainingCount: remaining.length,
      addresses: remaining
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete address' });
  }
});

// Revoke all sessions
router.post('/revoke-all-sessions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // 1. Revoke Firebase Auth tokens (forces all devices to re-authenticate when current token expires)
    await adminAuth.revokeRefreshTokens(userId);

    // 2. Mark all Firestore device_heartbeats as inactive (forces realtime listeners to sign out instantly)
    const sessionsSnapshot = await adminDb.collection('device_heartbeats')
      .where('uid', '==', userId)
      .where('isActive', '==', true)
      .get();

    const batch = adminDb.batch();
    sessionsSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { isActive: false });
    });
    
    if (!sessionsSnapshot.empty) {
      await batch.commit();
    }

    res.json({ success: true, message: 'All sessions revoked' });
  } catch (error) {
    console.error("Revoke sessions error", error);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

// ── POST /deletion-request — Customer Account Deletion Request ────────────────
// Records a deletion request with 30-day grace period before actual erasure.
// Any pending active orders are noted on the request but do NOT block it.
router.post('/deletion-request', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { email, reason, downloadData } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email address is required to confirm your identity.' });
      return;
    }

    // Verify email matches authenticated user's registered email
    const userRecord = await adminAuth.getUser(uid).catch(() => null);
    if (userRecord && userRecord.email && userRecord.email.toLowerCase() !== email.toLowerCase()) {
      res.status(400).json({ error: 'The email address provided does not match your registered account email.' });
      return;
    }

    const now = new Date();
    const gracePeriodEnd = new Date(now);
    gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 30);

    // Check for any active orders before logging the request
    const activeOrdersSnap = await adminDb.collection('orders')
      .where('userId', '==', uid)
      .get()
      .catch(() => ({ docs: [] } as any));

    const activeOrders = activeOrdersSnap.docs
      .filter((d: any) => !['delivered', 'cancelled', 'rejected', 'failed'].includes(d.data().status))
      .map((d: any) => d.id);

    const requestData = {
      uid,
      email: email.toLowerCase(),
      reason: reason || 'No reason provided',
      downloadDataRequested: Boolean(downloadData),
      status: 'pending',
      activeOrdersAtRequest: activeOrders,
      requestedAt: now.toISOString(),
      gracePeriodEnd: gracePeriodEnd.toISOString(),
      scheduledErasureAt: gracePeriodEnd.toISOString(),
      source: 'customer_portal',
      ipAddress: req.ip || 'unknown'
    };

    await adminDb.collection('deletion_requests').add(requestData);

    // Mark user account as pending deletion (prevents new orders but doesn't deactivate immediately)
    await adminDb.collection('users').doc(uid).set({
      deletionRequestPending: true,
      deletionRequestedAt: now.toISOString(),
      deletionScheduledFor: gracePeriodEnd.toISOString()
    }, { merge: true });

    console.log(`[UserRoutes] Account deletion request logged for uid=${uid} email=${email} grace_period_end=${gracePeriodEnd.toISOString()}`);

    res.json({
      success: true,
      message: 'Account deletion request recorded. Your account will be permanently erased after the 30-day grace period.',
      gracePeriodEnd: gracePeriodEnd.toISOString(),
      activeOrdersAtRequest: activeOrders.length
    });
  } catch (error: any) {
    console.error('[UserRoutes] Deletion request error:', error);
    res.status(500).json({ error: error.message || 'Failed to submit deletion request' });
  }
});

export default router;

