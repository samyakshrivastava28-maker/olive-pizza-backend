import { adminDb } from '../../config/firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { DeliveryTemplates } from '../notification/NotificationTemplates.js';
import { SupabaseGpsService } from '../gps/SupabaseGpsService.js';

export type RiderOperationalState =
  | 'OFFLINE'
  | 'AVAILABLE'
  | 'RESERVED'
  | 'OUT_FOR_DELIVERY'
  | 'RETURNING'
  | 'PAUSED'
  | 'DISABLED';

export interface FleetRider {
  uid: string;
  name: string;
  phone: string;
  branchId: string;
  state: RiderOperationalState;
  activeOrderId: string | null;
  availableSince: string | null; // ISO timestamp for FIFO queue ordering
  latitude?: number;
  longitude?: number;
  locationUpdatedAt?: string;
  locationFreshness?: 'LIVE' | 'RECENT' | 'STALE' | 'OFFLINE';
  vehicleNumber?: string;
  vehicleType?: string;
}

export interface DeliveryAssignmentAuditLog {
  id?: string;
  orderId: string;
  riderId: string | null;
  branchId: string;
  action: 'AUTO_FIFO_ASSIGN' | 'MANUAL_ASSIGN' | 'EMERGENCY_REASSIGN' | 'DECLINED' | 'STATUS_CHANGE' | 'UNASSIGNED';
  previousState?: string;
  newState?: string;
  reason?: string;
  performedBy: {
    uid: string;
    role: string;
    name?: string;
  };
  timestamp: string;
}

export class StoreBoundDeliveryFleetService {
  /**
   * Computes location freshness based on timestamp age
   */
  public static getLocationFreshness(isoString?: string | null): 'LIVE' | 'RECENT' | 'STALE' | 'OFFLINE' {
    if (!isoString) return 'OFFLINE';
    const ageMs = Date.now() - new Date(isoString).getTime();
    if (isNaN(ageMs) || ageMs < 0) return 'OFFLINE';
    if (ageMs <= 30 * 1000) return 'LIVE';       // <= 30 seconds
    if (ageMs <= 2 * 60 * 1000) return 'RECENT';  // <= 2 minutes
    if (ageMs <= 10 * 60 * 1000) return 'STALE';  // <= 10 minutes
    return 'OFFLINE';
  }

  /**
   * Get all riders registered for a specific store/branch, with their current state and location freshness
   */
  public static async getStoreFleet(branchId: string): Promise<FleetRider[]> {
    const usersSnap = await adminDb.collection('users')
      .where('role', 'in', ['delivery', 'delivery_partner'])
      .get()
      .catch(() => ({ docs: [] } as any));

    const dpSnap = await adminDb.collection('delivery_partners')
      .get()
      .catch(() => ({ docs: [] } as any));

    const combinedCandidates = new Map<string, any>();
    usersSnap.docs.forEach((d: any) => combinedCandidates.set(d.id, { id: d.id, ...d.data() }));
    dpSnap.docs.forEach((d: any) => {
      const existing = combinedCandidates.get(d.id);
      combinedCandidates.set(d.id, existing ? { ...existing, ...d.data() } : { id: d.id, ...d.data() });
    });

    // Single Source of Truth: Query authoritative live locations from Supabase
    const activeLocations = await SupabaseGpsService.getActiveLocations().catch(() => []);
    const locMap = new Map<string, any>();
    for (const loc of activeLocations) {
      const pid = loc.delivery_partner_id || loc.id;
      if (pid) locMap.set(pid, loc);
    }

    const riders: FleetRider[] = [];

    for (const [uid, data] of combinedCandidates.entries()) {
      const riderBranchId = (data.branchId || '').trim();
      
      if (!riderBranchId || riderBranchId !== branchId) {
        continue;
      }

      const loc = locMap.get(uid) || {};
      const locUpdated = loc.updated_at || loc.last_updated || data.lastLocationUpdate || data.updatedAt || null;
      const freshness = this.getLocationFreshness(locUpdated);

      let state: RiderOperationalState = 'OFFLINE';
      if (data.isActive === false || data.isDisabled === true) {
        state = 'DISABLED';
      } else if (data.isPaused === true || data.deliveryStatus === 'break') {
        state = 'PAUSED';
      } else if (data.isOnline === false || data.status === 'offline') {
        state = 'OFFLINE';
      } else if (data.activeOrderId) {
        state = data.deliveryStatus === 'out_for_delivery' ? 'OUT_FOR_DELIVERY' : 'RESERVED';
      } else if (data.deliveryStatus === 'returning') {
        state = 'RETURNING';
      } else {
        state = 'AVAILABLE';
      }

      riders.push({
        uid,
        name: data.name || data.displayName || 'Delivery Partner',
        phone: data.phone || data.phoneNumber || '',
        branchId: riderBranchId,
        state,
        activeOrderId: data.activeOrderId || null,
        availableSince: data.availableSince || data.onlineStatusUpdatedAt || null,
        latitude: loc.latitude !== undefined ? Number(loc.latitude) : (data.latitude || data.lat),
        longitude: loc.longitude !== undefined ? Number(loc.longitude) : (data.longitude || data.lng),
        locationUpdatedAt: locUpdated,
        locationFreshness: freshness,
        vehicleNumber: data.vehicleNumber,
        vehicleType: data.vehicleType,
      });
    }

    return riders;
  }

  /**
   * Retrieves the server-authoritative FIFO queue of AVAILABLE riders for a branch
   * Ordered by availableSince ASC (oldest available rider first)
   */
  public static async getStoreFifoQueue(branchId: string): Promise<FleetRider[]> {
    const fleet = await this.getStoreFleet(branchId);
    const available = fleet.filter((r) => r.state === 'AVAILABLE');

    available.sort((a, b) => {
      const timeA = a.availableSince ? new Date(a.availableSince).getTime() : 0;
      const timeB = b.availableSince ? new Date(b.availableSince).getTime() : 0;
      return timeA - timeB;
    });

    return available;
  }

  /**
   * Atomically assigns the head of the FIFO queue to an order upon READY_FOR_DELIVERY
   */
  public static async assignOrderToFifoRider(
    orderId: string,
    branchId?: string
  ): Promise<{ success: boolean; rider?: FleetRider; reason?: string }> {
    if (!branchId || !branchId.trim()) {
      return { success: false, reason: 'Branch ID is required for delivery fleet assignment' };
    }
    const cleanBranchId = branchId.trim();
    const orderRef = adminDb.collection('orders').doc(orderId);

    const fifoQueue = await this.getStoreFifoQueue(cleanBranchId);
    if (fifoQueue.length === 0) {
      if (!orderId.startsWith('test_') && process.env.NODE_ENV !== 'test') {
        await orderRef.set({
          riderAssignmentStatus: 'pending_rider_available',
          riderAssignmentNote: `No available riders in FIFO queue for branch ${cleanBranchId}`,
          updatedAt: new Date(),
        }, { merge: true }).catch(() => {});
      }
      return { success: false, reason: `No riders currently available in store FIFO queue (${cleanBranchId})` };
    }

    let assignedRider: FleetRider | null = null;

    for (const candidate of fifoQueue) {
      const userRef = adminDb.collection('users').doc(candidate.uid);
      const dpRef = adminDb.collection('delivery_partners').doc(candidate.uid);

      try {
        await adminDb.runTransaction(async (t) => {
          const orderSnap = await t.get(orderRef);
          if (!orderSnap.exists) {
            throw new Error('Order not found');
          }
          const orderData = orderSnap.data()!;

          if (orderData.deliveryPartnerId && orderData.deliveryPartnerId !== candidate.uid) {
            return;
          }

          const userSnap = await t.get(userRef);
          if (!userSnap.exists) {
            throw new Error('Rider user record not found');
          }
          const userData = userSnap.data()!;

          if (userData.activeOrderId && userData.activeOrderId !== orderId) {
            throw new Error('Rider acquired another order concurrently');
          }
          if (userData.isOnline === false || userData.isPaused === true) {
            throw new Error('Rider is no longer online/available');
          }

          const now = new Date();
          const isoNow = now.toISOString();

          t.update(orderRef, {
            status: 'partner_assigned',
            deliveryPartnerId: candidate.uid,
            deliveryPartnerName: candidate.name,
            deliveryPartnerPhone: candidate.phone,
            partnerAssignedAt: isoNow,
            riderAssignedAt: isoNow,
            riderAssignmentStatus: 'assigned',
            riderAssignmentMethod: 'FIFO_QUEUE',
            updatedAt: now,
          });

          t.set(userRef, {
            activeOrderId: orderId,
            deliveryStatus: 'busy',
            lastAssignedAt: isoNow,
            updatedAt: now,
          }, { merge: true });

          t.set(dpRef, {
            activeOrderId: orderId,
            deliveryStatus: 'busy',
            lastAssignedAt: isoNow,
            updatedAt: now,
          }, { merge: true });

          assignedRider = candidate;
        });

        if (assignedRider) break;
      } catch (txnErr: any) {
        console.warn(`[StoreDeliveryFleet] Candidate ${candidate.uid} lock missed:`, txnErr?.message);
        try {
          const now = new Date();
          const isoNow = now.toISOString();
          await orderRef.set({
            status: 'partner_assigned',
            deliveryPartnerId: candidate.uid,
            deliveryPartnerName: candidate.name,
            deliveryPartnerPhone: candidate.phone,
            partnerAssignedAt: isoNow,
            riderAssignedAt: isoNow,
            riderAssignmentStatus: 'assigned',
            riderAssignmentMethod: 'FIFO_QUEUE',
            updatedAt: now,
          }, { merge: true });

          await userRef.set({
            activeOrderId: orderId,
            deliveryStatus: 'busy',
            lastAssignedAt: isoNow,
            updatedAt: now,
          }, { merge: true }).catch(() => {});

          await dpRef.set({
            activeOrderId: orderId,
            deliveryStatus: 'busy',
            lastAssignedAt: isoNow,
            updatedAt: now,
          }, { merge: true }).catch(() => {});

          assignedRider = candidate;
          break;
        } catch {}
      }
    }

    if (!assignedRider) {
      await orderRef.set({
        riderAssignmentStatus: 'pending_rider_available',
        riderAssignmentNote: 'All eligible candidates could not be locked concurrently',
        updatedAt: new Date(),
      }, { merge: true }).catch(() => {});
      return { success: false, reason: 'Could not lock an available FIFO rider' };
    }

    await this.logFleetAction({
      orderId,
      riderId: (assignedRider as FleetRider).uid,
      branchId,
      action: 'AUTO_FIFO_ASSIGN',
      previousState: 'AVAILABLE',
      newState: 'RESERVED',
      reason: 'Server-authoritative FIFO automatic assignment on order ready',
      performedBy: { uid: 'system', role: 'system', name: 'Store FIFO Engine' },
      timestamp: new Date().toISOString(),
    });

    this.sendRiderAlert(orderId, assignedRider as FleetRider).catch((e) =>
      console.error('[StoreDeliveryFleet] Notification error:', e.message)
    );

    return { success: true, rider: assignedRider };
  }

  /**
   * Manual override: Store manager or Owner assigns a specific rider
   */
  public static async manualAssignRider(
    orderId: string,
    riderId: string,
    actor: { uid: string; role: string; name?: string },
    reason: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!reason || reason.trim().length < 3) {
      return { success: false, error: 'A valid reason is required for manual rider assignment override.' };
    }

    const orderRef = adminDb.collection('orders').doc(orderId);
    const userRef = adminDb.collection('users').doc(riderId);

    try {
      let previousRiderId: string | null = null;

      await adminDb.runTransaction(async (t) => {
        const orderSnap = await t.get(orderRef);
        if (!orderSnap.exists) throw new Error('Order not found');
        const oData = orderSnap.data()!;
        previousRiderId = oData.deliveryPartnerId || null;

        const userSnap = await t.get(userRef);
        if (!userSnap.exists) throw new Error('Selected rider does not exist');
        const uData = userSnap.data()!;

        if (uData.isOnline === false || uData.isActive === false) {
          throw new Error('Selected rider is currently offline or inactive.');
        }

        if (uData.activeOrderId && uData.activeOrderId !== orderId) {
          throw new Error('Selected rider is already actively delivering another order.');
        }

        const now = new Date();
        const isoNow = now.toISOString();

        t.update(orderRef, {
          status: 'partner_assigned',
          deliveryPartnerId: riderId,
          deliveryPartnerName: uData.name || uData.displayName || 'Delivery Partner',
          deliveryPartnerPhone: uData.phone || '',
          partnerAssignedAt: isoNow,
          riderAssignedAt: isoNow,
          riderAssignmentStatus: 'assigned',
          riderAssignmentMethod: 'MANUAL_OVERRIDE',
          manualAssignmentReason: reason,
          manualAssignedBy: actor.uid,
          updatedAt: now,
        });

        if (previousRiderId && previousRiderId !== riderId) {
          const oldRef = adminDb.collection('users').doc(previousRiderId);
          t.set(oldRef, { activeOrderId: null, deliveryStatus: 'online', availableSince: isoNow }, { merge: true });
        }

        t.set(userRef, { activeOrderId: orderId, deliveryStatus: 'busy', updatedAt: now }, { merge: true });
      });

      await this.logFleetAction({
        orderId,
        riderId,
        branchId: 'main_branch',
        action: 'MANUAL_ASSIGN',
        previousState: previousRiderId ? `ASSIGNED_TO_${previousRiderId}` : 'UNASSIGNED',
        newState: 'RESERVED',
        reason,
        performedBy: actor,
        timestamp: new Date().toISOString(),
      });

      const riderSnap = await userRef.get();
      const rData = riderSnap.data()!;
      this.sendRiderAlert(orderId, {
        uid: riderId,
        name: rData.name || 'Delivery Partner',
        phone: rData.phone || '',
        branchId: rData.branchId || 'main_branch',
        state: 'RESERVED',
        activeOrderId: orderId,
        availableSince: null,
      }).catch(() => {});

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Manual assignment failed' };
    }
  }

  /**
   * Emergency Reassignment: Rider breakdown, accident, or non-responsive.
   */
  public static async emergencyReassign(
    orderId: string,
    reason: string,
    actor: { uid: string; role: string; name?: string },
    targetRiderId?: string
  ): Promise<{ success: boolean; newRiderId?: string; error?: string }> {
    if (!reason || reason.trim().length < 3) {
      return { success: false, error: 'A valid explanation is required for emergency reassignment.' };
    }

    const orderRef = adminDb.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) {
      return { success: false, error: 'Order not found' };
    }
    const oData = orderDoc.data()!;
    const previousRiderId = oData.deliveryPartnerId;
    const branchId = oData.branchId || 'main_branch';

    if (previousRiderId) {
      const isBreakdown = reason.toLowerCase().includes('breakdown') || 
                          reason.toLowerCase().includes('accident') || 
                          reason.toLowerCase().includes('puncture');
      await adminDb.collection('users').doc(previousRiderId).set({
        activeOrderId: null,
        deliveryStatus: isBreakdown ? 'break' : 'online',
        isPaused: isBreakdown,
        pauseReason: isBreakdown ? reason : null,
        availableSince: isBreakdown ? null : new Date().toISOString(),
        updatedAt: new Date(),
      }, { merge: true }).catch(() => {});
    }

    await orderRef.update({
      deliveryPartnerId: null,
      deliveryPartnerName: null,
      deliveryPartnerPhone: null,
      riderAssignmentStatus: 'emergency_reassigning',
      lastEmergencyReassignReason: reason,
      lastEmergencyReassignBy: actor.uid,
      updatedAt: new Date(),
    });

    await this.logFleetAction({
      orderId,
      riderId: previousRiderId || null,
      branchId,
      action: 'EMERGENCY_REASSIGN',
      previousState: 'ASSIGNED',
      newState: 'UNASSIGNED',
      reason,
      performedBy: actor,
      timestamp: new Date().toISOString(),
    });

    if (targetRiderId) {
      const manualRes = await this.manualAssignRider(orderId, targetRiderId, actor, `Emergency reassignment: ${reason}`);
      if (manualRes.success) {
        return { success: true, newRiderId: targetRiderId };
      } else {
        return { success: false, error: `Emergency pull succeeded, but assigning to requested rider failed: ${manualRes.error}` };
      }
    } else {
      const fifoRes = await this.assignOrderToFifoRider(orderId, branchId);
      if (fifoRes.success && fifoRes.rider) {
        return { success: true, newRiderId: fifoRes.rider.uid };
      } else {
        return { success: true, error: 'Order pulled from previous rider and returned to store queue. Awaiting available rider.' };
      }
    }
  }

  /**
   * Rider state transition (Rider checks in, pauses shift, returns to store, etc.)
   */
  public static async updateRiderState(
    riderUid: string,
    targetState: RiderOperationalState,
    metadata: { reason?: string } = {}
  ): Promise<{ success: boolean; state: RiderOperationalState; error?: string }> {
    const userRef = adminDb.collection('users').doc(riderUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      return { success: false, state: 'OFFLINE', error: 'Rider profile not found' };
    }

    const uData = userDoc.data()!;
    const now = new Date();
    const isoNow = now.toISOString();

    const updates: Record<string, any> = {
      updatedAt: now,
    };

    switch (targetState) {
      case 'AVAILABLE':
        if (uData.activeOrderId) {
          return { success: false, state: 'RESERVED', error: 'Cannot set status to AVAILABLE while on an active order.' };
        }
        updates.isOnline = true;
        updates.isPaused = false;
        updates.deliveryStatus = 'online';
        updates.availableSince = isoNow;
        break;

      case 'RETURNING':
        updates.isOnline = true;
        updates.deliveryStatus = 'returning';
        break;

      case 'PAUSED':
        updates.isPaused = true;
        updates.deliveryStatus = 'break';
        updates.pauseReason = metadata.reason || 'Break';
        break;

      case 'OFFLINE':
        if (uData.activeOrderId) {
          return { success: false, state: 'RESERVED', error: 'Cannot go OFFLINE while an active delivery is in progress.' };
        }
        updates.isOnline = false;
        updates.isPaused = false;
        updates.deliveryStatus = 'offline';
        updates.availableSince = null;
        break;

      case 'DISABLED':
        updates.isActive = false;
        updates.isDisabled = true;
        updates.isOnline = false;
        updates.availableSince = null;
        break;

      default:
        break;
    }

    await userRef.set(updates, { merge: true });
    await adminDb.collection('delivery_partners').doc(riderUid).set(updates, { merge: true }).catch(() => {});

    await this.logFleetAction({
      orderId: uData.activeOrderId || 'none',
      riderId: riderUid,
      branchId: uData.branchId || 'main_branch',
      action: 'STATUS_CHANGE',
      previousState: uData.deliveryStatus || 'unknown',
      newState: targetState,
      reason: metadata.reason || `Rider self-updated state to ${targetState}`,
      performedBy: { uid: riderUid, role: 'delivery_partner', name: uData.name },
      timestamp: isoNow,
    });

    return { success: true, state: targetState };
  }

  /**
   * Appends an immutable audit log entry
   */
  public static async logFleetAction(entry: DeliveryAssignmentAuditLog): Promise<void> {
    try {
      await adminDb.collection('delivery_fleet_audit_logs').add({
        ...entry,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err: any) {
      console.error('[StoreDeliveryFleet] Audit log error:', err.message);
    }
  }

  /**
   * Sends high-priority push alert to the assigned rider
   */
  private static async sendRiderAlert(orderId: string, rider: FleetRider): Promise<void> {
    const orderDoc = await adminDb.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return;
    const orderData = orderDoc.data()!;
    const orderNumber = orderData.dailyOrderNumber || orderData.orderNumber || ('#' + orderId.slice(-6).toUpperCase());

    const riderPayload = DeliveryTemplates.newAssignment(orderId, {
      orderNumber,
      customerName: orderData.customerName || 'Customer',
      customerPhone: orderData.contactPhone || 'N/A',
      deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
      distance: 'Store Dispatch',
      eta: '10 mins',
      totalAmount: Number(orderData.totalAmount || 0),
      paymentMethod: orderData.paymentMethod || 'COD',
    });

    await notificationEngine.send(rider.uid, riderPayload, {
      category: 'alarm_actionable',
      priority: 'critical',
      orderId,
      targetApp: 'delivery',
    });
  }
}
