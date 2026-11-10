import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiApp, { corsMiddleware } from './app.js';
import { DataRetentionJob } from './jobs/DataRetentionJob';
import './services/DataLifecycleService';
import './services/notification/NotificationQueueService';
import { kb } from './services/KnowledgeBaseService';
import { storageAnalyzer } from './services/storageAnalyzer.service';
import { validateEnvironmentVariables } from './config/validator';
import { initScheduler } from './scripts/scheduler';
import { initPostgres } from './config/postgres';
import { FirestoreListener } from './listeners/firestore.listener';
import { initKeepAlive } from './scripts/keepAlive';
import { webSocketServer } from './services/websocket/WebSocketServer';

dotenv.config();

// Crash Resilience
process.on('uncaughtException', (err: any) => {
  console.error('[Owner Backend] Uncaught Exception:', err?.message || err);
});

process.on('unhandledRejection', (reason: any) => {
  console.warn('[Owner Backend] Unhandled Rejection:', reason?.message || reason);
});

validateEnvironmentVariables();

const app = express();
const PORT = process.env.PORT || 5000;

// Strict production-grade CORS configuration shared from app.ts
app.use(corsMiddleware);

// Enable trusted reverse proxy (NGINX / Cloudflare)
app.set('trust proxy', 1);

// ── HEALTH & HEARTBEAT ENDPOINTS ──────────────────────────────────────────────
// Liveness probe (process is running)
app.get(['/health/live', '/health/liveness'], (_req, res) => {
  res.status(200).json({
    status: 'UP',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Readiness probe (verifies PostgreSQL and Redis connectivity)
app.get(['/health/ready', '/health/readiness'], async (_req, res) => {
  let pgHealthy = false;
  let redisHealthy = false;

  try {
    const { pgPool } = await import('./config/postgres');
    const pgRes = await pgPool.query('SELECT 1 as healthy').catch(() => null);
    pgHealthy = pgRes != null && pgRes.rows.length > 0;
  } catch {}

  try {
    const { redisService } = await import('./services/redis/RedisService');
    redisHealthy = await redisService.ping();
  } catch {}

  const isRedisConfigured = Boolean(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.REDIS_HOST);
  const isRedisSatisfied = isRedisConfigured || process.env.NODE_ENV === 'production' || process.env.REQUIRE_REDIS === 'true'
    ? redisHealthy
    : true;
  const isReady = pgHealthy && isRedisSatisfied;
  const statusCode = isReady ? 200 : 503;

  res.status(statusCode).json({
    status: isReady ? 'READY' : 'DEGRADED',
    checks: {
      postgres: pgHealthy ? 'UP' : 'DOWN',
      redis: redisHealthy ? 'UP' : 'DOWN'
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// General info and legacy heartbeat aliases
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Olive Pizza Standalone Owner Backend',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get(['/api/heartbeat', '/heartbeat', '/ping'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Olive Pizza Owner Backend Service',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/keep-alive', (_req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Mount full API application
app.use('/api', apiApp);
app.use(apiApp);

// Initialize background schedulers, Postgres & Knowledge services
async function startServer() {
  await initPostgres().catch((err: any) => console.warn('[PostgreSQL] Init warning:', err?.message));
  initScheduler();
  DataRetentionJob.schedule();
  storageAnalyzer.startCronJobs();
  FirestoreListener.init();

  kb.initialize().catch((err: any) => console.warn('[KB] Non-fatal init error:', err?.message));

  try {
    const { KnowledgeSyncService } = await import('./services/knowledge/KnowledgeSyncService');
    KnowledgeSyncService.initializeSync();
  } catch (err: any) {
    console.warn('[KnowledgeSync] Warning:', err?.message);
  }

  const server = app.listen(Number(PORT), '0.0.0.0', async () => {
    console.log(`🍕 Olive Pizza Standalone Full Owner Backend running on http://localhost:${PORT}`);
    initKeepAlive();
    webSocketServer.attach(server);
    console.log('[WebSocketServer] Attached on path /ws');

    try {
      const { DevOtpBypassService } = await import('./services/phone-verification/DevOtpBypassService.js');
      if (DevOtpBypassService.isDevOtpBypassActive()) {
        console.log('⚡ Development OTP bypass: ENABLED (DEV_OTP_BYPASS=true) — Any non-empty OTP will pass in dev mode.');
      } else {
        console.log('🔒 Development OTP bypass: DISABLED (Production OTP verification active)');
      }
    } catch (e: any) {
      console.warn('[DevOtpBypass] Status check notice:', e?.message);
    }
  });

  // ── GRACEFUL SHUTDOWN HANDLER ──────────────────────────────────────────────
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[GracefulShutdown] Received ${signal}. Starting graceful termination sequence...`);

    // 1. Stop receiving new HTTP requests
    server.close(async () => {
      console.log('[GracefulShutdown] HTTP server stopped accepting new connections.');

      // 2. Close WebSocket connections
      try {
        webSocketServer.close();
        console.log('[GracefulShutdown] WebSocket connections closed.');
      } catch (wsErr: any) {
        console.warn('[GracefulShutdown] WS close notice:', wsErr?.message);
      }

      // 3. Stop background workers
      try {
        storageAnalyzer.stopCronJobs();
        console.log('[GracefulShutdown] Cron tasks stopped.');
      } catch {}

      // 4. Close Redis client
      try {
        const { redisService } = await import('./services/redis/RedisService');
        await redisService.disconnect();
        console.log('[GracefulShutdown] Redis client disconnected.');
      } catch (rErr: any) {
        console.warn('[GracefulShutdown] Redis disconnect notice:', rErr?.message);
      }

      // 5. Close PostgreSQL connection pool
      try {
        const { pgPool } = await import('./config/postgres');
        await pgPool.end();
        console.log('[GracefulShutdown] PostgreSQL connection pool drained.');
      } catch (pgErr: any) {
        console.warn('[GracefulShutdown] PostgreSQL pool close notice:', pgErr?.message);
      }

      console.log('[GracefulShutdown] Clean termination complete. Exiting with code 0.');
      process.exit(0);
    });

    // Force exit after 15 seconds if drain times out
    setTimeout(() => {
      console.error('[GracefulShutdown] Forceful exit triggered after 15s timeout.');
      process.exit(1);
    }, 15000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch(console.error);
