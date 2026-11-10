/**
 * DeliveryEtaService.ts — Authoritative Delivery ETA Engine
 * 
 * Computes system-authoritative delivery ETA from:
 * 1. Rider-to-store distance and travel time
 * 2. Store-to-customer travel time via geodesic road estimation
 * 3. Remaining preparation time buffer (if still preparing)
 * 4. Handover buffer (3 minutes)
 * 
 * Strict Rule: Delivery ETA is server-calculated and cannot be manually overridden by riders.
 */

import { GeofenceVerificationService } from './GeofenceVerificationService.js';
import { SupabaseGpsService } from '../gps/SupabaseGpsService.js';
import { adminDb } from '../../config/firebase.js';
import { query } from '../../lib/db.js';

export interface DeliveryEtaResult {
  deliveryEta: string; // ISO timestamp
  estimatedRemainingMinutes: number;
  riderToStoreMinutes: number;
  storeToCustomerMinutes: number;
  preparationRemainingMinutes: number;
  handoverBufferMinutes: number;
  calculatedAt: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  source: string;
}

export class DeliveryEtaService {
  // Average urban delivery transit speed: ~24 km/h = 400 meters per minute
  public static readonly AVERAGE_SPEED_METERS_PER_MIN = 400;
  public static readonly HANDOVER_BUFFER_MINUTES = 3;

  /**
   * Calculates system-authoritative delivery ETA
   */
  public static async calculateDeliveryEta(params: {
    orderId: string;
    orderData: any;
    riderUid?: string;
  }): Promise<DeliveryEtaResult> {
    const { orderId, orderData, riderUid } = params;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const status = (orderData.status || 'accepted').toLowerCase();
    const storeLat = Number(orderData.restaurantLat || orderData.storeLat || 21.0967);
    const storeLng = Number(orderData.restaurantLng || orderData.storeLng || 81.0315);

    // 1. Resolve Customer Delivery Coordinates
    const customerCoords = GeofenceVerificationService.resolveCustomerCoordinates(orderData) || {
      lat: storeLat + 0.02,
      lng: storeLng + 0.02,
    };

    // 2. Resolve Rider Coordinates (from Supabase GPS or assigned rider data)
    let riderLat = storeLat;
    let riderLng = storeLng;
    let isRiderLive = false;

    const assignedRiderId = riderUid || orderData.deliveryPartnerId || orderData.riderId;
    if (assignedRiderId) {
      try {
        const supaLoc = await SupabaseGpsService.getLatestLocation(assignedRiderId);
        if (supaLoc && supaLoc.latitude != null && supaLoc.longitude != null) {
          riderLat = Number(supaLoc.latitude);
          riderLng = Number(supaLoc.longitude);
          isRiderLive = true;
        }
      } catch (err: any) {
        console.warn(`[DeliveryEtaService] GPS fetch warning for ${assignedRiderId}:`, err?.message);
      }
    }

    // 3. Distance Calculations
    const storeToCustomerDist = GeofenceVerificationService.calculateDistanceMeters(
      storeLat,
      storeLng,
      customerCoords.lat,
      customerCoords.lng
    );

    const riderToStoreDist = isRiderLive
      ? GeofenceVerificationService.calculateDistanceMeters(riderLat, riderLng, storeLat, storeLng)
      : 500;

    const riderToCustomerDist = isRiderLive
      ? GeofenceVerificationService.calculateDistanceMeters(riderLat, riderLng, customerCoords.lat, customerCoords.lng)
      : storeToCustomerDist;

    // 4. Time Component Breakdown
    const storeToCustomerMinutes = Math.max(3, Math.ceil(storeToCustomerDist / this.AVERAGE_SPEED_METERS_PER_MIN));
    const riderToStoreMinutes = Math.max(0, Math.ceil(riderToStoreDist / this.AVERAGE_SPEED_METERS_PER_MIN));

    // Remaining Preparation Time
    let preparationRemainingMinutes = 0;
    if (['pending', 'accepted', 'preparing'].includes(status)) {
      const readyAt = orderData.expectedReadyAt || orderData.estimatedReadyAt;
      if (readyAt) {
        const readyMs = new Date(readyAt).getTime();
        const diffMs = readyMs - now;
        preparationRemainingMinutes = Math.max(0, Math.ceil(diffMs / 60000));
      } else {
        preparationRemainingMinutes = Number(orderData.estimatedPreparationMinutes || 15);
      }
    }

    // 5. Total ETA Calculation based on Current Fulfillment State
    let totalMinutes = 0;
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';

    if (status === 'out_for_delivery') {
      // Rider is currently on the road to the customer
      const directTransitMinutes = Math.max(2, Math.ceil(riderToCustomerDist / this.AVERAGE_SPEED_METERS_PER_MIN));
      totalMinutes = directTransitMinutes;
      confidence = isRiderLive ? 'HIGH' : 'MEDIUM';
    } else if (status === 'picked_up' || status === 'ready') {
      // Order is ready; needs rider transit to customer
      totalMinutes = storeToCustomerMinutes;
      confidence = isRiderLive ? 'HIGH' : 'MEDIUM';
    } else if (status === 'partner_assigned') {
      // Rider must travel to store + handover + travel to customer
      totalMinutes = Math.max(
        preparationRemainingMinutes,
        riderToStoreMinutes
      ) + this.HANDOVER_BUFFER_MINUTES + storeToCustomerMinutes;
      confidence = isRiderLive ? 'HIGH' : 'MEDIUM';
    } else {
      // Pending / Accepted / Preparing without assigned rider
      totalMinutes = preparationRemainingMinutes + this.HANDOVER_BUFFER_MINUTES + storeToCustomerMinutes;
      confidence = 'MEDIUM';
    }

    // Ensure sensible minimum (at least 5 min for delivery)
    totalMinutes = Math.max(5, totalMinutes);

    const etaTimestamp = new Date(now + totalMinutes * 60000).toISOString();

    const result: DeliveryEtaResult = {
      deliveryEta: etaTimestamp,
      estimatedRemainingMinutes: totalMinutes,
      riderToStoreMinutes,
      storeToCustomerMinutes,
      preparationRemainingMinutes,
      handoverBufferMinutes: this.HANDOVER_BUFFER_MINUTES,
      calculatedAt: nowIso,
      confidence,
      source: isRiderLive ? 'SUPABASE_LIVE_TELEMETRY' : 'GEODESIC_STORE_BASELINE',
    };

    // 6. Update Canonical Orders and Firestore (skip for unit/test mock IDs)
    if (!orderId.startsWith('unit_') && !orderId.startsWith('test_') && process.env.NODE_ENV !== 'test') {
      try {
        await Promise.race([
          adminDb.collection('orders').doc(orderId).set({
            deliveryEta: etaTimestamp,
            deliveryEtaMinutes: totalMinutes,
            deliveryEtaCalculatedAt: nowIso,
            updatedAt: new Date(now),
          }, { merge: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 3000))
        ]).catch(() => {});


      } catch (persistErr: any) {
        console.warn(`[DeliveryEtaService] Persistence notice for ${orderId}:`, persistErr?.message);
      }
    }

    return result;
  }
}
