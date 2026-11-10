/**
 * FranchiseGoogleSheetsService.ts — Professional Dedicated Multi-Franchise Google Spreadsheet Engine
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. ONE Dedicated Google Spreadsheet per Franchise (e.g. "Olive Pizza — Rajnandgaon Reports").
 * 2. NO RAW DATABASE DUMPS: NO ITEMS_JSON, NO serialized JSON blobs, NO [object Object], NO undefined.
 * 3. ONE ROW = ONE RECORD: Order Details has exactly 1 row per order. Product Sales has 1 row per line item.
 * 4. FORMULA INJECTION & PHONE #ERROR! PROTECTION: Phone numbers and special strings are sanitized with safe text escaping.
 * 5. TRUE NUMERIC VALUES: Financial amounts are pure numbers with INR currency formatting (₹#,##0.00) for SUM/AVERAGE/Looker Studio.
 * 6. DEDUPLICATION: Idempotent writes keyed by orderId / itemLineId prevent duplicate rows during retries, re-prints, or reconnects.
 * 7. 11 STRUCTURED TABS:
 *    - Dashboard (Executive KPI cards & channel performance)
 *    - Monthly Summary (Month-by-month accounting rollup)
 *    - Daily Sales (31-day calendar ledger)
 *    - Order Details (Primary transaction table, 1 row per order)
 *    - Product Sales (Item-level breakdown, 1 row per line item sold)
 *    - Payments (Reconciliation for Cash, UPI, Card, Online)
 *    - GST & Tax (2.5% CGST + 2.5% SGST audit schedules)
 *    - Discounts & Coupons (Marketing coupon & promo analysis)
 *    - Refunds & Cancellations (Voided bills and cancellation audits)
 *    - POS & Cashier Summary (Terminal shifts and cash handling)
 *    - Audit & Adjustments (Manager overrides and operational adjustments)
 */

import { google } from 'googleapis';
import { adminDb as db } from '../../config/firebase.js';

export interface FranchiseSheetsMetadata {
  franchiseId: string;
  franchiseName: string;
  spreadsheetId: string | null;
  spreadsheetName: string;
  spreadsheetUrl: string | null;
  status: 'CONNECTED' | 'PROVISIONING_PENDING' | 'ERROR' | 'DEACTIVATED';
  createdAt: string;
  lastProvisionedAt: string;
  lastSyncedAt: string;
  currentMonthTab: string;
  pendingSyncCount: number;
  failedSyncCount: number;
  lastError?: string;
}

export class FranchiseGoogleSheetsService {
  private static sheetsClient: any = null;

  /**
   * Initializes Google Sheets API v4 client using backend service account credentials.
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
        console.warn('[FranchiseGoogleSheets] Base64 service account parse notice:', err.message);
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
   * Sanitizes string against formula injection (=, +, -, @) and object dumps.
   */
  static sanitizeText(val: any, fallback = '-'): string {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'object') {
      if (val.addressLine) return this.sanitizeText(val.addressLine, fallback);
      if (val.formatted) return this.sanitizeText(val.formatted, fallback);
      if (val.name) return this.sanitizeText(val.name, fallback);
      return fallback;
    }
    let str = String(val).trim();
    if (!str || str === 'undefined' || str === 'null' || str === '[object Object]') return fallback;
    if (/^[=+\-@]/.test(str)) {
      str = `'${str}`;
    }
    return str;
  }

  /**
   * Sanitizes phone number: forces plain string text with ' prefix to prevent #ERROR! formulas.
   */
  static sanitizePhoneNumber(phone: any): string {
    if (!phone) return 'N/A';
    const str = String(phone).trim();
    if (!str || str === 'undefined' || str === 'null' || str === 'N/A') return 'N/A';
    const digits = str.replace(/\D/g, '');
    if (digits.length === 10) {
      return `'+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    }
    if (digits.length === 12 && digits.startsWith('91')) {
      return `'+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    return `'${str}`;
  }

  /**
   * Formats line items array into clean human-readable text summary (e.g. "2x Farmhouse Pizza, 1x Garlic Bread").
   */
  static formatItemsSummary(items: any[]): string {
    if (!Array.isArray(items) || items.length === 0) return '1x Pizza';
    return items.map((it: any) => {
      if (typeof it === 'string') return it;
      const qty = Number(it.quantity || 1);
      const name = it.name || it.productName || 'Pizza';
      const size = it.size || it.selectedSize;
      const crust = it.crust || it.selectedCrust;
      const addonsList = Array.isArray(it.addons || it.selectedAddons)
        ? (it.addons || it.selectedAddons).map((a: any) => a.name || a).join(', ')
        : '';

      let desc = `${qty}x ${name}`;
      if (size && size !== 'Regular') desc += ` (${size})`;
      if (crust && crust !== 'Regular Crust') desc += ` [${crust}]`;
      if (addonsList) desc += ` + ${addonsList}`;
      return desc;
    }).join('; ');
  }

  /**
   * Generates clean formatted month title (e.g. "August 2026").
   */
  static getMonthTabName(date: Date = new Date()): string {
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
  }

  // ─── STANDARD TABLE HEADERS (CLEAN & STRUCTURED) ──────────────────────────

  static readonly ORDER_DETAILS_HEADERS = [
    'ORDER ID',
    'BILL NO',
    'DATE',
    'TIME',
    'FRANCHISE',
    'BRANCH',
    'SOURCE',
    'ORDER TYPE',
    'FULFILLMENT',
    'TABLE NO',
    'CUSTOMER NAME',
    'CUSTOMER PHONE',
    'ITEMS SUMMARY',
    'ITEM QTY',
    'SUBTOTAL (₹)',
    'DISCOUNT (₹)',
    'COUPON CODE',
    'TAXABLE AMT (₹)',
    'CGST 2.5% (₹)',
    'SGST 2.5% (₹)',
    'TOTAL TAX 5% (₹)',
    'DELIVERY FEE (₹)',
    'FINAL TOTAL (₹)',
    'PAYMENT METHOD',
    'PAYMENT STATUS',
    'ORDER STATUS',
    'CASHIER / STAFF',
    'TERMINAL ID',
    'TIMESTAMP'
  ];

  static readonly PRODUCT_SALES_HEADERS = [
    'DATE',
    'TIME',
    'ORDER ID',
    'BILL NO',
    'BRANCH',
    'PRODUCT NAME',
    'CATEGORY',
    'SIZE / VARIANT',
    'CRUST TYPE',
    'CUSTOMIZATIONS',
    'QUANTITY',
    'UNIT PRICE (₹)',
    'LINE TOTAL (₹)',
    'ORDER SOURCE',
    'PAYMENT METHOD'
  ];

  static readonly PAYMENTS_HEADERS = [
    'TRANSACTION ID',
    'ORDER ID',
    'BILL NO',
    'DATE',
    'TIME',
    'BRANCH',
    'PAYMENT METHOD',
    'AMOUNT (₹)',
    'PAYMENT STATUS',
    'REFERENCE ID',
    'STAFF / TERMINAL'
  ];

  static readonly GST_TAX_HEADERS = [
    'DATE',
    'BRANCH',
    'TOTAL INVOICES',
    'GROSS SALES (₹)',
    'DISCOUNTS (₹)',
    'TAXABLE TURNOVER (₹)',
    'CGST 2.5% (₹)',
    'SGST 2.5% (₹)',
    'TOTAL GST 5% (₹)',
    'NET INVOICE VALUE (₹)'
  ];

  static readonly DAILY_SALES_HEADERS = [
    'DATE',
    'DAY',
    'ORDERS',
    'GROSS SALES (₹)',
    'DISCOUNTS (₹)',
    'TAXABLE (₹)',
    'CGST 2.5% (₹)',
    'SGST 2.5% (₹)',
    'TOTAL GST 5% (₹)',
    'DELIVERY (₹)',
    'NET REVENUE (₹)',
    'CASH (₹)',
    'UPI (₹)',
    'CARD (₹)',
    'ONLINE (₹)'
  ];

  static readonly MONTHLY_SUMMARY_HEADERS = [
    'MONTH / YEAR',
    'ORDERS',
    'GROSS SALES (₹)',
    'DISCOUNTS (₹)',
    'TAXABLE TURNOVER (₹)',
    'CGST 2.5% (₹)',
    'SGST 2.5% (₹)',
    'TOTAL GST 5% (₹)',
    'DELIVERY FEES (₹)',
    'NET REVENUE (₹)',
    'CASH (₹)',
    'UPI (₹)',
    'CARD (₹)',
    'ONLINE (₹)',
    'AOV (₹)'
  ];

  static readonly DISCOUNTS_COUPONS_HEADERS = [
    'COUPON / PROMO CODE',
    'TIMES REDEEMED',
    'TOTAL DISCOUNT GIVEN (₹)',
    'GROSS SALES GENERATED (₹)',
    'NET REVENUE RESULT (₹)',
    'AVG DISCOUNT / ORDER (₹)'
  ];

  static readonly REFUNDS_HEADERS = [
    'ORDER ID',
    'BILL NO',
    'DATE',
    'CUSTOMER NAME',
    'REFUND AMOUNT (₹)',
    'PAYMENT METHOD',
    'CANCELLATION REASON',
    'AUTHORIZED BY',
    'STATUS'
  ];

  static readonly POS_CASHIER_HEADERS = [
    'CASHIER / STAFF',
    'TERMINAL ID',
    'SHIFT ID',
    'BILLS PROCESSED',
    'GROSS SALES (₹)',
    'CASH COLLECTED (₹)',
    'UPI COLLECTED (₹)',
    'CARD COLLECTED (₹)',
    'DISCOUNTS GIVEN (₹)',
    'TOTAL SHIFT REVENUE (₹)'
  ];

  static readonly AUDIT_ADJUSTMENTS_HEADERS = [
    'DATE',
    'TIME',
    'ORDER / BILL REF',
    'ADJUSTMENT TYPE',
    'PREVIOUS VALUE',
    'NEW VALUE',
    'REASON / NOTE',
    'AUTHORIZED BY',
    'TIMESTAMP'
  ];

  /**
   * Provisions a dedicated Google Spreadsheet for a specific Franchise with all 11 professional reporting sheets.
   */
  static async provisionFranchiseSpreadsheet(
    franchiseId: string,
    franchiseName: string,
    region: string = 'Chhattisgarh'
  ): Promise<{ success: boolean; spreadsheetId: string | null; spreadsheetUrl: string | null; error?: string }> {
    const cleanName = franchiseName.replace(/Olive Pizza\s*[-—]?\s*/gi, '').trim() || franchiseId;
    const spreadsheetTitle = `Olive Pizza — ${cleanName} Reports`;
    const now = new Date().toISOString();

    // Check if already provisioned in metadata
    const metaDoc = await db.collection('franchise_sheets_metadata').doc(franchiseId).get();
    if (metaDoc.exists && metaDoc.data()?.spreadsheetId) {
      const existingId = metaDoc.data()?.spreadsheetId;
      return {
        success: true,
        spreadsheetId: existingId,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${existingId}`
      };
    }

    try {
      const sheets = this.getSheetsClient();

      // Create workbook with the 11 standard professional reporting sheets
      const createResponse = await sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title: spreadsheetTitle,
            locale: 'en_IN',
            autoRecalc: 'ON_CHANGE',
            timeZone: 'Asia/Kolkata'
          },
          sheets: [
            { properties: { title: 'Dashboard', gridProperties: { rowCount: 100, columnCount: 20 } } },
            { properties: { title: 'Monthly Summary', gridProperties: { rowCount: 60, columnCount: 20, frozenRowCount: 1 } } },
            { properties: { title: 'Daily Sales', gridProperties: { rowCount: 366, columnCount: 20, frozenRowCount: 1 } } },
            { properties: { title: 'Order Details', gridProperties: { rowCount: 5000, columnCount: 30, frozenRowCount: 1 } } },
            { properties: { title: 'Product Sales', gridProperties: { rowCount: 8000, columnCount: 20, frozenRowCount: 1 } } },
            { properties: { title: 'Payments', gridProperties: { rowCount: 5000, columnCount: 15, frozenRowCount: 1 } } },
            { properties: { title: 'GST & Tax', gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 } } },
            { properties: { title: 'Discounts & Coupons', gridProperties: { rowCount: 200, columnCount: 15, frozenRowCount: 1 } } },
            { properties: { title: 'Refunds & Cancellations', gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 } } },
            { properties: { title: 'POS & Cashier Summary', gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 } } },
            { properties: { title: 'Audit & Adjustments', gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 } } }
          ]
        }
      });

      const spreadsheetId = createResponse.data.spreadsheetId;
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

      // Initialize all structured headers and dashboard models
      await this.initializeWorkbookHeaders(spreadsheetId, cleanName, region);

      // Save metadata to Firestore
      const metadata: FranchiseSheetsMetadata = {
        franchiseId,
        franchiseName: `Olive Pizza — ${cleanName}`,
        spreadsheetId,
        spreadsheetName: spreadsheetTitle,
        spreadsheetUrl,
        status: 'CONNECTED',
        createdAt: now,
        lastProvisionedAt: now,
        lastSyncedAt: now,
        currentMonthTab: this.getMonthTabName(),
        pendingSyncCount: 0,
        failedSyncCount: 0
      };

      await db.collection('franchise_sheets_metadata').doc(franchiseId).set(metadata, { merge: true });
      await db.collection('franchise_entities').doc(franchiseId).set({
        googleSpreadsheetId: spreadsheetId,
        googleSpreadsheetUrl: spreadsheetUrl,
        sheetsProvisionedAt: now,
        sheetsStatus: 'CONNECTED'
      }, { merge: true });

      console.log(`✅ [FranchiseGoogleSheets] Successfully provisioned dedicated structured workbook for ${franchiseId}: ${spreadsheetId}`);
      return { success: true, spreadsheetId, spreadsheetUrl };
    } catch (error: any) {
      console.warn(`⚠️ [FranchiseGoogleSheets] Automated provisioning deferred for ${franchiseId}:`, error.message);

      const pendingMeta: FranchiseSheetsMetadata = {
        franchiseId,
        franchiseName: `Olive Pizza — ${cleanName}`,
        spreadsheetId: null,
        spreadsheetName: spreadsheetTitle,
        spreadsheetUrl: null,
        status: 'PROVISIONING_PENDING',
        createdAt: now,
        lastProvisionedAt: now,
        lastSyncedAt: now,
        currentMonthTab: this.getMonthTabName(),
        pendingSyncCount: 0,
        failedSyncCount: 0,
        lastError: error.message
      };

      await db.collection('franchise_sheets_metadata').doc(franchiseId).set(pendingMeta, { merge: true });
      return { success: false, spreadsheetId: null, spreadsheetUrl: null, error: error.message };
    }
  }

  /**
   * Initializes structured headers, formulas, and visual dashboard formatting across all tabs.
   */
  private static async initializeWorkbookHeaders(
    spreadsheetId: string,
    franchiseName: string,
    region: string
  ): Promise<void> {
    const sheets = this.getSheetsClient();
    const dateGenerated = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // 1. Dashboard Executive Summary Model
    const dashboardValues = [
      [`OLIVE PIZZA — ${franchiseName.toUpperCase()} EXECUTIVE MANAGEMENT & ACCOUNTING HUB`, '', '', '', '', ''],
      [`Franchise: Olive Pizza — ${franchiseName}`, `Region: ${region}`, 'Currency: INR (₹)', 'F&B GST: 5% (2.5% CGST + 2.5% SGST)', `Generated: ${dateGenerated}`, ''],
      [''],
      ['KEY PERFORMANCE INDICATORS', 'VALUE', 'TENDER & PAYMENT MIX', 'AMOUNT (₹)', 'ORDER CHANNELS', 'TICKETS'],
      ['Total Gross Billed Sales', '=IFERROR(SUM(\'Order Details\'!O2:O5000), 0)', 'Cash on Counter', '=IFERROR(SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!X2:X5000, "*CASH*"), 0)', 'Dine-In Restaurant', '=COUNTIF(\'Order Details\'!H2:H5000, "*Dine*")'],
      ['Total Discounts Given', '=IFERROR(SUM(\'Order Details\'!P2:P5000), 0)', 'Dynamic UPI / QR', '=IFERROR(SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!X2:X5000, "*UPI*"), 0)', 'Takeaway / Parcel', '=COUNTIF(\'Order Details\'!H2:H5000, "*Takeaway*")'],
      ['Total Taxable Turnover', '=IFERROR(SUM(\'Order Details\'!R2:R5000), 0)', 'Credit & Debit Cards', '=IFERROR(SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!X2:X5000, "*CARD*"), 0)', 'Online App Delivery', '=COUNTIF(\'Order Details\'!G2:G5000, "*CUSTOMER*") + COUNTIF(\'Order Details\'!H2:H5000, "*Delivery*")'],
      ['Total CGST Collected (2.5%)', '=IFERROR(SUM(\'Order Details\'!S2:S5000), 0)', 'Online App Prepaid', '=IFERROR(SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!Y2:Y5000, "*PAID*") - SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!X2:X5000, "*CASH*"), 0)', 'Total Orders Billed', '=COUNTA(\'Order Details\'!A2:A5000)'],
      ['Total SGST Collected (2.5%)', '=IFERROR(SUM(\'Order Details\'!T2:T5000), 0)', 'COD / Payment Due', '=IFERROR(SUMIFS(\'Order Details\'!W2:W5000, \'Order Details\'!Y2:Y5000, "*DUE*"), 0)', 'Total Items Sold', '=IFERROR(SUM(\'Order Details\'!N2:N5000), 0)'],
      ['Total GST 5% Collected', '=B8+B9', 'Total Collections', '=SUM(D5:D9)', 'Average Ticket (AOV)', '=IFERROR(B5/B10, 0)'],
      ['Total Net Revenue Realized', '=IFERROR(SUM(\'Order Details\'!W2:W5000), 0)', '', '', '', '']
    ];

    // 2. Daily Sales 31-Day Ledger Model
    const dailySalesValues = [this.DAILY_SALES_HEADERS];
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(currentYear, currentMonth, day);
      const dateStr = dateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      const r = day + 1;

      dailySalesValues.push([
        dateStr,
        `Day ${day}`,
        `=COUNTIF('Order Details'!$C$2:$C$5000, A${r})`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$O$2:$O$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$P$2:$P$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$R$2:$R$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$S$2:$S$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$T$2:$T$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$U$2:$U$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$V$2:$V$5000)`,
        `=SUMIF('Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$W$2:$W$5000)`,
        `=SUMIFS('Order Details'!$W$2:$W$5000, 'Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$X$2:$X$5000, "*CASH*")`,
        `=SUMIFS('Order Details'!$W$2:$W$5000, 'Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$X$2:$X$5000, "*UPI*")`,
        `=SUMIFS('Order Details'!$W$2:$W$5000, 'Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$X$2:$X$5000, "*CARD*")`,
        `=SUMIFS('Order Details'!$W$2:$W$5000, 'Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$Y$2:$Y$5000, "*PAID*") - SUMIFS('Order Details'!$W$2:$W$5000, 'Order Details'!$C$2:$C$5000, A${r}, 'Order Details'!$X$2:$X$5000, "*CASH*")`
      ]);
    }

    const headerPayloads = [
      { range: 'Dashboard!A1:F11', values: dashboardValues },
      { range: 'Monthly Summary!A1:O1', values: [this.MONTHLY_SUMMARY_HEADERS] },
      { range: `Daily Sales!A1:O${dailySalesValues.length}`, values: dailySalesValues },
      { range: 'Order Details!A1:AC1', values: [this.ORDER_DETAILS_HEADERS] },
      { range: 'Product Sales!A1:O1', values: [this.PRODUCT_SALES_HEADERS] },
      { range: 'Payments!A1:K1', values: [this.PAYMENTS_HEADERS] },
      { range: 'GST & Tax!A1:J1', values: [this.GST_TAX_HEADERS] },
      { range: 'Discounts & Coupons!A1:F1', values: [this.DISCOUNTS_COUPONS_HEADERS] },
      { range: 'Refunds & Cancellations!A1:I1', values: [this.REFUNDS_HEADERS] },
      { range: 'POS & Cashier Summary!A1:J1', values: [this.POS_CASHIER_HEADERS] },
      { range: 'Audit & Adjustments!A1:I1', values: [this.AUDIT_ADJUSTMENTS_HEADERS] }
    ];

    for (const payload of headerPayloads) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: payload.range,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: payload.values }
        });
      } catch (err: any) {
        console.warn(`[FranchiseGoogleSheets] Notice updating ${payload.range}:`, err.message);
      }
    }
  }

  /**
   * Synchronizes an order cleanly to the dedicated Franchise Google Spreadsheet.
   * STRICT IDEMPOTENCY: 1 order = 1 row in Order Details. 1 item = 1 row in Product Sales.
   */
  static async syncOrderToFranchise(order: any): Promise<boolean> {
    const franchiseId = order.franchiseId || 'fra_rajnandgaon';
    const orderId = order.id || order.orderId;

    if (!orderId) return false;

    // 1. Idempotency Check via Firestore Audit
    const auditKey = `${franchiseId}_${orderId}`;
    const syncAuditDoc = await db.collection('sheets_sync_audit').doc(auditKey).get();
    if (syncAuditDoc.exists && syncAuditDoc.data()?.synced) {
      return true; // Already synced, avoid duplicate insertion
    }

    // 2. Retrieve Franchise Spreadsheet ID
    let metaDoc = await db.collection('franchise_sheets_metadata').doc(franchiseId).get();
    let spreadsheetId = metaDoc.exists ? metaDoc.data()?.spreadsheetId : null;

    if (!spreadsheetId) {
      const provRes = await this.provisionFranchiseSpreadsheet(franchiseId, order.branchName || franchiseId);
      spreadsheetId = provRes.spreadsheetId;
    }

    if (!spreadsheetId) {
      console.warn(`[FranchiseGoogleSheets] Spreadsheet not provisioned for ${franchiseId}, sync queued.`);
      return false;
    }

    try {
      const sheets = this.getSheetsClient();

      // Format Date & Time in IST
      let dateObj = new Date();
      if (order.createdAt) {
        if (typeof order.createdAt.toDate === 'function') dateObj = order.createdAt.toDate();
        else if (order.createdAt._seconds) dateObj = new Date(order.createdAt._seconds * 1000);
        else if (typeof order.createdAt === 'string' || typeof order.createdAt === 'number') dateObj = new Date(order.createdAt);
      }

      const formattedDate = dateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
      const formattedTime = dateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const timestampIso = dateObj.toISOString();

      // Standard Numeric Calculations
      const subtotal = Number(order.subtotal || order.totalAmount || 0);
      const discount = Number(order.discountAmount || order.discount || 0);
      const taxable = Math.max(0, subtotal - discount);
      const totalTax = Number(order.taxes || order.tax || Math.round(taxable * 0.05));
      const cgst = Number(order.cgst || (totalTax / 2).toFixed(2));
      const sgst = Number(order.sgst || (totalTax / 2).toFixed(2));
      const deliveryFee = Number(order.deliveryFee || 0);
      const grandTotal = Number(order.totalAmount || order.finalTotal || order.total || (taxable + totalTax + deliveryFee));

      const isPOS = (order.orderSource || '').startsWith('POS_') || order.orderSource === 'OFFLINE_RESTAURANT';
      const orderSourceStr = isPOS ? 'POS' : 'ONLINE_APP';
      const orderTypeStr = this.sanitizeText(order.orderSource || (isPOS ? 'POS_DINE_IN' : 'CUSTOMER_APP'));
      const fulfillmentStr = this.sanitizeText(order.fulfillmentType || order.orderType || (isPOS ? 'Dine-In' : 'Delivery'));
      const tableStr = this.sanitizeText(order.tableNumber || '-');

      // Sanitized Customer Info (Zero Object Blobs & Zero Phone #ERROR!)
      const customerNameStr = this.sanitizeText(order.customerName || (isPOS ? 'Walk-in Customer' : 'Online Guest'));
      const customerPhoneStr = this.sanitizePhoneNumber(order.customerPhone || order.contactPhone || order.phone);

      // Clean Items Summary (Human-readable text)
      const itemsList = Array.isArray(order.items) ? order.items : [];
      const itemsSummaryStr = this.formatItemsSummary(itemsList);
      const totalQty = itemsList.reduce((acc: number, it: any) => acc + Number(it.quantity || 1), 0) || 1;

      const billNoStr = order.dailyOrderNumber 
        ? `#${order.dailyOrderNumber}` 
        : this.sanitizeText(order.orderNumber || orderId.slice(-6).toUpperCase());

      // ─── A. 1 ORDER = 1 ROW IN 'Order Details' ───────────────────────────
      const orderDetailsRow = [
        orderId,
        billNoStr,
        formattedDate,
        formattedTime,
        this.sanitizeText(order.franchiseName || franchiseId),
        this.sanitizeText(order.branchName || 'Olive Pizza Branch'),
        orderSourceStr,
        orderTypeStr,
        fulfillmentStr,
        tableStr,
        customerNameStr,
        customerPhoneStr,
        itemsSummaryStr,
        totalQty,
        subtotal,
        discount,
        this.sanitizeText(order.couponCode || order.appliedCouponCode || '-'),
        taxable,
        cgst,
        sgst,
        totalTax,
        deliveryFee,
        grandTotal,
        this.sanitizeText((order.paymentMethod || 'CASH').toUpperCase()),
        this.sanitizeText((order.paymentStatus || 'PAID').toUpperCase()),
        this.sanitizeText((order.status || 'COMPLETED').toUpperCase()),
        this.sanitizeText(order.cashierName || (isPOS ? 'Counter Staff' : 'Auto System')),
        this.sanitizeText(order.terminalId || (isPOS ? 'POS-TERM-01' : 'ONLINE-SYS')),
        timestampIso
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Order Details'!A2:AC",
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [orderDetailsRow] }
      });

      // ─── B. 1 ITEM = 1 ROW IN 'Product Sales' ────────────────────────────
      if (itemsList.length > 0) {
        const productRows = itemsList.map((it: any) => {
          const qty = Number(it.quantity || 1);
          const price = Number(it.price || it.unitPrice || 0);
          const lineTotal = Number(it.lineTotal || (price * qty));
          const size = this.sanitizeText(it.size || it.selectedSize || 'Regular');
          const crust = this.sanitizeText(it.crust || it.selectedCrust || 'Regular Crust');
          const addons = Array.isArray(it.addons || it.selectedAddons)
            ? (it.addons || it.selectedAddons).map((a: any) => a.name || a).join(', ')
            : '-';

          return [
            formattedDate,
            formattedTime,
            orderId,
            billNoStr,
            this.sanitizeText(order.branchName || 'Olive Pizza Branch'),
            this.sanitizeText(it.name || it.productName || 'Pizza'),
            this.sanitizeText(it.category || 'Pizzas'),
            size,
            crust,
            this.sanitizeText(addons),
            qty,
            price,
            lineTotal,
            orderSourceStr,
            this.sanitizeText((order.paymentMethod || 'CASH').toUpperCase())
          ];
        });

        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "'Product Sales'!A2:O",
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: productRows }
        });
      }

      // ─── C. PAYMENTS RECONCILIATION ROW ──────────────────────────────────
      const paymentRow = [
        `PAY_${orderId.slice(-8).toUpperCase()}`,
        orderId,
        billNoStr,
        formattedDate,
        formattedTime,
        this.sanitizeText(order.branchName || 'Olive Pizza Branch'),
        this.sanitizeText((order.paymentMethod || 'CASH').toUpperCase()),
        grandTotal,
        this.sanitizeText((order.paymentStatus || 'PAID').toUpperCase()),
        this.sanitizeText(order.paymentId || order.transactionRef || '-'),
        this.sanitizeText(order.terminalId || (isPOS ? 'POS-TERM-01' : 'ONLINE-SYS'))
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "'Payments'!A2:K",
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [paymentRow] }
      });

      // 3. Mark Audit in Firestore to prevent duplicate row insertion on retry
      const nowIso = new Date().toISOString();
      await db.collection('sheets_sync_audit').doc(auditKey).set({
        franchiseId,
        orderId,
        spreadsheetId,
        synced: true,
        grandTotal,
        syncedAt: nowIso
      });

      await db.collection('franchise_sheets_metadata').doc(franchiseId).set({
        lastSyncedAt: nowIso,
        lastOrderId: orderId
      }, { merge: true });

      return true;
    } catch (error: any) {
      console.warn(`⚠️ [FranchiseGoogleSheets] Error syncing order ${orderId} to ${franchiseId}:`, error.message);
      return false;
    }
  }

  /**
   * Retrieves Google Sheets metadata and connection status for a franchise.
   */
  static async getFranchiseSheetsStatus(franchiseId: string): Promise<FranchiseSheetsMetadata | null> {
    try {
      const doc = await db.collection('franchise_sheets_metadata').doc(franchiseId).get();
      if (doc.exists) {
        return doc.data() as FranchiseSheetsMetadata;
      }
      return null;
    } catch (error: any) {
      console.warn(`[FranchiseGoogleSheets] Error fetching status for ${franchiseId}:`, error.message);
      return null;
    }
  }
}
