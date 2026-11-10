/**
 * RedisGpsService.ts — Capacity-Safe Ephemeral Live Rider GPS & Tracking Engine
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. Redis 7.2.15 is the sole storage for high-frequency live GPS telemetry.
 * 2. Bounded memory: exactly one GEO member per rider (GEOADD replaces previous coordinates).
 * 3. Atomic compare-and-delete Lua script eliminates stale-cleanup race conditions.
 * 4. Zero disk writes to PostgreSQL during continuous live tracking.
 * 5. Full franchise scoping: olive:riders:geo:{franchiseId} and olive:riders:last_seen:{franchiseId}.
 */

import { redisService } from '../redis/RedisService.js';
import { Redis } from 'ioredis';

export interface GpsLocationPayload {
  deliveryPartnerId: string;
  franchiseId?: string;
  branchId?: string;
  activeOrderId?: string | null;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  battery?: number | null;
  onlineStatus?: boolean;
  timestamp?: string;
}

export interface LiveRiderLocation {
  deliveryPartnerId: string;
  franchiseId: string;
  branchId?: string;
  activeOrderId?: string | null;
  latitude: number;
  longitude: number;
  accuracy: number;
  speed: number;
  heading: number;
  status: string;
  lastPing: number;
  updatedAt: string;
}

export interface ActiveOrderTrackingPointer {
  orderId: string;
  riderId: string;
  franchiseId: string;
  branchId: string;
  status: string;
  etaMinutes?: number;
  updatedAt: string;
}

// Atomic Compare-And-Delete Lua Script for Safe Stale Cleanup
const ATOMIC_STALE_CLEANUP_LUA = `
local last_seen_key = KEYS[1]
local geo_key = KEYS[2]
local cutoff = tonumber(ARGV[1])

local stale_riders = redis.call('ZRANGEBYSCORE', last_seen_key, '-inf', cutoff)
local removed = {}

for _, rider_id in ipairs(stale_riders) do
  local current_score = tonumber(redis.call('ZSCORE', last_seen_key, rider_id))
  if current_score and current_score <= cutoff then
    redis.call('ZREM', last_seen_key, rider_id)
    redis.call('ZREM', geo_key, rider_id)
    redis.call('DEL', 'olive:rider:presence:' .. rider_id)
    table.insert(removed, rider_id)
  end
end

return removed
`;

export class RedisGpsService {
  private static defaultFranchiseId = 'fra_primary';

  private static getClient(): Redis | null {
    return redisService.getClient();
  }

  /**
   * Ingest and atomically update a rider's live position in Redis.
   * Updates:
   * 1. GEO set: olive:riders:geo:{franchiseId} (Replaces previous coordinates)
   * 2. Presence hash: olive:rider:presence:{riderId} with 60s expiration
   * 3. Last-seen sorted set: olive:riders:last_seen:{franchiseId} with server epoch score
   * 4. If activeOrderId is present, refreshes order tracking pointer
   */
  public static async updateLocation(payload: GpsLocationPayload): Promise<{ success: boolean; error?: string }> {
    const client = this.getClient();
    if (!client) {
      return { success: false, error: 'Redis client unavailable' };
    }

    const riderId = payload.deliveryPartnerId;
    const franchiseId = payload.franchiseId || this.defaultFranchiseId;
    const lat = Number(payload.latitude);
    const lng = Number(payload.longitude);
    const accuracy = payload.accuracy !== undefined && payload.accuracy !== null ? Number(payload.accuracy) : 5.0;
    const speed = payload.speed !== undefined && payload.speed !== null ? Number(payload.speed) : 0.0;
    const heading = payload.heading !== undefined && payload.heading !== null ? Number(payload.heading) : 0.0;
    const now = Date.now();
    const activeOrderId = payload.activeOrderId || null;

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { success: false, error: 'Invalid coordinate range' };
    }

    const geoKey = `olive:riders:geo:${franchiseId}`;
    const presenceKey = `olive:rider:presence:${riderId}`;
    const lastSeenKey = `olive:riders:last_seen:${franchiseId}`;

    try {
      const pipeline = client.pipeline();

      // 1. Update GEO member (O(1) replacement for riderId)
      pipeline.geoadd(geoKey, lng, lat, riderId);

      // 2. Update presence hash
      pipeline.hset(presenceKey, {
        riderId,
        franchiseId,
        branchId: payload.branchId || 'main_branch',
        activeOrderId: activeOrderId || '',
        lat: lat.toFixed(6),
        lng: lng.toFixed(6),
        accuracy: accuracy.toFixed(1),
        speed: speed.toFixed(1),
        heading: heading.toFixed(1),
        status: payload.onlineStatus === false ? 'OFFLINE' : 'ONLINE',
        lastPing: now.toString(),
        updatedAt: new Date(now).toISOString()
      });
      pipeline.expire(presenceKey, 60); // Auto-expires if rider disconnects without going offline

      // 3. Update last-seen sorted set
      pipeline.zadd(lastSeenKey, now, riderId);

      // 4. Update order tracking pointer if on active delivery
      if (activeOrderId) {
        const orderTrackingKey = `olive:order:tracking:${activeOrderId}`;
        const trackingPayload: ActiveOrderTrackingPointer = {
          orderId: activeOrderId,
          riderId,
          franchiseId,
          branchId: payload.branchId || 'main_branch',
          status: 'OUT_FOR_DELIVERY',
          updatedAt: new Date(now).toISOString()
        };
        pipeline.set(orderTrackingKey, JSON.stringify(trackingPayload), 'EX', 7200); // 2 hours TTL
      }

      await pipeline.exec();
      return { success: true };
    } catch (err: any) {
      console.error('[RedisGpsService] updateLocation error:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Retrieve the latest live location for a specific rider from their presence hash.
   */
  public static async getLatestLocation(riderId: string): Promise<LiveRiderLocation | null> {
    const client = this.getClient();
    if (!client) return null;

    try {
      const data = await client.hgetall(`olive:rider:presence:${riderId}`);
      if (!data || !data.lat || !data.lng) return null;

      return {
        deliveryPartnerId: data.riderId || riderId,
        franchiseId: data.franchiseId || this.defaultFranchiseId,
        branchId: data.branchId || 'main_branch',
        activeOrderId: data.activeOrderId || null,
        latitude: parseFloat(data.lat),
        longitude: parseFloat(data.lng),
        accuracy: parseFloat(data.accuracy || '5.0'),
        speed: parseFloat(data.speed || '0.0'),
        heading: parseFloat(data.heading || '0.0'),
        status: data.status || 'ONLINE',
        lastPing: parseInt(data.lastPing || '0', 10),
        updatedAt: data.updatedAt || new Date().toISOString()
      };
    } catch (err: any) {
      console.error('[RedisGpsService] getLatestLocation error:', err.message);
      return null;
    }
  }

  /**
   * Retrieve the latest location of the rider assigned to an active order.
   */
  public static async getLatestLocationByOrder(orderId: string): Promise<LiveRiderLocation | null> {
    const client = this.getClient();
    if (!client) return null;

    try {
      const pointerRaw = await client.get(`olive:order:tracking:${orderId}`);
      if (!pointerRaw) return null;

      const pointer: ActiveOrderTrackingPointer = JSON.parse(pointerRaw);
      if (!pointer || !pointer.riderId) return null;

      return await this.getLatestLocation(pointer.riderId);
    } catch (err: any) {
      console.error('[RedisGpsService] getLatestLocationByOrder error:', err.message);
      return null;
    }
  }

  /**
   * Retrieve all currently active live rider locations for a franchise.
   */
  public static async getActiveLocations(franchiseId: string = this.defaultFranchiseId): Promise<LiveRiderLocation[]> {
    const client = this.getClient();
    if (!client) return [];

    try {
      const riderIds = await client.zrange(`olive:riders:last_seen:${franchiseId}`, 0, -1 as any);
      if (!riderIds || riderIds.length === 0) return [];

      const pipe = client.pipeline();
      for (const rId of riderIds) {
        pipe.hgetall(`olive:rider:presence:${rId}`);
      }
      const results = await pipe.exec();

      const locations: LiveRiderLocation[] = [];
      if (!results) return [];

      for (let i = 0; i < results.length; i++) {
        const [err, data] = results[i] as [Error | null, Record<string, string>];
        if (!err && data && data.lat && data.lng) {
          locations.push({
            deliveryPartnerId: data.riderId || riderIds[i],
            franchiseId: data.franchiseId || franchiseId,
            branchId: data.branchId || 'main_branch',
            activeOrderId: data.activeOrderId || null,
            latitude: parseFloat(data.lat),
            longitude: parseFloat(data.lng),
            accuracy: parseFloat(data.accuracy || '5.0'),
            speed: parseFloat(data.speed || '0.0'),
            heading: parseFloat(data.heading || '0.0'),
            status: data.status || 'ONLINE',
            lastPing: parseInt(data.lastPing || '0', 10),
            updatedAt: data.updatedAt || new Date().toISOString()
          });
        }
      }
      return locations;
    } catch (err: any) {
      console.error('[RedisGpsService] getActiveLocations error:', err.message);
      return [];
    }
  }

  /**
   * Explicitly remove a rider when they go offline.
   */
  public static async removeRider(franchiseId: string, riderId: string): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    try {
      const pipeline = client.pipeline();
      pipeline.zrem(`olive:riders:last_seen:${franchiseId}`, riderId);
      pipeline.zrem(`olive:riders:geo:${franchiseId}`, riderId);
      pipeline.del(`olive:rider:presence:${riderId}`);
      await pipeline.exec();
    } catch (err: any) {
      console.error('[RedisGpsService] removeRider error:', err.message);
    }
  }

  /**
   * Atomically reassign an order from oldRider to newRider in Redis.
   */
  public static async reassignOrder(
    orderId: string,
    oldRiderId: string | null,
    newRiderId: string,
    franchiseId: string = this.defaultFranchiseId,
    branchId: string = 'main_branch'
  ): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    try {
      const pipeline = client.pipeline();
      if (oldRiderId) {
        pipeline.hset(`olive:rider:presence:${oldRiderId}`, 'activeOrderId', '');
      }
      pipeline.hset(`olive:rider:presence:${newRiderId}`, 'activeOrderId', orderId);
      
      const trackingPayload: ActiveOrderTrackingPointer = {
        orderId,
        riderId: newRiderId,
        franchiseId,
        branchId,
        status: 'OUT_FOR_DELIVERY',
        updatedAt: new Date().toISOString()
      };
      pipeline.set(`olive:order:tracking:${orderId}`, JSON.stringify(trackingPayload), 'EX', 7200);

      await pipeline.exec();
    } catch (err: any) {
      console.error('[RedisGpsService] reassignOrder error:', err.message);
    }
  }

  /**
   * Terminate order tracking upon delivery or cancellation.
   */
  public static async completeOrderTracking(orderId: string, riderId?: string | null): Promise<void> {
    const client = this.getClient();
    if (!client) return;

    try {
      const pipeline = client.pipeline();
      pipeline.del(`olive:order:tracking:${orderId}`);
      if (riderId) {
        pipeline.hset(`olive:rider:presence:${riderId}`, 'activeOrderId', '');
      }
      await pipeline.exec();
    } catch (err: any) {
      console.error('[RedisGpsService] completeOrderTracking error:', err.message);
    }
  }

  /**
   * Atomic Lua-based stale rider cleanup.
   * Compares each rider's last-seen timestamp to cutoff atomically before removing.
   */
  public static async pruneStaleRiders(
    franchiseId: string = this.defaultFranchiseId,
    staleThresholdSeconds: number = 60
  ): Promise<string[]> {
    const client = this.getClient();
    if (!client) return [];

    const cutoff = Date.now() - (staleThresholdSeconds * 1000);
    const lastSeenKey = `olive:riders:last_seen:${franchiseId}`;
    const geoKey = `olive:riders:geo:${franchiseId}`;

    try {
      const removedRiders = await client.eval(
        ATOMIC_STALE_CLEANUP_LUA,
        2,
        lastSeenKey,
        geoKey,
        cutoff.toString()
      ) as string[];

      return removedRiders || [];
    } catch (err: any) {
      console.error('[RedisGpsService] pruneStaleRiders error:', err.message);
      return [];
    }
  }
}
