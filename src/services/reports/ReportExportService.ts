/**
 * ReportExportService.ts — Spreadsheet-Compatible CSV Reporting Engine
 * 
 * Complies with Phase 7 Architecture:
 * 1. Generates RFC 4180 spreadsheet-compatible CSV reports without Google Sheets dependency.
 * 2. Multi-tenant with strict franchise and branch isolation.
 * 3. Supports Online Orders, POS Orders, Combined Orders, and Financial Reconciliation Ledgers.
 * 4. Implements Formula Injection Protection:
 *    Prepends single quote (') to cells starting with '=', '+', '-', '@', '\t', '\r'.
 * 5. Uses standard IST (Asia/Kolkata) date boundaries.
 */

import { query } from '../../lib/db.js';

export interface ReportQueryParams {
  franchiseId: string;
  branchId?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface CsvExportResult {
  csvContent: string;
  rowCount: number;
  startDate: string;
  endDate: string;
  franchiseId: string;
  branchId?: string;
  reportType: 'ONLINE' | 'POS' | 'COMBINED' | 'FINANCIAL_SUMMARY' | 'ORDER_ITEMS';
}

export class ReportExportService {
  /**
   * Sanitizes a cell value for CSV output:
   * - Prevents CSV formula injection (CSV Injection / CWE-1236).
   * - Escapes quotes, commas, and newlines per RFC 4180.
   */
  public static sanitizeCell(val: any): string {
    if (val === null || val === undefined) {
      return '';
    }

    if (val instanceof Date) {
      return val.toISOString();
    }

    // Fast-path: If value is a native number, preserve as-is (e.g. -50.00, 100, 0)
    if (typeof val === 'number') {
      return Number.isFinite(val) ? String(val) : '';
    }

    let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    const trimmed = str.trim();

    // Preserve valid numeric strings (including negative numbers and decimal points)
    // Examples: "-50.00", "+12.5", "0.00", "-0.99", "1250"
    const isPureNumeric = !isNaN(Number(trimmed)) && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed);

    if (!isPureNumeric) {
      // Formula Injection Mitigation (CWE-1236):
      // Dangerous leading characters: =, @, \t, \r, or + / - when NOT part of a valid numeric literal
      const dangerousChars = ['=', '@', '\t', '\r'];
      if (
        str.length > 0 &&
        (dangerousChars.includes(str[0]) ||
         ((str[0] === '+' || str[0] === '-') && !isPureNumeric))
      ) {
        str = `'${str}`;
      }
    }

    // RFC 4180 escaping: If value contains comma, double-quote, or newline, wrap in double quotes
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Helper to serialize an array of records to CSV format.
   */
  public static buildCsv(headers: string[], rows: any[][]): string {
    const headerLine = headers.map(h => this.sanitizeCell(h)).join(',');
    const bodyLines = rows.map(row => row.map(cell => this.sanitizeCell(cell)).join(','));
    return [headerLine, ...bodyLines].join('\r\n');
  }

  /**
   * 1. Online Order History CSV Export
   */
  public static async generateOnlineOrderCsv(params: ReportQueryParams): Promise<CsvExportResult> {
    const { franchiseId, branchId, startDate, endDate } = params;

    const sqlParams: any[] = [franchiseId, startDate, endDate];
    let branchClause = '';
    if (branchId) {
      sqlParams.push(branchId);
      branchClause = ` AND branch_id = $${sqlParams.length}`;
    }

    const sql = `
      SELECT id, permanent_bill_no, daily_order_no, order_date, order_time,
             order_source, order_type, order_status, payment_method, payment_status,
             customer_name, customer_phone, delivery_address,
             subtotal, discount_amount, coupon_code, cgst, sgst, tax_amount,
             delivery_fee, total_amount, delivery_partner_name, delivery_partner_phone,
             created_at
      FROM canonical_orders
      WHERE franchise_id = $1
        AND order_source = 'ONLINE'
        AND order_date >= $2 AND order_date <= $3
        ${branchClause}
      ORDER BY order_date ASC, order_time ASC
    `;

    const res = await query(sql, sqlParams);
    const headers = [
      'Order ID',
      'Permanent Bill No',
      'Daily Order No',
      'Date',
      'Time',
      'Source',
      'Type',
      'Order Status',
      'Payment Method',
      'Payment Status',
      'Customer Name',
      'Customer Phone',
      'Delivery Address',
      'Subtotal',
      'Discount Amount',
      'Coupon Code',
      'CGST (2.5%)',
      'SGST (2.5%)',
      'Tax Amount',
      'Delivery Fee',
      'Total Amount',
      'Delivery Partner',
      'Partner Phone',
      'Created At'
    ];

    const rows = res.rows.map((r: any) => [
      r.id,
      r.permanent_bill_no,
      r.daily_order_no,
      r.order_date instanceof Date ? r.order_date.toISOString().split('T')[0] : r.order_date,
      r.order_time,
      r.order_source,
      r.order_type,
      r.order_status,
      r.payment_method,
      r.payment_status,
      r.customer_name,
      r.customer_phone,
      r.delivery_address || 'N/A',
      Number(r.subtotal || 0).toFixed(2),
      Number(r.discount_amount || 0).toFixed(2),
      r.coupon_code || '',
      Number(r.cgst || 0).toFixed(2),
      Number(r.sgst || 0).toFixed(2),
      Number(r.tax_amount || 0).toFixed(2),
      Number(r.delivery_fee || 0).toFixed(2),
      Number(r.total_amount || 0).toFixed(2),
      r.delivery_partner_name || 'Unassigned',
      r.delivery_partner_phone || 'N/A',
      r.created_at ? new Date(r.created_at).toISOString() : ''
    ]);

    const csvContent = this.buildCsv(headers, rows);
    return {
      csvContent,
      rowCount: rows.length,
      startDate,
      endDate,
      franchiseId,
      branchId,
      reportType: 'ONLINE'
    };
  }

  /**
   * 2. POS Order History CSV Export (with cashier, terminal, bill number)
   */
  public static async generatePosOrderCsv(params: ReportQueryParams): Promise<CsvExportResult> {
    const { franchiseId, branchId, startDate, endDate } = params;

    const sqlParams: any[] = [franchiseId, startDate, endDate];
    let branchClause = '';
    if (branchId) {
      sqlParams.push(branchId);
      branchClause = ` AND branch_id = $${sqlParams.length}`;
    }

    const sql = `
      SELECT id, permanent_bill_no, daily_order_no, order_date, order_time,
             order_source, order_type, order_status, payment_method, payment_status,
             customer_name, customer_phone, table_number, cashier_id, cashier_name, terminal_id,
             subtotal, discount_amount, coupon_code, cgst, sgst, tax_amount,
             total_amount, created_at
      FROM canonical_orders
      WHERE franchise_id = $1
        AND order_source LIKE 'POS%'
        AND order_date >= $2 AND order_date <= $3
        ${branchClause}
      ORDER BY order_date ASC, order_time ASC
    `;

    const res = await query(sql, sqlParams);
    const headers = [
      'Order ID',
      'Permanent Bill No',
      'Daily Order No',
      'Date',
      'Time',
      'POS Mode',
      'Order Type',
      'Order Status',
      'Payment Method',
      'Payment Status',
      'Customer Name',
      'Customer Phone',
      'Table No',
      'Cashier ID',
      'Cashier Name',
      'Terminal ID',
      'Subtotal',
      'Discount Amount',
      'Coupon Code',
      'CGST (2.5%)',
      'SGST (2.5%)',
      'Tax Amount',
      'Total Amount',
      'Created At'
    ];

    const rows = res.rows.map((r: any) => [
      r.id,
      r.permanent_bill_no,
      r.daily_order_no,
      r.order_date instanceof Date ? r.order_date.toISOString().split('T')[0] : r.order_date,
      r.order_time,
      r.order_source,
      r.order_type,
      r.order_status,
      r.payment_method,
      r.payment_status,
      r.customer_name,
      r.customer_phone,
      r.table_number || '',
      r.cashier_id || '',
      r.cashier_name || 'POS Cashier',
      r.terminal_id || 'Counter',
      Number(r.subtotal || 0).toFixed(2),
      Number(r.discount_amount || 0).toFixed(2),
      r.coupon_code || '',
      Number(r.cgst || 0).toFixed(2),
      Number(r.sgst || 0).toFixed(2),
      Number(r.tax_amount || 0).toFixed(2),
      Number(r.total_amount || 0).toFixed(2),
      r.created_at ? new Date(r.created_at).toISOString() : ''
    ]);

    const csvContent = this.buildCsv(headers, rows);
    return {
      csvContent,
      rowCount: rows.length,
      startDate,
      endDate,
      franchiseId,
      branchId,
      reportType: 'POS'
    };
  }

  /**
   * 3. Combined Order History CSV Export (Online + POS with explicit source identifier)
   */
  public static async generateCombinedOrderCsv(params: ReportQueryParams): Promise<CsvExportResult> {
    const { franchiseId, branchId, startDate, endDate } = params;

    const sqlParams: any[] = [franchiseId, startDate, endDate];
    let branchClause = '';
    if (branchId) {
      sqlParams.push(branchId);
      branchClause = ` AND branch_id = $${sqlParams.length}`;
    }

    const sql = `
      SELECT id, permanent_bill_no, daily_order_no, order_date, order_time,
             order_source, order_type, order_status, payment_method, payment_status,
             customer_name, customer_phone,
             COALESCE(cashier_name, delivery_partner_name, 'N/A') AS staff_handler,
             terminal_id, subtotal, discount_amount, cgst, sgst, tax_amount,
             delivery_fee, total_amount, created_at
      FROM canonical_orders
      WHERE franchise_id = $1
        AND order_date >= $2 AND order_date <= $3
        ${branchClause}
      ORDER BY order_date ASC, order_time ASC
    `;

    const res = await query(sql, sqlParams);
    const headers = [
      'Order ID',
      'Permanent Bill No',
      'Daily Order No',
      'Date',
      'Time',
      'Order Source',
      'Order Type',
      'Order Status',
      'Payment Method',
      'Payment Status',
      'Customer Name',
      'Customer Phone',
      'Staff Handler',
      'Terminal ID',
      'Subtotal',
      'Discount Amount',
      'CGST (2.5%)',
      'SGST (2.5%)',
      'Tax Total',
      'Delivery Fee',
      'Total Amount',
      'Created At'
    ];

    const rows = res.rows.map((r: any) => [
      r.id,
      r.permanent_bill_no,
      r.daily_order_no,
      r.order_date instanceof Date ? r.order_date.toISOString().split('T')[0] : r.order_date,
      r.order_time,
      r.order_source,
      r.order_type,
      r.order_status,
      r.payment_method,
      r.payment_status,
      r.customer_name,
      r.customer_phone,
      r.staff_handler,
      r.terminal_id || '',
      Number(r.subtotal || 0).toFixed(2),
      Number(r.discount_amount || 0).toFixed(2),
      Number(r.cgst || 0).toFixed(2),
      Number(r.sgst || 0).toFixed(2),
      Number(r.tax_amount || 0).toFixed(2),
      Number(r.delivery_fee || 0).toFixed(2),
      Number(r.total_amount || 0).toFixed(2),
      r.created_at ? new Date(r.created_at).toISOString() : ''
    ]);

    const csvContent = this.buildCsv(headers, rows);
    return {
      csvContent,
      rowCount: rows.length,
      startDate,
      endDate,
      franchiseId,
      branchId,
      reportType: 'COMBINED'
    };
  }

  /**
   * 4. Financial Reconciliation Summary CSV Export (Daily aggregates, GST, Cash/Digital, Refunds)
   */
  public static async generateFinancialSummaryCsv(params: ReportQueryParams): Promise<CsvExportResult> {
    const { franchiseId, branchId, startDate, endDate } = params;

    const sqlParams: any[] = [franchiseId, startDate, endDate];
    let branchClause = '';
    if (branchId) {
      sqlParams.push(branchId);
      branchClause = ` AND branch_id = $${sqlParams.length}`;
    }

    const sql = `
      SELECT order_date,
             COUNT(*) AS total_orders,
             COUNT(CASE WHEN order_source = 'ONLINE' THEN 1 END) AS online_orders,
             COUNT(CASE WHEN order_source LIKE 'POS%' THEN 1 END) AS pos_orders,
             COALESCE(SUM(subtotal), 0) AS gross_sales,
             COALESCE(SUM(discount_amount), 0) AS total_discounts,
             COALESCE(SUM(subtotal - discount_amount), 0) AS net_sales,
             COALESCE(SUM(cgst), 0) AS total_cgst,
             COALESCE(SUM(sgst), 0) AS total_sgst,
             COALESCE(SUM(tax_amount), 0) AS total_tax,
             COALESCE(SUM(delivery_fee), 0) AS total_delivery_fees,
             COALESCE(SUM(total_amount), 0) AS total_revenue,
             COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total_amount ELSE 0 END), 0) AS cash_collected,
             COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN total_amount ELSE 0 END), 0) AS upi_collected,
             COALESCE(SUM(CASE WHEN payment_method = 'CARD' THEN total_amount ELSE 0 END), 0) AS card_collected,
             COALESCE(SUM(CASE WHEN payment_method NOT IN ('CASH', 'UPI', 'CARD') THEN total_amount ELSE 0 END), 0) AS other_digital_collected,
             COALESCE(SUM(CASE WHEN payment_status = 'REFUNDED' THEN total_amount ELSE 0 END), 0) AS refunds_total
      FROM canonical_orders
      WHERE franchise_id = $1
        AND order_date >= $2 AND order_date <= $3
        ${branchClause}
      GROUP BY order_date
      ORDER BY order_date ASC
    `;

    const res = await query(sql, sqlParams);
    const headers = [
      'Date',
      'Total Orders',
      'Online Orders',
      'POS Orders',
      'Gross Sales',
      'Total Discounts',
      'Net Sales',
      'CGST (2.5%)',
      'SGST (2.5%)',
      'Total Tax (5%)',
      'Delivery Fees',
      'Total Revenue',
      'Cash Collected',
      'UPI Collected',
      'Card Collected',
      'Other Online Collected',
      'Refunds Total',
      'Net Amount Collected'
    ];

    const rows = res.rows.map((r: any) => {
      const gross = Number(r.gross_sales || 0);
      const discounts = Number(r.total_discounts || 0);
      const net = Number(r.net_sales || 0);
      const cgst = Number(r.total_cgst || 0);
      const sgst = Number(r.total_sgst || 0);
      const tax = Number(r.total_tax || 0);
      const delivery = Number(r.total_delivery_fees || 0);
      const revenue = Number(r.total_revenue || 0);
      const cash = Number(r.cash_collected || 0);
      const upi = Number(r.upi_collected || 0);
      const card = Number(r.card_collected || 0);
      const other = Number(r.other_digital_collected || 0);
      const refunds = Number(r.refunds_total || 0);
      const netCollected = revenue - refunds;

      return [
        r.order_date instanceof Date ? r.order_date.toISOString().split('T')[0] : r.order_date,
        Number(r.total_orders || 0),
        Number(r.online_orders || 0),
        Number(r.pos_orders || 0),
        gross.toFixed(2),
        discounts.toFixed(2),
        net.toFixed(2),
        cgst.toFixed(2),
        sgst.toFixed(2),
        tax.toFixed(2),
        delivery.toFixed(2),
        revenue.toFixed(2),
        cash.toFixed(2),
        upi.toFixed(2),
        card.toFixed(2),
        other.toFixed(2),
        refunds.toFixed(2),
        netCollected.toFixed(2)
      ];
    });

    const csvContent = this.buildCsv(headers, rows);
    return {
      csvContent,
      rowCount: rows.length,
      startDate,
      endDate,
      franchiseId,
      branchId,
      reportType: 'FINANCIAL_SUMMARY'
    };
  }

  /**
   * 5. Granular Order Items Breakdown CSV Export
   * Retains franchise business records down to individual line items.
   */
  public static async generateOrderItemsCsv(params: ReportQueryParams): Promise<CsvExportResult> {
    const { franchiseId, branchId, startDate, endDate } = params;

    const sqlParams: any[] = [franchiseId, startDate, endDate];
    let branchClause = '';
    if (branchId && branchId !== 'all') {
      sqlParams.push(branchId);
      branchClause = ` AND o.branch_id = $${sqlParams.length}`;
    }

    const sql = `
      SELECT o.id AS order_id, o.permanent_bill_no, o.daily_order_no, o.order_date, o.order_time,
             o.order_source, o.order_type, o.order_status, o.payment_method, o.payment_status,
             o.customer_name, o.customer_phone,
             i.id AS item_id, i.menu_item_id, i.item_name, i.size_variant, i.crust,
             i.quantity, i.unit_price, i.addons_json, i.tax_amount AS item_tax,
             i.discount_amount AS item_discount, i.line_total,
             i.created_at
      FROM canonical_orders o
      JOIN canonical_order_items i ON i.order_id = o.id
      WHERE o.franchise_id = $1
        AND o.order_date >= $2 AND o.order_date <= $3
        ${branchClause}
      ORDER BY o.order_date ASC, o.order_time ASC, i.id ASC
    `;

    const res = await query(sql, sqlParams);
    const headers = [
      'Order ID',
      'Permanent Bill No',
      'Daily Order No',
      'Date',
      'Time',
      'Source',
      'Type',
      'Order Status',
      'Payment Method',
      'Payment Status',
      'Customer Name',
      'Customer Phone',
      'Item ID',
      'Menu Item ID',
      'Item Name',
      'Size Variant',
      'Crust',
      'Quantity',
      'Unit Price',
      'Addons',
      'Item Tax',
      'Item Discount',
      'Line Total',
      'Created At'
    ];

    const rows = res.rows.map((r: any) => [
      r.order_id,
      r.permanent_bill_no,
      r.daily_order_no,
      r.order_date instanceof Date ? r.order_date.toISOString().split('T')[0] : r.order_date,
      r.order_time,
      r.order_source,
      r.order_type,
      r.order_status,
      r.payment_method,
      r.payment_status,
      r.customer_name,
      r.customer_phone,
      r.item_id,
      r.menu_item_id || '',
      r.item_name,
      r.size_variant || 'Standard',
      r.crust || 'Default',
      Number(r.quantity || 1),
      Number(r.unit_price || 0).toFixed(2),
      typeof r.addons_json === 'string' ? r.addons_json : JSON.stringify(r.addons_json || []),
      Number(r.item_tax || 0).toFixed(2),
      Number(r.item_discount || 0).toFixed(2),
      Number(r.line_total || 0).toFixed(2),
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at
    ]);

    const csvContent = this.buildCsv(headers, rows);
    return {
      csvContent,
      rowCount: rows.length,
      startDate,
      endDate,
      franchiseId,
      branchId,
      reportType: 'ORDER_ITEMS'
    };
  }
}
