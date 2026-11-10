import { Router, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware.js';
import { MonthlyReportNotificationService, ReportScope } from '../services/reports/MonthlyReportNotificationService.js';
import { CloudflareReportService } from '../services/reports/CloudflareReportService.js';
import { MonthlyReportGenerator } from '../services/reports/MonthlyReportGenerator.js';
import { CloudflareR2Service } from '../services/storage/CloudflareR2Service.js';
import { GoogleSheetsReportService } from '../services/reports/GoogleSheetsReportService.js';
import { MonthlyPdfReportService } from '../services/reports/MonthlyPdfReportService.js';
import { GoogleSheetsMonthlyReportService } from '../services/reports/GoogleSheetsMonthlyReportService.js';
import { SalesCalculationEngine } from '../services/reports/SalesCalculationEngine.js';
import { pgPool, query } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { ReportExportService } from '../services/reports/ReportExportService.js';
import { FirebaseStorageReportService } from '../services/storage/FirebaseStorageReportService.js';
import crypto from 'crypto';

const router = Router();

// Middleware: Require Owner or Admin role (supporting canonical roles and authorized master accounts)
const requireOwnerOrAdmin = (req: AuthRequest, res: Response, next: any) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.isActive === false) {
    return res.status(403).json({ error: 'Forbidden: Account has been deactivated or revoked.', code: 'ACCOUNT_REVOKED' });
  }
  const role = (req.user.role || '').toLowerCase();
  if (['customer', 'delivery', 'delivery_partner', 'rider'].includes(role)) {
    return res.status(403).json({ error: 'Forbidden: Role not authorized for administrative access.', code: 'ROLE_FORBIDDEN' });
  }
  const isAuthorized = ['owner', 'admin', 'platform_owner'].includes(role);
  if (!isAuthorized) {
    return res.status(403).json({ error: 'Forbidden. Owner or Admin access required.' });
  }
  next();
};

function getReportCapabilitySecret(): string {
  const secret = process.env.TRACKING_TOKEN_SECRET || process.env.INTERNAL_RPC_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL SECURITY ERROR: TRACKING_TOKEN_SECRET or INTERNAL_RPC_SECRET must be configured in production.');
    }
    return 'olive-capability-dev-secret-32-chars';
  }
  return secret;
}

export function verifyReportCapabilityToken(token: string): boolean {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 5) return false;
    const [reportId, scope, purpose, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Math.floor(Date.now() / 1000) > exp) return false;
    if (scope !== 'reporting' && scope !== 'looker') return false;

    const secret = getReportCapabilitySecret();
    const expectedSig = crypto.createHmac('sha256', secret).update(`${reportId}:${scope}:${purpose}:${expStr}`).digest('hex');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

const requireReportCapabilityOrAdmin = (req: AuthRequest, res: Response, next: any) => {
  const capHeader = (req.headers['x-capability-token'] || req.headers['x-report-token']) as string;
  if (capHeader && typeof capHeader === 'string' && verifyReportCapabilityToken(capHeader.trim())) {
    return next();
  }

  verifyToken(req, res, () => {
    requireOwnerOrAdmin(req, res, next);
  });
};

/**
 * Handles PDF streaming (View inline or Download attachment).
 * STRICT SECURITY: Validates HMAC signed link OR user scope authorization.
 */
async function handleStreamPdf(req: AuthRequest, res: Response, forceDownload?: boolean): Promise<void> {
  try {
    const { id } = req.params;
    const download = forceDownload ?? (req.query.download === 'true');

    // 1. Signature Check (HMAC deep links from owner emails)
    const sig = req.query.sig as string;
    const exp = req.query.exp as string;
    let isSignedLink = false;
    if (sig) {
      try {
        if (exp) {
          const expNum = parseInt(exp, 10);
          const expMs = exp.length === 10 ? expNum * 1000 : expNum;
          if (Date.now() > expMs) {
            res.status(403).json({ error: 'Forbidden: Signed report link has expired', code: 'LINK_EXPIRED' });
            return;
          }
        }
        const trackingSecret = getReportCapabilitySecret();
        const dataToSign = exp ? `${id}:${exp}` : id;
        const expectedSig = crypto.createHmac('sha256', trackingSecret).update(dataToSign).digest('hex');
        const sigBuf = Buffer.from(sig, 'utf8');
        const expBuf = Buffer.from(expectedSig, 'utf8');
        if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
          isSignedLink = true;
        }
      } catch {}
    }

    if (!isSignedLink) {
      // Must authenticate via token
      let user = req.user;
      if (!user) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1].trim() : undefined;
        if (token) {
          try {
            const { adminAuth } = await import('../config/firebase.js');
            const decoded: any = await adminAuth.verifyIdToken(token);
            user = {
              uid: decoded.uid,
              email: decoded.email,
              role: decoded.role || 'customer'
            };
          } catch (_) {}
        }
      }

      if (!user) {
        res.status(401).json({ error: 'Unauthorized: Authentication required.' });
        return;
      }
      req.user = user;
    }

    // 2. Check Firestore metadata & PostgreSQL canonical snapshots
    const docSnap = await adminDb.collection('monthly_reports').doc(id).get();
    let cloudflarePath = `reports/${id}.pdf`;
    let monthName = 'September';
    let yearNum = new Date().getFullYear();
    let franchiseId: string | null = null;
    let branchId: string | null = null;
    let branchName = 'Olive Pizza';
    let franchiseName = 'Olive Pizza';
    let scopeLevel: 'GLOBAL' | 'FRANCHISE' | 'RESTAURANT' = 'GLOBAL';

    if (docSnap.exists) {
      const data = docSnap.data()!;
      cloudflarePath = data.cloudflarePath || cloudflarePath;
      monthName = data.month || monthName;
      yearNum = data.year || yearNum;
      franchiseId = data.franchiseId || null;
      branchId = data.branchId || data.restaurantId || null;
      branchName = data.branchName || branchName;
      franchiseName = data.franchiseName || franchiseName;
      scopeLevel = data.accessScope || (branchId ? 'RESTAURANT' : franchiseId ? 'FRANCHISE' : 'GLOBAL');
    } else {
      const pgSnap = await query(
        `SELECT franchise_id, branch_id, report_month, report_year, pdf_cloudflare_path
         FROM canonical_report_snapshots
         WHERE id::text = $1 OR pdf_cloudflare_path LIKE $2 LIMIT 1`,
        [id, `%${id}%`]
      ).catch(() => ({ rows: [] }));

      if (pgSnap.rows.length > 0) {
        const row = pgSnap.rows[0];
        franchiseId = row.franchise_id;
        branchId = row.branch_id;
        monthName = row.report_month;
        yearNum = row.report_year;
        cloudflarePath = row.pdf_cloudflare_path || cloudflarePath;
        scopeLevel = branchId ? 'RESTAURANT' : franchiseId ? 'FRANCHISE' : 'GLOBAL';
      }
    }

    // 3. Authoritative Scope Authorization Check (if not signed link)
    if (!isSignedLink && req.user) {
      const scope: ReportScope = {
        level: scopeLevel,
        franchiseId,
        restaurantId: branchId,
        periodMonth: monthName,
        periodYear: yearNum
      };

      const authResult = MonthlyReportNotificationService.isUserAuthorizedForReport(req.user, scope);
      if (!authResult.authorized) {
        res.status(403).json({ error: authResult.reason || 'Forbidden: Access to this internal report is restricted.' });
        return;
      }

      await FirebaseStorageReportService.verifyReportAccess(req.user, {
        franchiseId,
        branchId,
        isGlobal: scopeLevel === 'GLOBAL'
      });
    }

    // 4. Fetch Buffer from Cloudflare R2 / local mock
    let buffer = await FirebaseStorageReportService.getReportBuffer(cloudflarePath) || await CloudflareR2Service.getBuffer(cloudflarePath);

    // 5. If buffer not found, generate on the fly from PostgreSQL
    if (!buffer) {
      buffer = await MonthlyPdfReportService.generateMonthlyReportBuffer({
        monthName,
        year: yearNum,
        branchId: branchId || 'main_branch',
        branchName: branchName || 'Olive Pizza — Rajnandgaon HQ',
        franchiseId: franchiseId || 'fra_rajnandgaon',
        franchiseName: franchiseName || 'Olive Pizza Rajnandgaon'
      });
    }

    const filename = `Olive-Pizza-Report-${branchId || 'HQ'}-${monthName}-${yearNum}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    }

    res.send(buffer);
  } catch (err: any) {
    console.error(`[Report PDF Route Error]:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve report PDF' });
  }
}

// PDF Streaming Endpoints
router.get('/pdf/:id', (req: AuthRequest, res: Response) => handleStreamPdf(req, res));
router.get('/monthly/:id/view', (req: AuthRequest, res: Response) => handleStreamPdf(req, res, false));
router.get('/monthly/:id/download', (req: AuthRequest, res: Response) => handleStreamPdf(req, res, true));

/**
 * POST /api/reports/google-sheet/set-id
 * Sets or updates the Google Spreadsheet ID in Firestore settings.
 */
router.post('/google-sheet/set-id', verifyToken, requireOwnerOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { spreadsheetId } = req.body;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId is required' });

    await adminDb.collection('settings').doc('google_sheets').set({
      spreadsheetId: spreadsheetId.trim(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    res.json({ success: true, spreadsheetId: spreadsheetId.trim() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reports/google-sheet/sync
 * Syncs recent orders into Google Sheets.
 */
router.post('/google-sheet/sync', verifyToken, requireOwnerOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const spreadsheetId = await GoogleSheetsReportService.getSpreadsheetId();
    if (!spreadsheetId) {
      return res.status(400).json({ error: 'Google Sheet ID not configured. Please set Spreadsheet ID first.' });
    }

    const ordersSnap = await adminDb.collection('orders').orderBy('createdAt', 'desc').limit(100).get();
    let syncedCount = 0;

    for (const doc of ordersSnap.docs) {
      const o = doc.data();
      await GoogleSheetsReportService.syncOrderToMonthlySheet({
        id: doc.id,
        ...o
      });
      syncedCount++;
    }

    res.json({ success: true, syncedCount, spreadsheetId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/monthly & GET /api/reports/list
 * Lists monthly reports stored in Cloudflare R2 and Firestore.
 * Scoped by role:
 *  - Owner/Admin: Overall reports & all franchise reports
 *  - Franchise Manager: Only authorized franchise reports
 *  - Restaurant Manager: Only authorized restaurant branch reports
 *  - Customer/Delivery: 403 Forbidden
 */
async function handleListMonthlyReports(req: AuthRequest, res: Response): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      return;
    }

    const callerRole = (user.role || 'customer').toLowerCase();
    const isOwner = [
      'owner', 'admin', 'developer', 'platform_owner'
    ].includes(callerRole) ||
      user.email === 'olivepizzarjn@gmail.com' ||
      user.email === 'webhub2811@gmail.com' ||
      user.email === 'olivepizzamaker@gmail.com';

    const isFranchiseManager = ['franchise_owner', 'franchise_manager'].includes(callerRole);
    const isRestaurantManager = ['restaurant_manager', 'manager', 'kitchen_manager'].includes(callerRole);

    if (!isOwner && !isFranchiseManager && !isRestaurantManager) {
      res.status(403).json({ error: 'Forbidden: Access to internal business reports is restricted.' });
      return;
    }

    const allReports = await CloudflareReportService.listMonthlyReports();
    
    // Filter reports according to authoritative caller scope
    const scopedReports = allReports.filter((r: any) => {
      if (isOwner) return true;
      if (isFranchiseManager) {
        return r.franchiseId === user.franchiseId || !r.franchiseId;
      }
      if (isRestaurantManager) {
        return (r.branchId && r.branchId === user.branchId) || (r.restaurantId && r.restaurantId === user.branchId);
      }
      return false;
    });

    const spreadsheetId = await GoogleSheetsReportService.getSpreadsheetId();
    const currentSheetTitle = GoogleSheetsReportService.getMonthSheetTitle();

    res.json({
      success: true,
      reports: scopedReports,
      liveSheet: isOwner ? {
        spreadsheetId,
        currentSheetTitle,
        url: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null,
      } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/monthly', verifyToken, handleListMonthlyReports);
router.get('/list', verifyToken, handleListMonthlyReports);

/**
 * POST /api/reports/generate-monthly
 * Triggers monthly PDF generation, Cloudflare R2 upload, and owner email notification.
 */
router.post('/generate-monthly', verifyToken, requireOwnerOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const now = new Date();
    const month = req.body.month || now.toLocaleString('default', { month: 'long' });
    const year = Number(req.body.year) || now.getFullYear();
    let branchId = user.branchId || req.body.branchId;
    let franchiseId = user.franchiseId || req.body.franchiseId;
    let branchName = 'Olive Pizza Branch';
    let franchiseName = 'Olive Pizza Franchise';

    if (!branchId || !franchiseId) {
      const bSnap = await adminDb.collection('franchises').limit(1).get().catch(() => ({ empty: true, docs: [] } as any));
      if (!bSnap.empty) {
        const firstBranch = bSnap.docs[0];
        branchId = branchId || firstBranch.id;
        franchiseId = franchiseId || firstBranch.data().franchiseId || firstBranch.id;
      }
    }

    if (!branchId || !franchiseId) {
      res.status(400).json({ error: 'Valid branchId and franchiseId are required to generate monthly report' });
      return;
    }

    try {
      const bDoc = await adminDb.collection('franchises').doc(branchId).get();
      if (bDoc.exists) {
        const data = bDoc.data()!;
        branchName = data.name || branchName;
        franchiseName = data.franchiseName || franchiseName;
      }
    } catch (_) {}

    // 1. Generate Multi-Page Monthly PDF Report (100% real PostgreSQL data)
    const pdfBuffer = await MonthlyPdfReportService.generateMonthlyReportBuffer({
      monthName: month,
      year,
      branchId,
      branchName,
      franchiseId,
      franchiseName
    });

    const monthNum = String(new Date(`${month} 1, ${year}`).getMonth() + 1).padStart(2, '0');
    const reportKey = `${franchiseId}_${branchId}_${year}_${monthNum}`;
    let cloudflarePath = `reports/${year}/olive-pizza/${franchiseId}/${branchId}/monthly/${year}-${monthNum}.pdf`;
    let pdfUrl = `/api/reports/monthly/${reportKey}/download`;
    let viewUrl = `/api/reports/monthly/${reportKey}/view`;
    let downloadUrl = `/api/reports/monthly/${reportKey}/download`;

    try {
      const uploadRes = await CloudflareReportService.uploadPdfReport(year, month, pdfBuffer, franchiseId, branchId);
      cloudflarePath = uploadRes.cloudflarePath;
      const urls = await CloudflareReportService.getReportUrls(cloudflarePath, reportKey);
      pdfUrl = uploadRes.publicUrl || urls.downloadUrl;
      viewUrl = urls.viewUrl;
      downloadUrl = urls.downloadUrl;
    } catch (err: any) {
      console.warn('[MonthlyReport] Cloudflare upload notice:', err.message);
    }

    // 2. Synchronize Rebuilt Enterprise Google Sheets (6 tabs, Olive Pizza brand theme)
    let sheetsUrl = '';
    try {
      const sheetRes = await GoogleSheetsMonthlyReportService.syncMonthlyReport({
        monthName: month,
        year,
        branchId,
        franchiseId,
        branchName: 'Olive Pizza — Rajnandgaon HQ',
        franchiseName: 'Olive Pizza Franchise'
      });
      sheetsUrl = sheetRes.url;
    } catch (sheetErr: any) {
      console.warn('[MonthlyReport] Google Sheets sync notice:', sheetErr.message);
    }

    // 3. Compute summary snapshot for persistent history
    const monthIndex = new Date(`${month} 1, ${year}`).getMonth();
    const startDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
    const lastDayNum = new Date(year, monthIndex + 1, 0).getDate();
    const endDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;

    const summary = await SalesCalculationEngine.getSalesSummary({
      branchId,
      franchiseId,
      startDate,
      endDate,
      periodLabel: `${month.toUpperCase()} ${year}`
    });

    // 4. Save canonical report snapshot in PostgreSQL
    const snapshotId = crypto.randomUUID();
    await query(`
      INSERT INTO canonical_report_snapshots (
        id, franchise_id, branch_id, report_month, report_year,
        summary_json, pdf_cloudflare_path, pdf_url, sheets_url, status
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6::jsonb, $7, $8, $9, 'COMPLETED'
      )
      ON CONFLICT (franchise_id, branch_id, report_month, report_year)
      DO UPDATE SET
        summary_json = EXCLUDED.summary_json,
        pdf_cloudflare_path = EXCLUDED.pdf_cloudflare_path,
        pdf_url = EXCLUDED.pdf_url,
        sheets_url = EXCLUDED.sheets_url,
        status = 'COMPLETED',
        created_at = CURRENT_TIMESTAMP;
    `, [
      snapshotId, franchiseId, branchId, month, year,
      JSON.stringify(summary), cloudflarePath, pdfUrl, sheetsUrl
    ]);

    // 5. Update Firestore metadata for backward compatibility
    await adminDb.collection('monthly_reports').doc(reportKey).set({
      id: reportKey,
      month,
      year,
      revenue: summary.grossSales,
      orders: summary.totalBills,
      cloudflarePath,
      reportUrl: viewUrl,
      viewUrl,
      downloadUrl,
      period: `${month} ${year}`,
      branchName,
      franchiseName,
      averageOrderValue: summary.averageOrderValue,
      sheetsUrl,
      status: 'COMPLETED',
      createdTime: new Date().toISOString()
    }, { merge: true });

    const reportScopeLevel: 'GLOBAL' | 'FRANCHISE' | 'RESTAURANT' = (!franchiseId || franchiseId === 'global') ? 'GLOBAL' : (branchId ? 'RESTAURANT' : 'FRANCHISE');
    const reportScope: ReportScope = {
      level: reportScopeLevel,
      franchiseId: reportScopeLevel === 'GLOBAL' ? null : franchiseId,
      restaurantId: reportScopeLevel === 'RESTAURANT' ? branchId : null,
      periodMonth: month,
      periodYear: year,
    };

    // Save scope in Firestore metadata
    await adminDb.collection('monthly_reports').doc(reportKey).set({
      accessScope: reportScope.level,
      franchiseId: reportScope.franchiseId,
      branchId: reportScope.restaurantId,
      restaurantId: reportScope.restaurantId,
      createdBy: user.uid
    }, { merge: true });

    // 6. Dispatch Authoritative Scoped Monthly Report Notification
    await MonthlyReportNotificationService.dispatchMonthlyReportNotification(reportScope, {
      reportKey,
      pdfUrl,
      grossSales: summary.grossSales,
      totalOrders: summary.totalBills
    }).catch(err => console.error('[MonthlyReport] Notification dispatch notice:', err));

    res.json({
      success: true,
      report: {
        id: reportKey,
        month,
        year,
        grossSales: summary.grossSales,
        netSales: summary.netSales,
        totalBills: summary.totalBills,
        pdfUrl,
        sheetsUrl,
        summary
      }
    });
  } catch (err: any) {
    console.error('[Monthly Report Generation Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/reports/monthly/:id
 * Deletes a monthly report from Cloudflare R2 and Firestore.
 */
router.delete('/monthly/:id', verifyToken, requireOwnerOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { cloudflarePath } = req.body;
    const success = await CloudflareReportService.deleteReport(id, cloudflarePath);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/diagnostics
 * Provides production diagnostics for PDF Generation, Cloudflare R2, Google Sheets, and Email.
 */
router.get('/diagnostics', verifyToken, requireOwnerOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const isR2Configured = CloudflareR2Service.isConfigured();
    const spreadsheetId = await GoogleSheetsReportService.getSpreadsheetId();

    const emailQueueStats = await pgPool.query(`
      SELECT status, COUNT(*) as count
      FROM email_queue
      GROUP BY status
    `).catch(() => ({ rows: [] }));

    const reportsSnap = await adminDb.collection('monthly_reports').get().catch(() => ({ size: 0 }));

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      pdfGenerator: { status: 'healthy', format: 'jsPDF + Cloudflare R2 PDF Engine' },
      cloudflareR2: {
        status: isR2Configured ? 'healthy' : 'unconfigured',
        bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME || 'olive-pizza-r2',
      },
      googleSheets: {
        status: spreadsheetId ? 'active' : 'unconfigured',
        spreadsheetId,
      },
      emailQueue: {
        statusBreakdown: emailQueueStats.rows,
        smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
        recipient: process.env.OWNER_EMAIL || 'olivepizzarjn@gmail.com',
      },
      reportsSummary: {
        totalGenerated: reportsSnap.size,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


/**
 * GET /api/reports/looker-studio/config
 * Returns Looker Studio embed URL, spreadsheet metadata, and live sync state.
 */
router.get('/looker-studio/config', verifyToken, requireOwnerOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const config = await GoogleSheetsReportService.getLookerStudioConfig();
    res.json({ success: true, ...config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reports/looker-studio/set-embed-url
 * Updates Looker Studio embed URL in Firestore settings.
 */
router.post('/looker-studio/set-embed-url', verifyToken, requireOwnerOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { embedUrl } = req.body;
    if (!embedUrl) return res.status(400).json({ error: 'embedUrl is required' });

    await GoogleSheetsReportService.setLookerStudioEmbedUrl(embedUrl);
    res.json({ success: true, embedUrl });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/looker-studio/feed
 * Provides continuous standardized time-series reporting feed for Looker Studio / BI ingestion.
 * Protected by capability token or Owner/Admin authorization.
 */
router.get('/looker-studio/feed', requireReportCapabilityOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { franchiseId, limit } = req.query;
    const feed = await GoogleSheetsReportService.getLookerStudioFeed({
      franchiseId: franchiseId as string,
      limit: limit ? Number(limit) : 500,
    });
    res.json({
      success: true,
      count: feed.length,
      timestamp: new Date().toISOString(),
      data: feed,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Looker Studio Config Aliases - Protected by capability token or Owner/Admin
router.get('/looker/config', requireReportCapabilityOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const config = await GoogleSheetsReportService.getLookerStudioConfig();
    res.json({ success: true, ...config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/config', requireReportCapabilityOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const config = await GoogleSheetsReportService.getLookerStudioConfig();
    res.json({ success: true, ...config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/quota?branchId=...
 * Returns hourly custom PDF generation quota for the requesting restaurant manager.
 * Owner has unlimited quota (remaining: 9999).
 */
router.get('/quota', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      return;
    }

    const callerRole = (user.role || 'customer').toLowerCase();
    const isOwner = [
      'owner', 'admin', 'developer', 'platform_owner'
    ].includes(callerRole) ||
      user.email === 'olivepizzarjn@gmail.com' ||
      user.email === 'webhub2811@gmail.com';

    if (isOwner) {
      res.json({ success: true, unlimited: true, remaining: 9999, limit: 9999, resetInSeconds: 0 });
      return;
    }

    const branchId = (req.query.branchId as string) || user.branchId || 'main_branch';
    const rateLimitKey = `pdf:custom:branch:${branchId}`;
    
    let remaining = 2;
    let resetInSeconds = 3600;

    if (redisService.isAvailable()) {
      const client = redisService.getClient();
      if (client) {
        const namespacedKey = `olive:rate:${rateLimitKey}`;
        const val = await client.get(namespacedKey);
        const count = val ? parseInt(val, 10) : 0;
        remaining = Math.max(0, 2 - count);
        const ttl = await client.ttl(namespacedKey);
        if (ttl > 0) resetInSeconds = ttl;
      }
    }

    res.json({
      success: true,
      branchId,
      remaining,
      limit: 2,
      resetInSeconds
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reports/custom
 * Compiles a custom PDF report dynamically in memory and streams it over HTTP.
 * Strictly NEVER stores custom reports in Cloudflare R2!
 * Rate limited to 2 PDFs per hour for Restaurant Managers via Layerbase Redis.
 * Unlimited for Store Owners.
 */
router.post('/custom', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required.' });
      return;
    }

    const callerRole = (user.role || 'customer').toLowerCase();
    const isOwner = [
      'owner', 'admin', 'developer', 'platform_owner'
    ].includes(callerRole) ||
      user.email === 'olivepizzarjn@gmail.com' ||
      user.email === 'webhub2811@gmail.com';

    const isFranchiseManager = ['franchise_owner', 'franchise_manager'].includes(callerRole);
    const isRestaurantManager = ['restaurant_manager', 'manager', 'kitchen_manager'].includes(callerRole);

    if (!isOwner && !isFranchiseManager && !isRestaurantManager) {
      res.status(403).json({ error: 'Forbidden: Insufficient privileges to generate custom reports.' });
      return;
    }

    const branchId = (req.body.branchId as string) || user.branchId || 'main_branch';
    const franchiseId = (req.body.franchiseId as string) || user.franchiseId || 'fra_primary';
    const timeRange = (req.body.timeRange as string) || 'ongoing_month';
    const channel = (req.body.channel as 'ALL' | 'ONLINE' | 'POS') || 'ALL';

    // Rate-limiting check for restaurant managers (2 PDFs/hour)
    if (!isOwner) {
      const rateLimitKey = `pdf:custom:branch:${branchId}`;
      const { allowed, remaining } = await redisService.checkRateLimit(rateLimitKey, 2, 3600);
      if (!allowed) {
        let resetMinutes = 60;
        const client = redisService.getClient();
        if (client) {
          const ttl = await client.ttl(`olive:rate:${rateLimitKey}`);
          if (ttl > 0) resetMinutes = Math.ceil(ttl / 60);
        }
        res.status(429).json({
          error: `Hourly custom PDF limit reached (2 PDFs/hr). Next PDF download available in ${resetMinutes} minutes.`,
          remaining: 0,
          limit: 2
        });
        return;
      }
    }

    // Determine Month and Year based on current date
    const now = new Date();
    const monthName = req.body.monthName || now.toLocaleString('en-US', { month: 'long' });
    const year = Number(req.body.year) || now.getFullYear();

    // Compile in memory
    const pdfBuffer = await MonthlyPdfReportService.generateMonthlyReportBuffer({
      monthName,
      year,
      branchId,
      franchiseId,
      channel
    });

    const filename = `OlivePizza-Report-${branchId}-${timeRange}-${Date.now()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('[Custom Report Error]:', err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/reports/export/orders
 * Export Online, POS, or Combined orders as CSV.
 * Stored to Firebase Storage private path with metadata.
 */
router.get('/export/orders', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const caller = req.user;
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const type = ((req.query.type as string) || 'combined').toLowerCase();
    const startDate = (req.query.startDate as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const franchiseId = (req.query.franchiseId as string) || caller.franchiseId || 'fra_rajnandgaon';
    const branchId = (req.query.branchId as string) || caller.branchId || undefined;
    const format = ((req.query.format as string) || 'download').toLowerCase();

    // Authoritative PostgreSQL Access Control Check
    await FirebaseStorageReportService.verifyReportAccess(caller, {
      franchiseId,
      branchId,
      isGlobal: franchiseId === 'global' || franchiseId === 'all'
    });

    let exportResult;
    if (type === 'online') {
      exportResult = await ReportExportService.generateOnlineOrderCsv({ franchiseId, branchId, startDate, endDate });
    } else if (type === 'pos') {
      exportResult = await ReportExportService.generatePosOrderCsv({ franchiseId, branchId, startDate, endDate });
    } else if (type === 'items' || type === 'order_items') {
      exportResult = await ReportExportService.generateOrderItemsCsv({ franchiseId, branchId, startDate, endDate });
    } else {
      exportResult = await ReportExportService.generateCombinedOrderCsv({ franchiseId, branchId, startDate, endDate });
    }

    const upload = await FirebaseStorageReportService.uploadReport({
      franchiseId,
      branchId: branchId || 'all',
      reportType: exportResult.reportType,
      periodLabel: `${startDate}_to_${endDate}`,
      startDate,
      endDate,
      csvContent: exportResult.csvContent,
      generatedByUid: caller.uid
    });

    if (format === 'json') {
      const signed = await FirebaseStorageReportService.getSignedDownloadUrl(upload.reportId, caller);
      res.json({
        success: true,
        reportId: upload.reportId,
        filePath: upload.filePath,
        rowCount: exportResult.rowCount,
        checksum: upload.checksumSha256,
        downloadUrl: signed.downloadUrl,
        expiresInSeconds: signed.expiresInSeconds
      });
      return;
    }

    const filename = `olive-pizza-orders-${type}-${startDate}-${endDate}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportResult.csvContent);
  } catch (err: any) {
    console.error('[Export Orders Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/export/financial
 * Export Daily Reconciliation & Financial Summary Ledger as CSV.
 */
router.get('/export/financial', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const caller = req.user;
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const startDate = (req.query.startDate as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const franchiseId = (req.query.franchiseId as string) || caller.franchiseId || 'fra_rajnandgaon';
    const branchId = (req.query.branchId as string) || caller.branchId || undefined;
    const format = ((req.query.format as string) || 'download').toLowerCase();

    // Authoritative PostgreSQL Access Control Check
    await FirebaseStorageReportService.verifyReportAccess(caller, {
      franchiseId,
      branchId,
      isGlobal: franchiseId === 'global' || franchiseId === 'all'
    });

    const exportResult = await ReportExportService.generateFinancialSummaryCsv({ franchiseId, branchId, startDate, endDate });

    const upload = await FirebaseStorageReportService.uploadReport({
      franchiseId,
      branchId: branchId || 'all',
      reportType: exportResult.reportType,
      periodLabel: `${startDate}_to_${endDate}`,
      startDate,
      endDate,
      csvContent: exportResult.csvContent,
      generatedByUid: caller.uid
    });

    if (format === 'json') {
      const signed = await FirebaseStorageReportService.getSignedDownloadUrl(upload.reportId, caller);
      res.json({
        success: true,
        reportId: upload.reportId,
        filePath: upload.filePath,
        rowCount: exportResult.rowCount,
        checksum: upload.checksumSha256,
        downloadUrl: signed.downloadUrl,
        expiresInSeconds: signed.expiresInSeconds
      });
      return;
    }

    const filename = `olive-pizza-financial-summary-${startDate}-${endDate}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportResult.csvContent);
  } catch (err: any) {
    console.error('[Export Financial Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reports/export/items
 * Export Granular Order Items Breakdown as CSV.
 */
router.get('/export/items', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const caller = req.user;
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const startDate = (req.query.startDate as string) || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = (req.query.endDate as string) || new Date().toISOString().split('T')[0];
    const franchiseId = (req.query.franchiseId as string) || caller.franchiseId || 'fra_rajnandgaon';
    const branchId = (req.query.branchId as string) || caller.branchId || undefined;
    const format = ((req.query.format as string) || 'download').toLowerCase();

    // Authoritative PostgreSQL Access Control Check
    await FirebaseStorageReportService.verifyReportAccess(caller, {
      franchiseId,
      branchId,
      isGlobal: franchiseId === 'global' || franchiseId === 'all'
    });

    const exportResult = await ReportExportService.generateOrderItemsCsv({ franchiseId, branchId, startDate, endDate });

    const upload = await FirebaseStorageReportService.uploadReport({
      franchiseId,
      branchId: branchId || 'all',
      reportType: exportResult.reportType,
      periodLabel: `${startDate}_to_${endDate}`,
      startDate,
      endDate,
      csvContent: exportResult.csvContent,
      generatedByUid: caller.uid
    });

    if (format === 'json') {
      const signed = await FirebaseStorageReportService.getSignedDownloadUrl(upload.reportId, caller);
      res.json({
        success: true,
        reportId: upload.reportId,
        filePath: upload.filePath,
        rowCount: exportResult.rowCount,
        checksum: upload.checksumSha256,
        downloadUrl: signed.downloadUrl,
        expiresInSeconds: signed.expiresInSeconds
      });
      return;
    }

    const filename = `olive-pizza-order-items-${startDate}-${endDate}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportResult.csvContent);
  } catch (err: any) {
    if (err.message && err.message.includes('Forbidden')) {
      res.status(403).json({ error: err.message, code: err.code || 'FORBIDDEN' });
    } else {
      console.error('[Export Items Error]:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * GET /api/reports/download/:id
 * Retrieve signed download link or stream private report from Firebase Storage.
 */
router.get('/download/:id', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const caller = req.user;
    if (!caller) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { id } = req.params;
    const signed = await FirebaseStorageReportService.getSignedDownloadUrl(id, caller);

    if (req.query.stream === 'true' || !signed.downloadUrl.startsWith('http')) {
      const buffer = await FirebaseStorageReportService.getReportBuffer(signed.report.file_path);
      if (buffer) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);
        res.send(buffer);
        return;
      }
    }

    res.json({
      success: true,
      downloadUrl: signed.downloadUrl,
      expiresInSeconds: signed.expiresInSeconds,
      report: signed.report
    });
  } catch (err: any) {
    if (err.message && err.message.includes('Forbidden')) {
      res.status(403).json({ error: err.message });
    } else {
      res.status(404).json({ error: err.message });
    }
  }
});

export default router;

