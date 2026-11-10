/**
 * PostgresGpsService.ts — Authoritative Main PostgreSQL GPS & Location Engine
 * 
 * Complies with Phase 7 Architecture:
 * 1. Main PostgreSQL is the sole authoritative source for live rider GPS telemetry,
 *    current positions, breadcrumbs, and spatial discovery.
 * 2. Eliminates external Supabase GPS dependency.
 * 3. Enforces validated franchise/branch scoping from PostgreSQL delivery_partners.
 * 4. Implements safe GPS cleanup that never deletes active-delivery state.
 */

import { query } from '../../lib/db.js';

export interface GpsLocationPayload {
  deliveryPartnerId: string;
  activeOrderId?: string | null;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  onlineStatus?: boolean;
}

export interface NavigationSessionPayload {
  sessionId: string;
  orderId: string;
  deliveryPartnerId: string;
  expiresAt?: Date | string | null;
}

export interface NavigationPointPayload {
  sessionId: string;
  orderId: string;
  latitude: number;
  longitude: number;
  speed?: number | null;
  heading?: number | null;
  accuracy?: number | null;
}

export interface LiveRiderLocation {
  deliveryPartnerId: string;
  activeOrderId: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  onlineStatus: boolean;
  isStale: boolean;
  franchiseId: string;
  branchId: string;
  lastUpdated: string;
}

export class PostgresGpsService {
  /**
   * Upsert the latest live GPS coordinate into main PostgreSQL delivery_locations
   * and update delivery_partners with latest coordinates and timestamp.
   */
  public static async upsertLatestLocation(payload: GpsLocationPayload): Promise<{
    success: boolean;
    franchiseId?: string;
    branchId?: string;
    isStale?: boolean;
    error?: string;
  }> {
    const lat = Number(payload.latitude);
    const lng = Number(payload.longitude);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { success: false, error: 'Invalid geographic coordinates' };
    }

    try {
      // 1. Authoritative Partner Verification against delivery_partners in PostgreSQL
      const partnerRes = await query(
        `SELECT id, franchise_id, branch_id, status, is_online, active_order_id 
         FROM delivery_partners 
         WHERE id = $1 LIMIT 1`,
        [payload.deliveryPartnerId]
      );

      if (partnerRes.rows.length === 0) {
        return { success: false, error: 'Delivery partner record not found in system database' };
      }

      const partner = partnerRes.rows[0];
      if (partner.status === 'REVOKED' || partner.status === 'TERMINATED' || partner.status === 'DISABLED') {
        return { success: false, error: 'Delivery partner account has been revoked or deactivated' };
      }

      const activeOrderId = payload.activeOrderId !== undefined ? payload.activeOrderId : partner.active_order_id;
      const onlineStatus = payload.onlineStatus ?? true;

      // 2. Atomic Upsert into delivery_locations (One updatable record per rider)
      await query(
        `INSERT INTO delivery_locations (
           delivery_partner_id, active_order_id, latitude, longitude, accuracy, speed, heading, online_status, last_updated
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (delivery_partner_id) DO UPDATE SET
           active_order_id = COALESCE(EXCLUDED.active_order_id, delivery_locations.active_order_id),
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           accuracy = EXCLUDED.accuracy,
           speed = EXCLUDED.speed,
           heading = EXCLUDED.heading,
           online_status = EXCLUDED.online_status,
           last_updated = NOW()`,
        [
          payload.deliveryPartnerId,
          activeOrderId || null,
          lat,
          lng,
          payload.accuracy != null ? Number(payload.accuracy) : null,
          payload.speed != null ? Number(payload.speed) : null,
          payload.heading != null ? Number(payload.heading) : null,
          onlineStatus,
        ]
      );

      // 3. Keep delivery_partners synchronized
      await query(
        `UPDATE delivery_partners
         SET current_lat = $2,
             current_lng = $3,
             last_location_time = NOW(),
             is_online = $4,
             active_order_id = COALESCE($5, active_order_id),
             updated_at = NOW()
         WHERE id = $1`,
        [
          payload.deliveryPartnerId,
          lat,
          lng,
          onlineStatus,
          activeOrderId || null,
        ]
      );

      return {
        success: true,
        franchiseId: partner.franchise_id,
        branchId: partner.branch_id
      };
    } catch (err: any) {
      console.error('[PostgresGpsService] Error upserting delivery location:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Retrieve the latest GPS location for a specific delivery partner.
   */
  public static async getLatestLocation(deliveryPartnerId: string): Promise<LiveRiderLocation | null> {
    try {
      const res = await query(
        `SELECT l.delivery_partner_id, l.active_order_id, l.latitude, l.longitude,
                l.accuracy, l.speed, l.heading, l.online_status, l.last_updated,
                p.franchise_id, p.branch_id,
                (l.last_updated < NOW() - INTERVAL '5 minutes') AS is_stale
         FROM delivery_locations l
         JOIN delivery_partners p ON p.id = l.delivery_partner_id
         WHERE l.delivery_partner_id = $1 LIMIT 1`,
        [deliveryPartnerId]
      );

      if (res.rows.length === 0) return null;
      const row = res.rows[0];

      return {
        deliveryPartnerId: row.delivery_partner_id,
        activeOrderId: row.active_order_id,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracy: row.accuracy != null ? Number(row.accuracy) : null,
        speed: row.speed != null ? Number(row.speed) : null,
        heading: row.heading != null ? Number(row.heading) : null,
        onlineStatus: Boolean(row.online_status),
        isStale: Boolean(row.is_stale),
        franchiseId: row.franchise_id || 'fra_rajnandgaon',
        branchId: row.branch_id || 'main_branch',
        lastUpdated: row.last_updated,
      };
    } catch (err: any) {
      console.error('[PostgresGpsService] Error fetching location:', err.message);
      return null;
    }
  }

  /**
   * Retrieve the latest GPS location for an active order.
   */
  public static async getLatestLocationByOrder(orderId: string): Promise<LiveRiderLocation | null> {
    try {
      const res = await query(
        `SELECT l.delivery_partner_id, l.active_order_id, l.latitude, l.longitude,
                l.accuracy, l.speed, l.heading, l.online_status, l.last_updated,
                p.franchise_id, p.branch_id,
                (l.last_updated < NOW() - INTERVAL '5 minutes') AS is_stale
         FROM delivery_locations l
         JOIN delivery_partners p ON p.id = l.delivery_partner_id
         WHERE l.active_order_id = $1 LIMIT 1`,
        [orderId]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          deliveryPartnerId: row.delivery_partner_id,
          activeOrderId: row.active_order_id,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          accuracy: row.accuracy != null ? Number(row.accuracy) : null,
          speed: row.speed != null ? Number(row.speed) : null,
          heading: row.heading != null ? Number(row.heading) : null,
          onlineStatus: Boolean(row.online_status),
          isStale: Boolean(row.is_stale),
          franchiseId: row.franchise_id || 'fra_rajnandgaon',
          branchId: row.branch_id || 'main_branch',
          lastUpdated: row.last_updated,
        };
      }

      // Fallback: check delivery_partners table by active_order_id
      const pRes = await query(
        `SELECT id, franchise_id, branch_id, current_lat, current_lng, is_online, last_location_time,
                (last_location_time < NOW() - INTERVAL '5 minutes') AS is_stale
         FROM delivery_partners
         WHERE active_order_id = $1 AND current_lat IS NOT NULL LIMIT 1`,
        [orderId]
      );

      if (pRes.rows.length === 0) return null;
      const pRow = pRes.rows[0];
      return {
        deliveryPartnerId: pRow.id,
        activeOrderId: orderId,
        latitude: Number(pRow.current_lat),
        longitude: Number(pRow.current_lng),
        accuracy: 10,
        speed: 0,
        heading: 0,
        onlineStatus: Boolean(pRow.is_online),
        isStale: Boolean(pRow.is_stale),
        franchiseId: pRow.franchise_id || 'fra_rajnandgaon',
        branchId: pRow.branch_id || 'main_branch',
        lastUpdated: pRow.last_location_time,
      };
    } catch (err: any) {
      console.error('[PostgresGpsService] Error fetching location by order:', err.message);
      return null;
    }
  }

  /**
   * Retrieve all currently active rider locations, filtered by franchise or branch.
   */
  public static async getActiveLocations(scope?: { franchiseId?: string; branchId?: string }): Promise<LiveRiderLocation[]> {
    try {
      let sql = `
        SELECT l.delivery_partner_id, l.active_order_id, l.latitude, l.longitude,
               l.accuracy, l.speed, l.heading, l.online_status, l.last_updated,
               p.franchise_id, p.branch_id,
               (l.last_updated < NOW() - INTERVAL '5 minutes') AS is_stale
        FROM delivery_locations l
        JOIN delivery_partners p ON p.id = l.delivery_partner_id
        WHERE (l.online_status = true OR p.is_online = true)
      `;
      const params: any[] = [];

      if (scope?.franchiseId) {
        params.push(scope.franchiseId);
        sql += ` AND p.franchise_id = $${params.length}`;
      }
      if (scope?.branchId) {
        params.push(scope.branchId);
        sql += ` AND p.branch_id = $${params.length}`;
      }

      sql += ` ORDER BY l.last_updated DESC`;
      const res = await query(sql, params);

      return res.rows.map((row: any) => ({
        deliveryPartnerId: row.delivery_partner_id,
        activeOrderId: row.active_order_id,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracy: row.accuracy != null ? Number(row.accuracy) : null,
        speed: row.speed != null ? Number(row.speed) : null,
        heading: row.heading != null ? Number(row.heading) : null,
        onlineStatus: Boolean(row.online_status),
        isStale: Boolean(row.is_stale),
        franchiseId: row.franchise_id,
        branchId: row.branch_id,
        lastUpdated: row.last_updated,
      }));
    } catch (err: any) {
      console.error('[PostgresGpsService] Error fetching active locations:', err.message);
      return [];
    }
  }

  /**
   * Set active order for rider.
   */
  public static async setActiveOrder(deliveryPartnerId: string, orderId: string): Promise<void> {
    try {
      await query(
        `UPDATE delivery_locations 
         SET active_order_id = $2, last_updated = NOW() 
         WHERE delivery_partner_id = $1`,
        [deliveryPartnerId, orderId]
      );
      await query(
        `UPDATE delivery_partners 
         SET active_order_id = $2, updated_at = NOW() 
         WHERE id = $1`,
        [deliveryPartnerId, orderId]
      );
    } catch (err: any) {
      console.warn('[PostgresGpsService] Error setting active order:', err.message);
    }
  }

  /**
   * Clear active order on rider location upon delivery or cancellation.
   */
  public static async clearActiveOrder(deliveryPartnerId: string, orderId?: string): Promise<void> {
    try {
      let locSql = `UPDATE delivery_locations SET active_order_id = NULL, last_updated = NOW() WHERE delivery_partner_id = $1`;
      let partSql = `UPDATE delivery_partners SET active_order_id = NULL, updated_at = NOW() WHERE id = $1`;
      const params: any[] = [deliveryPartnerId];

      if (orderId) {
        params.push(orderId);
        locSql += ` AND active_order_id = $2`;
        partSql += ` AND active_order_id = $2`;
      }

      await query(locSql, params);
      await query(partSql, params);
    } catch (err: any) {
      console.warn('[PostgresGpsService] Error clearing active order:', err.message);
    }
  }

  /**
   * Set rider online/offline status.
   */
  public static async setOnlineStatus(deliveryPartnerId: string, online: boolean): Promise<void> {
    try {
      await query(
        `UPDATE delivery_locations SET online_status = $2, last_updated = NOW() WHERE delivery_partner_id = $1`,
        [deliveryPartnerId, online]
      );
      await query(
        `UPDATE delivery_partners SET is_online = $2, updated_at = NOW() WHERE id = $1`,
        [deliveryPartnerId, online]
      );
    } catch (err: any) {
      console.warn('[PostgresGpsService] Error setting online status:', err.message);
    }
  }

  /**
   * Start a navigation session in PostgreSQL.
   */
  public static async startNavigationSession(payload: NavigationSessionPayload): Promise<{ success: boolean; error?: string }> {
    try {
      await query(
        `INSERT INTO navigation_sessions (id, order_id, delivery_partner_id, status, started_at, expires_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), $4)
         ON CONFLICT (id) DO UPDATE SET
           status = 'ACTIVE',
           order_id = EXCLUDED.order_id,
           delivery_partner_id = EXCLUDED.delivery_partner_id,
           started_at = NOW()`,
        [
          payload.sessionId,
          payload.orderId,
          payload.deliveryPartnerId,
          payload.expiresAt ? new Date(payload.expiresAt) : new Date(Date.now() + 2 * 60 * 60 * 1000),
        ]
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Append a breadcrumb navigation point to PostgreSQL navigation_points.
   */
  public static async appendNavigationPoint(payload: NavigationPointPayload): Promise<{ success: boolean; error?: string }> {
    try {
      await query(
        `INSERT INTO navigation_points (session_id, order_id, latitude, longitude, speed, heading, accuracy, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          payload.sessionId,
          payload.orderId,
          Number(payload.latitude),
          Number(payload.longitude),
          payload.speed != null ? Number(payload.speed) : null,
          payload.heading != null ? Number(payload.heading) : null,
          payload.accuracy != null ? Number(payload.accuracy) : null,
        ]
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * End navigation session.
   */
  public static async endNavigationSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await query(
        `UPDATE navigation_sessions SET status = 'COMPLETED', ended_at = NOW() WHERE id = $1`,
        [sessionId]
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Clean up delivered order GPS breadcrumbs.
   */
  public static async cleanupDeliveredGps(orderId: string): Promise<number> {
    try {
      const res = await query(
        `DELETE FROM navigation_points WHERE order_id = $1`,
        [orderId]
      );
      await query(
        `UPDATE navigation_sessions SET status = 'COMPLETED', ended_at = NOW() WHERE order_id = $1 AND status = 'ACTIVE'`,
        [orderId]
      );
      return res.rowCount || 0;
    } catch (err: any) {
      console.warn('[PostgresGpsService] Error cleaning delivered GPS:', err.message);
      return 0;
    }
  }

  /**
   * Automatic GPS Cleanup:
   * 1. Prunes temporary navigation points older than retentionMinutes (default: 5 min).
   * 2. Marks stale idle locations as offline (> 15 min with no ping) without deleting active-order locations.
   * 3. Prunes offline, non-active locations older than 24 hours.
   */
  public static async pruneStaleGpsData(retentionMinutes: number = 5): Promise<{
    prunedPoints: number;
    staleRidersMarkedOffline: number;
    expiredLocationsDeleted: number;
  }> {
    let prunedPoints = 0;
    let staleRidersMarkedOffline = 0;
    let expiredLocationsDeleted = 0;

    try {
      // 1. Prune temporary breadcrumbs older than retentionMinutes
      const cutoff = new Date(Date.now() - retentionMinutes * 60 * 1000);
      const ptRes = await query(
        `DELETE FROM navigation_points 
         WHERE created_at < $1 RETURNING id`,
        [cutoff]
      );
      prunedPoints = ptRes.rowCount || ptRes.rows?.length || 0;

      // 2. Mark idle online riders stale (> 15 minutes without location update, active_order_id IS NULL)
      const staleRes = await query(
        `UPDATE delivery_locations 
         SET online_status = false 
         WHERE online_status = true 
           AND active_order_id IS NULL 
           AND last_updated < NOW() - INTERVAL '15 minutes'`
      );
      staleRidersMarkedOffline = staleRes.rowCount || 0;

      // 3. Expire offline locations older than 24 hours that have NO active order
      const expRes = await query(
        `DELETE FROM delivery_locations 
         WHERE online_status = false 
           AND active_order_id IS NULL 
           AND last_updated < NOW() - INTERVAL '24 hours'`
      );
      expiredLocationsDeleted = expRes.rowCount || 0;

      return { prunedPoints, staleRidersMarkedOffline, expiredLocationsDeleted };
    } catch (err: any) {
      console.error('[PostgresGpsService] Cleanup failure:', err.message);
      return { prunedPoints, staleRidersMarkedOffline, expiredLocationsDeleted };
    }
  }

  /**
   * Spatial Candidate Discovery:
   * Fast indexed bounding-box query + Haversine distance in metres.
   * Enforces franchise/branch isolation, active shift, and location freshness.
   */
  public static async findNearbyEligibleRiders(params: {
    restaurantLat: number;
    restaurantLng: number;
    branchId: string;
    franchiseId?: string;
    maxRadiusMeters?: number;
    maxCandidates?: number;
    excludePartnerIds?: string[];
  }): Promise<Array<{
    uid: string;
    name: string;
    phone: string;
    latitude: number;
    longitude: number;
    distanceMeters: number;
    score: number;
    branchId: string;
    franchiseId: string;
    isStale: boolean;
  }>> {
    const {
      restaurantLat,
      restaurantLng,
      branchId,
      franchiseId,
      maxRadiusMeters = 15000, // 15 km max radius
      maxCandidates = 10,
      excludePartnerIds = []
    } = params;

    // Approximate bounding box in degrees (1 degree lat ~= 111.32 km)
    const latDelta = (maxRadiusMeters / 111320);
    const lngDelta = maxRadiusMeters / (111320 * Math.max(0.1, Math.cos((restaurantLat * Math.PI) / 180)));

    const minLat = restaurantLat - latDelta;
    const maxLat = restaurantLat + latDelta;
    const minLng = restaurantLng - lngDelta;
    const maxLng = restaurantLng + lngDelta;

    const queryParams: any[] = [
      branchId,
      minLat,
      maxLat,
      minLng,
      maxLng,
      restaurantLat,
      restaurantLng,
    ];

    let filterFranchiseClause = '';
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterFranchiseClause = ` AND p.franchise_id = $${queryParams.length}`;
    }

    let excludeClause = '';
    if (excludePartnerIds.length > 0) {
      queryParams.push(excludePartnerIds);
      excludeClause = ` AND p.id != ALL($${queryParams.length}::varchar[])`;
    }

    queryParams.push(maxCandidates);
    const limitIndex = queryParams.length;

    // Great-circle distance using standard PostgreSQL trigonometric functions in metres:
    // 6371000 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1)/2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1)/2), 2)))
    const sql = `
      SELECT p.id AS uid, p.name, p.phone, p.branch_id, p.franchise_id,
             l.latitude, l.longitude, l.accuracy, l.last_updated,
             (l.last_updated < NOW() - INTERVAL '5 minutes') AS is_stale,
             ROUND((
               6371000 * 2 * ASIN(SQRT(
                 POWER(SIN(RADIANS(l.latitude - $6) / 2), 2) +
                 COS(RADIANS($6)) * COS(RADIANS(l.latitude)) *
                 POWER(SIN(RADIANS(l.longitude - $7) / 2), 2)
               ))
             )::numeric, 0) AS distance_meters
      FROM delivery_partners p
      JOIN delivery_locations l ON l.delivery_partner_id = p.id
      WHERE p.branch_id = $1
        ${filterFranchiseClause}
        ${excludeClause}
        AND p.status = 'APPROVED'
        AND (p.is_online = true OR l.online_status = true)
        AND (p.active_order_id IS NULL OR p.active_order_id = '')
        AND (l.active_order_id IS NULL OR l.active_order_id = '')
        AND l.latitude BETWEEN $2 AND $3
        AND l.longitude BETWEEN $4 AND $5
        AND l.last_updated >= NOW() - INTERVAL '10 minutes'
      ORDER BY distance_meters ASC
      LIMIT $${limitIndex}
    `;

    try {
      const res = await query(sql, queryParams);
      return res.rows
        .filter((r: any) => Number(r.distance_meters) <= maxRadiusMeters)
        .map((r: any) => {
          const dist = Number(r.distance_meters);
          // Score formula: 10000 base minus distance penalty
          const score = Math.max(1000, 10000 - dist);
          return {
            uid: r.uid,
            name: r.name || 'Delivery Partner',
            phone: r.phone || '',
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
            distanceMeters: dist,
            score,
            branchId: r.branch_id,
            franchiseId: r.franchise_id,
            isStale: Boolean(r.is_stale),
          };
        });
    } catch (err: any) {
      console.error('[PostgresGpsService] Error discovering nearby riders:', err.message);
      return [];
    }
  }
}
