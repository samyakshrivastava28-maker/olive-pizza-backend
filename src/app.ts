import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import orderRoutes from './routes/order.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { backgroundTaskWorker } from './services/background/BackgroundTaskWorker.js';
import aiRoutes from './routes/ai.routes.js';
import deliveryRoutes from './routes/delivery.routes.js';
import userRoutes from './routes/user.routes.js';
import menuRoutes from './routes/menu.routes.js';
import reportRoutes from './routes/report.routes.js';
import mediaRoutes from './routes/media.routes.js';
import couponRoutes from './routes/coupon.routes.js';
import trackingRoutes from './routes/tracking.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import authRoutes from './routes/auth.routes.js';
import heartbeatRoutes from './routes/heartbeat.routes.js';
import seoRoutes from './routes/seo.routes.js';
import versionRoutes from './routes/version.routes.js';
import githubRoutes from './routes/github.routes.js';
import phoneVerificationRoutes from './routes/phoneVerification.routes.js';
import devopsRoutes from './routes/devops.routes.js';
import ttsRoutes from './routes/tts.routes.js';
import locationRoutes from './routes/location.routes.js';
import { versionCheck } from './middleware/versionCheck.js';
import { verifyTurnstile } from './middleware/turnstile.middleware.js';
import { cloudflareEdgeSecurity } from './middleware/cloudflareSecurity.middleware.js';
import { 
  authLimiter, 
  otpLimiter, 
  publicLimiter, 
  userLimiter, 
  adminLimiter, 
  expensiveLimiter 
} from './config/security.config.js';
import { errorSanitizerMiddleware, sanitizeErrorDetails, generateReferenceId } from './middleware/errorSanitizer.middleware.js';
import { ApiSecurityMiddleware } from './security/index.js';

const app = express();
app.set('trust proxy', 1);

// ─── CLOUDFLARE EDGE CONTEXT & MALICIOUS SCANNER SHIELD ─────────────────────
app.use(cloudflareEdgeSecurity);

// ─── CENTRALIZED PRODUCTION ERROR SANITIZER & LEAK DEFENSE ────────────────────
app.use(errorSanitizerMiddleware);

// ─── PRODUCTION SECURITY HEADERS (HELMET + CLOUDFLARE EDGE HARDENING) ────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://apis.google.com", 
        "https://checkout.razorpay.com",
        "https://challenges.cloudflare.com", 
        "https://static.cloudflareinsights.com"
      ],
      frameSrc: [
        "'self'", 
        "https://checkout.razorpay.com",
        "https://api.razorpay.com",
        "https://mercury.phonepe.com",
        "https://challenges.cloudflare.com"
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:", "https://challenges.cloudflare.com"],
      imgSrc: [
        "'self'", 
        "data:", 
        "blob:", 
        "https://res.cloudinary.com", 
        "https://*.googleusercontent.com", 
        "https://tiles.openfreemap.org", 
        "https://*.cartocdn.com", 
        "https://*.tile.openstreetmap.org",
        "https://media.olivepizza.in"
      ],
      connectSrc: [
        "'self'", 
        "https://*.firebaseio.com", 
        "https://*.googleapis.com", 
        "https://*.supabase.co", 
        "wss://*.supabase.co", 
        "https://api.razorpay.com",
        "https://api.phonepe.com",
        "https://mercury.phonepe.com",
        "https://mercury-t2.phonepe.com",
        "https://integrate.api.nvidia.com", 
        "https://tiles.openfreemap.org", 
        "https://*.cartocdn.com", 
        "https://*.tile.openstreetmap.org",
        "https://challenges.cloudflare.com",
        "https://cloudflareinsights.com"
      ],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ─── SOURCE LEAK & REVERSE ENGINEERING PROTECTION ────────────────────────────
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const path = req.path.toLowerCase();
  if (
    path.endsWith('.ts') ||
    path.endsWith('.tsx') ||
    path.endsWith('.map') ||
    path.endsWith('.env') ||
    path.includes('/src/') ||
    path.includes('/.git') ||
    path.includes('/node_modules/') ||
    path.includes('/.agents')
  ) {
    return res.status(403).json({ success: false, error: 'Access forbidden', code: 'FORBIDDEN' });
  }
  next();
});

// ─── STRICT PRODUCTION & CLOUDFLARE CORS CONFIGURATION ───────────────────────
const isProduction = process.env.NODE_ENV === 'production';

const allowedOrigins = [
  'https://olivepizza.in',
  'https://www.olivepizza.in',
  'https://api.olivepizza.in',
  'https://owner.olivepizza.in',
  'https://franchise.olivepizza.in',
  'https://manager.olivepizza.in',
  'https://delivery.olivepizza.in',
  'https://pos.olivepizza.in',
  'https://media.olivepizza.in',
  'https://olive-pizza.vercel.app',
  'https://olive-pizza-backend.onrender.app',
  'https://olive-pizza-backend.onrender.com',
  'https://olivepizza-owner.onrender.com',
  'https://olive-pizza-ai-frontend.vercel.app',
  'https://olive-pizza-ai.onrender.com',
  'capacitor://localhost',
  'ionic://localhost',
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : [])
];

const devOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://localhost:5179',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://localhost',
  'http://127.0.0.1'
];

export function sanitizeUrlForLogging(rawUrl: string): string {
  if (!rawUrl) return '';
  return rawUrl.replace(
    /([?&](?:trackingToken|token|access_token|key|secret|password|idToken|auth)=)[^&]+/gi,
    '[REDACTED]'
  );
}

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // 1. Direct server-to-server, health checks, or native client with no origin header
    if (!origin) {
      return callback(null, true);
    }

    // 2. Official production allowed origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // 3. Strict HTTPS official subdomains of olivepizza.in or Vercel preview deployments
    if (
      /^https:\/\/([a-z0-9-]+\.)*olivepizza\.in$/.test(origin) ||
      /^https:\/\/olive-pizza(-[a-z0-9-]+)?\.vercel\.app$/.test(origin)
    ) {
      return callback(null, true);
    }

    // 4. Mobile app protocols (exact origins only, no prefix matching)
    if (origin === 'capacitor://localhost' || origin === 'ionic://localhost') {
      return callback(null, true);
    }

    // 5. Authorized local development origins (strictly excluded in production)
    if (!isProduction) {
      if (
        devOrigins.includes(origin) ||
        /^http:\/\/localhost:\d+$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
      ) {
        return callback(null, true);
      }
    }

    // Reject all other unknown origins safely
    callback(null, false);
  },
  credentials: true
});

app.use(corsMiddleware);

// Strict, justified request body size limits (defense-in-depth against payload flooding DoS)
app.use(express.json({
  limit: '2mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// API Performance & Correlation Tracker
app.use((req, res, next) => {
  const start = process.hrtime();
  const requestId = (req.headers['x-request-id'] as string) || `OP-REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  (req as any).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const elapsed = process.hrtime(start);
    const ms = (elapsed[0] * 1000) + (elapsed[1] / 1e6);
    console.log(`[API TRACE][${requestId}] ${req.method} ${req.originalUrl} -> HTTP ${res.statusCode} (${ms.toFixed(2)}ms)`);
  });
  next();
});
app.use(versionCheck);

// ─── CLOUDFLARE EDGE & CACHE-CONTROL MIDDLEWARE ────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Edge-Routing', 'Cloudflare-Canonical');
  
  // 1. Differentiated caching: Public catalog GET requests get short CDN caching; private/transactional endpoints are no-store
  const isPublicCatalogGet = req.method === 'GET' && (
    req.path.startsWith('/api/menu') ||
    req.path.startsWith('/api/products') ||
    req.path.startsWith('/api/categories') ||
    req.path.startsWith('/api/branches')
  );

  if (isPublicCatalogGet) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=180, stale-while-revalidate=300');
  } else if (
    req.path.startsWith('/api') || 
    req.path.startsWith('/orders') || 
    req.path.startsWith('/tracking') || 
    req.path.startsWith('/pos') ||
    req.path.startsWith('/payment') ||
    req.path.startsWith('/payments') ||
    req.path.startsWith('/auth')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  // 2. Shield private management applications from search engine indexing
  if (
    req.path.startsWith('/admin') ||
    req.path.startsWith('/franchises') ||
    req.path.startsWith('/restaurant-managers') ||
    req.path.startsWith('/pos') ||
    req.path.startsWith('/kitchen') ||
    req.path.startsWith('/devops')
  ) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }

  next();
});

import healthRoutes from './routes/health.routes.js';
import healthStreamRoutes from './routes/health.stream.routes.js';

// Direct core health & readiness probes
app.use('/', healthRoutes);
app.use('/api', healthRoutes);
app.use('/health', healthRoutes);
app.use('/health', healthStreamRoutes);

// Public SEO Routes (Sitemap & Robots)
app.use('/', seoRoutes);
app.use('/api', seoRoutes);

// ─── RATE LIMITING TIER ATTACHMENTS ──────────────────────────────────────────
app.use(['/auth', '/api/auth'], authLimiter);
app.use(['/phone', '/api/phone'], authLimiter);
app.use(['/phone/send-otp', '/api/phone/send-otp'], otpLimiter, verifyTurnstile);

app.use(['/menu', '/api/menu'], publicLimiter);
app.use(['/seo', '/api/seo'], publicLimiter);

app.use(['/orders', '/api/orders', '/api/order'], userLimiter);
app.use(['/users', '/api/users'], userLimiter);
app.use(['/tracking', '/api/tracking', '/api/v1/tracking'], userLimiter);

app.use(['/admin', '/api/admin'], adminLimiter);
app.use(['/delivery', '/api/delivery'], adminLimiter);
app.use(['/data-manager', '/api/data-manager'], adminLimiter);

app.use(['/ai', '/api/ai'], expensiveLimiter);
app.use(['/reports', '/api/reports'], expensiveLimiter);
app.use(['/google-drive', '/api/google-drive'], expensiveLimiter);
app.use(['/notifications/send-custom', '/api/notifications/send-custom'], expensiveLimiter);
app.use(['/tts', '/api/tts'], expensiveLimiter);

import emailRoutes from './routes/email.routes.js';
import googleDriveRoutes from './routes/googleDrive.routes.js';
import dataManagerRoutes from './routes/dataManager.routes.js';
import aiIntegrationRoutes from './routes/aiIntegration.routes.js';

app.use('/orders', orderRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/order', orderRoutes);

app.use('/api/integration/ai', aiIntegrationRoutes);
app.use('/api/ai/management', aiIntegrationRoutes);

app.use('/admin', adminRoutes);
app.use('/api/admin', adminRoutes);

import dashboardRoutes from './routes/dashboard.routes.js';

app.use('/dashboard', dashboardRoutes);
app.use('/api/dashboard', dashboardRoutes);

import aiImageRoutes from './routes/aiImage.routes.js';

app.use('/ai', aiRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/ai/image', aiImageRoutes);
app.use('/ai/image', aiImageRoutes);

import navigationRoutes from './routes/navigation.routes.js';

app.use('/delivery', deliveryRoutes);
app.use('/api/delivery', deliveryRoutes);

app.use('/navigation', navigationRoutes);
app.use('/api/navigation', navigationRoutes);

app.use('/users', userRoutes);
app.use('/api/users', userRoutes);
app.use('/user', userRoutes);
app.use('/api/user', userRoutes);

app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);

app.use('/menu', menuRoutes);
app.use('/products', menuRoutes);
app.use('/api/products', menuRoutes);
app.use('/categories', menuRoutes);
app.use('/api/categories', menuRoutes);
app.use('/looker', reportRoutes);
app.use('/api/looker', reportRoutes);
app.use('/api/menu', menuRoutes);

app.use('/reports', reportRoutes);
app.use('/api/reports', reportRoutes);

app.use('/notifications', notificationRoutes);
app.use('/api/notifications', notificationRoutes);

app.use('/media', mediaRoutes);
app.use('/api/media', mediaRoutes);

app.use('/coupons', couponRoutes);
app.use('/api/coupons', couponRoutes);

app.use('/tracking', trackingRoutes);
app.use('/api/tracking', trackingRoutes);

app.use('/email', emailRoutes);
app.use('/api/email', emailRoutes);

app.use('/heartbeat', heartbeatRoutes);
app.use('/api/heartbeat', heartbeatRoutes);

app.use('/version', versionRoutes);
app.use('/api/version', versionRoutes);

app.use('/github', githubRoutes);
app.use('/api/github', githubRoutes);

app.use('/phone', phoneVerificationRoutes);
app.use('/api/phone', phoneVerificationRoutes);
app.use('/truecaller', phoneVerificationRoutes);
app.use('/api/truecaller', phoneVerificationRoutes);
app.use('/auth/truecaller', phoneVerificationRoutes);
app.use('/api/auth/truecaller', phoneVerificationRoutes);
app.use('/api/v1/auth/truecaller', phoneVerificationRoutes);
app.use('/api/v1/auth/truecaller/callback', phoneVerificationRoutes);
app.use('/api/auth/truecaller/callback', phoneVerificationRoutes);
app.use('/auth/truecaller/callback', phoneVerificationRoutes);

app.use('/data-manager', dataManagerRoutes);
app.use('/api/data-manager', dataManagerRoutes);

app.use('/devops', devopsRoutes);
app.use('/api/devops', devopsRoutes);

import privacyRoutes from './routes/privacy.routes.js';
app.use('/privacy', privacyRoutes);
app.use('/api/privacy', privacyRoutes);

import financeRoutes from './routes/finance.routes.js';
app.use('/finance', financeRoutes);
app.use('/api/finance', financeRoutes);

app.use('/location', locationRoutes);
app.use('/api/location', locationRoutes);

import paymentRoutes from './routes/payment.routes.js';
import { PaymentReconciliationService } from './services/payment/PaymentReconciliationService.js';

app.use('/payment', paymentRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/payments', paymentRoutes);
app.use('/api/payments', paymentRoutes);

import ownerAIRoutes from './routes/ownerAI.routes.js';
import websiteAnalyticsRoutes from './routes/websiteAnalytics.routes.js';
import mediaLibraryRoutes from './routes/mediaLibrary.routes.js';

app.use('/owner-ai', ownerAIRoutes);
app.use('/api/owner-ai', ownerAIRoutes);

app.use('/website-analytics', websiteAnalyticsRoutes);
app.use('/api/website-analytics', websiteAnalyticsRoutes);

app.use('/media-library', mediaLibraryRoutes);
app.use('/api/media-library', mediaLibraryRoutes);

import homePageManagerRoutes from './routes/homePageManager.routes.js';
app.use('/home-page-manager', homePageManagerRoutes);
app.use('/api/home-page-manager', homePageManagerRoutes);
app.use('/homepage', homePageManagerRoutes);
app.use('/api/homepage', homePageManagerRoutes);

import restaurantRoutes from './routes/restaurant.routes.js';
import restaurantManagerRoutes from './routes/restaurantManager.routes.js';
import franchiseRoutes from './routes/franchise.routes.js';
import riderDeliveryRoutes from './routes/riderDelivery.routes.js';
import riderWorkScheduleRoutes from './routes/riderWorkSchedule.routes.js';
app.use('/delivery/rider/schedule', riderWorkScheduleRoutes);
app.use('/api/delivery/rider/schedule', riderWorkScheduleRoutes);
app.use('/delivery/rider', riderDeliveryRoutes);
app.use('/api/delivery/rider', riderDeliveryRoutes);
app.use('/api/rider-delivery', riderDeliveryRoutes);
app.use('/rider-delivery', riderDeliveryRoutes);
app.use('/franchises', franchiseRoutes);
app.use('/api/franchises', franchiseRoutes);
app.use('/franchise', franchiseRoutes);
app.use('/api/franchise', franchiseRoutes);
app.use('/restaurant-managers', restaurantManagerRoutes);
app.use('/api/restaurant-managers', restaurantManagerRoutes);
app.use('/restaurant', restaurantRoutes);
app.use('/api/restaurant', restaurantRoutes);

import knowledgeRoutes from './routes/knowledge.routes.js';
import posRoutes from './routes/pos.routes.js';
app.use('/knowledge', knowledgeRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/pos', posRoutes);
app.use('/api/pos', posRoutes);

import kitchenRoutes from './routes/kitchen.routes.js';
app.use('/kitchen', kitchenRoutes);
app.use('/api/kitchen', kitchenRoutes);

import deviceAlarmRoutes from './routes/deviceAlarm.routes.js';
app.use('/device', deviceAlarmRoutes);
app.use('/api/device', deviceAlarmRoutes);

// Start background payment reconciliation cron job
PaymentReconciliationService.startCronJob();

// Seed canonical organization, franchise, and branch documents (idempotent, merge-safe)
import { FranchiseSeedService } from './services/franchise/FranchiseSeedService.js';
FranchiseSeedService.seedDefaults().catch((e) =>
  console.warn('[Startup] FranchiseSeedService non-critical warning:', e)
);

// Start background Google Sheets sync worker
import { SheetsSyncWorker } from './services/reports/SheetsSyncWorker.js';
SheetsSyncWorker.startBackgroundWorker();

import appConfigRoutes from './routes/appConfig.routes.js';
app.use('/app-config', appConfigRoutes);
app.use('/api/app-config', appConfigRoutes);
app.use('/api/v1/app-config', appConfigRoutes);
app.use('/v1/app-config', appConfigRoutes);

import bootstrapRoutes from './routes/bootstrap.routes.js';
app.use('/api/v1', bootstrapRoutes);
app.use('/v1', bootstrapRoutes);

app.use('/tts', ttsRoutes);
app.use('/api/tts', ttsRoutes);

// 404 Handler - MUST return JSON to prevent HTML fallback for API routes
app.use((req: express.Request, res: express.Response) => {
  const requestId = (req as any).requestId || req.headers['x-request-id'] || 'UNKNOWN';
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`,
    code: 'NOT_FOUND',
    requestId,
    severity: 'info'
  });
});

// Global Error Handler - SANITIZES ALL ERRORS TO PRODUCTION-SAFE FORMAT
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const referenceId = generateReferenceId();
  const statusCode = typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
  
  // Log full raw error server-side for developers
  console.error(`[Global Error][${referenceId}][${new Date().toISOString()}][${req.method} ${req.url}]`, err);

  const sanitized = sanitizeErrorDetails(err, statusCode);

  res.status(statusCode).json({
    success: false,
    code: sanitized.code,
    message: sanitized.message,
    referenceId,
    ...(sanitized.retryAfter ? { retryAfter: sanitized.retryAfter, retryAfterSeconds: sanitized.retryAfter } : {}),
    // Backward compatibility fields
    error: sanitized.message,
    requestId: referenceId
  });
});

export default app;