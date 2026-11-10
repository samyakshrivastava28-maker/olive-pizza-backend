/**
 * DistributedJobCoordinator.ts — Multi-Node Background Job Synchronization Engine
 *
 * In a horizontally scaled cluster behind HAProxy, multiple Node.js instances
 * execute identical node-cron schedules. Without coordination, each node would
 * redundantly send abandoned cart pushes, fire daily Google Sheets syncs,
 * build monthly PDF reports, or execute duplicate data retention cleanups.
 *
 * COORDINATION MECHANISM:
 * 1. Primary: Central Redis atomic mutex lock (SET key token NX EX ttl) with safe Lua release.
 * 2. Fallback: Central PostgreSQL transactionless advisory lock (pg_try_advisory_lock).
 * 3. Debouncing: Absorbs cross-node clock skew (e.g. 10-60s) so identical cron triggers only run once.
 */

import crypto from 'crypto';
import { redisService } from '../redis/RedisService.js';
import { pgPool } from '../../config/postgres.js';

export interface JobExecutionResult<T = any> {
  executed: boolean;
  result?: T;
  reason?: string;
  coordinator: 'redis' | 'postgres' | 'local_fallback';
  instanceId: string;
  durationMs?: number;
}

export class DistributedJobCoordinator {
  private static instance: DistributedJobCoordinator;
  public readonly instanceId: string;
  private readonly unlockLuaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor() {
    this.instanceId = process.env.APP_INSTANCE_ID || 
                      process.env.HOSTNAME || 
                      `node_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
    console.log(`[DistributedJobCoordinator] Initialized on instance: "${this.instanceId}"`);
  }

  public static getInstance(): DistributedJobCoordinator {
    if (!DistributedJobCoordinator.instance) {
      DistributedJobCoordinator.instance = new DistributedJobCoordinator();
    }
    return DistributedJobCoordinator.instance;
  }

  /**
   * Generates a deterministic 32-bit signed integer hash for Postgres advisory locks
   */
  private hashJobNameToNumber(jobName: string): number {
    let hash = 0;
    const str = `olive_job_lock_${jobName}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Executes a job with distributed mutual exclusion.
   * Lock is released as soon as the task finishes.
   */
  public async withJobLock<T = any>(
    jobName: string,
    ttlSeconds: number,
    fn: () => Promise<T>
  ): Promise<JobExecutionResult<T>> {
    const startTime = Date.now();
    const lockKey = `olive:locks:jobs:${jobName}`;
    const token = `${this.instanceId}:${Date.now()}:${crypto.randomUUID()}`;
    const redisClient = redisService.getClient();

    // ── ATTEMPT 1: Redis Mutex Lock ──────────────────────────────────────────
    if (redisService.isAvailable() && redisClient) {
      try {
        const acquired = await redisClient.set(lockKey, token, 'EX', ttlSeconds, 'NX');
        if (acquired === 'OK') {
          console.log(`[DistributedJobCoordinator] 🔒 Acquired Redis lock for job "${jobName}" on ${this.instanceId} (TTL: ${ttlSeconds}s)`);
          try {
            const res = await fn();
            return {
              executed: true,
              result: res,
              coordinator: 'redis',
              instanceId: this.instanceId,
              durationMs: Date.now() - startTime
            };
          } finally {
            try {
              await redisClient.eval(this.unlockLuaScript, 1, lockKey, token);
              console.log(`[DistributedJobCoordinator] 🔓 Released Redis lock for job "${jobName}" on ${this.instanceId}`);
            } catch (err: any) {
              console.warn(`[DistributedJobCoordinator] Redis lock release warning for "${jobName}":`, err.message);
            }
          }
        } else {
          console.log(`[DistributedJobCoordinator] ⏭️ Job "${jobName}" already locked by another cluster node. Skipping on ${this.instanceId}.`);
          return {
            executed: false,
            reason: 'LOCKED_BY_ANOTHER_NODE',
            coordinator: 'redis',
            instanceId: this.instanceId
          };
        }
      } catch (err: any) {
        console.warn(`[DistributedJobCoordinator] Redis lock error for "${jobName}", attempting PostgreSQL fallback:`, err.message);
      }
    }

    // ── ATTEMPT 2: PostgreSQL Advisory Lock Fallback ──────────────────────────
    let pgClient = null;
    const lockId = this.hashJobNameToNumber(jobName);
    try {
      pgClient = await pgPool.connect();
      const lockRes = await pgClient.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId]);
      const acquired = Boolean(lockRes.rows[0]?.acquired);

      if (acquired) {
        console.log(`[DistributedJobCoordinator] 🔒 Acquired PostgreSQL advisory lock for job "${jobName}" on ${this.instanceId}`);
        try {
          const res = await fn();
          return {
            executed: true,
            result: res,
            coordinator: 'postgres',
            instanceId: this.instanceId,
            durationMs: Date.now() - startTime
          };
        } finally {
          try {
            await pgClient.query('SELECT pg_advisory_unlock($1)', [lockId]);
            console.log(`[DistributedJobCoordinator] 🔓 Released PostgreSQL advisory lock for job "${jobName}" on ${this.instanceId}`);
          } catch (err: any) {
            console.warn(`[DistributedJobCoordinator] PG unlock notice for "${jobName}":`, err.message);
          }
        }
      } else {
        console.log(`[DistributedJobCoordinator] ⏭️ Job "${jobName}" locked via PostgreSQL by another node. Skipping on ${this.instanceId}.`);
        return {
          executed: false,
          reason: 'LOCKED_BY_ANOTHER_NODE',
          coordinator: 'postgres',
          instanceId: this.instanceId
        };
      }
    } catch (pgErr: any) {
      console.warn(`[DistributedJobCoordinator] PostgreSQL advisory lock error for "${jobName}":`, pgErr.message);
    } finally {
      if (pgClient) {
        try {
          pgClient.release();
        } catch {}
      }
    }

    // ── ATTEMPT 3: Local Fallback (Single-Node Dev Mode) ──────────────────────
    console.log(`[DistributedJobCoordinator] ⚠️ Operating in local execution mode for "${jobName}" on ${this.instanceId}`);
    const res = await fn();
    return {
      executed: true,
      result: res,
      coordinator: 'local_fallback',
      instanceId: this.instanceId,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Executes a periodic scheduled singleton job.
   * Holds the lock for the designated debounce window (e.g. 50-60s) to prevent
   * sister nodes from re-executing the same scheduled interval due to clock drift.
   */
  public async runScheduledSingleton<T = any>(
    jobName: string,
    debounceSeconds: number,
    fn: () => Promise<T>
  ): Promise<JobExecutionResult<T>> {
    const lockKey = `olive:locks:jobs:singleton:${jobName}`;
    const token = `${this.instanceId}:${Date.now()}:${crypto.randomUUID()}`;
    const redisClient = redisService.getClient();

    if (redisService.isAvailable() && redisClient) {
      try {
        const acquired = await redisClient.set(lockKey, token, 'EX', debounceSeconds, 'NX');
        if (acquired === 'OK') {
          console.log(`[DistributedJobCoordinator] 🔒 Acquired singleton window lock for "${jobName}" (${debounceSeconds}s debounce)`);
          const res = await fn();
          return {
            executed: true,
            result: res,
            coordinator: 'redis',
            instanceId: this.instanceId
          };
        } else {
          console.log(`[DistributedJobCoordinator] ⏭️ Singleton "${jobName}" already executed in this interval. Skipping on ${this.instanceId}.`);
          return {
            executed: false,
            reason: 'INTERVAL_ALREADY_EXECUTED',
            coordinator: 'redis',
            instanceId: this.instanceId
          };
        }
      } catch (err: any) {
        console.warn(`[DistributedJobCoordinator] Singleton Redis error for "${jobName}":`, err.message);
      }
    }

    // Fall back to standard mutual exclusion if singleton debounce via Redis is not available
    return this.withJobLock(jobName, debounceSeconds, fn);
  }
}

export const distributedJobCoordinator = DistributedJobCoordinator.getInstance();
