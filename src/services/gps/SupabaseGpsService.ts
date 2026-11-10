/**
 * SupabaseGpsService.ts — GPS Service Gateway (Delegated to Capacity-Safe RedisGpsService)
 * 
 * Complies with Redis Capacity-Safe Architecture:
 * 1. Layerbase Redis 7.2.15 is the authoritative store for live rider GPS telemetry,
 *    eliminating continuous PostgreSQL table bloat.
 * 2. Transparently forwards to RedisGpsService with backwards-compatible API contracts.
 */

import { RedisGpsService, GpsLocationPayload as RedisGpsPayload } from './RedisGpsService.js';

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
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
}

export class SupabaseGpsService {
  /**
   * Upsert the latest live GPS coordinate for a delivery partner into Redis GEO & presence.
   */
  public static async upsertLatestLocation(payload: GpsLocationPayload): Promise<{ success: boolean; error?: string }> {
    return RedisGpsService.updateLocation({
      deliveryPartnerId: payload.deliveryPartnerId,
      activeOrderId: payload.activeOrderId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy,
      speed: payload.speed,
      heading: payload.heading,
      onlineStatus: payload.onlineStatus !== false
    });
  }

  /**
   * Retrieve the latest GPS location for a specific delivery partner from Redis.
   */
  public static async getLatestLocation(deliveryPartnerId: string): Promise<any | null> {
    const loc = await RedisGpsService.getLatestLocation(deliveryPartnerId);
    if (!loc) return null;
    return {
      delivery_partner_id: loc.deliveryPartnerId,
      active_order_id: loc.activeOrderId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      online_status: loc.status === 'ONLINE',
      updated_at: loc.updatedAt,
      created_at: loc.updatedAt
    };
  }

  /**
   * Retrieve the latest GPS location for an active order from Redis.
   */
  public static async getLatestLocationByOrder(orderId: string): Promise<any | null> {
    const loc = await RedisGpsService.getLatestLocationByOrder(orderId);
    if (!loc) return null;
    return {
      delivery_partner_id: loc.deliveryPartnerId,
      active_order_id: loc.activeOrderId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      online_status: loc.status === 'ONLINE',
      updated_at: loc.updatedAt,
      created_at: loc.updatedAt
    };
  }

  /**
   * Retrieve all currently active live locations from Redis.
   */
  public static async getActiveLocations(scope?: { franchiseId?: string }): Promise<any[]> {
    const locs = await RedisGpsService.getActiveLocations(scope?.franchiseId || 'fra_primary');
    return locs.map(loc => ({
      delivery_partner_id: loc.deliveryPartnerId,
      active_order_id: loc.activeOrderId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      online_status: loc.status === 'ONLINE',
      updated_at: loc.updatedAt
    }));
  }

  public static async startNavigationSession(payload: NavigationSessionPayload): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  public static async appendNavigationPoint(payload: NavigationPointPayload): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  public static async endNavigationSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  public static async setActiveOrder(deliveryPartnerId: string, orderId: string): Promise<void> {
    await RedisGpsService.reassignOrder(orderId, null, deliveryPartnerId);
  }

  public static async clearActiveOrder(deliveryPartnerId: string, orderId?: string): Promise<void> {
    if (orderId) {
      await RedisGpsService.completeOrderTracking(orderId, deliveryPartnerId);
    }
  }

  public static async setOnlineStatus(deliveryPartnerId: string, onlineStatus: boolean): Promise<void> {
    if (!onlineStatus) {
      await RedisGpsService.removeRider('fra_primary', deliveryPartnerId);
    }
  }

  public static async pruneStaleNavigationPoints(retentionMinutes = 5): Promise<number> {
    const pruned = await RedisGpsService.pruneStaleRiders('fra_primary', retentionMinutes * 60);
    return pruned.length;
  }

  public static async cleanupDeliveredGps(orderId: string): Promise<void> {
    await RedisGpsService.completeOrderTracking(orderId);
  }
}
