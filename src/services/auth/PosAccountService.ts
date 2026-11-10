import { adminDb, adminAuth } from '../../config/firebase.js';
import { AuthAuditService } from './AuthAuditService.js';

export type PosAccountStatus = 'PENDING_OWNER_APPROVAL' | 'APPROVED' | 'ACTIVE' | 'REJECTED' | 'REVOKED';

export interface PosAccountData {
  id: string;
  name: string;
  email: string;
  franchiseId: string;
  branchId?: string;
  status: PosAccountStatus;
  createdAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  revokedAt?: string;
  approvedBy?: string;
  pinConfigured?: boolean;
}

export class PosAccountService {
  private static readonly COLLECTION = 'pos_accounts';

  /**
   * Check if a franchise already has an active, approved, or pending POS account.
   */
  public static async getExistingPosAccount(franchiseId: string): Promise<PosAccountData | null> {
    if (!adminDb) return null;

    const snapshot = await adminDb
      .collection(this.COLLECTION)
      .where('franchiseId', '==', franchiseId)
      .where('status', 'in', ['PENDING_OWNER_APPROVAL', 'APPROVED', 'ACTIVE'])
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as PosAccountData;
  }

  /**
   * Franchise Manager creates a POS account for their franchise.
   * Strictly enforces exactly 1 POS account per franchise.
   */
  public static async createPosAccount(params: {
    franchiseId: string;
    branchId?: string;
    name: string;
    email: string;
    password?: string;
    createdBy: string;
  }): Promise<{ success: boolean; message: string; posAccount?: PosAccountData }> {
    const { franchiseId, branchId, name, email, password, createdBy } = params;

    if (!franchiseId || !email || !name) {
      return { success: false, message: 'Franchise ID, terminal name, and email are required.' };
    }

    const cleanEmail = email.toLowerCase().trim();

    if (!adminDb || !adminAuth) {
      return { success: false, message: 'Firebase service unavailable.' };
    }

    // 1. Enforce 1 POS account per franchise constraint
    const existing = await this.getExistingPosAccount(franchiseId);
    if (existing) {
      return {
        success: false,
        message: `A POS account already exists for this franchise (${existing.email}, status: ${existing.status}). Only 1 POS account is permitted per franchise.`,
      };
    }

    // 2. Create or verify Firebase Auth user
    let uid: string;
    try {
      const existingAuthUser = await adminAuth.getUserByEmail(cleanEmail).catch(() => null);
      if (existingAuthUser) {
        uid = existingAuthUser.uid;
      } else {
        if (!password || password.length < 6) {
          return { success: false, message: 'A valid password (minimum 6 characters) is required to create a new POS account.' };
        }
        const newUser = await adminAuth.createUser({
          email: cleanEmail,
          password: password,
          displayName: name,
        });
        uid = newUser.uid;
      }

      // Set custom claims: role 'pos_operator', franchiseId, branchId, approved false
      await adminAuth.setCustomUserClaims(uid, {
        role: 'pos_operator',
        franchiseId,
        branchId: branchId || franchiseId,
        posApproved: false,
      });
    } catch (err: any) {
      console.error('[PosAccountService] Auth user creation failed:', err);
      return { success: false, message: `Failed to create auth user: ${err.message}` };
    }

    // 3. Store record in pos_accounts collection with status PENDING_OWNER_APPROVAL
    const resolvedBranch = branchId || franchiseId;
    const posAccount: PosAccountData = {
      id: uid,
      name,
      email: cleanEmail,
      franchiseId,
      branchId: resolvedBranch,
      status: 'PENDING_OWNER_APPROVAL',
      createdAt: new Date().toISOString(),
      pinConfigured: false,
    };

    await adminDb.collection(this.COLLECTION).doc(uid).set({
      ...posAccount,
      createdBy,
      updatedAt: new Date().toISOString(),
    });

    // Also mirror into users collection with role pos_operator
    await adminDb.collection('users').doc(uid).set({
      uid,
      email: cleanEmail,
      displayName: name,
      role: 'pos_operator',
      franchiseId,
      branchId: resolvedBranch,
      status: 'PENDING_OWNER_APPROVAL',
      emailVerified: true, // Internal operational user created by manager
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    await AuthAuditService.logEvent({
      eventType: 'POS_ACCOUNT_CREATED',
      userId: uid,
      identifier: cleanEmail,
      franchiseId,
      status: 'SUCCESS',
      metadata: { name, createdBy },
    });

    return {
      success: true,
      message: 'POS account created successfully and is now PENDING OWNER APPROVAL.',
      posAccount,
    };
  }

  /**
   * Owner approves a pending POS account.
   */
  public static async approvePosAccount(posId: string, ownerEmail: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb || !adminAuth) return { success: false, message: 'Database service unavailable.' };

    const ref = adminDb.collection(this.COLLECTION).doc(posId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'POS account record not found.' };
    }

    const data = snap.data()!;
    const franchiseId = data.franchiseId;

    const resolvedBranchId = data.branchId || franchiseId;

    // Update status to APPROVED / ACTIVE
    const now = new Date().toISOString();
    await ref.update({
      status: 'APPROVED',
      branchId: resolvedBranchId,
      approvedAt: now,
      approvedBy: ownerEmail,
      updatedAt: now,
    });

    // Update users collection
    await adminDb.collection('users').doc(posId).set({
      status: 'ACTIVE',
      branchId: resolvedBranchId,
      posApproved: true,
      approvedAt: now,
      approvedBy: ownerEmail,
      updatedAt: now,
    }, { merge: true });

    // Update franchises collection to ensure franchise.posEnabled is true and bound to this account
    if (franchiseId) {
      await adminDb.collection('franchises').doc(franchiseId).set({
        posEnabled: true,
        posAccountUid: posId,
        posAccountEmail: data.email,
        posApprovedAt: now,
        posApprovedBy: ownerEmail,
        updatedAt: now,
      }, { merge: true });
    }

    // Update custom claims
    try {
      await adminAuth.setCustomUserClaims(posId, {
        role: 'pos_operator',
        franchiseId,
        branchId: resolvedBranchId,
        posApproved: true,
      });
    } catch (err) {
      console.warn('[PosAccountService] Failed to set approved custom claims:', err);
    }

    await AuthAuditService.logEvent({
      eventType: 'POS_ACCOUNT_APPROVED',
      userId: posId,
      identifier: data.email,
      franchiseId,
      status: 'SUCCESS',
      metadata: { approvedBy: ownerEmail },
    });

    return { success: true, message: 'POS account has been approved and activated.' };
  }

  /**
   * Owner rejects a pending POS account.
   */
  public static async rejectPosAccount(posId: string, ownerEmail: string, reason?: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const ref = adminDb.collection(this.COLLECTION).doc(posId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'POS account record not found.' };
    }

    const data = snap.data()!;
    const now = new Date().toISOString();

    await ref.update({
      status: 'REJECTED',
      rejectedAt: now,
      rejectedBy: ownerEmail,
      rejectReason: reason || 'Rejected by Owner',
      updatedAt: now,
    });

    await adminDb.collection('users').doc(posId).set({
      status: 'REJECTED',
      posApproved: false,
      updatedAt: now,
    }, { merge: true });

    if (data.franchiseId) {
      await adminDb.collection('franchises').doc(data.franchiseId).set({
        posEnabled: false,
        updatedAt: now,
      }, { merge: true });
    }

    await AuthAuditService.logEvent({
      eventType: 'POS_ACCOUNT_REJECTED',
      userId: posId,
      identifier: data.email,
      franchiseId: data.franchiseId,
      status: 'SUCCESS',
      metadata: { rejectedBy: ownerEmail, reason },
    });

    return { success: true, message: 'POS account has been rejected.' };
  }

  /**
   * Owner revokes access for an active POS account.
   */
  public static async revokePosAccount(posId: string, ownerEmail: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const ref = adminDb.collection(this.COLLECTION).doc(posId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { success: false, message: 'POS account record not found.' };
    }

    const data = snap.data()!;
    const now = new Date().toISOString();

    await ref.update({
      status: 'REVOKED',
      revokedAt: now,
      revokedBy: ownerEmail,
      updatedAt: now,
    });

    await adminDb.collection('users').doc(posId).set({
      status: 'REVOKED',
      role: 'REVOKED',
      isActive: false,
      posApproved: false,
      revokedAt: now,
      revokedBy: ownerEmail,
      updatedAt: now,
    }, { merge: true });

    if (data.franchiseId) {
      await adminDb.collection('franchises').doc(data.franchiseId).set({
        posEnabled: false,
        updatedAt: now,
      }, { merge: true });
    }

    // Revoke Firebase Auth session tokens if possible
    try {
      await adminAuth.revokeRefreshTokens(posId);
      await adminAuth.setCustomUserClaims(posId, { role: 'REVOKED', revokedAt: now });
    } catch (err) {
      console.warn('[PosAccountService] Failed to revoke refresh tokens:', err);
    }

    await AuthAuditService.logEvent({
      eventType: 'POS_ACCOUNT_REVOKED',
      userId: posId,
      identifier: data.email,
      franchiseId: data.franchiseId,
      status: 'SUCCESS',
      metadata: { revokedBy: ownerEmail },
    });

    return { success: true, message: 'POS account access has been revoked.' };
  }

  /**
   * List POS accounts by franchise.
   */
  public static async listAccountsByFranchise(franchiseId: string): Promise<PosAccountData[]> {
    if (!adminDb) return [];
    const snapshot = await adminDb
      .collection(this.COLLECTION)
      .where('franchiseId', '==', franchiseId)
      .get();

    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PosAccountData));
  }

  /**
   * List all POS accounts pending Owner approval across all franchises.
   */
  public static async listPendingAccounts(): Promise<PosAccountData[]> {
    if (!adminDb) return [];
    const snapshot = await adminDb
      .collection(this.COLLECTION)
      .where('status', '==', 'PENDING_OWNER_APPROVAL')
      .get();

    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PosAccountData));
  }

  /**
   * Franchise Manager requests POS access for their own franchise.
   * Derives franchise scope server-side.
   */
  public static async requestPosAccess(params: {
    managerUid: string;
    managerEmail: string;
    managerName?: string;
    franchiseId?: string;
  }): Promise<{ success: boolean; message: string; request?: any }> {
    const { managerUid, managerEmail, managerName } = params;
    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    // 1. Derive manager's franchiseId server-side
    let franchiseId: string | null = params.franchiseId || null;
    if (!franchiseId && managerUid) {
      const userDoc = await adminDb.collection('users').doc(managerUid).get();
      if (userDoc.exists) {
        franchiseId = userDoc.data()?.franchiseId || null;
      }
    }
    if (!franchiseId) {
      const fraDoc = await adminDb.collection('franchise_users').doc(managerUid).get();
      if (fraDoc.exists) {
        franchiseId = fraDoc.data()?.franchiseId || null;
      }
    }

    if (!franchiseId) {
      return { success: false, message: 'Forbidden: No authorized franchise is bound to your account.' };
    }

    // 2. Check if franchise is already POS-enabled
    const fraRef = adminDb.collection('franchises').doc(franchiseId);
    const fraSnap = await fraRef.get();
    if (fraSnap.exists && fraSnap.data()?.posEnabled === true) {
      return { success: false, message: 'POS is already enabled and active for this franchise.' };
    }

    // 3. Check for existing pending request (duplicate / rate-limiting protection)
    const existingReqSnap = await adminDb
      .collection('pos_access_requests')
      .where('franchiseId', '==', franchiseId)
      .where('status', '==', 'PENDING')
      .limit(1)
      .get();

    if (!existingReqSnap.empty) {
      return { success: false, message: 'A POS access request is already pending Owner approval for this franchise.' };
    }

    // 4. Create request record
    const now = new Date().toISOString();
    const reqRef = adminDb.collection('pos_access_requests').doc();
    const franchiseName = (fraSnap.exists && fraSnap.data()?.name) ? fraSnap.data()!.name : franchiseId;
    const requestData = {
      id: reqRef.id,
      requestId: reqRef.id,
      franchiseId,
      franchiseName,
      managerUid,
      managerEmail,
      managerName: managerName || managerEmail.split('@')[0] || 'Franchise Manager',
      status: 'PENDING',
      requestedAt: now,
      updatedAt: now
    };

    await reqRef.set(requestData);

    // 5. Notify Owner with deep link to exact franchise
    try {
      await adminDb.collection('notifications').add({
        type: 'POS_ACCESS_REQUEST',
        recipientRole: 'owner',
        title: 'New POS Access Request',
        body: `Franchise Manager (${managerEmail}) has requested POS access for franchise "${franchiseName}".`,
        franchiseId,
        actionUrl: `/franchise-management/${franchiseId}?tab=pos`,
        metadata: { requestId: reqRef.id, franchiseId, managerUid, managerEmail },
        read: false,
        createdAt: now
      });
    } catch (notifErr) {
      console.warn('[PosAccountService] Failed to record owner notification:', notifErr);
    }

    await AuthAuditService.logEvent({
      eventType: 'POS_ACCESS_REQUESTED',
      userId: managerUid,
      identifier: managerEmail,
      franchiseId,
      status: 'SUCCESS',
      metadata: { requestId: reqRef.id }
    });

    return {
      success: true,
      message: 'POS access request submitted successfully and is pending Owner review.',
      request: requestData
    };
  }

  /**
   * Owner approves a pending POS access request with concurrency protection.
   */
  public static async approvePosRequest(requestId: string, ownerEmail: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb || !adminAuth) return { success: false, message: 'Database service unavailable.' };

    const reqRef = adminDb.collection('pos_access_requests').doc(requestId);
    const now = new Date().toISOString();

    try {
      const result = await adminDb.runTransaction(async (t) => {
        const reqSnap = await t.get(reqRef);
        if (!reqSnap.exists) {
          throw new Error('POS access request not found.');
        }
        const rData = reqSnap.data()!;
        if (rData.status !== 'PENDING') {
          throw new Error(`Request cannot be approved because current status is ${rData.status}.`);
        }

        let fraRef = adminDb.collection('franchises').doc(rData.franchiseId);
        let fraSnap = await t.get(fraRef);
        if (!fraSnap.exists) {
          fraRef = adminDb.collection('franchise_entities').doc(rData.franchiseId);
          fraSnap = await t.get(fraRef);
        }
        if (!fraSnap.exists) {
          throw new Error('Associated franchise record not found.');
        }

        // Mark request as APPROVED
        t.update(reqRef, {
          status: 'APPROVED',
          approvedAt: now,
          approvedBy: ownerEmail,
          updatedAt: now
        });

        // Update franchise to posEnabled: true
        t.set(fraRef, {
          posEnabled: true,
          posAccountUid: rData.managerUid,
          posAccountEmail: rData.managerEmail,
          posApprovedAt: now,
          posApprovedBy: ownerEmail,
          updatedAt: now
        }, { merge: true });

        // Update user record
        const userRef = adminDb.collection('users').doc(rData.managerUid);
        t.set(userRef, {
          posApproved: true,
          posApprovedAt: now,
          posApprovedBy: ownerEmail,
          applicationAccess: { app_pos: true },
          updatedAt: now
        }, { merge: true });

        return {
          success: true,
          message: `POS access approved for franchise "${rData.franchiseName}".`,
          managerUid: rData.managerUid,
          franchiseId: rData.franchiseId,
          managerEmail: rData.managerEmail
        };
      });

      // Update custom claims
      if (result.managerUid) {
        try {
          await adminAuth.setCustomUserClaims(result.managerUid, {
            franchiseId: result.franchiseId,
            posApproved: true
          });
        } catch (claimErr) {
          console.warn('[PosAccountService] Failed to set claim after request approval:', claimErr);
        }
      }

      await AuthAuditService.logEvent({
        eventType: 'POS_REQUEST_APPROVED',
        userId: result.managerUid,
        identifier: result.managerEmail,
        franchiseId: result.franchiseId,
        status: 'SUCCESS',
        metadata: { requestId, approvedBy: ownerEmail }
      });

      return { success: true, message: result.message };
    } catch (err: any) {
      console.error('[PosAccountService] Error approving POS request:', err);
      return { success: false, message: err.message || 'Approval transaction failed' };
    }
  }

  /**
   * Owner rejects a pending POS access request.
   */
  public static async rejectPosRequest(requestId: string, ownerEmail: string, reason?: string): Promise<{ success: boolean; message: string }> {
    if (!adminDb) return { success: false, message: 'Database service unavailable.' };

    const reqRef = adminDb.collection('pos_access_requests').doc(requestId);
    const now = new Date().toISOString();

    try {
      const result = await adminDb.runTransaction(async (t) => {
        const reqSnap = await t.get(reqRef);
        if (!reqSnap.exists) {
          throw new Error('POS access request not found.');
        }
        const rData = reqSnap.data()!;
        if (rData.status !== 'PENDING') {
          throw new Error(`Request cannot be rejected because current status is ${rData.status}.`);
        }

        let fraRef = adminDb.collection('franchises').doc(rData.franchiseId);
        let fraSnap = await t.get(fraRef);
        if (!fraSnap.exists) {
          fraRef = adminDb.collection('franchise_entities').doc(rData.franchiseId);
          fraSnap = await t.get(fraRef);
        }

        t.update(reqRef, {
          status: 'REJECTED',
          rejectedAt: now,
          rejectedBy: ownerEmail,
          rejectReason: reason || 'Rejected by Owner',
          updatedAt: now
        });

        if (fraSnap.exists) {
          t.set(fraRef, {
            posEnabled: false,
            updatedAt: now
          }, { merge: true });
        }

        return { success: true, message: 'POS access request rejected.' };
      });

      return result;
    } catch (err: any) {
      console.error('[PosAccountService] Error rejecting POS request:', err);
      return { success: false, message: err.message || 'Rejection failed' };
    }
  }

  /**
   * Get POS access request status for a specific franchise.
   */
  public static async getPosRequestStatus(franchiseId: string): Promise<any> {
    if (!adminDb) return null;
    const snapshot = await adminDb
      .collection('pos_access_requests')
      .where('franchiseId', '==', franchiseId)
      .get();

    if (snapshot.empty) return null;
    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    docs.sort((a: any, b: any) => new Date(b.requestedAt || 0).getTime() - new Date(a.requestedAt || 0).getTime());
    return docs[0];
  }

  /**
   * List all pending POS access requests across franchises.
   */
  public static async listPendingPosRequests(): Promise<any[]> {
    if (!adminDb) return [];
    const snapshot = await adminDb
      .collection('pos_access_requests')
      .where('status', 'in', ['PENDING', 'PENDING_OWNER_APPROVAL'])
      .get();

    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    docs.sort((a: any, b: any) => new Date(b.requestedAt || 0).getTime() - new Date(a.requestedAt || 0).getTime());
    return docs;
  }
}
