import { adminDb } from '../../config/firebase.js';
import { withTimeout } from '../../lib/utils.js';
import { GeohashService } from '../location/GeohashService.js';

export interface CustomerOrderingContext {
  customerId: string;
  franchiseId: string;
  branchId: string;
  branchName: string;
  location: {
    lat: number;
    lng: number;
    addressLine?: string;
  };
  distanceKm: number;
  deliveryRadiusKm: number;
  deliveryFee?: number;
  geohash?: string;
  version: number;
  resolvedAt: string;
  expiresAt: number;
}

export interface OrderingContextResolutionResult {
  isServiceable: boolean;
  context?: CustomerOrderingContext;
  error?: string;
  code?: string;
}

export class CustomerOrderingContextService {
  public static haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) *
        Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private static cachedBranches: Array<{
    id: string;
    franchiseId: string;
    name: string;
    lat: number;
    lng: number;
    deliveryRadiusKm: number;
  }> | null = null;
  private static branchCacheExpiry: number = 0;
  private static readonly BRANCH_CACHE_TTL_MS = 60 * 1000; // 60s cache

  /**
   * Invalidate operational branches snapshot cache (e.g. after franchise mutation)
   */
  public static invalidateBranchesSnapshot(): void {
    this.cachedBranches = null;
    this.branchCacheExpiry = 0;
  }

  /**
   * Fetch active operational branches snapshot once and cache in-memory.
   * Excludes deleted, deactivated, suspended, or planned branches.
   */
  public static async getActiveBranchesSnapshot(): Promise<Array<{
    id: string;
    franchiseId: string;
    name: string;
    lat: number;
    lng: number;
    deliveryRadiusKm: number;
  }>> {
    const now = Date.now();
    if (this.cachedBranches && now < this.branchCacheExpiry) {
      return this.cachedBranches;
    }

    const branches: Array<{
      id: string;
      franchiseId: string;
      name: string;
      lat: number;
      lng: number;
      deliveryRadiusKm: number;
    }> = [];
    const seenBranchIds = new Set<string>();

    try {
      const { query } = await import('../../lib/db.js');
      const pgBranches = await query(`
        SELECT id, franchise_id, name, latitude, longitude, delivery_settings, is_open
        FROM restaurant_branches
        WHERE is_open = true;
      `);
      for (const row of pgBranches.rows) {
        let bLat = Number(row.latitude);
        let bLng = Number(row.longitude);
        // Canonical fallback coordinates for Rajnandgaon HQ aliases if not populated in DB row
        if ((isNaN(bLat) || isNaN(bLng) || (bLat === 0 && bLng === 0)) && (row.id === 'main_branch' || row.id === 'branch_rjn_main')) {
          bLat = 21.0974;
          bLng = 81.0347;
        }
        if (!isNaN(bLat) && !isNaN(bLng) && !(bLat === 0 && bLng === 0)) {
          // Canonical default delivery radius is 12 km per project specification
          const maxRadius = Number(row.delivery_settings?.radiusKm ?? row.delivery_settings?.maxDeliveryRadiusKm ?? 12);
          seenBranchIds.add(row.id);
          branches.push({
            id: row.id,
            franchiseId: row.franchise_id || 'fra_rajnandgaon',
            name: row.name || 'Olive Pizza Branch',
            lat: bLat,
            lng: bLng,
            deliveryRadiusKm: maxRadius
          });
        }
      }
    } catch (pgErr: any) {
      console.error('[CustomerOrderingContext] Error reading restaurant_branches from PG:', pgErr.message);
      // Re-throw so callers fail closed on database outages rather than fabricating successful serviceability
      throw new Error(`Database service error: unable to load canonical branches from PostgreSQL (${pgErr.message})`);
    }

    this.cachedBranches = branches;
    this.branchCacheExpiry = now + this.BRANCH_CACHE_TTL_MS;
    return branches;
  }

  /**
   * Fast in-memory batch serviceability check for multiple location candidates.
   * Eliminates per-candidate Firestore queries.
   */
  public static async checkBatchServiceability(candidates: Array<{ latitude: number; longitude: number }>): Promise<Array<{
    isServiceable: boolean;
    serviceabilityMessage: string;
    distanceKm?: number;
    branchId?: string;
    branchName?: string;
    franchiseId?: string;
  }>> {
    let branches: any[];
    try {
      branches = await this.getActiveBranchesSnapshot();
    } catch {
      return candidates.map(() => ({
        isServiceable: false,
        serviceabilityMessage: 'Database service error: unable to load operational branches'
      }));
    }

    if (!branches || branches.length === 0) {
      return candidates.map(() => ({
        isServiceable: false,
        serviceabilityMessage: 'No operational branches available in database'
      }));
    }

    return candidates.map((cand) => {
      const cLat = Number(cand.latitude);
      const cLng = Number(cand.longitude);
      if (
        isNaN(cLat) || 
        isNaN(cLng) || 
        cLat < -90 || 
        cLat > 90 || 
        cLng < -180 || 
        cLng > 180 || 
        (Math.abs(cLat) < 0.0001 && Math.abs(cLng) < 0.0001)
      ) {
        return {
          isServiceable: false,
          serviceabilityMessage: 'Invalid coordinates'
        };
      }

      let closestBranch: (typeof branches)[0] | null = null;
      let minDistance = Infinity;

      for (const b of branches) {
        const dist = this.haversineDistanceKm(cLat, cLng, b.lat, b.lng);
        if (dist <= b.deliveryRadiusKm && dist < minDistance) {
          minDistance = dist;
          closestBranch = b;
        }
      }

      if (!closestBranch) {
        return {
          isServiceable: false,
          serviceabilityMessage: 'Outside current delivery radius'
        };
      }

      const roundedDist = Math.round(minDistance * 100) / 100;
      return {
        isServiceable: true,
        serviceabilityMessage: `Deliverable from ${closestBranch.name} (${roundedDist} km)`,
        distanceKm: roundedDist,
        branchId: closestBranch.id,
        branchName: closestBranch.name,
        franchiseId: closestBranch.franchiseId
      };
    });
  }

  /**
   * Resolves the authoritative Olive Pizza franchise & branch serving the provided GPS coordinates.
   * If customer is outside all active branches' delivery radius, rejects with OUT_OF_DELIVERY_ZONE.
   */
  public static async resolveOrderingContext(params: {
    customerId: string;
    lat: number;
    lng: number;
    addressLine?: string;
    targetBranchId?: string;
    targetFranchiseId?: string;
  }): Promise<OrderingContextResolutionResult> {
    const { customerId, lat, lng, addressLine, targetBranchId, targetFranchiseId } = params;

    const custLat = Number(lat);
    const custLng = Number(lng);

    // Validate coordinate ranges strictly
    if (
      lat == null || 
      lng == null || 
      isNaN(custLat) || 
      isNaN(custLng) ||
      custLat < -90 || 
      custLat > 90 || 
      custLng < -180 || 
      custLng > 180 ||
      (Math.abs(custLat) < 0.0001 && Math.abs(custLng) < 0.0001)
    ) {
      return {
        isServiceable: false,
        error: 'Invalid coordinates provided for delivery location resolution.',
        code: 'INVALID_COORDINATES'
      };
    }

    // 1. Fetch active branches using snapshot cache (Fail closed on database outage)
    let branches: any[];
    try {
      branches = await this.getActiveBranchesSnapshot();
    } catch (dbErr: any) {
      console.error('[CustomerOrderingContext] Database failure in resolveOrderingContext:', dbErr.message);
      return {
        isServiceable: false,
        error: 'Branch serviceability verification unavailable due to database service error. Please try again later.',
        code: 'SERVICE_UNAVAILABLE'
      };
    }

    if (!branches || branches.length === 0) {
      return {
        isServiceable: false,
        error: 'No active delivery branches currently available in canonical database. Store pickup and takeaway are available.',
        code: 'SERVICE_UNAVAILABLE'
      };
    }

    let closestBranch: any = null;
    let minDistance = Infinity;

    // Prioritize target branch if explicitly requested and within serviceable radius.
    // Gracefully handle 'branch_rjn_main' / 'main_branch' aliases in application logic.
    if (targetBranchId) {
      const isTargetRjnAlias = targetBranchId === 'main_branch' || targetBranchId === 'branch_rjn_main';
      const targetB = branches.find(b => 
        b.id === targetBranchId || 
        (isTargetRjnAlias && (b.id === 'main_branch' || b.id === 'branch_rjn_main'))
      );
      if (targetB) {
        const dist = this.haversineDistanceKm(custLat, custLng, targetB.lat, targetB.lng);
        if (dist <= targetB.deliveryRadiusKm) {
          closestBranch = {
            ...targetB,
            id: targetBranchId, // Preserve caller's requested alias without breaking canonical routing
            maxRadius: targetB.deliveryRadiusKm
          };
          minDistance = dist;
        }
      }
    }

    if (!closestBranch) {
      for (const b of branches) {
        const dist = this.haversineDistanceKm(custLat, custLng, b.lat, b.lng);
        if (dist <= b.deliveryRadiusKm && dist < minDistance) {
          minDistance = dist;
          closestBranch = {
            ...b,
            maxRadius: b.deliveryRadiusKm
          };
        }
      }
    }

    // 2. Strict Delivery Radius Evaluation
    if (!closestBranch) {
      let nearestAnyBranch: any = null;
      let nearestDist = Infinity;
      for (const b of branches) {
        const d = this.haversineDistanceKm(custLat, custLng, b.lat, b.lng);
        if (d < nearestDist) {
          nearestDist = d;
          nearestAnyBranch = b;
        }
      }
      const roundedDist = Math.round(nearestDist * 10) / 10;
      const branchName = nearestAnyBranch?.name || 'Olive Pizza';
      const maxRadius = nearestAnyBranch?.deliveryRadiusKm || 15;
      const userGeohash = GeohashService.encode(custLat, custLng, 6);

      return {
        isServiceable: false,
        error: `Your location is ${roundedDist} km away from ${branchName} (maximum delivery radius is ${maxRadius} km). Store pickup and takeaway are available!`,
        code: 'OUT_OF_DELIVERY_ZONE'
      };
    }

    const resolvedFranchiseId = closestBranch.franchiseId || closestBranch.id;
    const resolvedBranchId = closestBranch.id;
    const resolvedBranchName = closestBranch.name || 'Olive Pizza Branch';
    const now = Date.now();
    const version = now;
    const userGeohash = GeohashService.encode(custLat, custLng, 6);

    const context: CustomerOrderingContext = {
      customerId: customerId || 'guest',
      franchiseId: resolvedFranchiseId,
      branchId: resolvedBranchId,
      branchName: resolvedBranchName,
      location: {
        lat: custLat,
        lng: custLng,
        addressLine: addressLine || ''
      },
      distanceKm: Math.round(minDistance * 100) / 100,
      deliveryRadiusKm: closestBranch.maxRadius,
      deliveryFee: minDistance > 5 ? 40 : 30,
      geohash: userGeohash,
      version,
      resolvedAt: new Date().toISOString(),
      expiresAt: now + (60 * 60 * 1000) // 1 hour validity
    };

    // 3. Persist context server-side if customerId is present
    if (customerId && customerId !== 'guest') {
      try {
        await adminDb.collection('customer_ordering_contexts').doc(customerId).set({
          ...context,
          updatedAt: new Date().toISOString()
        });
      } catch (persistErr) {
        console.warn('[CustomerOrderingContext] Notice saving context:', persistErr);
      }
    }

    return {
      isServiceable: true,
      context
    };
  }

  /**
   * Validates whether a given delivery location and targeted franchise are valid
   * according to authoritative server-side radius and single-franchise locking rules.
   */
  public static async validateCustomerOrderLocation(params: {
    lat: number;
    lng: number;
    targetFranchiseId?: string;
    targetBranchId?: string;
    customerId?: string;
  }): Promise<{
    isValid: boolean;
    resolvedFranchiseId: string;
    resolvedBranchId: string;
    distanceKm: number;
    error?: string;
    code?: string;
  }> {
    const { lat, lng, targetFranchiseId, targetBranchId, customerId } = params;

    const resolution = await this.resolveOrderingContext({
      customerId: customerId || 'guest',
      lat,
      lng,
      targetBranchId,
      targetFranchiseId
    });

    if (!resolution.isServiceable || !resolution.context) {
      return {
        isValid: false,
        resolvedFranchiseId: '',
        resolvedBranchId: '',
        distanceKm: 0,
        error: resolution.error || "We currently don't deliver to this location.",
        code: resolution.code || 'OUT_OF_DELIVERY_ZONE'
      };
    }

    const { franchiseId, branchId, distanceKm } = resolution.context;

    // Single-Franchise Lock Enforcement:
    // If client explicitly supplied a target franchise that differs from the resolved franchise,
    // verify against known franchise ID and branch associations (e.g. fra_primary <-> fra_rajnandgaon <-> main_branch).
    const isMatchingFranchise = !targetFranchiseId || targetFranchiseId.trim() === '' ||
      targetFranchiseId.trim() === franchiseId ||
      targetFranchiseId.trim() === branchId ||
      (targetFranchiseId.trim() === 'fra_primary' && (franchiseId === 'fra_rajnandgaon' || branchId === 'main_branch')) ||
      (targetFranchiseId.trim() === 'fra_rajnandgaon' && (franchiseId === 'fra_primary' || branchId === 'main_branch'));

    if (!isMatchingFranchise) {
      return {
        isValid: false,
        resolvedFranchiseId: franchiseId,
        resolvedBranchId: branchId,
        distanceKm,
        error: 'The requested order belongs to a different franchise than the confirmed delivery location.',
        code: 'FRANCHISE_MISMATCH'
      };
    }

    // If client explicitly supplied a branchId that does not belong to the resolved branch:
    const isMatchingBranch = !targetBranchId || targetBranchId.trim() === '' ||
      targetBranchId.trim() === branchId ||
      targetBranchId.trim() === franchiseId ||
      (targetBranchId.trim() === 'main_branch' && (branchId === 'fra_rajnandgaon' || franchiseId === 'fra_rajnandgaon' || franchiseId === 'fra_primary')) ||
      (targetBranchId.trim() === 'branch_rjn' && branchId === 'main_branch');

    if (!isMatchingBranch) {
      return {
        isValid: false,
        resolvedFranchiseId: franchiseId,
        resolvedBranchId: branchId,
        distanceKm,
        error: 'The requested branch does not serve this delivery location.',
        code: 'BRANCH_MISMATCH'
      };
    }

    return {
      isValid: true,
      resolvedFranchiseId: franchiseId,
      resolvedBranchId: branchId,
      distanceKm
    };
  }
}
