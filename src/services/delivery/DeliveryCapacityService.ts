import { adminDb } from '../../config/firebase.js';
import { pgPool } from '../../config/postgres.js';
import { FieldValue } from 'firebase-admin/firestore';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { SupabaseGpsService } from '../gps/SupabaseGpsService.js';
import { CustomerTemplates } from '../notification/NotificationTemplates.js';

export type DeliveryPartnerStatus = 'online' | 'offline' | 'busy' | 'on_delivery' | 'break';

export interface DeliveryPartner {
  id: string;
  name: string;
  status: DeliveryPartnerStatus;
  latitude?: number;
  longitude?: number;
  assignedOrderId?: string;
  distanceFromRestaurantKm?: number;
  lastUpdated: Date;
}

export class DeliveryCapacityService {
  /**
   * Sets the status of a delivery partner and triggers queue processing if they become available.
   */
  static async setPartnerStatus(partnerId: string, status: DeliveryPartnerStatus, orderId?: string | null) {
    // 1. Update Firestore
    await adminDb.collection('users').doc(partnerId).update({
      deliveryStatus: status,
      ...(orderId !== undefined && { assignedOrderId: orderId }),
      lastStatusUpdate: FieldValue.serverTimestamp()
    });

    // 2. Authoritative Supabase location update to reflect online status mapping (Section 9 & 10)
    try {
      const isOnline = (status === 'online' || status === 'on_delivery');
      await SupabaseGpsService.setOnlineStatus(partnerId, isOnline);
      if (orderId !== undefined) {
        if (orderId) {
          await SupabaseGpsService.setActiveOrder(partnerId, orderId);
        } else {
          await SupabaseGpsService.clearActiveOrder(partnerId);
        }
      }
    } catch (e: any) {
      console.warn('[DeliveryCapacity] Supabase location status notice:', e.message);
    }

    // 3. If becoming available (online and not assigned), pop the queue
    if (status === 'online') {
      await this.processNotifyQueue();
    }
  }

  /**
   * Evaluates the current restaurant delivery availability status for a branch
   */
  static async getRestaurantAvailability(targetBranchId?: string) {
    try {
      const settingsDoc = await adminDb.collection('settings').doc('global').get();
      const settings = settingsDoc.exists ? settingsDoc.data() || {} : {};

      let branchSettings: any = {};
      if (targetBranchId && targetBranchId !== 'all') {
        try {
          const bDoc = await adminDb.collection('franchises').doc(targetBranchId).get();
          if (bDoc.exists) {
            branchSettings = bDoc.data() || {};
          }
        } catch {}
      }
      
      const openH = branchSettings.openingTime ? parseInt(branchSettings.openingTime.split(':')[0], 10) : (settings.openingHour !== undefined ? Number(settings.openingHour) : 0);
      const closeH = branchSettings.closingTime ? parseInt(branchSettings.closingTime.split(':')[0], 10) : (settings.closingHour !== undefined ? Number(settings.closingHour) : 24);
      const currentHour = new Date().getHours();

      // Check if configured for 24x7 or full-day operation
      const is24Hours = settings.is24x7 === true ||
        (openH === 0 && (closeH >= 23 || closeH === 24 || settings.closingTime === '23:59' || String(settings.businessHours).includes('23:59') || String(settings.businessHours).toLowerCase().includes('24')));

      let isWithinBusinessHours = true;
      if (!is24Hours) {
        if (openH <= closeH) {
          isWithinBusinessHours = currentHour >= openH && currentHour < closeH;
        } else {
          // Overnight span (e.g. 18:00 to 03:00)
          isWithinBusinessHours = currentHour >= openH || currentHour < closeH;
        }
      }

      const isBranchActive = branchSettings.isActive !== false && branchSettings.isOpen !== false;
      const isRestaurantOpen = (settings.isRestaurantOpen !== false) && isBranchActive && isWithinBusinessHours;
      const isDeliveryEnabled = settings.isDeliveryAvailable !== false;

      // Fetch all riders
      const snapshot = await adminDb.collection('users')
        .where('role', 'in', ['delivery', 'delivery_partner'])
        .get();

      let onlineCount = 0;
      let availableCount = 0;
      let onDeliveryCount = 0;

      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (targetBranchId && targetBranchId !== 'all') {
          const rBranch = data.branchId || 'main_branch';
          if (rBranch !== targetBranchId && rBranch !== 'all') {
            continue;
          }
        }
        const status = (data.deliveryStatus || data.status || 'offline').toLowerCase();
        if (status === 'online' || status === 'available') {
          onlineCount++;
          availableCount++;
        } else if (status === 'on_delivery' || status === 'busy' || status === 'assigned') {
          onlineCount++;
          
          // Verify if the assigned order is genuinely active in Firestore
          const assignedId = data.assignedOrderId || data.activeOrderId;
          let isGenuinelyOnDelivery = false;
          if (assignedId) {
            try {
              const orderDoc = await adminDb.collection('orders').doc(assignedId).get();
              if (orderDoc.exists) {
                const orderStatus = (orderDoc.data()?.status || '').toLowerCase();
                if (!['delivered', 'cancelled', 'rejected', 'failed', 'completed'].includes(orderStatus)) {
                  isGenuinelyOnDelivery = true;
                }
              }
            } catch (err) {
              console.warn(`[DeliveryCapacity] Error checking order ${assignedId}:`, err);
            }
          }

          if (isGenuinelyOnDelivery) {
            onDeliveryCount++;
          } else {
            // Stale order assignment recovered: rider is online & free for new orders
            availableCount++;
            adminDb.collection('users').doc(doc.id).update({
              deliveryStatus: 'online',
              status: 'online',
              assignedOrderId: null,
              activeOrderId: null,
            }).catch(() => {});
          }
        }
      }

      let availabilityStatus: 'AVAILABLE' | 'HIGH_DEMAND' | 'NO_RIDERS' | 'CLOSED' = 'AVAILABLE';
      let availabilityMessage = 'Delivery available';
      let canAcceptDeliveries = true;

      if (!isRestaurantOpen) {
        availabilityStatus = 'CLOSED';
        availabilityMessage = 'Restaurant is currently closed';
        canAcceptDeliveries = false;
      } else if (!isDeliveryEnabled) {
        availabilityStatus = 'NO_RIDERS';
        availabilityMessage = 'Delivery service is currently paused';
        canAcceptDeliveries = false;
      } else if (onlineCount > 0 && availableCount === 0) {
        // High demand, but allow kitchen to queue orders
        availabilityStatus = 'HIGH_DEMAND';
        availabilityMessage = 'High demand in progress';
        canAcceptDeliveries = true;
      } else {
        availabilityStatus = 'AVAILABLE';
        availabilityMessage = 'Delivery available';
        canAcceptDeliveries = true;
      }

      // Estimate Wait Time (approx 15 mins base + 5 mins per active delivery)
      let estimatedWaitMins = 20;
      if (!canAcceptDeliveries && onDeliveryCount > 0) {
        estimatedWaitMins = 15 + (Math.round(onDeliveryCount / Math.max(1, onlineCount)) * 10);
      }

      const baseDeliveryFee = Number(
        branchSettings.deliverySettings?.deliveryFee ??
        branchSettings.deliveryFee ??
        settings.deliveryFee ??
        30
      );
      const freeDeliveryThreshold = Number(
        branchSettings.deliverySettings?.freeDeliveryThreshold ??
        branchSettings.deliverySettings?.freeDeliveryAbove ??
        branchSettings.freeDeliveryThreshold ??
        settings.freeDeliveryAbove ??
        500
      );

      return {
        isRestaurantOpen,
        isDeliveryEnabled,
        isWithinBusinessHours,
        totalRiders: snapshot.size,
        onlineCount,
        availableCount,
        onDeliveryCount,
        availabilityStatus,
        availabilityMessage,
        canAcceptDeliveries,
        estimatedWaitMins,
        deliveryFee: baseDeliveryFee,
        freeDeliveryThreshold
      };

    } catch (e) {
      console.error('[DeliveryCapacity] Error evaluating availability', e);
      return { 
        isRestaurantOpen: true,
        isDeliveryEnabled: true,
        canAcceptDeliveries: true, 
        availabilityStatus: 'AVAILABLE' as const,
        availabilityMessage: 'Delivery available',
        estimatedWaitMins: 30 
      };
    }
  }

  /**
   * Enqueues a customer to be notified when delivery becomes available
   */
  static async addToNotifyQueue(customerId: string, fcmToken?: string) {
    const queueRef = adminDb.collection('delivery_notify_queue').doc(customerId);
    await queueRef.set({
      customerId,
      fcmToken: fcmToken || null,
      createdAt: FieldValue.serverTimestamp(),
      notified: false
    }, { merge: true });
    return true;
  }

  /**
   * Processes the notify queue and triggers push notifications
   */
  static async processNotifyQueue() {
    try {
      const queueSnap = await adminDb.collection('delivery_notify_queue')
        .where('notified', '==', false)
        .get();

      if (queueSnap.empty) return;

      // Sort in-memory by createdAt ascending to avoid composite index requirement
      const sortedDocs = [...queueSnap.docs].sort((a, b) => {
        const aTime = a.data().createdAt?.toMillis?.() || 0;
        const bTime = b.data().createdAt?.toMillis?.() || 0;
        return aTime - bTime;
      });

      // A rider is available. Let's notify everyone in the queue
      const batch = adminDb.batch();
      
      for (const doc of sortedDocs) {
        const data = doc.data();
        const customerId = data.customerId;

        // Send push notification
        if (customerId) {
          const payload = CustomerTemplates.informational('Delivery Available!', 'Great news! Delivery is available again. You can now place your order.', 'https://olivepizza.app/checkout');
          await notificationEngine.send(customerId, payload, { category: 'simple_informational', priority: 'high' });
        }

        // Mark as notified so we don't spam them
        batch.update(doc.ref, { notified: true, notifiedAt: FieldValue.serverTimestamp() });
      }

      await batch.commit();
    } catch (e: any) {
      console.warn('[DeliveryCapacity] processNotifyQueue warning:', e.message);
    }
  }

  /**
   * Calculates the distance between two GPS coordinates in kilometers using the Haversine formula
   */
  static getDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
  }
}
