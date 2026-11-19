import { SupabaseGpsService } from '../gps/SupabaseGpsService.js';
import { adminDb } from '../../config/firebase.js';

export interface GeofenceValidationResult {
  allowed: boolean;
  distanceMeters: number;
  requiredMeters: number;
  accuracyMeters?: number | null;
  riderLat: number;
  riderLng: number;
  targetLat: number;
  targetLng: number;
  reason?: string;
  verifiedAt: string;
}

export class GeofenceVerificationService {
  public static readonly DEFAULT_RADIUS_METERS = 50;
  public static readonly MAX_LOCATION_AGE_MS = 5 * 60 * 1000; // 5 minutes freshness window
  public static readonly MAX_ALLOWED_ACCURACY_METERS = 100; // Capped accuracy threshold

  /**
   * Calculates geodesic distance between two points in meters using Haversine formula
   */
  public static calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * Resolves customer target coordinates from order data
   */
  public static resolveCustomerCoordinates(orderData: any): { lat: number; lng: number } | null {
    if (!orderData) return null;

    const candidateSources = [
      orderData.deliveryAddressCoordinates,
      orderData.deliveryAddress?.coordinates,
      orderData.deliveryAddress,
      orderData.deliveryLocation,
      orderData.customerLocation,
      orderData.customerAddress?.coordinates,
      orderData.customerAddress,
      orderData.location,
    ];

    for (const src of candidateSources) {
      if (!src || typeof src !== 'object') continue;
      const lat = src.lat != null ? Number(src.lat) : (src.latitude != null ? Number(src.latitude) : null);
      const lng = src.lng != null ? Number(src.lng) : (src.longitude != null ? Number(src.longitude) : null);

      if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
        if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) continue;
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
      }
    }

    return null;
  }

  /**
   * Authoritatively verifies whether an assigned rider is within the mandatory 50-meter delivery gate
   */
  public static async verifyRiderProximity(
    orderId: string,
    riderUid: string,
    orderData: any,
    clientProvidedCoords?: { lat?: number; lng?: number; accuracy?: number }
  ): Promise<GeofenceValidationResult> {
    const verifiedAt = new Date().toISOString();
    const requiredMeters = process.env.DELIVERY_COMPLETION_RADIUS_METERS
      ? Number(process.env.DELIVERY_COMPLETION_RADIUS_METERS)
      : this.DEFAULT_RADIUS_METERS;

    // 0. Verify Authenticated Assigned Rider (Must match order's canonical assigned partner)
    const assignedRider = orderData?.deliveryPartnerId || orderData?.delivery_partner_id || orderData?.assignedRiderId;
    if (assignedRider && assignedRider !== riderUid) {
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        riderLat: 0,
        riderLng: 0,
        targetLat: 0,
        targetLng: 0,
        reason: `Rider ${riderUid} is not the assigned delivery partner for this canonical order. Assigned rider is ${assignedRider}.`,
        verifiedAt
      };
    }

    // 1. Fetch Authoritative Rider GPS strictly from Redis Telemetry (via SupabaseGpsService -> RedisGpsService)
    // No fallback to PostgreSQL or Firestore: Redis is the single authoritative temporary GPS store.
    let riderLat: number | null = null;
    let riderLng: number | null = null;
    let accuracyMeters: number | null = null;
    let locationTimestamp: number = 0;

    try {
      const supaLoc = await SupabaseGpsService.getLatestLocation(riderUid);
      if (supaLoc && supaLoc.latitude != null && supaLoc.longitude != null) {
        riderLat = Number(supaLoc.latitude);
        riderLng = Number(supaLoc.longitude);
        accuracyMeters = supaLoc.accuracy != null ? Number(supaLoc.accuracy) : null;
        locationTimestamp = supaLoc.updated_at ? new Date(supaLoc.updated_at).getTime() : 0;
      }
    } catch (err: any) {
      console.warn(`[GeofenceVerificationService] Redis GPS lookup warning for ${riderUid}:`, err?.message);
    }

    // 2. Resolve Customer Target Coordinates from canonical order record
    const target = this.resolveCustomerCoordinates(orderData);
    if (!target) {
      // Fail closed: Missing customer coordinates cannot complete delivery
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        riderLat: riderLat ?? 0,
        riderLng: riderLng ?? 0,
        targetLat: 0,
        targetLng: 0,
        reason: 'Order is missing verified customer delivery destination coordinates in canonical record. Delivery completion requires verified customer pin coordinates.',
        verifiedAt,
      };
    }

    // 3. Strict Server-Side GPS Validation: Fail closed if trusted server rider GPS is unavailable
    if (riderLat === null || riderLng === null || isNaN(riderLat) || isNaN(riderLng)) {
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        riderLat: 0,
        riderLng: 0,
        targetLat: target.lat,
        targetLng: target.lng,
        reason: 'Unable to acquire fresh, trusted server-side rider GPS coordinates. Please ensure location services are active and streaming.',
        verifiedAt,
      };
    }

    // 4. Freshness Validation: Must be within MAX_LOCATION_AGE_MS
    const now = Date.now();
    if (locationTimestamp > 0 && now - locationTimestamp > this.MAX_LOCATION_AGE_MS) {
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        accuracyMeters,
        riderLat,
        riderLng,
        targetLat: target.lat,
        targetLng: target.lng,
        reason: 'Rider GPS fix is stale (> 5 minutes old). Please refresh location in the delivery app before continuing.',
        verifiedAt,
      };
    }

    // 5. Accuracy Threshold Validation
    if (accuracyMeters != null && accuracyMeters > this.MAX_ALLOWED_ACCURACY_METERS) {
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        accuracyMeters,
        riderLat,
        riderLng,
        targetLat: target.lat,
        targetLng: target.lng,
        reason: `GPS accuracy is too low (±${Math.round(accuracyMeters)}m). Move to an open area with a better GPS signal.`,
        verifiedAt,
      };
    }

    // 6. Geodesic Distance Calculation
    const distanceMeters = this.calculateDistanceMeters(riderLat, riderLng, target.lat, target.lng);
    const roundedDist = Math.round(distanceMeters);

    if (distanceMeters > requiredMeters) {
      return {
        allowed: false,
        distanceMeters: roundedDist,
        requiredMeters,
        accuracyMeters,
        riderLat,
        riderLng,
        targetLat: target.lat,
        targetLng: target.lng,
        reason: `Delivery location gate requires you to be within ${requiredMeters}m of customer. Currently ${roundedDist}m away.`,
        verifiedAt,
      };
    }

    return {
      allowed: true,
      distanceMeters: roundedDist,
      requiredMeters,
      accuracyMeters,
      riderLat,
      riderLng,
      targetLat: target.lat,
      targetLng: target.lng,
      verifiedAt,
    };
  }
}
