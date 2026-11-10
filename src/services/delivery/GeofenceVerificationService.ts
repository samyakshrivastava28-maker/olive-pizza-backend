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

    // 1. Fetch Authoritative Rider GPS from Supabase (Single Source of Truth)
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
        locationTimestamp = supaLoc.last_updated ? new Date(supaLoc.last_updated).getTime() : 0;
      }
    } catch (err: any) {
      console.warn(`[GeofenceVerificationService] Supabase GPS lookup warning for ${riderUid}:`, err?.message);
    }

    // Secondary fallback: delivery_partners collection in Firestore
    if (riderLat === null || riderLng === null) {
      try {
        const dpDoc = await adminDb.collection('delivery_partners').doc(riderUid).get();
        if (dpDoc.exists) {
          const data = dpDoc.data()!;
          if (data.latitude != null && data.longitude != null) {
            riderLat = Number(data.latitude);
            riderLng = Number(data.longitude);
            accuracyMeters = data.accuracy != null ? Number(data.accuracy) : null;
            locationTimestamp = data.lastLocationUpdate ? new Date(data.lastLocationUpdate).getTime() : 0;
          }
        }
      } catch (fsErr: any) {
        console.warn(`[GeofenceVerificationService] Firestore fallback warning for ${riderUid}:`, fsErr?.message);
      }
    }

    // Direct mobile client GPS payload fallback
    if ((riderLat === null || riderLng === null) && clientProvidedCoords?.lat != null && clientProvidedCoords?.lng != null) {
      riderLat = Number(clientProvidedCoords.lat);
      riderLng = Number(clientProvidedCoords.lng);
      accuracyMeters = clientProvidedCoords.accuracy ?? 10;
      locationTimestamp = Date.now();
    }

    // Resolve Customer Target Coordinates
    const target = this.resolveCustomerCoordinates(orderData);
    if (!target) {
      // Order lacks customer coordinates (e.g. text address without pin).
      // Accept rider coordinates as the verified delivery point if available.
      if (riderLat !== null && riderLng !== null && !isNaN(riderLat) && !isNaN(riderLng)) {
        return {
          allowed: true,
          distanceMeters: 0,
          requiredMeters,
          accuracyMeters: accuracyMeters ?? 10,
          riderLat,
          riderLng,
          targetLat: riderLat,
          targetLng: riderLng,
          reason: 'Delivery completed at rider arrival coordinates (customer pin not specified on order).',
          verifiedAt,
        };
      }
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        riderLat: 0,
        riderLng: 0,
        targetLat: 0,
        targetLng: 0,
        reason: 'Order is missing verified customer delivery coordinates, and rider GPS location was not acquired.',
        verifiedAt,
      };
    }

    // 2. Strict Validation: Fail closed if rider location is unavailable
    if (riderLat === null || riderLng === null || isNaN(riderLat) || isNaN(riderLng)) {
      return {
        allowed: false,
        distanceMeters: -1,
        requiredMeters,
        riderLat: 0,
        riderLng: 0,
        targetLat: target.lat,
        targetLng: target.lng,
        reason: 'Unable to acquire fresh, trusted rider GPS coordinates. Please ensure location services are active.',
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
