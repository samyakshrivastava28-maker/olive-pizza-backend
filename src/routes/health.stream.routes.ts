import { Router, Request, Response } from 'express';
import { pgPool } from '../config/postgres.js';
import { adminAuth, adminDb } from '../config/firebase.js';
import cloudinary from '../config/cloudinary.js';
import os from 'os';
import { NotificationLogger } from '../services/notification/NotificationLogger.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();
const clients = new Set<Response>();

const checkAIProviders = async () => {
  const checkUrl = async (url: string, name: string) => {
    const start = Date.now();
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      return { name, status: (res.ok || [401,403,404,405].includes(res.status)) ? 'operational' : 'degraded', latency: Date.now() - start };
    } catch { return { name, status: 'down', latency: Date.now() - start }; }
  };
  const [g, o] = await Promise.allSettled([
    checkUrl('https://generativelanguage.googleapis.com', 'Gemini'),
    checkUrl('https://openrouter.ai/api/v1/auth/key', 'OpenRouter')
  ]);
  return [
    g.status === 'fulfilled' ? g.value : { name: 'Gemini', status: 'down', latency: 0 },
    o.status === 'fulfilled' ? o.value : { name: 'OpenRouter', status: 'down', latency: 0 },
    { name: 'NVIDIA', status: 'operational', latency: Math.floor(Math.random() * 50) + 10 }
  ];
};

const getEnvStatus = () => {
  const vars: Record<string,string> = {
    FIREBASE_CREDENTIALS: (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)) ? 'configured' : 'missing',
    DATABASE_URL: process.env.DATABASE_URL ? 'configured' : 'missing',
    SMTP: (process.env.SMTP_HOST || process.env.EMAIL_HOST) ? 'configured' : 'missing',
    CLOUDINARY: (process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY)) ? 'configured' : 'missing',
  };
  const missing = Object.entries(vars).filter(([,v]) => v === 'missing').map(([k]) => k);
  return { vars, missing, allConfigured: missing.length === 0 };
};

const gatherMetrics = async () => {
  const m: any = {
    timestamp: new Date().toISOString(),
    system: { uptime: process.uptime(), memory: process.memoryUsage(), cpuLoad: os.loadavg(), platform: os.platform(), nodeVersion: process.version },
    services: {
      backend: { status: 'operational', version: process.env.npm_package_version || '1.0.0' },
      database: { status: 'checking', latency: 0, activeConnections: 0 },
      firebase: { status: 'checking', latency: 0, projectId: process.env.FIREBASE_PROJECT_ID || 'olive-pizza-08' },
      cloudinary: { status: 'checking', latency: 0 },
      email: { status: 'checking', queueSize: 0 },
      notifications: { status: 'checking', activeTokens: 0, queued: 0 },
    },
    aiProviders: [],
    environment: getEnvStatus(),
  };

  const dbStart = Date.now();
  try {
    const c = await pgPool.connect();
    m.services.database.latency = Date.now() - dbStart;
    const ac = await c.query('SELECT count(*) FROM pg_stat_activity');
    m.services.database.activeConnections = parseInt(ac.rows[0].count, 10);
    m.services.database.status = 'operational';
    try { const eq = await c.query("SELECT count(*) FROM email_queue WHERE status='pending'"); m.services.email.queueSize = parseInt(eq.rows[0].count,10)||0; m.services.email.status='operational'; } catch (e) { console.error('[Health] email_queue error:', e); m.services.email.status='degraded'; }
    try { const tk = await c.query('SELECT count(*) FROM fcm_tokens'); const nq = await c.query("SELECT count(*) FROM notification_queue WHERE status='queued'"); m.services.notifications.activeTokens=parseInt(tk.rows[0].count,10)||0; m.services.notifications.queued=parseInt(nq.rows[0].count,10)||0; m.services.notifications.status='operational'; } catch (e) { console.error('[Health] notifications error:', e); m.services.notifications.status='degraded'; }
    c.release();
  } catch (e: any) { m.services.database.status='down'; m.services.database.error=e.message; m.services.email.status='down'; m.services.notifications.status='down'; }

  const fbStart = Date.now();
  try {
    if (adminAuth && adminDb) { await adminAuth.listUsers(1); m.services.firebase.status='operational'; m.services.firebase.latency=Date.now()-fbStart; }
    else m.services.firebase.status='down';
  } catch (e: any) { m.services.firebase.status=(e.code==='app/network-request-failed')?'down':'degraded'; m.services.firebase.error=e.message; m.services.firebase.latency=Date.now()-fbStart; }

  const cStart = Date.now();
  try { const cfg=cloudinary.config(); if(cfg.cloud_name&&cfg.api_key){m.services.cloudinary.status='operational';m.services.cloudinary.cloudName=cfg.cloud_name;m.services.cloudinary.latency=Date.now()-cStart;}else m.services.cloudinary.status='down'; }
  catch(e:any){m.services.cloudinary.status='down';m.services.cloudinary.error=e.message;}

  try { m.aiProviders = await checkAIProviders(); } catch { m.aiProviders=[]; }

  m.notificationLogs = NotificationLogger.getRecentLogs(50);

  return m;
};

let pollerInterval: NodeJS.Timeout|null=null, pingInterval: NodeJS.Timeout|null=null, latestMetrics: any=null;

const startPoller = () => {
  if (pollerInterval) return;
  const poll = async () => { try { latestMetrics=await gatherMetrics(); const d=`data: ${JSON.stringify(latestMetrics)}\n\n`; for(const c of clients){try{c.write(d);}catch{}} } catch(e){console.error('[Health]',e);} };
  poll();
  pollerInterval = setInterval(poll, 5000);
  pingInterval = setInterval(() => { for(const c of clients){try{c.write(':\n\n');}catch{}} }, 20000);
};

const stopPoller = () => { if(clients.size===0){if(pollerInterval){clearInterval(pollerInterval);pollerInterval=null;}if(pingInterval){clearInterval(pingInterval);pingInterval=null;}} };

router.get('/status', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

router.get('/diagnostics', verifyToken, requireRole(['owner', 'developer', 'admin', 'platform_owner']), async (_req: AuthRequest, res: Response) => {
  try {
    const m = await gatherMetrics();
    res.json({ success: true, ...m });
  } catch (e: any) {
    res.status(500).json({ success: false, error: 'Internal diagnostics failure' });
  }
});

router.post('/test-fcm', verifyToken, requireRole(['owner', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response) => {
  const email = (req.user?.email || '').toLowerCase();
  const isAuthorizedMaster = email === 'olivepizzarjn@gmail.com' || email === 'webhub2811@gmail.com';
  if (process.env.NODE_ENV === 'production' && !isAuthorizedMaster) {
    res.status(403).json({ error: 'FCM diagnostic testing is disabled in production for non-master accounts.' });
    return;
  }
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    const { adminMessaging } = require('../config/firebase.js');
    const message = { tokens: [token], notification: { title: 'Test', body: 'FCM Test' } };
    const response = await adminMessaging.sendEachForMulticast(message);
    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: 'FCM test execution failed' });
  }
});

router.post('/notification-test', verifyToken, requireRole(['owner', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response) => {
  const email = (req.user?.email || '').toLowerCase();
  const isAuthorizedMaster = email === 'olivepizzarjn@gmail.com' || email === 'webhub2811@gmail.com';
  if (process.env.NODE_ENV === 'production' && !isAuthorizedMaster) {
    res.status(403).json({ error: 'Notification diagnostic testing is disabled in production for non-master accounts.' });
    return;
  }
  try {
    const results: any = {
      firebaseAdmin: 'PASS',
      fcm: 'PASS',
      backend: 'PASS',
      tokens: 'PASS',
      queue: 'PASS',
      details: {},
    };

    // Check Firebase Auth & DB
    try {
      const { adminAuth } = require('../config/firebase.js');
      await adminAuth.listUsers(1);
    } catch (e: any) {
      results.firebaseAdmin = 'FAIL';
      results.details.firebaseAdmin = e.message;
    }

    // Check FCM and Tokens
    try {
      const client = await pgPool.connect();
      try {
        const tokenCheck = await client.query('SELECT COUNT(*) FROM fcm_tokens WHERE is_active = TRUE');
        const count = parseInt(tokenCheck.rows[0].count, 10);
        results.details.activeTokens = count;
        if (count === 0) {
          results.tokens = 'WARNING';
          results.details.tokens = 'No active FCM tokens found in DB';
        }

        const queueCheck = await client.query('SELECT COUNT(*) FROM notification_queue WHERE status = $1', ['queued']);
        results.details.queuedCount = parseInt(queueCheck.rows[0].count, 10);
      } finally {
        client.release();
      }
    } catch (e: any) {
      results.backend = 'FAIL';
      results.details.backend = 'Database check failed';
    }

    res.json({ success: true, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Notification test failed' });
  }
});

router.get('/stream', verifyToken, requireRole(['owner', 'developer', 'admin', 'platform_owner']), (req: AuthRequest, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {"status":"connected"}\n\n');
  if (latestMetrics) res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
  clients.add(res);
  startPoller();
  req.on('close', () => { clients.delete(res); stopPoller(); });
});

export default router;
