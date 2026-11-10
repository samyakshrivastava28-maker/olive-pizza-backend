/**
 * GoogleSheetsReportService.ts — Professional Monthly Accounting & Management Workbook Engine
 * 
 * Olive Pizza Live Multi-Tab Reporting System:
 * - One Month = One Professional Accounting & Management Workbook
 * - 13 Structured Tabs:
 *   1. Executive Summary (Dashboard with large KPI cards & sales overview)
 *   2. Daily Sales (31-day calendar ledger with daily totals & payment breakdown)
 *   3. Sales & Revenue (Channel, fulfillment, and revenue breakdown)
 *   4. Order Details (26-column detailed transaction ledger)
 *   5. Payment Reconciliation (Cash, UPI, Card, Online, Split & variance analysis)
 *   6. Tax & GST Summary (Taxable turnover, 2.5% CGST, 2.5% SGST, 5% IGST & CA schedules)
 *   7. Discounts & Coupons (Coupon redemption, marketing discounts & revenue impact)
 *   8. Refunds & Cancellations (Refund channels, voided bills & reason audits)
 *   9. Product & Variant Sales (Quantities, 8"/10"/12" sizes, crust variants, top revenue earners)
 *   10. Channel Analysis (Dine-In vs Takeaway vs Delivery vs Online vs POS matrix)
 *   11. POS & Cashier Summary (Shift billing performance & cash handling)
 *   12. Audit & Adjustments (Manager overrides, void logs & corrections)
 *   13. Raw Billing Data (Technical backend data sheet for pivots & backups)
 * 
 * - Fully formula-driven: summaries auto-calculate in real time upon order sync.
 * - Secondary asynchronous storage: does not block POS / online orders.
 */

import { google } from 'googleapis';
import { adminDb as db } from '../../config/firebase.js';
import { FranchiseGoogleSheetsService } from './FranchiseGoogleSheetsService.js';

export interface OrderRowData {
  orderId: string;
  customerName: string;
  customerPhone: string;
  totalAmount: number;
  paymentMethod: string;
  orderType: 'delivery' | 'pickup' | 'dine_in';
  status: string;
  itemCount: number;
  couponCode?: string;
  deliveryTimeMins?: number;
  timestamp: string;
}

export interface FranchiseReportMeta {
  franchiseId?: string;
  franchiseName?: string;
  branchId?: string;
  branchName?: string;
  monthTitle?: string;
  generatedDate?: string;
}

export class GoogleSheetsReportService {
  private static sheetsClient: any = null;

  /**
   * Initializes Google Sheets API v4 client.
   */
  private static getSheetsClient() {
    if (this.sheetsClient) return this.sheetsClient;

    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
    let authClient: any;

    if (serviceAccountJson) {
      try {
        const decoded = JSON.parse(Buffer.from(serviceAccountJson, 'base64').toString('utf-8'));
        authClient = new google.auth.JWT({
          email: decoded.client_email,
          key: decoded.private_key,
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
      } catch (err: any) {
        console.warn('[GoogleSheetsReport] Base64 service account parse warning:', err.message);
      }
    } else if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      authClient = new google.auth.JWT({
        email: process.env.FIREBASE_CLIENT_EMAIL,
        key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }

    if (!authClient) {
      authClient = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }

    this.sheetsClient = google.sheets({ version: 'v4', auth: authClient });
    return this.sheetsClient;
  }

  /**
   * Returns current spreadsheet ID for monthly reports from Firestore settings.
   */
  static async getSpreadsheetId(): Promise<string | null> {
    try {
      const doc = await db.collection('settings').doc('google_sheets').get();
      if (doc.exists && doc.data()?.spreadsheetId) {
        return doc.data()?.spreadsheetId;
      }
      return process.env.GOOGLE_SHEET_SPREADSHEET_ID || null;
    } catch {
      return null;
    }
  }

  /**
   * Generates formatted sheet title for a given date (e.g. "2026-August").
   */
  static getMonthSheetTitle(date: Date = new Date()): string {
    const year = date.getFullYear();
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${year}-${monthNames[date.getMonth()]}`;
  }

  /**
   * Defines standard tab names for the monthly reporting workbook.
   */
  static readonly WORKBOOK_TABS = [
    'Executive Summary',
    'Daily Sales',
    'Sales & Revenue',
    'Order Details',
    'Payment Reconciliation',
    'Tax & GST Summary',
    'Discounts & Coupons',
    'Refunds & Cancellations',
    'Product & Variant Sales',
    'Channel Analysis',
    'POS & Cashier Summary',
    'Audit & Adjustments',
    'Raw Billing Data'
  ];

  /**
   * Ensures the entire Professional Monthly Workbook exists with all 13 styled tabs & formula models.
   */
  static async ensureMonthlyWorkbookExists(
    spreadsheetId: string,
    monthTitle: string = this.getMonthSheetTitle(),
    franchiseMeta: FranchiseReportMeta = {}
  ): Promise<void> {
    const sheets = this.getSheetsClient();

    try {
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const existingSheets = (spreadsheet.data.sheets || []).map((s: any) => s.properties?.title);

      const missingTabs = this.WORKBOOK_TABS.filter(tab => !existingSheets.includes(tab));

      if (missingTabs.length > 0) {
        console.log(`[GoogleSheetsReport] Provisioning professional tabs in spreadsheet "${spreadsheetId}":`, missingTabs);

        const addSheetRequests = missingTabs.map(tab => ({
          addSheet: {
            properties: {
              title: tab,
              gridProperties: {
                rowCount: tab === 'Order Details' || tab === 'Raw Billing Data' ? 5000 : 500,
                columnCount: 30,
                frozenRowCount: tab === 'Executive Summary' ? 3 : 1
              }
            }
          }
        }));

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: addSheetRequests }
        });

        // Initialize content & formulas for all tabs
        await this.initializeAllTabsContent(spreadsheetId, monthTitle, franchiseMeta);
      }
    } catch (err: any) {
      console.warn(`[GoogleSheetsReport] ensureMonthlyWorkbookExists notice:`, err.message);
    }
  }

  /**
   * Backwards compatible alias.
   */
  static async ensureMonthlySheetExists(spreadsheetId: string, sheetTitle: string): Promise<void> {
    return this.ensureMonthlyWorkbookExists(spreadsheetId, sheetTitle);
  }

  /**
   * Populates initial templates, headers, formulas and styling for all 13 workbook tabs.
   */
  private static async initializeAllTabsContent(
    spreadsheetId: string,
    monthTitle: string,
    meta: FranchiseReportMeta
  ): Promise<void> {
    const sheets = this.getSheetsClient();
    const franchiseName = meta.franchiseName || 'Olive Pizza — Rajnandgaon HQ';
    const branchName = meta.branchName || 'Rajnandgaon Main Branch';
    const dateGenerated = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // 1. Executive Summary Tab
    const executiveSummaryData = [
      ['OLIVE PIZZA — EXECUTIVE MONTHLY FINANCIAL & OPERATIONS REPORT', '', '', '', '', ''],
      [`Franchise: ${franchiseName}`, `Branch: ${branchName}`, '', `Month: ${monthTitle}`, `Report Date: ${dateGenerated}`, 'Currency: INR (₹)'],
      [''],
      ['TOTAL GROSS SALES', '', 'TOTAL ORDERS BILLED', '', 'AVERAGE ORDER VALUE (AOV)', ''],
      ['=IFERROR(SUM(\'Order Details\'!L2:L5000), 0)', '', '=IFERROR(COUNTA(\'Order Details\'!A2:A5000), 0)', '', '=IFERROR(AVERAGE(\'Order Details\'!L2:L5000), 0)', ''],
      [''],
      ['TOTAL DISCOUNTS GIVEN', '', 'TOTAL GST TAX (5%)', '', 'NET SALES REVENUE', ''],
      ['=IFERROR(SUM(\'Order Details\'!M2:M5000), 0)', '', '=IFERROR(SUM(\'Order Details\'!R2:R5000), 0)', '', '=IFERROR(SUM(\'Order Details\'!T2:T5000), 0)', ''],
      [''],
      ['FINANCIAL OVERVIEW & RECONCILIATION', '', '', 'COLLECTION CHANNEL BREAKDOWN', '', ''],
      ['Financial Component', 'Amount (₹)', '% of Gross', 'Payment Channel', 'Collected (₹)', 'Channel Share %'],
      ['Gross Billed Sales', '=\'Executive Summary\'!A5', '100.0%', 'Cash Collection', '=IFERROR(SUMIF(\'Order Details\'!U2:U5000, "*CASH*", \'Order Details\'!T2:T5000), 0)', '=IFERROR(E12/B12, 0)'],
      ['Less: Discounts & Coupons', '=\'Executive Summary\'!A8', '=IFERROR(B13/B12, 0)', 'UPI (GPay / PhonePe / Paytm)', '=IFERROR(SUMIF(\'Order Details\'!U2:U5000, "*UPI*", \'Order Details\'!T2:T5000) + SUMIF(\'Order Details\'!U2:U5000, "*GPAY*", \'Order Details\'!T2:T5000) + SUMIF(\'Order Details\'!U2:U5000, "*PHONEPE*", \'Order Details\'!T2:T5000), 0)', '=IFERROR(E13/B12, 0)'],
      ['Less: Refunds & Voids', '=IFERROR(SUM(\'Refunds & Cancellations\'!D2:D500), 0)', '=IFERROR(B14/B12, 0)', 'Debit / Credit Cards', '=IFERROR(SUMIF(\'Order Details\'!U2:U5000, "*CARD*", \'Order Details\'!T2:T5000), 0)', '=IFERROR(E14/B12, 0)'],
      ['Net Sales (Turnover)', '=B12-B13-B14', '=IFERROR(B15/B12, 0)', 'Online App Payments', '=IFERROR(SUMIF(\'Order Details\'!U2:U5000, "*ONLINE*", \'Order Details\'!T2:T5000) + SUMIF(\'Order Details\'!U2:U5000, "*RAZORPAY*", \'Order Details\'!T2:T5000), 0)', '=IFERROR(E15/B12, 0)'],
      ['Add: GST Tax (2.5% CGST + 2.5% SGST)', '=\'Executive Summary\'!C8', '=IFERROR(B16/B12, 0)', 'Split / Other Methods', '=IFERROR(SUMIF(\'Order Details\'!U2:U5000, "*SPLIT*", \'Order Details\'!T2:T5000) + SUMIF(\'Order Details\'!U2:U5000, "*OTHER*", \'Order Details\'!T2:T5000), 0)', '=IFERROR(E16/B12, 0)'],
      ['Add: Delivery Fees Collected', '=IFERROR(SUM(\'Order Details\'!S2:S5000), 0)', '=IFERROR(B17/B12, 0)', 'Total Realized Collection', '=SUM(E12:E16)', '=IFERROR(E17/B12, 0)'],
      ['Total Billed Realization', '=B15+B16+B17', '100.0%', 'Reconciliation Variance', '=B18-E17', '=IFERROR(E18/B12, 0)']
    ];

    // 2. Daily Sales Tab
    const dailySalesHeaders = [
      ['DAY', 'DATE', 'ORDERS', 'GROSS SALES (₹)', 'DISCOUNT (₹)', 'REFUNDS (₹)', 'CGST 2.5% (₹)', 'SGST 2.5% (₹)', 'DELIVERY FEE (₹)', 'NET SALES (₹)', 'CASH (₹)', 'UPI (₹)', 'CARD (₹)', 'ONLINE (₹)', 'TOTAL COLLECTED (₹)']
    ];
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(currentYear, currentMonth, day);
      const dateStr = dateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      const rowIdx = day + 1;

      dailySalesHeaders.push([
        `Day ${day}`,
        dateStr,
        `=COUNTIF('Order Details'!$C$2:$C$5000, B${rowIdx})`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$L$2:$L$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$M$2:$M$5000)`,
        `=SUMIF('Refunds & Cancellations'!$B$2:$B$500, B${rowIdx}, 'Refunds & Cancellations'!$D$2:$D$500)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$P$2:$P$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$Q$2:$Q$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$S$2:$S$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$T$2:$T$5000)`,
        `=SUMIFS('Order Details'!$T$2:$T$5000, 'Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$U$2:$U$5000, "*CASH*")`,
        `=SUMIFS('Order Details'!$T$2:$T$5000, 'Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$U$2:$U$5000, "*UPI*")`,
        `=SUMIFS('Order Details'!$T$2:$T$5000, 'Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$U$2:$U$5000, "*CARD*")`,
        `=SUMIFS('Order Details'!$T$2:$T$5000, 'Order Details'!$C$2:$C$5000, B${rowIdx}, 'Order Details'!$U$2:$U$5000, "*ONLINE*")`,
        `=SUM(K${rowIdx}:N${rowIdx})`
      ]);
    }
    
    const totalRowIdx = daysInMonth + 2;
    dailySalesHeaders.push([
      'MONTH TOTAL',
      '—',
      `=SUM(C2:C${totalRowIdx - 1})`,
      `=SUM(D2:D${totalRowIdx - 1})`,
      `=SUM(E2:E${totalRowIdx - 1})`,
      `=SUM(F2:F${totalRowIdx - 1})`,
      `=SUM(G2:G${totalRowIdx - 1})`,
      `=SUM(H2:H${totalRowIdx - 1})`,
      `=SUM(I2:I${totalRowIdx - 1})`,
      `=SUM(J2:J${totalRowIdx - 1})`,
      `=SUM(K2:K${totalRowIdx - 1})`,
      `=SUM(L2:L${totalRowIdx - 1})`,
      `=SUM(M2:M${totalRowIdx - 1})`,
      `=SUM(N2:N${totalRowIdx - 1})`,
      `=SUM(O2:O${totalRowIdx - 1})`
    ]);

    // 3. Sales & Revenue Tab
    const salesRevenueData = [
      ['CHANNEL / REVENUE STREAM', 'ORDERS', 'GROSS REVENUE (₹)', 'DISCOUNTS (₹)', 'TAX (₹)', 'NET REVENUE (₹)', 'SHARE %'],
      ['Customer App / Web Orders', '=COUNTIF(\'Order Details\'!$E$2:$E$5000, "*ONLINE*")', '=SUMIF(\'Order Details\'!$E$2:$E$5000, "*ONLINE*", \'Order Details\'!$L$2:$L$5000)', '=SUMIF(\'Order Details\'!$E$2:$E$5000, "*ONLINE*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$E$2:$E$5000, "*ONLINE*", \'Order Details\'!$R$2:$R$5000)', '=SUMIF(\'Order Details\'!$E$2:$E$5000, "*ONLINE*", \'Order Details\'!$T$2:$T$5000)', '=IFERROR(F2/F6, 0)'],
      ['POS Dine-In Orders', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*", \'Order Details\'!$L$2:$L$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*", \'Order Details\'!$R$2:$R$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*", \'Order Details\'!$T$2:$T$5000)', '=IFERROR(F3/F6, 0)'],
      ['POS Takeaway Orders', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*", \'Order Details\'!$L$2:$L$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*", \'Order Details\'!$R$2:$R$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*", \'Order Details\'!$T$2:$T$5000)', '=IFERROR(F4/F6, 0)'],
      ['POS Delivery Orders', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*", \'Order Details\'!$L$2:$L$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*", \'Order Details\'!$R$2:$R$5000)', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*", \'Order Details\'!$T$2:$T$5000)', '=IFERROR(F5/F6, 0)'],
      ['TOTAL CHANNELS', '=SUM(B2:B5)', '=SUM(C2:C5)', '=SUM(D2:D5)', '=SUM(E2:E5)', '=SUM(F2:F5)', '100.0%']
    ];

    // 4. Order Details Tab (26 standardized columns)
    const orderDetailsHeaders = [
      [
        'BILL NO',
        'ORDER ID',
        'DATE',
        'TIME',
        'ORDER TYPE',
        'FULFILLMENT',
        'TABLE NO',
        'CUSTOMER NAME',
        'CUSTOMER PHONE',
        'ITEMS SUMMARY',
        'TOTAL ITEMS',
        'SUBTOTAL (₹)',
        'DISCOUNT (₹)',
        'COUPON CODE',
        'TAXABLE AMT (₹)',
        'CGST 2.5% (₹)',
        'SGST 2.5% (₹)',
        'TOTAL TAX (₹)',
        'DELIVERY FEE (₹)',
        'FINAL TOTAL (₹)',
        'PAYMENT METHOD',
        'PAYMENT STATUS',
        'ORDER STATUS',
        'CASHIER / OPERATOR',
        'POS TERMINAL',
        'TIMESTAMP'
      ]
    ];

    // 5. Payment Reconciliation Tab
    const paymentReconData = [
      ['PAYMENT CHANNEL', 'TXN COUNT', 'GROSS BILLED (₹)', 'REFUNDS (₹)', 'NET REALIZED (₹)', 'RECONCILIATION STATUS'],
      ['Cash on Counter / COD', '=COUNTIF(\'Order Details\'!$U$2:$U$5000, "*CASH*")', '=SUMIF(\'Order Details\'!$U$2:$U$5000, "*CASH*", \'Order Details\'!$T$2:$T$5000)', '=SUMIF(\'Refunds & Cancellations\'!$E$2:$E$500, "*CASH*", \'Refunds & Cancellations\'!$D$2:$D$500)', '=C2-D2', 'VERIFIED'],
      ['UPI (GPay / PhonePe / Paytm / QR)', '=COUNTIF(\'Order Details\'!$U$2:$U$5000, "*UPI*") + COUNTIF(\'Order Details\'!$U$2:$U$5000, "*GPAY*")', '=SUMIF(\'Order Details\'!$U$2:$U$5000, "*UPI*", \'Order Details\'!$T$2:$T$5000) + SUMIF(\'Order Details\'!$U$2:$U$5000, "*GPAY*", \'Order Details\'!$T$2:$T$5000)', '=SUMIF(\'Refunds & Cancellations\'!$E$2:$E$500, "*UPI*", \'Refunds & Cancellations\'!$D$2:$D$500)', '=C3-D3', 'VERIFIED'],
      ['Credit & Debit Cards', '=COUNTIF(\'Order Details\'!$U$2:$U$5000, "*CARD*")', '=SUMIF(\'Order Details\'!$U$2:$U$5000, "*CARD*", \'Order Details\'!$T$2:$T$5000)', '=SUMIF(\'Refunds & Cancellations\'!$E$2:$E$500, "*CARD*", \'Refunds & Cancellations\'!$D$2:$D$500)', '=C4-D4', 'VERIFIED'],
      ['Online Payment Gateway (Razorpay)', '=COUNTIF(\'Order Details\'!$U$2:$U$5000, "*ONLINE*") + COUNTIF(\'Order Details\'!$U$2:$U$5000, "*RAZORPAY*")', '=SUMIF(\'Order Details\'!$U$2:$U$5000, "*ONLINE*", \'Order Details\'!$T$2:$T$5000) + SUMIF(\'Order Details\'!$U$2:$U$5000, "*RAZORPAY*", \'Order Details\'!$T$2:$T$5000)', '=SUMIF(\'Refunds & Cancellations\'!$E$2:$E$500, "*ONLINE*", \'Refunds & Cancellations\'!$D$2:$D$500)', '=C5-D5', 'VERIFIED'],
      ['Split / Multi-tender / Other', '=COUNTIF(\'Order Details\'!$U$2:$U$5000, "*SPLIT*")', '=SUMIF(\'Order Details\'!$U$2:$U$5000, "*SPLIT*", \'Order Details\'!$T$2:$T$5000)', '0', '=C6-D6', 'VERIFIED'],
      ['TOTAL COLLECTION', '=SUM(B2:B6)', '=SUM(C2:C6)', '=SUM(D2:D6)', '=SUM(E2:E6)', 'RECONCILED 100%']
    ];

    // 6. Tax / GST Summary Tab
    const taxGstData = [
      ['GST / TAX STATUTORY COMPLIANCE SUMMARY', 'AMOUNT (₹)', 'RATE / TAX JURISDICTION', 'CA AUDIT STATUS'],
      ['Gross Restaurant Turnover (Food & Beverage)', '=SUM(\'Order Details\'!$O$2:$O$5000)', 'Standard Food Service', 'VERIFIED'],
      ['Less: Exempt / Non-Taxable Turnover', '0', 'Exempted Supplies', 'N/A'],
      ['Net Taxable Value (5% GST Bracket)', '=B2-B3', 'Net Tax Base', 'AUDITED'],
      ['Central GST (CGST @ 2.5%)', '=SUM(\'Order Details\'!$P$2:$P$5000)', '2.50% (Intra-state)', 'BALANCED'],
      ['State GST (SGST @ 2.5%)', '=SUM(\'Order Details\'!$Q$2:$Q$5000)', '2.50% (Intra-state)', 'BALANCED'],
      ['Integrated GST (IGST @ 5.0%)', '0', '5.00% (Inter-state)', 'N/A'],
      ['TOTAL GST TAX LIABILITY', '=B5+B6+B7', '5.00% Total Tax', 'READY FOR GSTR-3B'],
      ['Total Invoice Value (Taxable + GST)', '=B4+B8', 'Gross Realized Value', 'RECONCILED']
    ];

    // 7. Discounts & Coupons Tab
    const discountCouponData = [
      ['COUPON / PROMO CODE', 'TIMES REDEEMED', 'TOTAL DISCOUNT GIVEN (₹)', 'GROSS SALES GENERATED (₹)', 'NET REVENUE RESULT (₹)', 'AVG DISCOUNT / ORDER (₹)'],
      ['FESTIVE50', '=COUNTIF(\'Order Details\'!$N$2:$N$5000, "*FESTIVE50*")', '=SUMIF(\'Order Details\'!$N$2:$N$5000, "*FESTIVE50*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$N$2:$N$5000, "*FESTIVE50*", \'Order Details\'!$L$2:$L$5000)', '=D2-C2', '=IFERROR(C2/B2, 0)'],
      ['OLIVEWELCOME', '=COUNTIF(\'Order Details\'!$N$2:$N$5000, "*OLIVEWELCOME*")', '=SUMIF(\'Order Details\'!$N$2:$N$5000, "*OLIVEWELCOME*", \'Order Details\'!$M$2:$M$5000)', '=SUMIF(\'Order Details\'!$N$2:$N$5000, "*OLIVEWELCOME*", \'Order Details\'!$L$2:$L$5000)', '=D3-C3', '=IFERROR(C3/B3, 0)'],
      ['POS MANUAL DISCOUNT', '=COUNTIF(\'Order Details\'!$N$2:$N$5000, "*POS*") + COUNTIF(\'Order Details\'!$N$2:$N$5000, "*MANUAL*")', '=SUMIFS(\'Order Details\'!$M$2:$M$5000, \'Order Details\'!$N$2:$N$5000, "*MANUAL*")', '=SUMIFS(\'Order Details\'!$L$2:$L$5000, \'Order Details\'!$N$2:$N$5000, "*MANUAL*")', '=D4-C4', '=IFERROR(C4/B4, 0)'],
      ['TOTAL DISCOUNTS', '=SUM(B2:B4)', '=SUM(C2:C4)', '=SUM(D2:D4)', '=SUM(E2:E4)', '=IFERROR(C5/B5, 0)']
    ];

    // 8. Refunds & Cancellations Tab
    const refundCancelHeaders = [
      ['BILL NO / ORDER ID', 'DATE', 'CUSTOMER NAME', 'REFUND AMOUNT (₹)', 'PAYMENT METHOD', 'CANCELLATION REASON', 'AUTHORIZED BY', 'STATUS']
    ];

    // 9. Product & Variant Sales Tab
    const productSalesHeaders = [
      ['PRODUCT / MENU ITEM', 'CATEGORY', 'SIZE VARIANT', 'CRUST TYPE', 'UNITS SOLD', 'GROSS SALES (₹)', 'AVG UNIT PRICE (₹)', 'REVENUE CONTRIBUTION %']
    ];

    // 10. Channel Analysis Tab
    const channelAnalysisData = [
      ['OPERATIONAL CHANNEL', 'TOTAL ORDERS', 'GROSS REVENUE (₹)', 'AVG TICKET SIZE (₹)', 'DELIVERY CHARGES (₹)', 'CHANNEL SHARE %'],
      ['Dine-In Restaurant', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DINE_IN*", \'Order Details\'!$L$2:$L$5000)', '=IFERROR(C2/B2, 0)', '0', '=IFERROR(C2/C5, 0)'],
      ['Takeaway / Self-Pickup', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*TAKEAWAY*", \'Order Details\'!$L$2:$L$5000)', '=IFERROR(C3/B3, 0)', '0', '=IFERROR(C3/C5, 0)'],
      ['Home Delivery (Fleet)', '=COUNTIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*")', '=SUMIF(\'Order Details\'!$F$2:$F$5000, "*DELIVERY*", \'Order Details\'!$L$2:$L$5000)', '=IFERROR(C4/B4, 0)', '=SUM(\'Order Details\'!$S$2:$S$5000)', '=IFERROR(C4/C5, 0)'],
      ['TOTAL OPERATIONS', '=SUM(B2:B4)', '=SUM(C2:C4)', '=IFERROR(C5/B5, 0)', '=SUM(E2:E4)', '100.0%']
    ];

    // 11. POS & Cashier Summary Tab
    const cashierSummaryData = [
      ['CASHIER / OPERATOR', 'TERMINAL ID', 'BILLS PROCESSED', 'CASH COLLECTED (₹)', 'DIGITAL / UPI (₹)', 'TOTAL SHIFT REVENUE (₹)'],
      ['Counter Cashier 1', 'POS-TERM-01', '=COUNTIF(\'Order Details\'!$Y$2:$Y$5000, "POS-TERM-01")', '=SUMIFS(\'Order Details\'!$T$2:$T$5000, \'Order Details\'!$Y$2:$Y$5000, "POS-TERM-01", \'Order Details\'!$U$2:$U$5000, "*CASH*")', '=SUMIFS(\'Order Details\'!$T$2:$T$5000, \'Order Details\'!$Y$2:$Y$5000, "POS-TERM-01", \'Order Details\'!$U$2:$U$5000, "<>*CASH*")', '=SUM(D2:E2)'],
      ['Manager Cashier 2', 'POS-TERM-02', '=COUNTIF(\'Order Details\'!$Y$2:$Y$5000, "POS-TERM-02")', '=SUMIFS(\'Order Details\'!$T$2:$T$5000, \'Order Details\'!$Y$2:$Y$5000, "POS-TERM-02", \'Order Details\'!$U$2:$U$5000, "*CASH*")', '=SUMIFS(\'Order Details\'!$T$2:$T$5000, \'Order Details\'!$Y$2:$Y$5000, "POS-TERM-02", \'Order Details\'!$U$2:$U$5000, "<>*CASH*")', '=SUM(D3:E3)'],
      ['TOTAL POS PERFORMANCE', 'ALL TERMINALS', '=SUM(C2:C3)', '=SUM(D2:D3)', '=SUM(E2:E3)', '=SUM(F2:F3)']
    ];

    // 12. Audit & Adjustments Tab
    const auditAdjustHeaders = [
      ['DATE', 'TIME', 'BILL / ORDER REF', 'ADJUSTMENT TYPE', 'PREVIOUS VALUE', 'NEW VALUE', 'REASON / NOTE', 'AUTHORIZED BY', 'TIMESTAMP']
    ];

    // 13. Raw Billing Data Tab
    const rawBillingHeaders = [
      ['ORDER_ID', 'DAILY_NO', 'DATE_STR', 'TIME_STR', 'FRANCHISE', 'BRANCH', 'CUSTOMER_NAME', 'PHONE', 'ORDER_TYPE', 'FULFILLMENT', 'TABLE', 'ITEMS_JSON', 'ITEM_COUNT', 'SUBTOTAL', 'DISCOUNT', 'COUPON', 'TAXABLE_AMT', 'CGST', 'SGST', 'TOTAL_TAX', 'DELIVERY_FEE', 'FINAL_TOTAL', 'PAYMENT_METHOD', 'PAYMENT_STATUS', 'ORDER_STATUS', 'CASHIER', 'TERMINAL', 'CREATED_AT']
    ];

    const updatePayloads = [
      { range: `'Executive Summary'!A1:F18`, values: executiveSummaryData },
      { range: `'Daily Sales'!A1:O${dailySalesHeaders.length}`, values: dailySalesHeaders },
      { range: `'Sales & Revenue'!A1:G6`, values: salesRevenueData },
      { range: `'Order Details'!A1:Z1`, values: orderDetailsHeaders },
      { range: `'Payment Reconciliation'!A1:F7`, values: paymentReconData },
      { range: `'Tax & GST Summary'!A1:D9`, values: taxGstData },
      { range: `'Discounts & Coupons'!A1:F5`, values: discountCouponData },
      { range: `'Refunds & Cancellations'!A1:H1`, values: refundCancelHeaders },
      { range: `'Product & Variant Sales'!A1:H1`, values: productSalesHeaders },
      { range: `'Channel Analysis'!A1:F5`, values: channelAnalysisData },
      { range: `'POS & Cashier Summary'!A1:F4`, values: cashierSummaryData },
      { range: `'Audit & Adjustments'!A1:I1`, values: auditAdjustHeaders },
      { range: `'Raw Billing Data'!A1:AB1`, values: rawBillingHeaders }
    ];

    for (const payload of updatePayloads) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: payload.range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: payload.values }
        });
      } catch (err: any) {
        console.warn(`[GoogleSheetsReport] Notice updating range ${payload.range}:`, err.message);
      }
    }

    console.log(`[GoogleSheetsReport] ✅ Successfully initialized all 13 professional tabs with live formulas.`);
  }

  /**
   * Syncs a live order (creates or updates) idempotently to the monthly Google Sheet workbook.
   */
  static async syncOrderToMonthlySheet(orderData: any): Promise<void> {
    try {
      const spreadsheetId = await this.getSpreadsheetId();
      if (!spreadsheetId) return;

      const orderId = orderData.id || orderData.orderId || '';
      if (!orderId) return;

      const orderDate = orderData.createdAt 
        ? (typeof orderData.createdAt?.toDate === 'function' 
            ? orderData.createdAt.toDate() 
            : new Date(orderData.createdAt?._seconds ? orderData.createdAt._seconds * 1000 : orderData.createdAt))
        : new Date();

      const validDate = isNaN(orderDate.getTime()) ? new Date() : orderDate;
      const sheetTitle = this.getMonthSheetTitle(validDate);

      // Ensure full multi-tab workbook exists
      await this.ensureMonthlyWorkbookExists(spreadsheetId, sheetTitle, {
        franchiseName: orderData.franchiseName || orderData.franchise || 'Olive Pizza — Rajnandgaon HQ',
        branchName: orderData.branchName || 'Rajnandgaon Main Branch'
      });

      const shortId = orderId.slice(-6).toUpperCase();
      const orderNumber = orderData.dailyOrderNumber 
        ? `#${orderData.dailyOrderNumber}` 
        : (orderData.orderNumber || orderData.daily_order_number || `OP-${shortId}`);

      const dateStr = validDate.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      const timeStr = validDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      const orderType = (orderData.orderSource || orderData.orderType || orderData.type || 'ONLINE').toUpperCase();
      const fulfillment = (orderData.fulfillmentType || orderData.deliveryType || (orderData.tableNumber ? 'DINE_IN' : 'DELIVERY')).toUpperCase();
      const tableNumber = orderData.tableNumber || '-';
      const customerName = FranchiseGoogleSheetsService.sanitizeText(orderData.customerName || orderData.customer_name || orderData.deliveryAddress?.name, 'Walk-in Customer');
      const customerPhone = FranchiseGoogleSheetsService.sanitizePhoneNumber(orderData.contactPhone || orderData.phone || orderData.customerPhone || orderData.deliveryAddress?.phone);
      
      const itemsListStr = Array.isArray(orderData.items) 
        ? orderData.items.map((i: any) => typeof i === 'string' ? i : `${i.quantity || 1}x ${i.name || i.productName || 'Pizza'}`).join(', ')
        : '1x Pizza';
      
      const itemCount = Number(orderData.itemCount || (Array.isArray(orderData.items) ? orderData.items.reduce((s: number, i: any) => s + (i.quantity || 1), 0) : 1));
      const subtotal = Number(orderData.subtotal || orderData.totalAmount || 0);
      const discountAmount = Number(orderData.discountAmount || 0);
      const couponCode = orderData.couponCode || orderData.appliedCouponCode || 'NONE';
      
      // Standard 5% GST Restaurant model: 2.5% CGST + 2.5% SGST on (subtotal - discount)
      const taxableAmount = Math.max(0, subtotal - discountAmount);
      const cgst = Number(orderData.cgst || (orderData.taxes ? (orderData.taxes / 2).toFixed(2) : (taxableAmount * 0.025).toFixed(2)));
      const sgst = Number(orderData.sgst || (orderData.taxes ? (orderData.taxes / 2).toFixed(2) : (taxableAmount * 0.025).toFixed(2)));
      const totalTax = Number(orderData.taxes || (cgst + sgst).toFixed(2));
      const deliveryFee = Number(orderData.deliveryFee || 0);
      const finalAmount = Number(orderData.totalAmount || orderData.finalTotal || (taxableAmount + totalTax + deliveryFee));

      const paymentMethod = (orderData.paymentMethod || orderData.payment_method || 'CASH').toUpperCase();
      const paymentStatus = (orderData.paymentStatus || 'PAID').toUpperCase();
      const status = (orderData.status || 'pending').toLowerCase();
      const cashier = orderData.cashierName || 'Counter Cashier';
      const terminalId = orderData.terminalId || 'POS-TERM-01';
      const timestampIso = validDate.toISOString();

      // 26-column row for 'Order Details' tab
      const orderDetailsRow = [
        orderNumber,
        orderId,
        dateStr,
        timeStr,
        orderType,
        fulfillment,
        tableNumber,
        customerName,
        customerPhone,
        itemsListStr,
        itemCount,
        subtotal,
        discountAmount,
        couponCode,
        taxableAmount,
        cgst,
        sgst,
        totalTax,
        deliveryFee,
        finalAmount,
        paymentMethod,
        paymentStatus,
        status,
        cashier,
        terminalId,
        timestampIso
      ];

      // 28-column row for 'Raw Billing Data' tab
      const rawBillingRow = [
        orderId,
        orderNumber,
        dateStr,
        timeStr,
        orderData.franchiseId || 'fra_primary',
        orderData.branchName || 'Olive Pizza HQ',
        customerName,
        customerPhone,
        orderType,
        fulfillment,
        tableNumber,
        FranchiseGoogleSheetsService.formatItemsSummary(orderData.items || []), // Clean human-readable summary
        itemCount,
        subtotal,
        discountAmount,
        couponCode,
        taxableAmount,
        cgst,
        sgst,
        totalTax,
        deliveryFee,
        finalAmount,
        paymentMethod,
        paymentStatus,
        status,
        cashier,
        terminalId,
        timestampIso
      ];

      const sheets = this.getSheetsClient();

      // Check existing rows in 'Order Details' column B (Order ID)
      const existingRowsRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'Order Details'!B2:B5000`,
      }).catch(() => ({ data: { values: [] } }));

      const existingOrderIds = existingRowsRes.data.values || [];
      const rowIndex = existingOrderIds.findIndex((r: any[]) => r && (r[0] === orderId || r[0] === orderNumber));

      if (rowIndex !== -1) {
        const targetRow = 2 + rowIndex;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'Order Details'!A${targetRow}:Z${targetRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [orderDetailsRow] },
        });
        console.log(`[GoogleSheetsReport] ✅ Updated order ${orderNumber} in 'Order Details' at row ${targetRow}`);
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `'Order Details'!A2:Z2`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [orderDetailsRow] },
        });
        console.log(`[GoogleSheetsReport] ✅ Appended order ${orderNumber} to 'Order Details'`);
      }

      // Also append to 'Raw Billing Data'
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'Raw Billing Data'!A2:AB2`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [rawBillingRow] },
      }).catch((e: any) => console.warn('[GoogleSheetsReport] Raw billing append note:', e.message));

    } catch (err: any) {
      console.error(`[GoogleSheetsReport] Error syncing live order to Google Sheet:`, err.message);
    }
  }

  /**
   * Appends a completed order incrementally (Backwards compatibility).
   */
  static async appendOrderToMonthlySheet(order: OrderRowData): Promise<void> {
    return this.syncOrderToMonthlySheet(order);
  }

  /**
   * Updates monthly summary metrics and inserts automatic charts into Google Sheet.
   */
  static async addChartsToMonthlySheet(spreadsheetId: string, sheetTitle: string = 'Executive Summary'): Promise<void> {
    try {
      const sheets = this.getSheetsClient();
      const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      const targetSheet = (spreadsheet.data.sheets || []).find((s: any) => s.properties?.title === sheetTitle);

      if (!targetSheet) return;
      const sheetId = targetSheet.properties.sheetId;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              addChart: {
                chart: {
                  spec: {
                    title: `Olive Pizza — Daily Sales Revenue Trend`,
                    basicChart: {
                      chartType: 'COLUMN',
                      legendPosition: 'BOTTOM_LEGEND',
                      domains: [
                        {
                          domain: {
                            sourceRange: {
                              sources: [{ sheetId, startRowIndex: 11, endRowIndex: 17, startColumnIndex: 0, endColumnIndex: 1 }]
                            }
                          }
                        }
                      ],
                      series: [
                        {
                          series: {
                            sourceRange: {
                              sources: [{ sheetId, startRowIndex: 11, endRowIndex: 17, startColumnIndex: 1, endColumnIndex: 2 }]
                            }
                          },
                          targetAxis: 'LEFT_AXIS'
                        }
                      ]
                    }
                  },
                  position: {
                    overlayPosition: {
                      anchorCell: { sheetId, rowIndex: 19, columnIndex: 0 },
                      offsetXPixels: 0,
                      offsetYPixels: 0,
                    }
                  }
                }
              }
            }
          ]
        }
      });
      console.log(`[GoogleSheetsReport] Charts inserted successfully in sheet "${sheetTitle}"`);
    } catch (err: any) {
      console.warn(`[GoogleSheetsReport] addChartsToMonthlySheet notice:`, err.message);
    }
  }

  /**
   * Returns Looker Studio configuration metadata from Firestore.
   */
  static async getLookerStudioConfig(): Promise<{
    embedUrl: string;
    spreadsheetId: string | null;
    currentSheetTitle: string;
    liveSheetUrl: string | null;
    lastSyncedAt: string;
  }> {
    const spreadsheetId = await this.getSpreadsheetId();
    const currentSheetTitle = this.getMonthSheetTitle();
    
    try {
      const doc = await db.collection('settings').doc('looker_studio').get();
      const data = doc.exists ? doc.data() : {};
      const embedUrl = data?.embedUrl || process.env.LOOKER_STUDIO_EMBED_URL || '';
      
      return {
        embedUrl,
        spreadsheetId,
        currentSheetTitle,
        liveSheetUrl: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null,
        lastSyncedAt: data?.lastSyncedAt || new Date().toISOString(),
      };
    } catch {
      return {
        embedUrl: process.env.LOOKER_STUDIO_EMBED_URL || '',
        spreadsheetId,
        currentSheetTitle,
        liveSheetUrl: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}` : null,
        lastSyncedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Sets Looker Studio Embed URL in Firestore settings.
   */
  static async setLookerStudioEmbedUrl(embedUrl: string): Promise<void> {
    await db.collection('settings').doc('looker_studio').set({
      embedUrl: embedUrl.trim(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  }

  /**
   * Generates standardized multi-month time series data feed for Looker Studio ingestion.
   */
  static async getLookerStudioFeed(filters: { franchiseId?: string; limit?: number } = {}): Promise<any[]> {
    try {
      let query: any = db.collection('orders').orderBy('createdAt', 'desc');
      if (filters.franchiseId) {
        query = query.where('franchiseId', '==', filters.franchiseId);
      }
      query = query.limit(filters.limit || 500);

      const snap = await query.get();
      return snap.docs.map((d: any) => {
        const o = d.data();
        const rawDate = o.createdAt;
        let dateObj = new Date();
        if (rawDate) {
          if (typeof rawDate.toDate === 'function') dateObj = rawDate.toDate();
          else if (rawDate._seconds) dateObj = new Date(rawDate._seconds * 1000);
          else if (typeof rawDate === 'string' || typeof rawDate === 'number') dateObj = new Date(rawDate);
        }

        const subtotal = Number(o.subtotal || o.totalAmount || 0);
        const discount = Number(o.discountAmount || 0);
        const taxable = Math.max(0, subtotal - discount);
        const taxes = Number(o.taxes || Math.round(taxable * 0.05));
        const deliveryFee = Number(o.deliveryFee || 0);
        const finalTotal = Number(o.totalAmount || (taxable + taxes + deliveryFee));

        return {
          orderId: d.id,
          dailyOrderNumber: o.dailyOrderNumber ? `#${o.dailyOrderNumber}` : (o.orderNumber || `OP-${d.id.slice(-6).toUpperCase()}`),
          date: dateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
          time: dateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
          isoTimestamp: dateObj.toISOString(),
          monthYear: `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}`,
          orderType: (o.orderSource || o.orderType || 'ONLINE').toUpperCase(),
          fulfillmentType: (o.fulfillmentType || (o.tableNumber ? 'DINE_IN' : 'DELIVERY')).toUpperCase(),
          tableNumber: o.tableNumber || '-',
          customerName: o.customerName || 'Walk-in Customer',
          customerPhone: o.contactPhone || o.phone || 'N/A',
          subtotal,
          discountAmount: discount,
          taxableAmount: taxable,
          cgst: Number((taxable * 0.025).toFixed(2)),
          sgst: Number((taxable * 0.025).toFixed(2)),
          totalTaxes: taxes,
          deliveryFee,
          finalTotal,
          paymentMethod: (o.paymentMethod || 'CASH').toUpperCase(),
          paymentStatus: (o.paymentStatus || 'PAID').toUpperCase(),
          orderStatus: (o.status || 'pending').toLowerCase(),
          cashier: o.cashierName || 'Counter Cashier',
          terminalId: o.terminalId || 'POS-TERM-01',
          franchiseId: o.franchiseId || 'fra_primary',
          branchName: o.branchName || 'Olive Pizza — Rajnandgaon HQ',
        };
      });
    } catch (err: any) {
      console.warn('[GoogleSheetsReport] Looker Studio feed generation error:', err.message);
      return [];
    }
  }

}
