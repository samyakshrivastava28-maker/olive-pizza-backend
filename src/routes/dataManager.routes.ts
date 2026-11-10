/**
 * dataManager.routes.ts — Data Manager & Multi-Database Orchestration API
 *
 * RESTRICTED TO: Authorized Developer & Owner RBAC
 *
 * Provides endpoints for:
 *  - System database overview & health aggregation
 *  - Provider registry & capability detection
 *  - Configured database listing with masked credentials
 *  - Live connectivity & latency testing
 *  - Safe role & data classification assignment
 *  - Capacity & overflow planning (non-destructive)
 *  - Metadata diagnostics (tables, collections, row counts)
 *  - Storage telemetry & historical rollups
 */

import express from 'express';
import { storageAnalyzer } from '../services/storageAnalyzer.service.js';
import { pgPool } from '../config/postgres.js';
import { DatabaseManagerService } from '../services/devOps/DatabaseManagerService.js';
import { DatabaseProviderRegistry } from '../services/devOps/DatabaseProviderRegistry.js';
import { requireDeveloper, DevRequest } from '../middleware/requireDeveloper.js';
import { verifyToken, requireRole } from '../middleware/auth.middleware.js';
import { DevAuditService } from '../services/devOps/DevAuditService.js';
import { expensiveLimiter, adminLimiter } from '../config/security.config.js';

const router = express.Router();

// Strict Authentication & Privilege Guard for all Data Manager routes
router.use(verifyToken);
router.use(requireRole(['owner', 'admin', 'developer', 'platform_owner']));

// ─── 1. Real-time Multi-Database Overview ────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const [storageOverview, multiDbOverview] = await Promise.all([
      storageAnalyzer.getOverview(force).catch(() => ({})),
      DatabaseManagerService.getOverview().catch(() => ({ databases: [], summary: {} })),
    ]);

    res.json({
      ...storageOverview,
      managedDatabases: multiDbOverview.databases || multiDbOverview.managedDatabases || [],
      systemSummary: multiDbOverview.summary || multiDbOverview.systemSummary || {},
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 2. Provider Capability Registry ─────────────────────────────────────────
router.get('/providers', (req, res) => {
  try {
    const providers = DatabaseProviderRegistry.getAll();
    res.json({ success: true, data: providers });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 3. List Configured Databases (Masked Credentials) ──────────────────────
router.get('/databases', async (req, res) => {
  try {
    const databases = await DatabaseManagerService.listDatabases();
    res.json({ success: true, data: databases });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 4. Test Connection (Live Latency & Capability Check) ────────────────────
router.post('/databases/test-connection', adminLimiter, async (req, res) => {
  try {
    const {
      providerId,
      connectionUri,
      baseUrl,
      apiKey,
      healthEndpoint,
      timeoutMs,
      projectId,
      databaseName,
      credentials,
    } = req.body;

    if (!providerId) {
      return res.status(400).json({ success: false, error: 'providerId is required.' });
    }

    const result = await DatabaseProviderRegistry.testProvider(providerId, {
      connectionUri,
      baseUrl,
      apiKey,
      healthEndpoint,
      timeoutMs: timeoutMs || 5000,
      projectId,
      databaseName,
      credentials: credentials || {},
    });

    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 4.1 Auto-Detect Provider Configuration ──────────────────────────────────
router.post('/providers/:id/auto-detect', adminLimiter, async (req, res) => {
  try {
    const providerId = req.params.id;
    const credentials = req.body.credentials || req.body || {};

    const result = await DatabaseProviderRegistry.autoDetectConfig(providerId, credentials);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 5. Add / Configure Database (Developer RBAC Guarded) ───────────────────
router.post('/databases', requireDeveloper, adminLimiter, async (req: DevRequest, res) => {
  try {
    const {
      id,
      name,
      providerId,
      category,
      connectionUri,
      baseUrl,
      healthEndpoint,
      currentRole,
      dataClassification,
      criticality,
      failoverAlternative,
    } = req.body;

    if (!id || !name || !providerId) {
      return res.status(400).json({ success: false, error: 'id, name, and providerId are required.' });
    }

    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await DatabaseManagerService.addDatabase(
      {
        id,
        name,
        providerId,
        category: category || 'sql',
        connectionUri,
        baseUrl,
        healthEndpoint,
        currentRole,
        dataClassification,
        criticality,
        failoverAlternative,
      },
      email
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 6. Update Database Role & Classification (Developer RBAC Guarded) ───────
router.put('/databases/:id/role', requireDeveloper, async (req: DevRequest, res) => {
  try {
    const { id } = req.params;
    const { currentRole, dataClassification, criticality, failoverAlternative } = req.body;

    if (!currentRole || !dataClassification || !criticality) {
      return res.status(400).json({
        success: false,
        error: 'currentRole, dataClassification, and criticality are required.',
      });
    }

    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await DatabaseManagerService.updateRole(
      id,
      currentRole,
      dataClassification,
      criticality,
      failoverAlternative || 'None',
      email
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 7. Remove / Deactivate Database (Developer RBAC Guarded) ────────────────
router.delete('/databases/:id', requireDeveloper, async (req: DevRequest, res) => {
  try {
    const { id } = req.params;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await DatabaseManagerService.removeDatabase(id, email);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 8. Safe Metadata Diagnostics ───────────────────────────────────────────
router.get('/databases/:id/diagnostics', async (req, res) => {
  try {
    const { id } = req.params;
    const diagnostics = await DatabaseManagerService.getDatabaseDiagnostics(id);
    res.json({ success: true, data: diagnostics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 9. Capacity & Overflow Planning Strategy ────────────────────────────────
router.get('/capacity-plan', async (req, res) => {
  try {
    const plan = await DatabaseManagerService.generateCapacityPlan();
    res.json({ success: true, data: plan });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 10. Audit Logs ──────────────────────────────────────────────────────────
router.get('/audit-logs', requireDeveloper, async (req: DevRequest, res) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const data = await DevAuditService.getLogs(limit, offset, 'db:');
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Existing Provider Usage Endpoints (Preserved for backward compatibility) ──
router.get('/firestore', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getFirestoreUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/supabase', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getSupabaseUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/cloudinary', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getCloudinaryUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/google-drive', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getDriveUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/qdrant', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getQdrantUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/email', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getEmailUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await storageAnalyzer.getNotificationUsage(force);
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history', async (req, res) => {
  try {
    const provider = req.query.provider as string;
    const client = await pgPool.connect();

    let query = 'SELECT * FROM storage_analytics ';
    let params: any[] = [];

    if (provider && provider !== 'all') {
      query += 'WHERE provider = $1 ';
      params.push(provider);
    }
    query += 'ORDER BY timestamp DESC LIMIT 50;';

    const result = await client.query(query, params);

    let dailyQuery = 'SELECT * FROM storage_analytics_daily ';
    if (provider && provider !== 'all') {
      dailyQuery += 'WHERE provider = $1 ';
    }
    dailyQuery += 'ORDER BY date DESC LIMIT 30;';
    const dailyResult = await client.query(dailyQuery, params);

    client.release();

    res.json({
      recent: result.rows.reverse(),
      daily: dailyResult.rows.reverse(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/app-storage', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const getDirSize = (dirPath: string): number => {
      if (!fs.existsSync(dirPath)) return 0;
      let totalSize = 0;
      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        if (item.isDirectory()) {
          totalSize += getDirSize(fullPath);
        } else {
          try {
            totalSize += fs.statSync(fullPath).size;
          } catch {}
        }
      }
      return totalSize;
    };

    const projectRoot = path.resolve(__dirname, '../../../../');
    const distPath = path.join(projectRoot, 'dist');
    const nodeModulesPath = path.join(projectRoot, 'node_modules');

    res.json({
      distSizeBytes: getDirSize(distPath),
      nodeModulesSizeBytes: getDirSize(nodeModulesPath),
      status: 'Healthy',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const logsDir = path.resolve(__dirname, '../../../logs');

    if (!fs.existsSync(logsDir)) {
      return res.json({ totalUsedBytes: 0, files: [] });
    }

    const files = fs.readdirSync(logsDir);
    let totalBytes = 0;
    const fileDetails = files.map((file) => {
      const stats = fs.statSync(path.join(logsDir, file));
      totalBytes += stats.size;
      return {
        name: file,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime,
      };
    });

    res.json({
      totalUsedBytes: totalBytes,
      files: fileDetails,
      status: 'Healthy',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
