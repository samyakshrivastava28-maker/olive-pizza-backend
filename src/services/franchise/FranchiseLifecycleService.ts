import { adminDb, adminAuth } from '../../config/firebase.js';
import { FranchiseScopeService } from './FranchiseScopeService.js';
import { CustomerOrderingContextService } from '../order/CustomerOrderingContextService.js';

export interface PreDeleteAccountSnapshot {
  uid: string;
  email: string;
  role: string;
  status: string;
  isActive: boolean;
  applicationAccess?: Record<string, boolean>;
  franchiseAccess?: any[];
  sourceCollection: 'users' | 'restaurant_managers' | 'pos_accounts' | 'franchise_users' | 'delivery_partners';
}

export interface PreDeleteState {
  franchiseId: string;
  deletedAt: string;
  deletedBy: string;
  accounts: PreDeleteAccountSnapshot[];
}

export class FranchiseLifecycleService {
  /**
   * Soft-delete a franchise branch / entity
   * - Marks franchise status = 'deleted', isActive = false
   * - Saves pre-delete access state of all assigned accounts
   * - Revokes active sessions / refresh tokens of assigned staff
   * - Deactivates accounts scoped strictly to this franchise
   * - Preserves historical orders, customers, and financial records
   */
  public static async softDeleteFranchise(params: {
    franchiseId: string;
    deletedBy: string;
    reason: string;
  }): Promise<{ success: boolean; message: string; franchise: any }> {
    const { franchiseId, deletedBy, reason } = params;
    const now = new Date().toISOString();

    if (!adminDb) {
      throw new Error('Database service unavailable');
    }

    // 1. Locate branch in franchises collection
    let branchRef = adminDb.collection('franchises').doc(franchiseId);
    let branchSnap = await branchRef.get();

    if (!branchSnap.exists) {
      const q = await adminDb.collection('franchises').where('franchiseId', '==', franchiseId).limit(1).get();
      if (!q.empty) {
        branchRef = adminDb.collection('franchises').doc(q.docs[0].id);
        branchSnap = q.docs[0];
      }
    }

    // 2. Locate entity in franchise_entities collection
    let entityRef = adminDb.collection('franchise_entities').doc(franchiseId);
    let entitySnap = await entityRef.get();

    if (!entitySnap.exists && branchSnap.exists) {
      const parentId = branchSnap.data()?.franchiseId;
      if (parentId) {
        const pRef = adminDb.collection('franchise_entities').doc(parentId);
        const pSnap = await pRef.get();
        if (pSnap.exists) {
          entityRef = pRef;
          entitySnap = pSnap;
        }
      }
    }

    if (!branchSnap.exists && !entitySnap.exists) {
      throw new Error(`Franchise "${franchiseId}" not found`);
    }

    const branchData = branchSnap.exists ? branchSnap.data()! : {};
    const entityData = entitySnap.exists ? entitySnap.data()! : {};
    const resolvedFranchiseId = entitySnap.exists ? entitySnap.id : (branchData.franchiseId || franchiseId);
    const resolvedBranchId = branchSnap.exists ? branchSnap.id : (entityData.mainBranchId || franchiseId);
    const franchiseName = branchData.name || entityData.name || 'Olive Pizza Franchise';

    // 3. Collect assigned accounts for preDeleteAccessState
    const accountsSnapshot: PreDeleteAccountSnapshot[] = [];

    // Query restaurant_managers
    const rmSnaps = await adminDb.collection('restaurant_managers')
      .where('branchId', '==', resolvedBranchId).get().catch(() => ({ docs: [] } as any));
    for (const d of rmSnaps.docs) {
      const data = d.data();
      accountsSnapshot.push({
        uid: d.id,
        email: data.email || '',
        role: 'restaurant_manager',
        status: data.status || 'APPROVED',
        isActive: data.isActive !== false,
        applicationAccess: data.applicationAccess,
        sourceCollection: 'restaurant_managers'
      });
    }

    // Query pos_accounts
    const posSnaps = await adminDb.collection('pos_accounts')
      .where('franchiseId', '==', resolvedFranchiseId).get().catch(() => ({ docs: [] } as any));
    for (const d of posSnaps.docs) {
      const data = d.data();
      accountsSnapshot.push({
        uid: d.id,
        email: data.email || '',
        role: 'cashier',
        status: data.status || 'APPROVED',
        isActive: data.isActive !== false,
        sourceCollection: 'pos_accounts'
      });
    }

    // Query franchise_users
    const fuSnaps = await adminDb.collection('franchise_users')
      .where('franchiseId', '==', resolvedFranchiseId).get().catch(() => ({ docs: [] } as any));
    for (const d of fuSnaps.docs) {
      const data = d.data();
      accountsSnapshot.push({
        uid: d.id,
        email: data.email || '',
        role: data.role || 'franchise_manager',
        status: data.status || 'APPROVED',
        isActive: data.isActive !== false,
        sourceCollection: 'franchise_users'
      });
    }

    // Query delivery_partners
    const dpSnaps = await adminDb.collection('delivery_partners')
      .where('branchId', '==', resolvedBranchId).get().catch(() => ({ docs: [] } as any));
    for (const d of dpSnaps.docs) {
      const data = d.data();
      accountsSnapshot.push({
        uid: d.id,
        email: data.email || data.phone || '',
        role: 'delivery_partner',
        status: data.status || 'approved',
        isActive: data.isActive !== false,
        sourceCollection: 'delivery_partners'
      });
    }

    // Also check direct manager emails on the branch
    const keyEmails = [
      branchData.restaurantManagerEmail,
      branchData.franchiseOwnerEmail,
      entityData.restaurantManagerEmail,
      entityData.franchiseOwnerEmail
    ].filter(Boolean).map(e => e.toLowerCase().trim());

    for (const email of keyEmails) {
      if (email === 'olivepizzarjn@gmail.com' || email === 'webhub2811@gmail.com' || email === 'olivepizzamaker@gmail.com') {
        continue; // Never deactivate platform owner
      }
      const uSnap = await adminDb.collection('users').where('email', '==', email).limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
      if (!uSnap.empty) {
        const uDoc = uSnap.docs[0];
        const uData = uDoc.data();
        if (!accountsSnapshot.some(a => a.email.toLowerCase() === email)) {
          accountsSnapshot.push({
            uid: uDoc.id,
            email,
            role: uData.role || 'staff',
            status: uData.status || 'ACTIVE',
            isActive: uData.isActive !== false,
            applicationAccess: uData.applicationAccess,
            franchiseAccess: uData.franchiseAccess,
            sourceCollection: 'users'
          });
        }
      }
    }

    const preDeleteState: PreDeleteState = {
      franchiseId: resolvedFranchiseId,
      deletedAt: now,
      deletedBy,
      accounts: accountsSnapshot
    };

    const updatePayload = {
      status: 'deleted',
      isActive: false,
      deletedAt: now,
      deletedBy,
      deletionReason: reason || 'Soft-deleted by Owner',
      previousStatus: branchData.status || entityData.status || 'ACTIVE',
      preDeleteAccessState: preDeleteState,
      updatedAt: now
    };

    // 4. Update branch doc
    if (branchSnap.exists) {
      await branchRef.set(updatePayload, { merge: true });
    }

    // 5. Update entity doc
    if (entitySnap.exists) {
      await entityRef.set(updatePayload, { merge: true });
    }

    // 6. Deactivate accounts & revoke sessions (except platform owners)
    for (const acc of accountsSnapshot) {
      const emailLower = acc.email.toLowerCase().trim();
      if (emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com' || emailLower === 'olivepizzamaker@gmail.com') {
        continue;
      }

      // Mark collection doc inactive
      if (acc.sourceCollection === 'restaurant_managers') {
        await adminDb.collection('restaurant_managers').doc(acc.uid).set({
          isActive: false,
          status: 'FRANCHISE_DELETED',
          deactivatedAt: now,
          deactivationReason: `Franchise ${franchiseName} was deleted`
        }, { merge: true }).catch(() => {});
      } else if (acc.sourceCollection === 'pos_accounts') {
        await adminDb.collection('pos_accounts').doc(acc.uid).set({
          isActive: false,
          status: 'REVOKED',
          revokedAt: now,
          revokedReason: `Franchise ${franchiseName} was deleted`
        }, { merge: true }).catch(() => {});
      } else if (acc.sourceCollection === 'franchise_users') {
        await adminDb.collection('franchise_users').doc(acc.uid).set({
          isActive: false,
          status: 'FRANCHISE_DELETED',
          deactivatedAt: now
        }, { merge: true }).catch(() => {});
      } else if (acc.sourceCollection === 'delivery_partners') {
        await adminDb.collection('delivery_partners').doc(acc.uid).set({
          isActive: false,
          status: 'suspended',
          suspendedAt: now
        }, { merge: true }).catch(() => {});
      }

      // Update users collection if present
      const userDoc = await adminDb.collection('users').doc(acc.uid).get().catch(() => null);
      if (userDoc && userDoc.exists) {
        const uData = userDoc.data()!;
        const updatedFranchiseAccess = Array.isArray(uData.franchiseAccess)
          ? uData.franchiseAccess.map((fa: any) => fa.franchiseId === resolvedFranchiseId ? { ...fa, status: 'FRANCHISE_DELETED' } : fa)
          : [];
        await adminDb.collection('users').doc(acc.uid).set({
          franchiseAccess: updatedFranchiseAccess,
          isFranchiseActive: false,
          updatedAt: now
        }, { merge: true }).catch(() => {});
      }

      // Revoke Firebase Auth tokens so active sessions end immediately
      if (adminAuth) {
        try {
          const authUser = await adminAuth.getUser(acc.uid).catch(async () => {
            return acc.email ? await adminAuth.getUserByEmail(acc.email).catch(() => null) : null;
          });
          if (authUser) {
            await adminAuth.revokeRefreshTokens(authUser.uid).catch(() => {});
          }
        } catch {
          // Non-blocking
        }
      }
    }

    // 7. Log audit event
    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: resolvedFranchiseId,
      branchId: resolvedBranchId,
      actorUid: deletedBy,
      actorEmail: deletedBy,
      actionType: 'FRANCHISE_SOFT_DELETED',
      entityType: 'franchise',
      entityId: resolvedFranchiseId,
      details: {
        reason,
        franchiseName,
        accountsDeactivatedCount: accountsSnapshot.length
      }
    });

    CustomerOrderingContextService.invalidateBranchesSnapshot();

    return {
      success: true,
      message: `Franchise "${franchiseName}" soft-deleted successfully. ${accountsSnapshot.length} assigned account(s) deactivated.`,
      franchise: {
        id: resolvedBranchId,
        franchiseId: resolvedFranchiseId,
        name: franchiseName,
        status: 'deleted',
        deletedAt: now,
        deletedBy,
        deletionReason: reason
      }
    };
  }

  /**
   * List all soft-deleted franchises with metadata and summary stats
   */
  public static async listDeletedFranchises(): Promise<any[]> {
    if (!adminDb) return [];

    const deletedBranchesSnap = await adminDb.collection('franchises')
      .where('status', '==', 'deleted')
      .get().catch(() => ({ docs: [] } as any));

    const deletedEntitiesSnap = await adminDb.collection('franchise_entities')
      .where('status', '==', 'deleted')
      .get().catch(() => ({ docs: [] } as any));

    const resultMap = new Map<string, any>();

    for (const doc of deletedEntitiesSnap.docs) {
      const data = doc.data();
      resultMap.set(doc.id, {
        id: doc.id,
        franchiseId: doc.id,
        name: data.name || 'Olive Pizza Franchise',
        code: data.code || 'OP-FRA',
        city: data.city || '',
        state: data.region || data.state || '',
        deletedAt: data.deletedAt || data.updatedAt,
        deletedBy: data.deletedBy || 'owner',
        deletionReason: data.deletionReason || 'Soft-deleted by Owner',
        accountsCount: data.preDeleteAccessState?.accounts?.length || 0,
        status: 'deleted'
      });
    }

    for (const doc of deletedBranchesSnap.docs) {
      const data = doc.data();
      const fId = data.franchiseId || doc.id;
      if (!resultMap.has(fId) && !resultMap.has(doc.id)) {
        resultMap.set(doc.id, {
          id: doc.id,
          franchiseId: fId,
          name: data.name || 'Olive Pizza Branch',
          code: data.code || 'OP-BRN',
          city: data.city || '',
          state: data.state || '',
          deletedAt: data.deletedAt || data.updatedAt,
          deletedBy: data.deletedBy || 'owner',
          deletionReason: data.deletionReason || 'Soft-deleted by Owner',
          accountsCount: data.preDeleteAccessState?.accounts?.length || 0,
          status: 'deleted'
        });
      }
    }

    return Array.from(resultMap.values()).sort((a, b) => 
      new Date(b.deletedAt || 0).getTime() - new Date(a.deletedAt || 0).getTime()
    );
  }

  /**
   * Get complete historical snapshot of a deleted or active franchise
   * (Orders, customers count, accounts, reports, audit log trail)
   */
  public static async getFranchiseHistory(franchiseId: string): Promise<any> {
    if (!adminDb) throw new Error('Database service unavailable');

    // 1. Fetch franchise docs
    let docSnap = await adminDb.collection('franchise_entities').doc(franchiseId).get();
    let isEntity = true;
    if (!docSnap.exists) {
      docSnap = await adminDb.collection('franchises').doc(franchiseId).get();
      isEntity = false;
    }

    if (!docSnap.exists) {
      const q = await adminDb.collection('franchises').where('franchiseId', '==', franchiseId).limit(1).get();
      if (!q.empty) {
        docSnap = q.docs[0];
        isEntity = false;
      }
    }

    if (!docSnap.exists) {
      throw new Error(`Franchise "${franchiseId}" not found`);
    }

    const franchiseData = docSnap.data()!;
    const fId = franchiseData.franchiseId || franchiseId;
    const bId = franchiseData.mainBranchId || franchiseData.id || franchiseId;

    // 2. Query historical orders summary
    const ordersSnap = await adminDb.collection('orders')
      .where('franchiseId', '==', fId)
      .get()
      .catch(async () => {
        return await adminDb.collection('orders').where('branchId', '==', bId).get().catch(() => ({ docs: [] } as any));
      });

    const orders = ordersSnap.docs.map((d: any) => d.data());
    const totalOrders = orders.length;
    const completedOrders = orders.filter((o: any) => o.status === 'delivered' || o.status === 'DELIVERED').length;
    const totalRevenue = orders.reduce((sum: number, o: any) => sum + (Number(o.totalAmount || o.total || 0) || 0), 0);
    const uniqueCustomers = new Set(orders.map((o: any) => o.customerPhone || o.userPhone || o.customerEmail || o.email).filter(Boolean)).size;

    // 3. Query audit trail
    const auditSnap = await adminDb.collection('franchise_audits')
      .where('franchiseId', '==', fId)
      .limit(50)
      .get()
      .catch(() => ({ docs: [] } as any));

    const auditTrail = auditSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }))
      .sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    // 4. Assigned accounts from preDeleteAccessState or current state
    const accounts = franchiseData.preDeleteAccessState?.accounts || [];

    return {
      franchise: {
        id: docSnap.id,
        franchiseId: fId,
        branchId: bId,
        name: franchiseData.name || 'Olive Pizza',
        code: franchiseData.code || '',
        city: franchiseData.city || '',
        state: franchiseData.state || franchiseData.region || '',
        address: franchiseData.address || '',
        phone: franchiseData.phone || franchiseData.contactPhone || '',
        email: franchiseData.email || franchiseData.contactEmail || '',
        status: franchiseData.status || (franchiseData.isActive ? 'ACTIVE' : 'DELETED'),
        deletedAt: franchiseData.deletedAt,
        deletedBy: franchiseData.deletedBy,
        deletionReason: franchiseData.deletionReason
      },
      stats: {
        totalOrders,
        completedOrders,
        totalRevenue: Math.round(totalRevenue),
        uniqueCustomers
      },
      accounts,
      auditTrail
    };
  }

  /**
   * Recover a soft-deleted franchise
   * - Restores status = 'active', isActive = true
   * - Restores pre-delete account permissions (without reactivating individually disabled accounts)
   * - Writes recovery audit record
   */
  public static async recoverFranchise(params: {
    franchiseId: string;
    recoveredBy: string;
  }): Promise<{ success: boolean; message: string; franchise: any }> {
    const { franchiseId, recoveredBy } = params;
    const now = new Date().toISOString();

    if (!adminDb) throw new Error('Database service unavailable');

    // 1. Locate branch & entity
    let branchRef = adminDb.collection('franchises').doc(franchiseId);
    let branchSnap = await branchRef.get();
    if (!branchSnap.exists) {
      const q = await adminDb.collection('franchises').where('franchiseId', '==', franchiseId).limit(1).get();
      if (!q.empty) {
        branchRef = adminDb.collection('franchises').doc(q.docs[0].id);
        branchSnap = q.docs[0];
      }
    }

    let entityRef = adminDb.collection('franchise_entities').doc(franchiseId);
    let entitySnap = await entityRef.get();
    if (!entitySnap.exists && branchSnap.exists) {
      const parentId = branchSnap.data()?.franchiseId;
      if (parentId) {
        const pRef = adminDb.collection('franchise_entities').doc(parentId);
        const pSnap = await pRef.get();
        if (pSnap.exists) {
          entityRef = pRef;
          entitySnap = pSnap;
        }
      }
    }

    if (!branchSnap.exists && !entitySnap.exists) {
      throw new Error(`Deleted franchise "${franchiseId}" not found`);
    }

    const branchData = branchSnap.exists ? branchSnap.data()! : {};
    const entityData = entitySnap.exists ? entitySnap.data()! : {};
    const preDeleteState: PreDeleteState | undefined = branchData.preDeleteAccessState || entityData.preDeleteAccessState;
    const resolvedFranchiseId = entitySnap.exists ? entitySnap.id : (branchData.franchiseId || franchiseId);
    const resolvedBranchId = branchSnap.exists ? branchSnap.id : (entityData.mainBranchId || franchiseId);
    const franchiseName = branchData.name || entityData.name || 'Olive Pizza Franchise';

    const recoverPayload = {
      status: 'active',
      isActive: true,
      recoveredAt: now,
      recoveredBy,
      deletionReason: null,
      updatedAt: now
    };

    if (branchSnap.exists) {
      await branchRef.set(recoverPayload, { merge: true });
    }
    if (entitySnap.exists) {
      await entityRef.set(recoverPayload, { merge: true });
    }

    // 2. Restore account access for previously active accounts
    let accountsRestoredCount = 0;
    if (preDeleteState && Array.isArray(preDeleteState.accounts)) {
      for (const acc of preDeleteState.accounts) {
        // Only reactivate if it was active prior to franchise deletion
        if (acc.isActive && acc.status !== 'SUSPENDED' && acc.status !== 'REVOKED') {
          accountsRestoredCount++;
          if (acc.sourceCollection === 'restaurant_managers') {
            await adminDb.collection('restaurant_managers').doc(acc.uid).set({
              isActive: true,
              status: 'APPROVED',
              updatedAt: now
            }, { merge: true }).catch(() => {});
          } else if (acc.sourceCollection === 'pos_accounts') {
            await adminDb.collection('pos_accounts').doc(acc.uid).set({
              isActive: true,
              status: 'APPROVED',
              updatedAt: now
            }, { merge: true }).catch(() => {});
          } else if (acc.sourceCollection === 'franchise_users') {
            await adminDb.collection('franchise_users').doc(acc.uid).set({
              isActive: true,
              status: 'APPROVED',
              updatedAt: now
            }, { merge: true }).catch(() => {});
          } else if (acc.sourceCollection === 'delivery_partners') {
            await adminDb.collection('delivery_partners').doc(acc.uid).set({
              isActive: true,
              status: 'approved',
              updatedAt: now
            }, { merge: true }).catch(() => {});
          }

          // Restore users collection record
          const userDoc = await adminDb.collection('users').doc(acc.uid).get().catch(() => null);
          if (userDoc && userDoc.exists) {
            const uData = userDoc.data()!;
            const updatedFranchiseAccess = Array.isArray(uData.franchiseAccess)
              ? uData.franchiseAccess.map((fa: any) => fa.franchiseId === resolvedFranchiseId ? { ...fa, status: 'ACTIVE' } : fa)
              : [{
                  franchiseId: resolvedFranchiseId,
                  branchId: resolvedBranchId,
                  role: acc.role,
                  status: 'ACTIVE',
                  updatedAt: now
                }];
            await adminDb.collection('users').doc(acc.uid).set({
              isActive: true,
              status: 'APPROVED',
              franchiseAccess: updatedFranchiseAccess,
              isFranchiseActive: true,
              updatedAt: now
            }, { merge: true }).catch(() => {});
          }
        }
      }
    }

    // 3. Log recovery audit
    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: resolvedFranchiseId,
      branchId: resolvedBranchId,
      actorUid: recoveredBy,
      actorEmail: recoveredBy,
      actionType: 'FRANCHISE_RECOVERED',
      entityType: 'franchise',
      entityId: resolvedFranchiseId,
      details: {
        franchiseName,
        accountsRestoredCount
      }
    });

    CustomerOrderingContextService.invalidateBranchesSnapshot();

    return {
      success: true,
      message: `Franchise "${franchiseName}" recovered successfully. ${accountsRestoredCount} account(s) restored.`,
      franchise: {
        id: resolvedBranchId,
        franchiseId: resolvedFranchiseId,
        name: franchiseName,
        status: 'active',
        isActive: true,
        recoveredAt: now,
        recoveredBy
      }
    };
  }

  /**
   * Permanently delete a franchise
   * - Platform Owner only
   * - Requires matching confirmation name
   * - Purges operational configuration (franchises, franchise_entities, pos_terminals, pos_accounts)
   * - Archives order records for retention compliance
   * - Writes irreversible deletion audit record
   */
  public static async permanentDeleteFranchise(params: {
    franchiseId: string;
    confirmFranchiseName: string;
    deletedBy: string;
  }): Promise<{ success: boolean; message: string }> {
    const { franchiseId, confirmFranchiseName, deletedBy } = params;
    const now = new Date().toISOString();

    if (!adminDb) throw new Error('Database service unavailable');

    // 1. Locate franchise
    let branchRef = adminDb.collection('franchises').doc(franchiseId);
    let branchSnap = await branchRef.get();
    if (!branchSnap.exists) {
      const q = await adminDb.collection('franchises').where('franchiseId', '==', franchiseId).limit(1).get();
      if (!q.empty) {
        branchRef = adminDb.collection('franchises').doc(q.docs[0].id);
        branchSnap = q.docs[0];
      }
    }

    let entityRef = adminDb.collection('franchise_entities').doc(franchiseId);
    let entitySnap = await entityRef.get();
    if (!entitySnap.exists && branchSnap.exists) {
      const parentId = branchSnap.data()?.franchiseId;
      if (parentId) {
        const pRef = adminDb.collection('franchise_entities').doc(parentId);
        const pSnap = await pRef.get();
        if (pSnap.exists) {
          entityRef = pRef;
          entitySnap = pSnap;
        }
      }
    }

    if (!branchSnap.exists && !entitySnap.exists) {
      throw new Error(`Franchise "${franchiseId}" not found`);
    }

    const branchData = branchSnap.exists ? branchSnap.data()! : {};
    const entityData = entitySnap.exists ? entitySnap.data()! : {};
    const actualName = (branchData.name || entityData.name || '').trim();

    // 2. Strict Confirmation Check
    if (confirmFranchiseName.trim().toLowerCase() !== actualName.toLowerCase()) {
      throw new Error(`Confirmation name "${confirmFranchiseName}" does not match franchise name "${actualName}".`);
    }

    const resolvedFranchiseId = entitySnap.exists ? entitySnap.id : (branchData.franchiseId || franchiseId);
    const resolvedBranchId = branchSnap.exists ? branchSnap.id : (entityData.mainBranchId || franchiseId);

    // 3. Purge operational collections
    const batch = adminDb.batch();

    if (branchSnap.exists) {
      batch.delete(branchRef);
    }
    if (entitySnap.exists) {
      batch.delete(entityRef);
    }

    // Delete POS terminals
    const ptSnaps = await adminDb.collection('pos_terminals')
      .where('franchiseId', '==', resolvedFranchiseId).get().catch(() => ({ docs: [] } as any));
    ptSnaps.docs.forEach((d: any) => batch.delete(d.ref));

    // Delete POS accounts
    const paSnaps = await adminDb.collection('pos_accounts')
      .where('franchiseId', '==', resolvedFranchiseId).get().catch(() => ({ docs: [] } as any));
    paSnaps.docs.forEach((d: any) => batch.delete(d.ref));

    await batch.commit();

    // 4. Archive associated orders (retention policy — do not erase tax audit records)
    const orderSnaps = await adminDb.collection('orders')
      .where('franchiseId', '==', resolvedFranchiseId).limit(500).get().catch(() => ({ docs: [] } as any));
    for (const oDoc of orderSnaps.docs) {
      await oDoc.ref.set({
        isArchived: true,
        franchisePermanentlyDeleted: true,
        franchiseDeletedAt: now
      }, { merge: true }).catch(() => {});
    }

    // 5. Log permanent deletion audit record
    await FranchiseScopeService.logFranchiseAudit({
      organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
      franchiseId: resolvedFranchiseId,
      branchId: resolvedBranchId,
      actorUid: deletedBy,
      actorEmail: deletedBy,
      actionType: 'FRANCHISE_PERMANENTLY_DELETED',
      entityType: 'franchise',
      entityId: resolvedFranchiseId,
      details: {
        franchiseName: actualName,
        confirmedWith: confirmFranchiseName,
        purgedTerminalsCount: ptSnaps.docs.length,
        purgedPosAccountsCount: paSnaps.docs.length,
        archivedOrdersCount: orderSnaps.docs.length
      }
    });

    CustomerOrderingContextService.invalidateBranchesSnapshot();

    return {
      success: true,
      message: `Franchise "${actualName}" has been permanently deleted and operational resources purged.`
    };
  }
}
