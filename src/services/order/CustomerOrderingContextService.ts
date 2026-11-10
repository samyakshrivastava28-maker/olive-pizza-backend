import { adminDb } from '../../config/firebase.js';

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
      // 1. Fetch active branches across franchises collection
      const franchisesSnap = await adminDb.collection('franchises').get();
      for (const bDoc of franchisesSnap.docs) {
        const bData = bDoc.data();
        const bStatus = String(bData.status || '').toLowerCase();
        if (
          bData.isActive === false ||
          bStatus === 'deleted' ||
          bStatus === 'deactivated' ||
          bStatus === 'suspended' ||
          bStatus === 'planned'
        ) {
          continue;
        }

        const bLat = Number(bData.lat ?? bData.coordinates?.lat ?? bData.location?.lat);
        const bLng = Number(bData.lng ?? bData.coordinates?.lng ?? bData.location?.lng);
        if (!isNaN(bLat) && !isNaN(bLng)) {
          const maxRadius = Number(
            bData.deliveryRadiusKm ||
            bData.maxDeliveryRadiusKm ||
            bData.deliverySettings?.maxDeliveryRadiusKm ||
            bData.deliveryRadius ||
            15
          );

          seenBranchIds.add(bDoc.id);
          branches.push({
            id: bDoc.id,
            franchiseId: bData.franchiseId || bDoc.id,
            name: bData.name || 'Olive Pizza Branch',
            lat: bLat,
            lng: bLng,
            deliveryRadiusKm: maxRadius
          });
        }
      }
    } catch (err) {
      console.warn('[CustomerOrderingContext] Warning reading franchises snapshot:', err);
    }

    // 2. Also check franchise_entities collection if available
    try {
      const entitiesSnap = await adminDb.collection('franchise_entities').get();
      for (const eDoc of entitiesSnap.docs) {
        const eData = eDoc.data();
        const eStatus = String(eData.status || '').toLowerCase();
        if (
          eData.isActive === false ||
          eStatus === 'deleted' ||
          eStatus === 'deactivated' ||
          eStatus === 'suspended' ||
          eStatus === 'planned'
        ) {
          continue;
        }

        const bId = eData.mainBranchId || eDoc.id;
        if (seenBranchIds.has(bId)) continue;

        const eLat = Number(eData.lat ?? eData.coordinates?.lat ?? eData.location?.lat);
        const eLng = Number(eData.lng ?? eData.coordinates?.lng ?? eData.location?.lng);
        if (!isNaN(eLat) && !isNaN(eLng)) {
          const maxRadius = Number(eData.deliveryRadiusKm || eData.maxDeliveryRadiusKm || 15);
          branches.push({
            id: bId,
            franchiseId: eDoc.id,
            name: eData.name || 'Olive Pizza Franchise',
            lat: eLat,
            lng: eLng,
            deliveryRadiusKm: maxRadius
          });
          seenBranchIds.add(bId);
        }
      }
    } catch {
      // Non-fatal
    }

    if (branches.length === 0) {
      branches.push({
        id: 'main_branch',
        franchiseId: 'fra_rajnandgaon',
        name: 'Olive Pizza (Rajnandgaon HQ)',
        lat: 21.0974,
        lng: 81.0347,
        deliveryRadiusKm: 25
      });
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
    const branches = await this.getActiveBranchesSnapshot();

    return candidates.map((cand) => {
      const cLat = Number(cand.latitude);
      const cLng = Number(cand.longitude);
      if (isNaN(cLat) || isNaN(cLng)) {
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
  }): Promise<OrderingContextResolutionResult> {
    const { customerId, lat, lng, addressLine } = params;

    if (lat == null || lng == null || isNaN(Number(lat)) || isNaN(Number(lng))) {
      return {
        isServiceable: false,
        error: 'Invalid coordinates provided for delivery location resolution.',
        code: 'INVALID_COORDINATES'
      };
    }

    const custLat = Number(lat);
    const custLng = Number(lng);

    // 1. Fetch active branches using snapshot cache
    const branches = await this.getActiveBranchesSnapshot();
    let closestBranch: any = null;
    let minDistance = Infinity;

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

    // 2. Strict Delivery Radius Evaluation
    if (!closestBranch) {
      return {
        isServiceable: false,
        error: "We currently don't deliver to this location.",
        code: 'OUT_OF_DELIVERY_ZONE'
      };
    }

    const resolvedFranchiseId = closestBranch.franchiseId || closestBranch.id;
    const resolvedBranchId = closestBranch.id;
    const resolvedBranchName = closestBranch.name || 'Olive Pizza Branch';
    const now = Date.now();
    const version = now;

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
      lng
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
