import { adminDb } from '../../config/firebase.js';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { PostgresGpsService } from '../gps/PostgresGpsService.js';
import { getClient, query } from '../../lib/db.js';
import { withTimeout } from '../../lib/utils.js';

export interface EligibleRider {
  uid: string;
  name: string;
  phone: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  score: number;
  branchId: string;
  franchiseId?: string;
}

export class RiderDispatchEngine {
  /**
   * Searches and ranks eligible riders for a specific order.
   * Priority:
   *  1. Main PostgreSQL delivery_partners + delivery_locations
   *  2. Strict branch & franchise isolation
   *  3. Online status == true
   *  4. No active delivery assigned (active_order_id IS NULL)
   *  5. Fresh GPS location (< 5 minutes old)
   *  6. Excludes previously declined rider UIDs for this order
   */
  public static async findEligibleRiders(orderId: string): Promise<EligibleRider[]> {
    let orderData: any = null;
    let branchId = '';
    let franchiseId = '';
    let restaurantLat = 21.0967;
    let restaurantLng = 81.0315;
    const excludedUids = new Set<string>();

    // 1. Authoritative check in PostgreSQL canonical_orders
    try {
      const orderRes = await query(
        `SELECT id, branch_id, franchise_id, order_status, delivery_partner_id
         FROM canonical_orders WHERE id = $1 LIMIT 1`,
        [orderId]
      );
      if (orderRes.rows.length > 0) {
        orderData = orderRes.rows[0];
        branchId = (orderData.branch_id || '').trim();
        franchiseId = (orderData.franchise_id || '').trim();
      }
    } catch (pgErr: any) {
      console.warn(`[RiderDispatchEngine] PostgreSQL order read notice for ${orderId}:`, pgErr.message);
    }

    // 2. Fallback to Firestore orders collection if unmigrated
    if (!orderData || !branchId) {
      try {
        const orderDoc = await adminDb.collection('orders').doc(orderId).get();
        if (orderDoc.exists) {
          const docData = orderDoc.data()!;
          orderData = docData;
          branchId = (docData.branchId || docData.branch_id || '').trim();
          franchiseId = (docData.franchiseId || docData.franchise_id || '').trim();
          if (docData.restaurantLat != null) restaurantLat = Number(docData.restaurantLat);
          if (docData.restaurantLng != null) restaurantLng = Number(docData.restaurantLng);
          if (Array.isArray(docData.declinedPartnerIds)) {
            docData.declinedPartnerIds.forEach((uid: string) => excludedUids.add(uid));
          }
        }
      } catch (fsErr: any) {
        console.warn(`[RiderDispatchEngine] Firestore order read notice for ${orderId}:`, fsErr.message);
      }
    }

    // 3. Fallback to OrderPersistenceArchiveService
    if (!orderData || !branchId) {
      try {
        const { OrderPersistenceArchiveService } = await import('../order/OrderPersistenceArchiveService.js');
        const hist = await OrderPersistenceArchiveService.getHistoricalOrder(orderId);
        if (hist) {
          orderData = hist;
          branchId = (hist.branchId || hist.branch_id || '').trim();
          franchiseId = (hist.franchiseId || hist.franchise_id || '').trim();
        }
      } catch (e: any) {
        console.warn(`[RiderDispatchEngine] Archive fallback notice:`, e.message);
      }
    }

    // Fail-Closed Invariant: If branchId cannot be resolved, return zero candidates
    if (!orderData || !branchId) {
      console.warn(`[RiderDispatchEngine] Fail-closed: Order ${orderId} has empty branchId.`);
      return [];
    }

    // Try resolving branch coordinates from PostgreSQL restaurant_branches
    try {
      const branchRes = await query(
        `SELECT latitude, longitude FROM restaurant_branches WHERE id = $1 LIMIT 1`,
        [branchId]
      );
      if (branchRes.rows.length > 0 && branchRes.rows[0].latitude != null && branchRes.rows[0].longitude != null) {
        restaurantLat = Number(branchRes.rows[0].latitude);
        restaurantLng = Number(branchRes.rows[0].longitude);
      }
    } catch {}

    // 4. Discover nearby eligible riders using PostgreSQL spatial bounding-box + Haversine
    const pgCandidates = await PostgresGpsService.findNearbyEligibleRiders({
      restaurantLat,
      restaurantLng,
      branchId,
      franchiseId: franchiseId || undefined,
      maxRadiusMeters: 15000,
      excludePartnerIds: Array.from(excludedUids)
    });

    if (pgCandidates.length > 0) {
      return pgCandidates;
    }

    // 5. Fallback: Check online delivery partners at this branch even if GPS breadcrumb hasn't emitted yet
    // Strictly requires is_online = true AND fresh activity/location timestamp within last 15 minutes
    try {
      let partnerSql = `
        SELECT id AS uid, name, phone, branch_id, franchise_id, current_lat, current_lng, is_online, active_order_id
        FROM delivery_partners
        WHERE (branch_id = $1 OR (branch_id IN ('main_branch', 'branch_rjn_main') AND $1 IN ('main_branch', 'branch_rjn_main')))
          AND status = 'APPROVED'
          AND is_online = true
          AND (active_order_id IS NULL OR active_order_id = '')
          AND (last_location_time >= NOW() - INTERVAL '15 minutes' OR updated_at >= NOW() - INTERVAL '15 minutes')
      `;
      const partnerParams: any[] = [branchId];
      if (franchiseId) {
        partnerParams.push(franchiseId);
        partnerSql += ` AND franchise_id = $${partnerParams.length}`;
      }
      partnerSql += ` ORDER BY id ASC LIMIT 10`;

      const partnerRes = await query(partnerSql, partnerParams);
      if (partnerRes.rows.length > 0) {
        return partnerRes.rows
          .filter((p: any) => !excludedUids.has(p.uid))
          .map((p: any) => ({
            uid: p.uid,
            name: p.name || 'Delivery Partner',
            phone: p.phone || '',
            latitude: Number(p.current_lat) || restaurantLat,
            longitude: Number(p.current_lng) || restaurantLng,
            distanceMeters: 300,
            score: 5000,
            branchId: p.branch_id,
            franchiseId: p.franchise_id,
          }));
      }
    } catch (e: any) {
      console.warn('[RiderDispatchEngine] PostgreSQL fallback partner discovery notice:', e.message);
    }

    // 6. Transitional Firestore fallback for unmigrated riders (strictly requires online + recent heartbeat)
    try {
      const ridersMap = new Map<string, any>();
      const ridersSnap = await withTimeout(
        adminDb.collection('users').where('role', 'in', ['delivery_partner', 'delivery']).get(),
        'dispatch.fsUsers',
        1200
      ).catch(() => ({ docs: [] } as any));
      (ridersSnap.docs || []).forEach((doc: any) => ridersMap.set(doc.id, { uid: doc.id, ...doc.data() }));

      const dpSnap = await withTimeout(
        adminDb.collection('delivery_partners').get(),
        'dispatch.fsPartners',
        1200
      ).catch(() => ({ docs: [] } as any));
      (dpSnap.docs || []).forEach((doc: any) => {
        const d = doc.data();
        const uid = d.uid || doc.id;
        if (!ridersMap.has(uid)) ridersMap.set(uid, { uid, ...d });
      });

      const fsCandidates: EligibleRider[] = [];
      const nowMs = Date.now();
      for (const [uid, rData] of ridersMap.entries()) {
        if (excludedUids.has(uid)) continue;
        const riderBranch = (rData.branchId || '').trim();
        const riderFranchise = (rData.franchiseId || '').trim();
        if (riderBranch !== branchId) continue;
        if (franchiseId && riderFranchise && riderFranchise !== franchiseId) continue;
        if (rData.isOnline !== true || rData.isActive === false || rData.isDisabled === true) continue;
        if (rData.activeOrderId && rData.activeOrderId !== orderId) continue;

        const lastUp = rData.lastLocationUpdate || rData.onlineStatusUpdatedAt || rData.updatedAt;
        if (!lastUp) continue;
        const lastMs = new Date(lastUp).getTime();
        if (isNaN(lastMs) || nowMs - lastMs > 15 * 60 * 1000) continue; // Must have recent activity

        fsCandidates.push({
          uid,
          name: rData.name || rData.displayName || 'Rider',
          phone: rData.phone || rData.phoneNumber || '',
          latitude: restaurantLat,
          longitude: restaurantLng,
          distanceMeters: 300,
          score: 5000,
          branchId: riderBranch,
          franchiseId: riderFranchise,
        });
      }
      return fsCandidates;
    } catch (fsErr: any) {
      console.warn('[RiderDispatchEngine] Firestore fallback discovery notice:', fsErr.message);
    }

    return [];
  }

  /**
   * Automatically assigns the best candidate rider with atomic PostgreSQL row locking.
   * Concurrency Safe:
   *  - Locks canonical_orders row with SELECT ... FOR UPDATE.
   *  - Idempotent: If already assigned, commits immediately and returns success.
   *  - Locks delivery_partners row with SELECT ... FOR UPDATE.
   *  - Atomically assigns partner and updates order status to PARTNER_ASSIGNED.
   *  - Synchronizes to Firestore and triggers actionable alerts.
   */
  public static async autoDispatchRider(orderId: string): Promise<{
    success: boolean;
    rider?: EligibleRider;
    reason?: string;
    idempotent?: boolean;
    isProvisional?: boolean;
    provisionalDispatchId?: string;
    code?: string;
    queued?: boolean;
    queueId?: string;
    status?: string;
  }> {
    let client: any = null;
    let assignedRider: EligibleRider | null = null;
    let orderRecord: any = null;

    try {
      client = await getClient();
    } catch (dbErr: any) {
      // Case C: PostgreSQL unavailable. Must fail-closed, never treat as order-not-found!
      console.error('[RiderDispatchEngine] PostgreSQL connection failed (Case C):', dbErr.message);
      return {
        success: false,
        reason: 'Database connection unavailable',
        code: 'DATABASE_UNAVAILABLE'
      };
    }

    try {
      await client.query('BEGIN');

      // 1. Lock the order row in PostgreSQL (Case A vs Case B)
      const orderRes = await client.query(
        `SELECT id, permanent_bill_no, daily_order_no, order_status, branch_id, franchise_id, delivery_partner_id,
                delivery_partner_name, delivery_partner_phone, partner_assigned_at,
                total_amount, payment_method, customer_name, customer_phone, delivery_address
         FROM canonical_orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId]
      );

      if (orderRes.rows.length > 0) {
        orderRecord = orderRes.rows[0];

        // Idempotency check: If already assigned to a partner, commit and return immediately
        if (orderRecord.delivery_partner_id) {
          await client.query('COMMIT');
          return {
            success: true,
            idempotent: true,
            rider: {
              uid: orderRecord.delivery_partner_id,
              name: orderRecord.delivery_partner_name || 'Assigned Partner',
              phone: orderRecord.delivery_partner_phone || '',
              latitude: 0,
              longitude: 0,
              distanceMeters: 0,
              score: 10000,
              branchId: orderRecord.branch_id,
              franchiseId: orderRecord.franchise_id,
            }
          };
        }

        // Validate branch assignment on canonical order
        if (!orderRecord.branch_id || !orderRecord.branch_id.trim()) {
          await client.query('ROLLBACK');
          return { success: false, reason: `Order ${orderId} lacks branchId`, code: 'MISSING_BRANCH_ID' };
        }

        // Validate order status in canonical order
        const terminalStatuses = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'VOIDED'];
        if (terminalStatuses.includes(String(orderRecord.order_status).toUpperCase())) {
          await client.query('ROLLBACK');
          return {
            success: false,
            reason: `Order ${orderId} is in terminal status: ${orderRecord.order_status}`,
            code: 'ORDER_TERMINAL'
          };
        }

        await client.query('COMMIT');
      } else {
        // Case B: Canonical order row does not exist in PostgreSQL. Rollback transaction before provisional handling.
        await client.query('ROLLBACK');
      }
    } catch (txnErr: any) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[RiderDispatchEngine] PostgreSQL transaction error:', txnErr.message);
      return {
        success: false,
        reason: 'Database connection unavailable',
        code: 'DATABASE_UNAVAILABLE'
      };
    } finally {
      if (client && typeof client.release === 'function') {
        client.release();
        client = null;
      }
    }

    // Handle Case B: PostgreSQL is healthy, but canonical order row not found
    if (!orderRecord) {
      // Check if order even exists in Firestore to give precise fail-closed reason
      let firestoreOrderData: any = null;
      try {
        const docSnap = await withTimeout(adminDb.collection('orders').doc(orderId).get(), 'dispatch.orderRead', 1200);
        if (!docSnap.exists) {
          return {
            success: false,
            reason: `Order ${orderId} not found in PostgreSQL or Firestore`,
            code: 'ORDER_NOT_FOUND'
          };
        }
        firestoreOrderData = docSnap.data() || {};
        if (!firestoreOrderData.branchId && !firestoreOrderData.branch_id) {
          return {
            success: false,
            reason: `Order ${orderId} lacks branchId in Firestore`,
            code: 'MISSING_BRANCH_ID'
          };
        }
      } catch (fErr: any) {
        return { success: false, reason: `Firestore lookup error: ${fErr.message}`, code: 'FIRESTORE_ERROR' };
      }

      // Discover candidate riders for this order (using Firestore order data + PostgreSQL rider pool)
      const candidates = await this.findEligibleRiders(orderId);
      if (candidates.length === 0) {
        const { PendingDispatchQueueService } = await import('./PendingDispatchQueueService.js');
        const queueRes = await PendingDispatchQueueService.enqueueOrder({
          orderId,
          branchId: firestoreOrderData.branchId || firestoreOrderData.branch_id || 'main_branch',
          franchiseId: firestoreOrderData.franchiseId || firestoreOrderData.franchise_id || 'fra_rajnandgaon',
          failureReason: 'No eligible riders currently available in branch radius'
        });
        return {
          success: false,
          queued: true,
          status: 'WAITING_FOR_RIDER',
          queueId: queueRes.entryId,
          reason: 'No eligible riders currently available in branch radius. Order added to persistent dispatch queue.',
          code: 'WAITING_FOR_RIDER'
        };
      }

      // Delegate to ProvisionalDispatchService for restricted Firestore-first fallback
      const { ProvisionalDispatchService } = await import('./ProvisionalDispatchService.js');
      const provResult = await ProvisionalDispatchService.createProvisionalIntent({
        orderId,
        rider: candidates[0],
        orderData: firestoreOrderData
      });

      if (!provResult.success) {
        return {
          success: false,
          reason: provResult.reason || 'Provisional dispatch rejected',
          code: provResult.code || 'PROVISIONAL_DISPATCH_REJECTED'
        };
      }

      return {
        success: true,
        isProvisional: true,
        provisionalDispatchId: provResult.provisionalDispatchId,
        rider: provResult.rider
      };
    }

    // Continue Authoritative Case A Flow: Discover eligible candidates
    const candidates = await this.findEligibleRiders(orderId);

    if (candidates.length === 0) {
      const { PendingDispatchQueueService } = await import('./PendingDispatchQueueService.js');
      const queueRes = await PendingDispatchQueueService.enqueueOrder({
        orderId,
        branchId: orderRecord.branch_id,
        franchiseId: orderRecord.franchise_id,
        failureReason: 'No eligible riders currently available in branch radius'
      });
      return {
        success: false,
        queued: true,
        status: 'WAITING_FOR_RIDER',
        queueId: queueRes.entryId,
        reason: 'No eligible riders currently available in branch radius. Order added to persistent dispatch queue.',
        code: 'WAITING_FOR_RIDER'
      };
    }

    const branchId = orderRecord.branch_id;
    let acquiredClient: any = null;

    try {
      acquiredClient = await getClient();
      await acquiredClient.query('BEGIN');

      // Atomically acquire lock on first available eligible candidate in PostgreSQL
      for (const candidate of candidates) {
        try {
          const dpRes = await acquiredClient.query(
            `SELECT id, name, phone, status, is_online, active_order_id, branch_id, franchise_id
             FROM delivery_partners
             WHERE id = $1 AND (branch_id = $2 OR (branch_id IN ('main_branch', 'branch_rjn_main') AND $2 IN ('main_branch', 'branch_rjn_main')))
             FOR UPDATE NOWAIT`,
            [candidate.uid, branchId]
          );

          if (dpRes.rows.length > 0) {
            const partner = dpRes.rows[0];
            if (partner.status === 'APPROVED' && partner.is_online && (!partner.active_order_id || partner.active_order_id === orderId)) {
              assignedRider = {
                ...candidate,
                name: partner.name || candidate.name,
                phone: partner.phone || candidate.phone,
                branchId: partner.branch_id,
                franchiseId: partner.franchise_id,
              };
              break;
            }
          }
        } catch (lockErr: any) {
          // Row is locked by another concurrent assignment, proceed to next candidate
          continue;
        }
      }

      if (!assignedRider) {
        await acquiredClient.query('ROLLBACK');
        const { PendingDispatchQueueService } = await import('./PendingDispatchQueueService.js');
        const queueRes = await PendingDispatchQueueService.enqueueOrder({
          orderId,
          branchId: orderRecord.branch_id,
          franchiseId: orderRecord.franchise_id,
          failureReason: 'All eligible candidates are currently busy'
        });
        return {
          success: false,
          queued: true,
          status: 'WAITING_FOR_RIDER',
          queueId: queueRes.entryId,
          reason: 'All eligible candidates are currently busy. Order added to persistent dispatch queue.',
          code: 'WAITING_FOR_RIDER'
        };
      }

      // Atomically commit assignment in PostgreSQL
      await acquiredClient.query(
        `UPDATE canonical_orders
         SET delivery_partner_id = $2,
             delivery_partner_name = $3,
             delivery_partner_phone = $4,
             partner_assigned_at = NOW(),
             order_status = 'PARTNER_ASSIGNED',
             updated_at = NOW()
         WHERE id = $1`,
        [orderId, assignedRider.uid, assignedRider.name, assignedRider.phone]
      );

      await acquiredClient.query(
        `UPDATE delivery_partners
         SET active_order_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [assignedRider.uid, orderId]
      ).catch(() => {});

      await acquiredClient.query(
        `UPDATE delivery_locations
         SET active_order_id = $2, last_updated = NOW()
         WHERE delivery_partner_id = $1`,
        [assignedRider.uid, orderId]
      ).catch(() => {});

      await acquiredClient.query(
        `UPDATE pending_dispatch_queue
         SET status = 'ASSIGNED',
             assigned_rider_id = $2,
             resolved_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1 AND status IN ('WAITING_FOR_RIDER', 'ASSIGNMENT_IN_PROGRESS', 'FAILED_RETRYABLE', 'PENDING', 'RETRYING')`,
        [orderId, assignedRider.uid]
      ).catch(() => {});

      await acquiredClient.query('COMMIT');
    } catch (txnErr: any) {
      if (acquiredClient) await acquiredClient.query('ROLLBACK').catch(() => {});
      console.error('[RiderDispatchEngine] PostgreSQL transaction failed:', txnErr.message);
      return { success: false, reason: txnErr.message };
    } finally {
      if (acquiredClient && typeof acquiredClient.release === 'function') {
        acquiredClient.release();
      }
    }

    // 5. Synchronize to Firestore for Realtime UI listeners (Best-Effort Non-Blocking)
    try {
      const now = new Date();
      const isoNow = now.toISOString();
      const orderRef = adminDb.collection('orders').doc(orderId);
      await Promise.all([
        withTimeout(orderRef.set({
          status: 'partner_assigned',
          deliveryPartnerId: assignedRider.uid,
          deliveryPartnerName: assignedRider.name,
          deliveryPartnerPhone: assignedRider.phone,
          partnerAssignedAt: isoNow,
          riderAssignedAt: isoNow,
          riderAssignmentStatus: 'assigned',
          updatedAt: now,
        }, { merge: true }), 'dispatch.orderWrite', 1200).catch(() => {}),
        withTimeout(adminDb.collection('users').doc(assignedRider.uid).set(
          { activeOrderId: orderId },
          { merge: true }
        ), 'dispatch.userWrite', 1000).catch(() => {}),
        withTimeout(adminDb.collection('delivery_partners').doc(assignedRider.uid).set(
          { activeOrderId: orderId },
          { merge: true }
        ), 'dispatch.dpWrite', 1000).catch(() => {}),
      ]);
    } catch (fsErr: any) {
      console.warn('[RiderDispatchEngine] Firestore realtime sync notice:', fsErr.message);
    }

    // 6. Actionable Notification Alert to Rider
    try {
      const orderNumber = orderRecord?.permanent_bill_no ? '#' + orderRecord.permanent_bill_no : ('#' + orderId.slice(-6).toUpperCase());
      const { DeliveryTemplates } = await import('../notification/NotificationTemplates.js');
      const riderPayload = DeliveryTemplates.newAssignment(orderId, {
        orderNumber,
        customerName: orderRecord?.customer_name || 'Customer',
        customerPhone: orderRecord?.customer_phone || 'N/A',
        deliveryAddress: orderRecord?.delivery_address?.addressLine || orderRecord?.delivery_address || 'Delivery Address',
        distance: `${((assignedRider.distanceMeters || 300) / 1000).toFixed(1)} km`,
        eta: `${Math.ceil((assignedRider.distanceMeters || 300) / 400) || 10} mins`,
        totalAmount: Number(orderRecord?.total_amount || 0),
        paymentMethod: orderRecord?.payment_method || 'COD',
      });

      await notificationEngine.send(assignedRider.uid, riderPayload, {
        category: 'alarm_actionable',
        priority: 'critical',
        orderId,
        targetApp: 'delivery'
      });
    } catch (notifErr: any) {
      console.warn('[RiderDispatchEngine] Notification delivery notice:', notifErr.message);
    }

    return { success: true, rider: assignedRider };
  }
}
