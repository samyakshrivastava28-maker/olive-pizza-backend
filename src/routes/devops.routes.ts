/**
 * Express Router for Developer Operations (/devops)
 * Protected by requireDeveloper middleware.
 *
 * Exposes API endpoints for:
 *  1. Live All-System Health
 *  2. Multi-Database Manager
 *  3. Dynamic Visual Config Center & Feature Flags
 *  4. Notification Templates
 *  5. Email Template Manager
 *  6. AI Providers & Failover Vault
 *  7. Error Center & Stack Traces
 *  8. Scheduler & Cron Operations
 *  9. Immutable Audit Logs
 */

import { Router, Response } from 'express';
import { requireDeveloper, DevRequest } from '../middleware/requireDeveloper.js';
import { DevOpsService } from '../services/devOps/DevOpsService.js';
import { DevAuditService } from '../services/devOps/DevAuditService.js';
import { PlatformConfigService } from '../services/devOps/PlatformConfigService.js';
import { DatabaseManagerService } from '../services/devOps/DatabaseManagerService.js';
import { NotificationTemplateService } from '../services/devOps/NotificationTemplateService.js';
import { AIRoutingManagerService } from '../services/devOps/AIRoutingManagerService.js';
import { ErrorCenterService } from '../services/devOps/ErrorCenterService.js';
import { SchedulerManagerService } from '../services/devOps/SchedulerManagerService.js';
import { NotificationLogger } from '../services/notification/NotificationLogger.js';

const router = Router();

// Apply strict requireDeveloper guard to all /devops endpoints
router.use(requireDeveloper);

// ── 1. System Health ────────────────────────────────────────────────────────
router.get('/health', async (req: DevRequest, res: Response) => {
  try {
    const health = await DevOpsService.getSystemHealth();
    res.json({ success: true, data: health });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 2. Audit Logs ───────────────────────────────────────────────────────────
router.get('/audit-logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const search = (req.query.search as string) || '';
    const data = await DevAuditService.getLogs(limit, offset, search);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 3. Visual Config & Feature Flags ───────────────────────────────────────
router.get('/configs', async (req: DevRequest, res: Response) => {
  try {
    const configs = await PlatformConfigService.getAllConfigs();
    res.json({ success: true, data: configs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/configs', async (req: DevRequest, res: Response) => {
  try {
    const { key, valueJson, category } = req.body;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await PlatformConfigService.setConfig(key, valueJson, category || 'general', email, req.ip);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/configs/:key', async (req: DevRequest, res: Response) => {
  try {
    const { key } = req.params;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await PlatformConfigService.deleteConfig(key, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 4. Multi-Database Manager ───────────────────────────────────────────────
router.get('/databases', async (req: DevRequest, res: Response) => {
  try {
    const databases = await DatabaseManagerService.listDatabases();
    res.json({ success: true, data: databases });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/databases', async (req: DevRequest, res: Response) => {
  try {
    const { id, name, type, providerId, connectionUri, baseUrl, healthEndpoint, currentRole, dataClassification, criticality, failoverAlternative } = req.body;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await DatabaseManagerService.addDatabase({
      id: id || `${type}_${Date.now()}`,
      name: name || id,
      providerId: providerId || type || 'custom_rest_db',
      category: req.body.category || 'sql',
      connectionUri,
      baseUrl,
      healthEndpoint,
      currentRole,
      dataClassification,
      criticality,
      failoverAlternative
    }, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /devops/purge-job-logs
 * Permanently deletes old pg_cron job_run_details logs & realtime tracking logs from PostgreSQL.
 */
router.post('/purge-job-logs', async (_req: DevRequest, res: Response) => {
  try {
    const { dataLifecycleService } = await import('../services/DataLifecycleService.js');
    const result = await dataLifecycleService.purgePostgresLogsAndReclaimSpace();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /devops/test-alert
 * Sends a test developer alert email to webhub2811@gmail.com
 */
router.post('/test-alert', async (_req: DevRequest, res: Response) => {
  try {
    const result = await DevOpsService.sendTestDevAlert();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /devops/email-retry/:id
 * Retries a failed email by resetting its status to pending in email_queue
 */
router.post('/email-retry/:id', async (req: DevRequest, res: Response) => {
  try {
    const emailId = parseInt(req.params.id, 10);
    if (isNaN(emailId)) return res.status(400).json({ success: false, error: 'Invalid email ID' });
    const result = await DevOpsService.retryFailedEmail(emailId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 5. Notification Templates ──────────────────────────────────────────────
router.get('/notification-templates', async (req: DevRequest, res: Response) => {
  try {
    const templates = await NotificationTemplateService.listTemplates();
    res.json({ success: true, data: templates });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notification-templates', async (req: DevRequest, res: Response) => {
  try {
    const template = req.body;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await NotificationTemplateService.updateTemplate(template, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notifications/send-test', async (req: DevRequest, res: Response) => {
  try {
    const { targetUid, templateId } = req.body;
    const uid = targetUid || req.developer?.uid;
    const result = await NotificationTemplateService.sendTestNotification(uid, templateId || 'test');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 6. AI Providers Vault ───────────────────────────────────────────────────
router.get('/ai-providers', async (req: DevRequest, res: Response) => {
  try {
    const providers = await AIRoutingManagerService.listProviders();
    res.json({ success: true, data: providers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/ai-providers', async (req: DevRequest, res: Response) => {
  try {
    const provider = req.body;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await AIRoutingManagerService.saveProvider(provider, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 7. Error Center ─────────────────────────────────────────────────────────
router.get('/error-center', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const status = (req.query.status as string) || 'ALL';
    const data = await ErrorCenterService.listErrors(limit, offset, status);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/error-center/resolve/:id', async (req: DevRequest, res: Response) => {
  try {
    const errorId = parseInt(req.params.id, 10);
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await ErrorCenterService.resolveError(errorId, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 8. Scheduler & Crons ────────────────────────────────────────────────────
router.get('/scheduler/jobs', async (req: DevRequest, res: Response) => {
  try {
    const jobs = await SchedulerManagerService.listJobs();
    res.json({ success: true, data: jobs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/scheduler/jobs/trigger/:id', async (req: DevRequest, res: Response) => {
  try {
    const jobId = req.params.id;
    const email = req.developer?.email || 'webhub2811@gmail.com';
    const result = await SchedulerManagerService.triggerJobNow(jobId, email);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 9. Diagnostics & Legacy Endpoints ──────────────────────────────────────
router.get('/notifications/diagnostics', async (req: DevRequest, res: Response) => {
  try {
    const orderId = req.query.orderId as string | undefined;
    const diagnostics = await DevOpsService.getNotificationDiagnostics(orderId);
    res.json({ success: true, data: diagnostics });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notifications/logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const logs = NotificationLogger.getRecentLogs(limit);
    res.json({ success: true, data: logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notifications/pipeline-monitor', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const data = await DevOpsService.getNotificationPipelineMonitorData(limit);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/security-logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '100', 10);
    const logs = await DevOpsService.getSecurityLogs(limit);
    res.json({ success: true, data: logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/init-claim', async (req: DevRequest, res: Response) => {
  try {
    const result = await DevOpsService.ensureDeveloperClaim('webhub2811@gmail.com');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 10. AI Assistant Developer Operations & Diagnostics ────────────────────
import { aiOperationsStore } from '../services/devOps/AIOperationsService.js';
import { generateChatReply } from '../services/ai.service.js';
import { aiContextBuilder } from '../services/ai/AIContextBuilder.js';

router.get('/ai/health', async (_req: DevRequest, res: Response) => {
  try {
    const health = await aiOperationsStore.getHealth();
    res.json({ success: true, data: health });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ai/logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const role = (req.query.role as string) || 'all';
    const search = (req.query.search as string) || '';
    const logs = aiOperationsStore.getLogs(limit, offset, role, search);
    res.json({ success: true, data: logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ai/stats', async (_req: DevRequest, res: Response) => {
  try {
    const stats = aiOperationsStore.getStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/ai/playground', async (req: DevRequest, res: Response) => {
  try {
    const { message, enableRag, history, userRole } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    let kbContext = '';
    let contextRes: any = null;

    if (enableRag !== false) {
      contextRes = await aiContextBuilder.buildContextDetailed(message);
      kbContext = contextRes.contextStr;
    }

    const result = await generateChatReply(message, history || [], {
      kbContext,
      role: userRole || 'developer',
      isAuthenticated: true,
      route: '/developer/ai-playground',
    });

    res.json({
      success: true,
      data: {
        reply: result.reply,
        action: result.action,
        source: result.source,
        telemetry: result.telemetry,
        ragContext: contextRes,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 11. SMS Gateway & Image Gen Diagnostics ────────────────────────────────
router.get('/sms/logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const data = aiOperationsStore.getSmsLogs(limit, offset);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/sms/test', async (req: DevRequest, res: Response) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required' });
    const { phoneVerificationService } = await import('../services/phone-verification/PhoneVerificationService.js');
    const result = await phoneVerificationService.sendOtp(phone, 'devops-test-runner');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/image-gen/logs', async (req: DevRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const data = aiOperationsStore.getImageGenLogs(limit, offset);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

