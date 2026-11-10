import { query } from '../config/postgres.js';

export class OrderLockRepository {
  /**
   * Acquire a pessimistic lock on an order.
   * Returns true if lock was successfully acquired, false if already locked.
   */
  static async acquireLock(orderId: string, lockedBy: string, action: string = 'STATE_MUTATION'): Promise<boolean> {
    try {
      const res = await query(
        `INSERT INTO order_locks (order_id, locked_by, action, locked_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (order_id) DO NOTHING
         RETURNING order_id`,
        [orderId, lockedBy, action]
      );
      return res.rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Release lock on an order
   */
  static async releaseLock(orderId: string): Promise<boolean> {
    const res = await query(`DELETE FROM order_locks WHERE order_id = $1`, [orderId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Clear stale locks older than 60 seconds
   */
  static async clearStaleLocks(olderThanSeconds: number = 60): Promise<number> {
    const res = await query(
      `DELETE FROM order_locks WHERE locked_at < NOW() - ($1 || ' seconds')::INTERVAL`,
      [olderThanSeconds]
    );
    return res.rowCount ?? 0;
  }
}