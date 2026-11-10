/**
 * MonthlyReportJob.ts
 *
 * Automated Month-End Scheduled Worker for Olive Pizza.
 * Runs on the 1st of every month at 00:05 AM IST.
 *
 * Workflow:
 * 1. Idempotency Check: Verify cycle lock for {year}-{monthNum} to avoid duplicate execution.
 * 2. Discover active branches & franchises dynamically from Firestore and PostgreSQL.
 * 3. PostgreSQL -> calculate monthly report from immutable financial records.
 * 4. Finalize report & generate authoritative PDF buffer.
 * 5. Store PDF securely in Cloudflare R2 under unique branch path:
 *    reports/{year}/olive-pizza/{franchiseId}/{branchId}/monthly/{year}-{monthNum}.pdf
 * 6. Sync enterprise Google Sheets workbook.
 * 7. Store canonical report snapshots in PostgreSQL & Firestore monthly_reports.
 * 8. Dispatch scoped branch notifications (strictly branch-scoped, no owner spam per branch).
 * 9. Consolidated Executive Summary: Send EXACTLY ONE notification to owners.
 * 10. Executive Email: Send EXACTLY ONE branded HTML email to OWNER_EMAIL with styled PDF download & portal buttons.
 *
 * ZERO BROADCAST: Never broadcasts to customer or delivery users.
 */

import cron from 'node-cron';
import { MonthlyPdfReportService } from '../services/reports/MonthlyPdfReportService.js';
import { CloudflareReportService } from '../services/reports/CloudflareReportService.js';
import { GoogleSheetsMonthlyReportService } from '../services/reports/GoogleSheetsMonthlyReportService.js';
import { SalesCalculationEngine } from '../services/reports/SalesCalculationEngine.js';
import { MonthlyReportNotificationService, ReportScope } from '../services/reports/MonthlyReportNotificationService.js';
import { query } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';
import { sendEmailDirect } from '../services/email.service.js';
import crypto from 'crypto';
import { distributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';

export class MonthlyReportJob {
  private static isInitialized = false;

  /**
   * Initializes the 1st-of-month cron scheduler.
   * Guarded against duplicate registration.
   */
  public static init() {
    if (this.isInitialized) {
      console.warn('⚠️ [MonthlyReportJob] Already initialized. Skipping duplicate registration.');
      return;
    }
    this.isInitialized = true;

    // Schedule: 1st of every month at 00:05 AM (Asia/Kolkata) coordinated across cluster
    cron.schedule('5 0 1 * *', async () => {
      await distributedJobCoordinator.runScheduledSingleton('monthly_report_1st_ist', 1800, async () => {
        console.log('⏰ [MonthlyReportJob] Automated 1st-of-month 00:05 AM report job triggered.');
        try {
          await MonthlyReportJob.runMonthEndPipeline();
          console.log('✅ [MonthlyReportJob] Month-end report pipeline completed successfully.');
        } catch (err: any) {
          console.error('❌ [MonthlyReportJob] Month-end report pipeline failed:', err.message);
        }
      });
    }, {
      timezone: 'Asia/Kolkata'
    });

    console.log('⏰ [MonthlyReportJob] Scheduled to run automatically on the 1st of every month at 00:05 AM IST (distributed).');
  }

  /**
   * Executes the full month-end pipeline with strict cycle idempotency.
   */
  public static async runMonthEndPipeline(targetDate: Date = new Date(), forceRerun: boolean = false) {
    // Calculate for the previous completed month
    const prevMonthDate = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
    const monthName = prevMonthDate.toLocaleString('default', { month: 'long' });
    const monthNum = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
    const year = prevMonthDate.getFullYear();
    const cycleKey = `${year}-${monthNum}`;

    console.log(`[MonthlyReportJob] Starting month-end processing for cycle: ${cycleKey} (${monthName} ${year})`);

    // 1. Cycle-Level Idempotency Check
    const cycleRef = adminDb.collection('monthly_cycles').doc(cycleKey);
    const cycleDoc = await cycleRef.get().catch(() => null);
    const cycleData = cycleDoc?.data();

    if (cycleData?.status === 'COMPLETED' && !forceRerun) {
      console.log(`🔒 [MonthlyReportJob] Cycle ${cycleKey} is already marked COMPLETED. Skipping duplicate execution.`);
      return;
    }

    if (cycleData?.status === 'PROCESSING' && !forceRerun) {
      const elapsedMs = Date.now() - new Date(cycleData.startedAt || 0).getTime();
      // If processing started less than 30 minutes ago, avoid duplicate run
      if (elapsedMs < 30 * 60 * 1000) {
        console.log(`⏳ [MonthlyReportJob] Cycle ${cycleKey} is currently PROCESSING (started ${Math.round(elapsedMs / 1000)}s ago). Skipping concurrent execution.`);
        return;
      }
      console.warn(`⚠️ [MonthlyReportJob] Cycle ${cycleKey} had a stale PROCESSING lock. Resuming execution.`);
    }

    // Set lock to PROCESSING
    await cycleRef.set({
      cycleKey,
      year,
      month: monthName,
      monthNum,
      status: 'PROCESSING',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, { merge: true }).catch(err => console.warn('[MonthlyReportJob] Lock acquisition warning:', err.message));

    // 2. Discover active branches and franchises dynamically
    const branchSnap = await adminDb.collection('franchises').get().catch(() => ({ docs: [] } as any));
    const targetMap = new Map<string, { branchId: string; branchName: string; franchiseId: string; franchiseName: string }>();

    // Scan Firestore franchises collection (filtering out dummy test entities)
    for (const d of branchSnap.docs) {
      const data = d.data();
      // Valid operational branch must be active and have a valid name or be the known main_branch
      if (data.isActive !== false && (data.name || d.id === 'main_branch')) {
        const branchId = d.id;
        const branchName = data.name || (branchId === 'main_branch' ? 'Olive Pizza — Rajnandgaon HQ' : `Olive Pizza — ${branchId}`);
        const franchiseId = data.franchiseId || (branchId === 'main_branch' ? 'fra_rajnandgaon' : branchId);
        const franchiseName = data.franchiseName || data.name || 'Olive Pizza Franchise';

        targetMap.set(`${franchiseId}_${branchId}`, {
          branchId,
          branchName,
          franchiseId,
          franchiseName
        });
      }
    }

    // Scan PostgreSQL canonical_orders for active branches in this month
    const monthIndex = prevMonthDate.getMonth();
    const startDate = `${year}-${monthNum}-01`;
    const lastDayNum = new Date(year, monthIndex + 1, 0).getDate();
    const endDate = `${year}-${monthNum}-${String(lastDayNum).padStart(2, '0')}`;

    try {
      const pgRes = await query(`
        SELECT DISTINCT franchise_id, branch_id 
        FROM canonical_orders 
        WHERE branch_id IS NOT NULL 
          AND created_at >= $1::date 
          AND created_at < ($2::date + INTERVAL '1 day')
      `, [startDate, endDate]);

      for (const r of pgRes.rows) {
        const branchId = r.branch_id;
        const franchiseId = r.franchise_id || (branchId === 'main_branch' ? 'fra_rajnandgaon' : branchId);
        const key = `${franchiseId}_${branchId}`;

        if (!targetMap.has(key)) {
          targetMap.set(key, {
            branchId,
            branchName: branchId === 'main_branch' ? 'Olive Pizza — Rajnandgaon HQ' : `Olive Pizza — ${branchId}`,
            franchiseId,
            franchiseName: franchiseId === 'fra_rajnandgaon' ? 'Olive Pizza Rajnandgaon' : `Olive Pizza ${franchiseId}`
          });
        }
      }
    } catch (err: any) {
      console.warn('[MonthlyReportJob] PostgreSQL branch discovery notice:', err.message);
    }

    // Ensure main_branch is always present if no targets discovered
    if (targetMap.size === 0) {
      targetMap.set('fra_rajnandgaon_main_branch', {
        branchId: 'main_branch',
        branchName: 'Olive Pizza — Rajnandgaon HQ',
        franchiseId: 'fra_rajnandgaon',
        franchiseName: 'Olive Pizza Rajnandgaon'
      });
    }

    const targets = Array.from(targetMap.values());
    console.log(`[MonthlyReportJob] Discovered ${targets.length} valid target branch(es) for month-end pipeline.`);

    let grandTotalRevenue = 0;
    let grandTotalOrders = 0;
    let grandTotalNetSales = 0;
    const branchSummaries: Array<{
      branchName: string;
      branchId: string;
      franchiseId: string;
      grossSales: number;
      netSales: number;
      totalBills: number;
      averageOrderValue: number;
      pdfUrl: string;
      viewUrl: string;
      downloadUrl: string;
    }> = [];

    // 3. Process each branch independently with unique storage keys
    for (const target of targets) {
      const { franchiseId, branchId, branchName, franchiseName } = target;
      const reportKey = `${franchiseId}_${branchId}_${year}_${monthNum}`;
      console.log(`[MonthlyReportJob] Generating report for: ${reportKey} (${branchName})`);

      // 3.1 Generate Consolidated PDF Buffer from PostgreSQL canonical data
      const pdfBuffer = await MonthlyPdfReportService.generateMonthlyReportBuffer({
        monthName,
        year,
        branchId,
        branchName,
        franchiseId,
        franchiseName,
        channel: 'ALL'
      });

      // 3.2 Upload Consolidated PDF to Cloudflare R2
      const uploadRes = await CloudflareReportService.uploadPdfReport(
        year,
        monthName,
        pdfBuffer,
        franchiseId,
        branchId,
        'ALL'
      );
      const cloudflarePath = uploadRes.cloudflarePath;

      // 3.3 Generate secure View and Download URLs for Consolidated
      const urls = await CloudflareReportService.getReportUrls(cloudflarePath, reportKey);
      const pdfUrl = uploadRes.publicUrl || urls.downloadUrl;
      const viewUrl = urls.viewUrl;
      const downloadUrl = urls.downloadUrl;

      // 3.3.1 Generate and upload Channel-Specific PDFs (Online Orders & POS Direct Billing)
      let onlinePdfUrl = '';
      let posPdfUrl = '';
      try {
        const [onlineBuffer, posBuffer] = await Promise.all([
          MonthlyPdfReportService.generateMonthlyReportBuffer({
            monthName, year, branchId, branchName, franchiseId, franchiseName, channel: 'ONLINE'
          }),
          MonthlyPdfReportService.generateMonthlyReportBuffer({
            monthName, year, branchId, branchName, franchiseId, franchiseName, channel: 'POS'
          })
        ]);

        const [onlineUpload, posUpload] = await Promise.all([
          CloudflareReportService.uploadPdfReport(year, monthName, onlineBuffer, franchiseId, branchId, 'ONLINE'),
          CloudflareReportService.uploadPdfReport(year, monthName, posBuffer, franchiseId, branchId, 'POS')
        ]);

        const onlineUrls = await CloudflareReportService.getReportUrls(onlineUpload.cloudflarePath, `${reportKey}_online`);
        const posUrls = await CloudflareReportService.getReportUrls(posUpload.cloudflarePath, `${reportKey}_pos`);
        onlinePdfUrl = onlineUpload.publicUrl || onlineUrls.downloadUrl;
        posPdfUrl = posUpload.publicUrl || posUrls.downloadUrl;
      } catch (chErr: any) {
        console.warn(`[MonthlyReportJob] Channel-specific PDF generation notice for ${reportKey}:`, chErr.message);
      }

      // 3.4 Sync Google Sheets
      let sheetsUrl = '';
      try {
        const sheetRes = await GoogleSheetsMonthlyReportService.syncMonthlyReport({
          monthName,
          year,
          branchId,
          franchiseId,
          branchName,
          franchiseName
        });
        sheetsUrl = sheetRes.url;
      } catch (sheetErr: any) {
        console.warn(`[MonthlyReportJob] Google Sheets sync notice for ${reportKey}:`, sheetErr.message);
      }

      // 3.5 Compute deterministic sales summary
      const summary = await SalesCalculationEngine.getSalesSummary({
        branchId,
        franchiseId,
        startDate,
        endDate,
        periodLabel: `${monthName.toUpperCase()} ${year}`
      });

      grandTotalRevenue += summary.grossSales;
      grandTotalOrders += summary.totalBills;
      grandTotalNetSales += summary.netSales;

      branchSummaries.push({
        branchName,
        branchId,
        franchiseId,
        grossSales: summary.grossSales,
        netSales: summary.netSales,
        totalBills: summary.totalBills,
        averageOrderValue: summary.averageOrderValue,
        pdfUrl,
        viewUrl,
        downloadUrl
      });

      // 3.6 Store snapshot in PostgreSQL
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
        snapshotId, franchiseId, branchId, monthName, year,
        JSON.stringify(summary), cloudflarePath, pdfUrl, sheetsUrl
      ]);

      // 3.7 Update Firestore metadata with explicit scope and URLs
      const reportScope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId,
        restaurantId: branchId,
        periodMonth: monthName,
        periodYear: year,
      };

      await adminDb.collection('monthly_reports').doc(reportKey).set({
        id: reportKey,
        month: monthName,
        year,
        period: `${monthName} ${year}`,
        accessScope: reportScope.level,
        franchiseId,
        franchiseName,
        branchId,
        restaurantId: branchId,
        branchName,
        revenue: summary.grossSales,
        orders: summary.totalBills,
        averageOrderValue: summary.averageOrderValue,
        cloudflarePath,
        reportUrl: viewUrl,
        viewUrl,
        downloadUrl,
        onlinePdfUrl,
        posPdfUrl,
        sheetsUrl,
        pdfSize: uploadRes.sizeFormatted,
        status: 'COMPLETED',
        createdTime: new Date().toISOString()
      }, { merge: true });

      // 3.8 Scoped Branch Notifications (skipOwners: true prevents spamming owner on every branch)
      await MonthlyReportNotificationService.dispatchMonthlyReportNotification(
        reportScope,
        {
          reportKey,
          pdfUrl: downloadUrl,
          grossSales: summary.grossSales,
          totalOrders: summary.totalBills
        },
        { skipOwners: true }
      ).catch(err => console.error('[MonthlyReportJob] Scoped branch notification notice:', err.message));
    }

    // 4. Send EXACTLY ONE Consolidated Executive Owner Notification
    const refreshedCycleDoc = await cycleRef.get().catch(() => null);
    const refreshedCycleData = refreshedCycleDoc?.data() || {};

    if (!refreshedCycleData.ownerNotificationSent) {
      console.log(`[MonthlyReportJob] Dispatching single consolidated executive notification to owners...`);
      const primaryBranch = branchSummaries[0];
      await MonthlyReportNotificationService.dispatchExecutiveOwnerNotification({
        monthName,
        year,
        totalRevenue: grandTotalRevenue,
        totalOrders: grandTotalOrders,
        pdfUrl: primaryBranch?.downloadUrl
      }).catch(err => console.error('[MonthlyReportJob] Executive notification error:', err.message));

      await cycleRef.set({ ownerNotificationSent: true }, { merge: true }).catch(() => {});
    } else {
      console.log(`[MonthlyReportJob] Owner push notification already sent for cycle ${cycleKey}. Skipping duplicate.`);
    }

    // 5. Send EXACTLY ONE Consolidated Executive Owner Email with Styled Action Buttons
    if (!refreshedCycleData.ownerEmailSent) {
      console.log(`[MonthlyReportJob] Dispatching single executive monthly email to owner...`);
      try {
        const ownerEmail = process.env.OWNER_EMAIL || 'olivepizzarjn@gmail.com';
        const primaryBranch = branchSummaries[0];
        const publicBaseUrl = process.env.RENDER_PUBLIC_URL || 'https://olivepizza-owner.onrender.com';
        const portalUrl = `${publicBaseUrl}/reports`;
        const primaryDownloadUrl = primaryBranch?.downloadUrl.startsWith('http') 
          ? primaryBranch.downloadUrl 
          : `${publicBaseUrl}${primaryBranch?.downloadUrl}`;

        const grandAov = grandTotalOrders > 0 ? Math.round(grandTotalRevenue / grandTotalOrders) : 0;

        // Generate branch rows HTML
        const branchRowsHtml = branchSummaries.map(b => `
          <tr style="border-bottom: 1px solid #1e293b;">
            <td style="padding: 12px 14px; color: #f8fafc; font-weight: 600; font-size: 13px;">${b.branchName}</td>
            <td style="padding: 12px 14px; text-align: center; color: #94a3b8; font-size: 13px;">${b.totalBills}</td>
            <td style="padding: 12px 14px; text-align: right; color: #f97316; font-weight: 700; font-size: 13px;">₹${b.grossSales.toLocaleString('en-IN')}</td>
            <td style="padding: 12px 14px; text-align: right; color: #cbd5e1; font-size: 13px;">₹${Math.round(b.averageOrderValue).toLocaleString('en-IN')}</td>
          </tr>
        `).join('');

        const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Olive Pizza Executive Monthly Report</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f17; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0b0f17; padding: 30px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 620px; background-color: #0e1524; border-radius: 20px; border: 1px solid #1e293b; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
          
          <!-- BRAND HEADER -->
          <tr>
            <td style="padding: 32px 32px 24px; background: linear-gradient(135deg, #1e130c 0%, #0e1524 100%); border-bottom: 1px solid #1e293b;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <div style="font-size: 24px; font-weight: 900; color: #ea580c; letter-spacing: -0.5px;">🍕 OLIVE PIZZA</div>
                    <div style="font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 4px; font-weight: 700;">Executive Business Report</div>
                  </td>
                  <td align="right">
                    <span style="background-color: rgba(234, 88, 12, 0.15); color: #f97316; border: 1px solid rgba(234, 88, 12, 0.3); font-size: 12px; font-weight: 800; padding: 6px 14px; border-radius: 20px;">
                      ${monthName.toUpperCase()} ${year}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI HIGHLIGHTS CARDS -->
          <tr>
            <td style="padding: 28px 32px 16px;">
              <table role="presentation" width="100%" cellspacing="8" cellpadding="0">
                <tr>
                  <td width="33%" style="background-color: #141c2e; border: 1px solid #1e293b; border-radius: 14px; padding: 16px; text-align: center;">
                    <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Gross Revenue</div>
                    <div style="font-size: 20px; font-weight: 900; color: #10b981; margin-top: 6px;">₹${grandTotalRevenue.toLocaleString('en-IN')}</div>
                    <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Audited Total</div>
                  </td>
                  <td width="33%" style="background-color: #141c2e; border: 1px solid #1e293b; border-radius: 14px; padding: 16px; text-align: center;">
                    <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Total Orders</div>
                    <div style="font-size: 20px; font-weight: 900; color: #f8fafc; margin-top: 6px;">${grandTotalOrders}</div>
                    <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Completed Bills</div>
                  </td>
                  <td width="33%" style="background-color: #141c2e; border: 1px solid #1e293b; border-radius: 14px; padding: 16px; text-align: center;">
                    <div style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">Avg Ticket</div>
                    <div style="font-size: 20px; font-weight: 900; color: #f97316; margin-top: 6px;">₹${grandAov}</div>
                    <div style="font-size: 10px; color: #64748b; margin-top: 2px;">Per Order AOV</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- BRANCH BREAKDOWN TABLE -->
          <tr>
            <td style="padding: 12px 32px 24px;">
              <div style="font-size: 13px; font-weight: 800; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;">Branch Breakdown</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #141c2e; border: 1px solid #1e293b; border-radius: 14px; border-collapse: collapse; overflow: hidden;">
                <thead>
                  <tr style="background-color: #1a233a; border-bottom: 1px solid #1e293b;">
                    <th style="padding: 10px 14px; text-align: left; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Branch</th>
                    <th style="padding: 10px 14px; text-align: center; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Orders</th>
                    <th style="padding: 10px 14px; text-align: right; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">Revenue</th>
                    <th style="padding: 10px 14px; text-align: right; color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase;">AOV</th>
                  </tr>
                </thead>
                <tbody>
                  ${branchRowsHtml}
                </tbody>
              </table>
            </td>
          </tr>

          <!-- ACTION BUTTONS -->
          <tr>
            <td style="padding: 12px 32px 36px; text-align: center;">
              <table role="presentation" cellspacing="0" cellpadding="0" align="center">
                <tr>
                  <td align="center" style="padding-bottom: 12px;">
                    <a href="${primaryDownloadUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%); color: #ffffff; text-decoration: none; padding: 15px 32px; border-radius: 12px; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 6px 18px rgba(234, 88, 12, 0.4);">
                      📥 Download Executive PDF Report
                    </a>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <a href="${portalUrl}" target="_blank" style="display: inline-block; background-color: #141c2e; color: #cbd5e1; text-decoration: none; padding: 12px 26px; border-radius: 10px; font-weight: 700; font-size: 13px; border: 1px solid #1e293b;">
                      📊 Open Owner Reports Portal
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="padding: 20px 32px; background-color: #090d16; border-top: 1px solid #1e293b; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #64748b;">
                Confidential executive business document intended solely for authorized management of Olive Pizza.
              </p>
              <p style="margin: 4px 0 0; font-size: 11px; color: #475569;">
                Generated securely on ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' })}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `;

        await sendEmailDirect(
          ownerEmail,
          `🍕 Olive Pizza Executive Monthly Report — ${monthName} ${year} (₹${grandTotalRevenue.toLocaleString('en-IN')})`,
          emailHtml
        );

        await cycleRef.set({ ownerEmailSent: true }, { merge: true }).catch(() => {});
        console.log(`✅ [MonthlyReportJob] Executive monthly email delivered successfully to ${ownerEmail}.`);
      } catch (emailErr: any) {
        console.warn('[MonthlyReportJob] Executive email notice:', emailErr.message);
      }
    } else {
      console.log(`[MonthlyReportJob] Owner email already sent for cycle ${cycleKey}. Skipping duplicate.`);
    }

    // 6. Finalize Cycle Lock as COMPLETED
    await cycleRef.set({
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      grandTotalRevenue,
      grandTotalOrders,
      grandTotalNetSales,
      branchCount: targets.length
    }, { merge: true }).catch(err => console.warn('[MonthlyReportJob] Cycle completion notice:', err.message));

    console.log(`🏁 [MonthlyReportJob] Cycle ${cycleKey} processing finished successfully.`);
  }
}
