import { Router } from 'express';
import { checkPostgresHealth, pgPool } from '../config/postgres.js';
import { checkSupabaseHealth } from '../config/supabase.js';
import { adminDb, isFirebaseAdminAuthenticated } from '../config/firebase.js';
import { redisService } from '../services/redis/RedisService.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { execSync } from 'child_process';

const router = Router();

let cachedCommitHash: string | null = null;
let cachedBuildTimestamp: string | null = null;

// Lightweight in-memory demo keep-warm telemetry
const demoKeepWarmStats = {
  totalPings: 0,
  lastPingTimestamp: new Date().toISOString(),
  lastOrigin: 'initial',
  lastUserAgent: 'system'
};

// Dedicated Lightweight Demo Keep-Warm Endpoint (Instant 200 OK)
router.get('/health/ping', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Liveness Probe: Minimal status without disclosing process internals
router.get(['/health', '/health/liveness', '/live', '/api/live'], (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Version info
router.get('/version', (req, res) => {
  res.json({
    status: 'ok',
    api_version: 'v2.1.0'
  });
});

// In-memory 60s TTL cache for dependency health probes to protect external quotas
let cachedFirestoreProbe: { status: 'healthy' | 'unhealthy'; error?: string; expiresAt: number } | null = null;

/**
 * Readiness Probe:
 * Returns simple pass/fail status without exposing internal infrastructure topology or connection metrics.
 */
router.get(['/ready', '/health/readiness', '/api/ready'], async (req, res) => {
  let firestoreStatus = 'healthy';
  let postgresStatus = 'healthy';
  let redisStatus = 'healthy';
  let firestoreError: string | undefined;
  let postgresError: string | undefined;
  let redisError: string | undefined;

  const probeTimeoutMs = 10000;

  // Run all probes concurrently for rapid HAProxy health responses
  const [firestoreResult, postgresResult, redisResult] = await Promise.allSettled([
    // 1. Firestore Probe with quota-protective cache
    (async () => {
      if (cachedFirestoreProbe && Date.now() < cachedFirestoreProbe.expiresAt) {
        if (cachedFirestoreProbe.status === 'healthy') return 'healthy';
        throw new Error(cachedFirestoreProbe.error || 'Firestore probe failed');
      }

      if (!adminDb || !isFirebaseAdminAuthenticated) {
        const err = !isFirebaseAdminAuthenticated
          ? 'Firebase Admin unauthenticated: Missing valid service account credentials'
          : 'Firebase Admin DB instance not initialized';
        cachedFirestoreProbe = { status: 'unhealthy', error: err, expiresAt: Date.now() + 15000 };
        throw new Error(err);
      }

      try {
        await Promise.race([
          adminDb.collection('settings').limit(1).get(),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`Firestore probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs))
        ]);
        cachedFirestoreProbe = { status: 'healthy', expiresAt: Date.now() + 60000 };
        return 'healthy';
      } catch (err: any) {
        let errorMsg = err?.message || String(err);
        const isQuotaExhausted = err?.code === 8 || errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('Quota exceeded');
        if (isQuotaExhausted) {
          errorMsg = 'Firestore daily quota exhausted (Google Cloud Code 8 RESOURCE_EXHAUSTED: Daily Free Tier limit reached)';
        } else if (errorMsg.includes('timed out')) {
          errorMsg = `Firestore probe timed out after ${probeTimeoutMs}ms (Google Cloud latency or quota throttling)`;
        }
        const cacheTtlMs = isQuotaExhausted ? 300000 : 60000;
        cachedFirestoreProbe = { status: 'unhealthy', error: errorMsg, expiresAt: Date.now() + cacheTtlMs };
        throw new Error(errorMsg);
      }
    })(),

    // 2. PostgreSQL Probe
    (async () => {
      return Promise.race([
        pgPool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`PostgreSQL probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs))
      ]);
    })(),

    // 3. Redis Probe
    (async () => {
      const isRedisConfigured = Boolean(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.REDIS_HOST);
      if (isRedisConfigured || process.env.NODE_ENV === 'production' || process.env.REQUIRE_REDIS === 'true') {
        const pong = await Promise.race([
          redisService.ping(),
          new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error(`Redis probe timed out after ${probeTimeoutMs}ms`)), probeTimeoutMs))
        ]);
        if (!pong) {
          throw new Error('Redis ping did not return PONG');
        }
        return 'healthy';
      }
      return 'skipped';
    })()
  ]);

  if (firestoreResult.status === 'rejected') {
    firestoreStatus = 'unhealthy';
    firestoreError = firestoreResult.reason?.message || String(firestoreResult.reason);
  }

  if (postgresResult.status === 'rejected') {
    postgresStatus = 'unhealthy';
    postgresError = postgresResult.reason?.message || String(postgresResult.reason);
  }

  if (redisResult.status === 'rejected') {
    redisStatus = 'unhealthy';
    redisError = redisResult.reason?.message || String(redisResult.reason);
  } else if (redisResult.value === 'skipped') {
    redisStatus = 'skipped';
  }

  const isCriticalDataHealthy = firestoreStatus === 'healthy' && postgresStatus === 'healthy';
  const isRedisHealthy = redisStatus === 'healthy' || redisStatus === 'skipped';
  const isReady = isCriticalDataHealthy && isRedisHealthy;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    firestore: firestoreStatus,
    postgres: postgresStatus,
    redis: redisStatus,
    checks: {
      server: 'ready',
      firestore: firestoreStatus,
      postgres: postgresStatus,
      redis: redisStatus
    },
    errors: isReady ? undefined : { firestore: firestoreError, postgres: postgresError, redis: redisError },
    timestamp: new Date().toISOString()
  });
});

// Admin metrics endpoint
router.get('/metrics', requireAuth, requireRole(['owner', 'admin']), async (req, res) => {
  let client = null;
  const metrics: any = {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };

  try {
    client = await pgPool.connect();
    const dbSizeRes = await client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size;`);
    metrics.dbSize = dbSizeRes.rows[0]?.size || 'Unknown';

    const queueSizeRes = await client.query(`SELECT COUNT(*) as count FROM notification_queue;`);
    metrics.notificationQueueSize = parseInt(queueSizeRes.rows[0]?.count || '0', 10);

    res.json({ success: true, limited: false, metrics });
  } catch (error: any) {
    res.status(200).json({ success: true, limited: true, metrics, error: error.message });
  } finally {
    if (client) client.release();
  }
});

export default router;