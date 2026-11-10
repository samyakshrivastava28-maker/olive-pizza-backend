import './src/config/env.ts';
import express from 'express';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import apiApp, { corsMiddleware } from './src/app.ts';
import healthRoutes from './src/routes/health.routes.ts';
import { DataRetentionJob } from './src/jobs/DataRetentionJob.ts';
import './src/services/DataLifecycleService.ts';
import './src/services/notification/NotificationQueueService.ts';
import './src/jobs/MonthlyReportJob.ts';
import { kb } from './src/services/KnowledgeBaseService.ts';
import { storageAnalyzer } from './src/services/storageAnalyzer.service.ts';
import { validateEnvironmentVariables } from './src/config/validator.ts';
import { initScheduler } from './src/scripts/scheduler.ts';
import { initPostgres, pgPool } from './src/config/postgres.ts';
import { adminDb } from './src/config/firebase.ts';
import { FirestoreListener } from './src/listeners/firestore.listener.ts';
import { initKeepAlive } from './src/scripts/keepAlive.ts';
import { webSocketServer } from './src/services/websocket/WebSocketServer.ts';
import { AIHeartbeatJob } from './src/jobs/AIHeartbeatJob.ts';
import { AiHealthMonitorService } from './src/services/AiHealthMonitorService.ts';
import { SheetsSyncWorker } from './src/services/reports/SheetsSyncWorker.ts';
import { startGrpcServer } from './src/grpc/grpcServer.ts';
import { OrderFulfillmentWorker } from './src/services/delivery/OrderFulfillmentWorker.ts';

dotenv.config();

// Crash Resilience
process.on('uncaughtException', (err: any) => {
  console.error('[Process] Uncaught Exception:', err?.message || err);
});

process.on('unhandledRejection', (reason: any) => {
  console.warn('[Process] Unhandled Rejection:', reason?.message || reason);
});

validateEnvironmentVariables();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(corsMiddleware);
app.use(healthRoutes);
app.use('/api', healthRoutes);
/* legacy */ app.get(['/legacy-health-unused'], (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString()
  });
});

/* legacy */ app.get(['/legacy-ready-unused'], async (req, res) => {
  let firestoreStatus = 'healthy';
  let postgresStatus = 'healthy';
  let firestoreError: string | undefined;
  let postgresError: string | undefined;

  try {
    await Promise.race([
      adminDb.collection('settings').limit(1).get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore probe timed out after 10000ms')), 10000))
    ]);
  } catch (e: any) {
    firestoreStatus = 'unhealthy';
    firestoreError = e.message;
  }

  try {
    await Promise.race([
      pgPool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PostgreSQL probe timed out after 5000ms')), 5000))
    ]);
  } catch (e: any) {
    postgresStatus = 'unhealthy';
    postgresError = e.message;
  }

  const isReady = firestoreStatus === 'healthy' && postgresStatus === 'healthy';
  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    firestore: firestoreStatus,
    postgres: postgresStatus,
    checks: {
      server: 'ready',
      firestore: firestoreStatus,
      postgres: postgresStatus
    },
    errors: isReady ? undefined : { firestore: firestoreError, postgres: postgresError },
    timestamp: new Date().toISOString()
  });
});

app.get(['/', '/api/heartbeat', '/heartbeat'], (req, res) => {
  res.json({
    status: 'ok',
    service: 'Olive Pizza Canonical Owner Backend Service',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.head('/', (req, res) => {
  res.status(200).end();
});

// Initialize Storage Analyzer Cron Jobs
storageAnalyzer.startCronJobs();

app.get('/keep-alive', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});

import { executeGraphQL } from './src/graphql/index.ts';
import { adminAuth } from './src/config/firebase.ts';
import { AUTHORIZED_INTERNAL_EMAILS } from './src/security/SecurityContext.ts';

// GraphQL Rate Limiter (Max 120 queries per minute per IP)
const graphqlRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { errors: [{ message: 'Too many GraphQL requests. Please try again later.' }] },
  standardHeaders: true,
  legacyHeaders: false
});

// GraphQL Endpoint mounting with 100kb body limit, rate limiting and query validation
app.use(['/graphql', '/api/graphql'], graphqlRateLimiter, express.json({ limit: '100kb' }), async (req, res) => {
  const authHeader = req.headers.authorization;
  let user: any = null;
  let isOwner = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1].trim();
    try {
      const decoded = await adminAuth.verifyIdToken(token, true);
      if (decoded) {
        const email = (decoded.email || '').toLowerCase().trim();
        let isActive = true;
        let role = decoded.role || 'customer';
        let franchiseId = decoded.franchiseId || null;
        let branchId = decoded.branchId || null;

        try {
          const userDoc = await adminDb.collection('users').doc(decoded.uid).get();
          if (userDoc.exists) {
            const uData = userDoc.data() || {};
            if (uData.isActive === false || uData.status === 'REVOKED' || uData.status === 'suspended' || uData.status === 'disabled' || uData.isBlocked === true) {
              isActive = false;
            }
            if (uData.role) role = uData.role;
            if (uData.franchiseId) franchiseId = uData.franchiseId;
            if (uData.branchId) branchId = uData.branchId;
          }
        } catch {
          // If Firestore is temporarily unreachable, fallback to verified token claims
        }

        if (isActive) {
          isOwner = AUTHORIZED_INTERNAL_EMAILS.includes(email) || role === 'owner' || role === 'platform_owner' || role === 'admin' || role === 'developer';
          user = {
            uid: decoded.uid,
            email,
            role,
            franchiseId,
            branchId
          };
        }
      }
    } catch {
      // Unauthenticated or revoked token attempt
    }
  }

  const { query: gqlQuery, variables } = req.body || {};
  if (!gqlQuery || typeof gqlQuery !== 'string' || gqlQuery.trim().length === 0) {
    res.status(400).json({ errors: [{ message: 'GraphQL query is required in request body.' }] });
    return;
  }

  if (gqlQuery.length > 10000) {
    res.status(400).json({ errors: [{ message: 'GraphQL query exceeds maximum allowed query length.' }] });
    return;
  }

  try {
    const result = await executeGraphQL(gqlQuery, variables, { user, isOwner });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ errors: [{ message: err.message || 'Internal GraphQL execution error' }] });
  }
});
console.log('[GraphQL] Unified GraphQL API mounted on /graphql and /api/graphql with rate limiting');

app.use('/api', apiApp);
app.use(apiApp);

// Start server on configured port (default: 5175 in dev)
const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`⚡ Olive Pizza Canonical Backend Server running on http://localhost:${PORT}`);
  initKeepAlive();
  webSocketServer.attach(server);
  console.log('[WebSocketServer] Attached on path /ws');

  // Asynchronous background boots
  (async () => {
    startGrpcServer().catch((err: any) => console.error('[gRPC Server] Startup failure:', err?.message));
    initPostgres().catch((err: any) => console.warn('[PostgreSQL] Init warning:', err?.message));
    initScheduler();
    DataRetentionJob.schedule();
    AIHeartbeatJob.schedule();
    AiHealthMonitorService.start();
    SheetsSyncWorker.startBackgroundWorker(60000);

    kb.initialize().catch(err => console.warn('[KB] Non-fatal init error:', err.message));
    try {
      const { KnowledgeSyncService } = await import('./src/services/knowledge/KnowledgeSyncService.ts');
      KnowledgeSyncService.initializeSync();
    } catch (err: any) {
      console.warn('[KnowledgeSync] Initialization warning:', err.message);
    }

    FirestoreListener.init();
    OrderFulfillmentWorker.start();

    // Archival safeguard & reconciliation worker (runs every 3 minutes)
    setInterval(() => {
      import('./src/services/order/OrderPersistenceArchiveService.js')
        .then(({ OrderPersistenceArchiveService }) => {
          OrderPersistenceArchiveService.reconcileArchivalWorker().catch(e => 
            console.warn('[OrderPersistence] Background reconciliation notice:', e.message)
          );
        })
        .catch(() => {});
    }, 3 * 60 * 1000);
  })();
});

export default app;
