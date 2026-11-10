import { query } from '../config/postgres.js';

export interface IdempotencyRecord {
  key: string;
  target_route: string;
  request_hash: string;
  response_code?: number | null;
  response_body?: any;
  status: 'IN_PROGRESS' | 'COMPLETED';
  created_at: Date;
  expires_at: Date;
}

export class IdempotencyRepository {
  /**
   * Try to acquire an idempotency lock. Returns true if acquired, false if key already exists.
   */
  static async acquireLock(key: string, route: string, requestHash: string, ttlSeconds: number = 300): Promise<boolean> {
    try {
      const res = await query(
        `INSERT INTO idempotency_keys (key, target_route, request_hash, status, created_at, expires_at)
         VALUES ($1, $2, $3, 'IN_PROGRESS', NOW(), NOW() + ($4 || ' seconds')::INTERVAL)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, route, requestHash, ttlSeconds]
      );
      return res.rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve cached response for an idempotency key
   */
  static async get(key: string): Promise<IdempotencyRecord | null> {
    const res = await query<IdempotencyRecord>(
      `SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
      [key]
    );
    return res.rows[0] || null;
  }

  /**
   * Save finalized response for an idempotency key
   */
  static async saveResponse(key: string, statusCode: number, responseBody: any): Promise<void> {
    await query(
      `UPDATE idempotency_keys
       SET response_code = $2,
           response_body = $3,
           status = 'COMPLETED'
       WHERE key = $1`,
      [key, statusCode, JSON.stringify(responseBody)]
    );
  }

  /**
   * Purge expired idempotency keys
   */
  static async purgeExpired(): Promise<number> {
    const res = await query(`DELETE FROM idempotency_keys WHERE expires_at <= NOW()`);
    return res.rowCount ?? 0;
  }
}