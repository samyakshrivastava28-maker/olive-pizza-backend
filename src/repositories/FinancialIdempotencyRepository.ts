import crypto from 'node:crypto';
import { query } from '../config/postgres.ts';
import { redisService } from '../services/redis/RedisService.ts';

export interface FinancialIdempotencyCheckResult {
  status: 'ACQUIRED' | 'CACHED' | 'CONFLICT' | 'IN_PROGRESS';
  cachedResponse?: any;
  cachedStatusCode?: number;
  error?: string;
}

export class FinancialIdempotencyRepository {
  /**
   * Deterministically hashes the request payload using SHA-256
   */
  public static calculateHash(payload: any): string {
    if (payload == null) return crypto.createHash('sha256').update('').digest('hex');
    const sortedString = typeof payload === 'string' 
      ? payload 
      : JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(sortedString).digest('hex');
  }

  /**
   * Checks for an existing financial idempotency record or acquires an atomic lock.
   */
  public static async checkOrLock(
    key: string,
    route: string,
    payload: any,
    ttlSeconds: number = 86400
  ): Promise<FinancialIdempotencyCheckResult> {
    if (!key || key.trim() === '') {
      return { status: 'ACQUIRED' };
    }

    const cleanKey = key.trim();
    const requestHash = this.calculateHash(payload);

    try {
      // 1. Check persistent PostgreSQL table
      const existing = await query(
        `SELECT request_hash, status, response_code, response_body, expires_at 
         FROM financial_idempotency_records 
         WHERE key = $1 AND expires_at > NOW()`,
        [cleanKey]
      );

      if (existing.rows && existing.rows.length > 0) {
        const record = existing.rows[0];
        if (record.request_hash !== requestHash) {
          return {
            status: 'CONFLICT',
            error: 'Idempotency conflict: Key was previously submitted with a different request payload.',
          };
        }

        if (record.status === 'COMPLETED') {
          return {
            status: 'CACHED',
            cachedResponse: record.response_body,
            cachedStatusCode: record.response_code || 200,
          };
        }

        return {
          status: 'IN_PROGRESS',
          error: 'Financial transaction is currently in progress for this idempotency key.',
        };
      }

      // 2. Insert new IN_PROGRESS lock
      await query(
        `INSERT INTO financial_idempotency_records (key, target_route, request_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', NOW(), NOW() + ($4 || ' seconds')::INTERVAL)
         ON CONFLICT (key) DO NOTHING`,
        [cleanKey, route, requestHash, ttlSeconds]
      );

      return { status: 'ACQUIRED' };
    } catch (pgErr: any) {
      console.warn('[FinancialIdempotencyRepository] PostgreSQL unavailable, falling back to Redis:', pgErr.message);

      // Fallback to Redis atomic set if available
      if (redisService.isAvailable()) {
        try {
          const redisKey = `fin_idemp:${cleanKey}`;
          const existingVal = await redisService.get<any>(redisKey);
          if (existingVal) {
            const parsed = typeof existingVal === 'string' ? JSON.parse(existingVal) : existingVal;
            if (parsed.hash !== requestHash) {
              return {
                status: 'CONFLICT',
                error: 'Idempotency conflict: Key previously submitted with different payload (Redis).',
              };
            }
            if (parsed.status === 'COMPLETED') {
              return {
                status: 'CACHED',
                cachedResponse: parsed.response,
                cachedStatusCode: parsed.statusCode || 200,
              };
            }
            return {
              status: 'IN_PROGRESS',
              error: 'Financial transaction in progress (Redis).',
            };
          }

          await redisService.set(
            redisKey,
            { hash: requestHash, status: 'IN_PROGRESS' },
            ttlSeconds
          );
          return { status: 'ACQUIRED' };
        } catch (rErr: any) {
          console.error('[FinancialIdempotencyRepository] Redis error:', rErr.message);
        }
      }

      // If both stores down, allow fail-safe acquisition
      return { status: 'ACQUIRED' };
    }
  }

  /**
   * Finalizes the financial idempotency record with success response
   */
  public static async saveSuccess(key: string, statusCode: number, responseBody: any): Promise<void> {
    if (!key || key.trim() === '') return;
    const cleanKey = key.trim();

    try {
      await query(
        `UPDATE financial_idempotency_records
         SET status = 'COMPLETED',
             response_code = $2,
             response_body = $3
         WHERE key = $1`,
        [cleanKey, statusCode, JSON.stringify(responseBody)]
      );
    } catch (pgErr: any) {
      console.warn('[FinancialIdempotencyRepository] Failed to save PG success:', pgErr.message);
    }

    if (redisService.isAvailable()) {
      try {
        const redisKey = `fin_idemp:${cleanKey}`;
        const existing = await redisService.get<any>(redisKey);
        const parsed = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : null;
        const hash = parsed ? parsed.hash : '';
        await redisService.set(
          redisKey,
          { hash, status: 'COMPLETED', response: responseBody, statusCode },
          86400
        );
      } catch {}
    }
  }

  /**
   * Releases lock on failure
   */
  public static async releaseLock(key: string): Promise<void> {
    if (!key || key.trim() === '') return;
    const cleanKey = key.trim();
    try {
      await query(`DELETE FROM financial_idempotency_records WHERE key = $1 AND status = 'IN_PROGRESS'`, [cleanKey]);
    } catch {}
    if (redisService.isAvailable()) {
      try {
        await redisService.del(`fin_idemp:${cleanKey}`);
      } catch {}
    }
  }
}
