/**
 * FCMTokenCache — Server-Side FCM Token Cache
 *
 * Caches FCM tokens per Firebase UID with a 5-minute TTL.
 * Reduces PostgreSQL reads per notification by ~90% for active users.
 *
 * Features:
 *  - TTL: 5 minutes per entry
 *  - Automatic invalidation on invalid token FCM errors
 *  - Refresh after expiration (fallback to PostgreSQL)
 *  - Cleanup of expired entries every 10 minutes
 */

import { pgPool } from '../../config/postgres.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

interface CacheEntry {
  tokens: string[];
  fetchedAt: number;
}

class FCMTokenCache {
  private cache = new Map<string, CacheEntry>();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    // Periodic cleanup of stale entries
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    console.log('[FCMTokenCache] Initialized with 5-minute TTL');
  }

  /**
   * Get active FCM tokens for a Firebase UID.
   * Returns cache if fresh, otherwise fetches from PostgreSQL.
   * @param userId Firebase UID
   * @returns Array of active token strings (may be empty)
   * @returns { tokens, source } with source = 'cache' | 'db'
   */
  async get(userId: string): Promise<{ tokens: string[]; source: 'cache' | 'db' }> {
    const entry = this.cache.get(userId);

    // Cache hit and fresh
    if (entry && Date.now() - entry.fetchedAt < TTL_MS) {
      return { tokens: entry.tokens, source: 'cache' };
    }

    // Cache miss or stale — fetch from DB
    const tokens = await this.fetchFromDb(userId);
    this.cache.set(userId, { tokens, fetchedAt: Date.now() });
    return { tokens, source: 'db' };
  }

  /**
   * Invalidate specific tokens for a user (called after FCM invalid-token errors).
   * Removes the invalid tokens from the cache and marks them inactive in the DB.
   * @param userId Firebase UID
   * @param invalidTokens Tokens that returned invalid-registration-token errors
   */
  async invalidate(userId: string, invalidTokens: string[]): Promise<void> {
    if (invalidTokens.length === 0) return;

    // Update cache entry to remove invalidated tokens
    const entry = this.cache.get(userId);
    if (entry) {
      entry.tokens = entry.tokens.filter(t => !invalidTokens.includes(t));
      this.cache.set(userId, entry);
    }

    // Mark tokens inactive in DB (fire and forget — non-blocking)
    pgPool.query(
      `UPDATE fcm_tokens SET is_active = FALSE WHERE user_id = $1 AND token = ANY($2)`,
      [userId, invalidTokens]
    ).catch(err => console.error('[FCMTokenCache] Failed to invalidate tokens in DB:', err));

    console.log(`[FCMTokenCache] Invalidated ${invalidTokens.length} tokens for user ${userId}`);
  }

  /**
   * Force-refresh cache for a user (called after token registration).
   */
  async refresh(userId: string): Promise<void> {
    const tokens = await this.fetchFromDb(userId);
    this.cache.set(userId, { tokens, fetchedAt: Date.now() });
    console.log(`[FCMTokenCache] Refreshed cache for user ${userId}: ${tokens.length} tokens`);
  }

  /**
   * Remove a user from the cache entirely.
   */
  evict(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * Returns cache statistics for diagnostics.
   */
  stats(): { size: number; entries: { userId: string; tokenCount: number; ageMs: number }[] } {
    const now = Date.now();
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.entries()).map(([userId, entry]) => ({
        userId,
        tokenCount: entry.tokens.length,
        ageMs: now - entry.fetchedAt,
      })),
    };
  }

  private async fetchFromDb(userId: string): Promise<string[]> {
    try {
      const result = await pgPool.query(
        `SELECT token FROM fcm_tokens WHERE user_id = $1 AND is_active = TRUE ORDER BY last_used_at DESC LIMIT 10`,
        [userId]
      );
      return result.rows.map((r: { token: string }) => r.token);
    } catch (err) {
      console.error(`[FCMTokenCache] DB fetch failed for ${userId}:`, err);
      return [];
    }
  }

  public cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [userId, entry] of this.cache.entries()) {
      if (now - entry.fetchedAt > TTL_MS * 2) {
        this.cache.delete(userId);
        evicted++;
      }
    }
    if (evicted > 0) {
      console.log(`[FCMTokenCache] Cleanup: evicted ${evicted} stale entries, ${this.cache.size} remaining`);
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }
}

export const fcmTokenCache = new FCMTokenCache();
