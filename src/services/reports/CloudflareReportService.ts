/**
 * CloudflareReportService.ts — Cloudflare R2 PDF Monthly Report Manager
 * 
 * Manages PDF report uploads, secure pre-signed URLs, listing, and deletion
 * in Cloudflare R2 under path: reports/<Year>/Olive-Pizza-<MonthYear>.pdf
 */

import { CloudflareR2Service } from '../storage/CloudflareR2Service.js';
import { adminDb as db } from '../../config/firebase.js';

export interface MonthlyReportMetadata {
  id: string;
  month: string;
  year: number;
  period?: string;
  revenue: number;
  orders: number;
  averageOrderValue?: number;
  branchId?: string;
  branchName?: string;
  franchiseId?: string;
  franchiseName?: string;
  restaurantId?: string;
  accessScope?: string;
  reportUrl?: string;
  viewUrl?: string;
  downloadUrl?: string;
  sheetsUrl?: string;
  cloudflarePath: string;
  createdTime: string;
  pdfSize?: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
}

export class CloudflareReportService {
  /**
   * Uploads a monthly PDF report buffer to Cloudflare R2 with unique deterministic branch path.
   * Format: reports/{year}/olive-pizza/{franchiseId}/{branchId}/monthly/{year}-{month}.pdf
   */
  static async uploadPdfReport(
    year: number,
    monthName: string,
    pdfBuffer: Buffer,
    franchiseId: string = 'fra_primary',
    branchId: string = 'main_branch',
    channel: 'ALL' | 'ONLINE' | 'POS' = 'ALL'
  ): Promise<{ cloudflarePath: string; publicUrl?: string; sizeFormatted: string }> {
    const monthNum = String(new Date(Date.parse(`${monthName} 1, ${year}`)).getMonth() + 1).padStart(2, '0');
    const suffix = channel === 'ONLINE' ? '-online' : channel === 'POS' ? '-pos' : '';
    const key = `reports/${year}/olive-pizza/${franchiseId}/${branchId}/monthly/${year}-${monthNum}${suffix}.pdf`;
    const sizeKb = (pdfBuffer.length / 1024).toFixed(1);
    const sizeFormatted = pdfBuffer.length > 1024 * 1024
      ? `${(pdfBuffer.length / (1024 * 1024)).toFixed(2)} MB`
      : `${sizeKb} KB`;

    console.log(`[CloudflareReportService] Uploading PDF report to R2: "${key}" (${sizeFormatted})...`);

    const result = await CloudflareR2Service.uploadBuffer(key, pdfBuffer, 'application/pdf');

    return {
      cloudflarePath: key,
      publicUrl: result.url,
      sizeFormatted,
    };
  }

  /**
   * Generates secure time-limited view and download URLs for a report.
   * If R2 is unconfigured, uses the backend API endpoint (/api/reports/monthly/:reportId/view and /download).
   */
  static async getReportUrls(
    cloudflarePath: string,
    reportId?: string,
    expiresInSeconds: number = 86400
  ): Promise<{ viewUrl: string; downloadUrl: string }> {
    const fallbackId = reportId || cloudflarePath.split('/').pop()?.replace('.pdf', '') || 'latest';
    const filename = `Olive-Pizza-Report-${fallbackId}.pdf`;

    if (CloudflareR2Service.isConfigured()) {
      try {
        const disposition = `attachment; filename="${encodeURIComponent(filename)}"`;
        const viewUrl = await CloudflareR2Service.generatePreSignedUrl(cloudflarePath, expiresInSeconds);
        const downloadUrl = (await CloudflareR2Service.generatePreSignedUrl(cloudflarePath, expiresInSeconds, disposition)) || viewUrl;
        if (viewUrl && downloadUrl) {
          return { viewUrl, downloadUrl };
        }
      } catch (err: any) {
        console.warn(`[CloudflareReportService] R2 pre-signed URL warning for "${cloudflarePath}":`, err.message);
      }
    }

    // Fallback: API endpoint routes
    const apiViewUrl = `/api/reports/monthly/${fallbackId}/view`;
    const apiDownloadUrl = `/api/reports/monthly/${fallbackId}/download`;

    return { viewUrl: apiViewUrl, downloadUrl: apiDownloadUrl };
  }

  /**
   * Archives report metadata into Firestore collection `monthly_reports`.
   */
  static async saveReportMetadata(metadata: MonthlyReportMetadata): Promise<void> {
    try {
      await db.collection('monthly_reports').doc(metadata.id).set(metadata, { merge: true });
      console.log(`[CloudflareReportService] Saved report metadata for "${metadata.id}" in Firestore.`);
    } catch (err: any) {
      console.error(`[CloudflareReportService] Error saving metadata for "${metadata.id}":`, err.message);
    }
  }

  /**
   * Deletes a monthly report from Cloudflare R2 and Firestore.
   */
  static async deleteReport(reportId: string, cloudflarePath?: string): Promise<boolean> {
    try {
      if (cloudflarePath && CloudflareR2Service.isConfigured()) {
        await CloudflareR2Service.deleteObject(cloudflarePath);
      }
      await db.collection('monthly_reports').doc(reportId).delete();
      console.log(`[CloudflareReportService] Successfully deleted report "${reportId}"`);
      return true;
    } catch (err: any) {
      console.error(`[CloudflareReportService] Error deleting report "${reportId}":`, err.message);
      return false;
    }
  }

  /**
   * Lists all monthly reports from Firestore and updates signed URLs.
   */
  static async listMonthlyReports(limitCount: number = 100): Promise<MonthlyReportMetadata[]> {
    try {
      const snap = await db.collection('monthly_reports').orderBy('createdTime', 'desc').limit(limitCount).get();
      const reports: MonthlyReportMetadata[] = await Promise.all(
        snap.docs.map(async (doc) => {
          const item = doc.data() as MonthlyReportMetadata;
          item.id = item.id || doc.id;
          const urls = await this.getReportUrls(item.cloudflarePath || `reports/${item.id}.pdf`, item.id);
          item.viewUrl = urls.viewUrl;
          item.reportUrl = urls.viewUrl;
          item.downloadUrl = urls.downloadUrl;
          if (!item.period) {
            item.period = `${item.month} ${item.year}`;
          }
          return item;
        })
      );

      return reports;
    } catch (err: any) {
      console.error('[CloudflareReportService] Error listing monthly reports:', err.message);
      return [];
    }
  }
}
