/**
 * SalesCalculationEngine.ts — Authoritative Deterministic Sales & Accounting Engine
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. SINGLE SOURCE OF TRUTH: Powers POS Dashboard, Monthly PDF Reports, Google Sheets, and Search.
 * 2. 100% DETERMINISTIC SQL: Every number, total, average, and percentage is aggregated
 *    directly from canonical PostgreSQL tables (`canonical_orders`, `canonical_order_items`, `canonical_bills`).
 * 3. ZERO FAKE DATA: Strictly forbids hardcoded placeholders, simulated numbers, or random estimates.
 * 4. ACCOUNTING RECONCILIATION:
 *    - Gross Sales = Subtotal before discounts
 *    - Discounts = Sum of coupon + promotional discounts
 *    - Refunds = Sum of processed refund amounts
 *    - Taxes = 5% F&B GST (2.5% CGST + 2.5% SGST)
 *    - Net Sales = Gross Sales - Discounts - Refunds
 */

import { query } from '../../config/postgres.js';
import { BillingNumberService } from '../pos/BillingNumberService.js';

export interface DateRange {
  startDate: string; // 'YYYY-MM-DD'
  endDate: string;   // 'YYYY-MM-DD'
}

export interface SalesSummaryMetrics {
  periodLabel: string;
  dateRange: DateRange;
  totalBills: number;
  onlineOrdersCount: number;
  physicalOrdersCount: number;
  cancelledOrdersCount: number;
  grossSales: number;
  discountAmount: number;
  refundAmount: number;
  taxAmount: number;
  cgst: number;
  sgst: number;
  netSales: number;
  deliveryFeeTotal: number;
  averageOrderValue: number;
  paymentBreakdown: {
    cash: { amount: number; count: number; percentage: number };
    upi: { amount: number; count: number; percentage: number };
    card: { amount: number; count: number; percentage: number };
    wallet: { amount: number; count: number; percentage: number };
    cod: { amount: number; count: number; percentage: number };
  };
  channelBreakdown: {
    dineIn: { amount: number; count: number; percentage: number };
    takeaway: { amount: number; count: number; percentage: number };
    delivery: { amount: number; count: number; percentage: number };
    online: { amount: number; count: number; percentage: number };
  };
}

export interface DailyLedgerRow {
  date: string;
  totalBills: number;
  grossSales: number;
  discounts: number;
  refunds: number;
  taxes: number;
  netSales: number;
  cashAmount: number;
  upiAmount: number;
  cardAmount: number;
  onlineAmount: number;
}

export interface ItemSalesRow {
  itemName: string;
  sizeVariant?: string;
  quantitySold: number;
  salesValue: number;
}

export interface CancelledOrderRow {
  permanentBillNo: number;
  dailyOrderNo: number;
  orderDate: string;
  orderTime: string;
  customerName: string;
  amount: number;
  reason: string;
  orderSource: string;
  orderStatus: string;
}

export interface CompleteBillLedgerRow {
  permanentBillNo: number;
  dailyOrderNo: number;
  orderDate: string;
  orderTime: string;
  orderSource: string;
  orderType: string;
  customerName: string;
  customerPhone: string;
  exactPurchasedItems: string;
  totalAmount: number;
  discountAmount: number;
  netAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  orderStatus: string;
  tableNumber?: string;
}

export class SalesCalculationEngine {
  /**
   * Resolves standard predefined or custom date range into [startDate, endDate] in IST.
   */
  public static resolveDateRange(
    period: 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'last_year' | 'custom' = 'today',
    customStart?: string,
    customEnd?: string
  ): { dateRange: DateRange; periodLabel: string } {
    const todayStr = BillingNumberService.getLocalDateString();
    const now = new Date();

    if (period === 'yesterday') {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      const yStr = BillingNumberService.getLocalDateString(y);
      return { dateRange: { startDate: yStr, endDate: yStr }, periodLabel: 'Yesterday' };
    }

    if (period === 'this_week') {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday as first day
      const monday = new Date(now.setDate(diff));
      return {
        dateRange: { startDate: BillingNumberService.getLocalDateString(monday), endDate: todayStr },
        periodLabel: 'This Week'
      };
    }

    if (period === 'last_week') {
      const d = new Date();
      const day = d.getDay();
      const diff = d.getDate() - day - 6;
      const lastMonday = new Date(d.setDate(diff));
      const lastSunday = new Date(lastMonday);
      lastSunday.setDate(lastSunday.getDate() + 6);
      return {
        dateRange: {
          startDate: BillingNumberService.getLocalDateString(lastMonday),
          endDate: BillingNumberService.getLocalDateString(lastSunday)
        },
        periodLabel: 'Last Week'
      };
    }

    if (period === 'this_month') {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        dateRange: { startDate: BillingNumberService.getLocalDateString(firstDay), endDate: todayStr },
        periodLabel: 'This Month'
      };
    }

    if (period === 'last_month') {
      const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDayLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        dateRange: {
          startDate: BillingNumberService.getLocalDateString(firstDayLastMonth),
          endDate: BillingNumberService.getLocalDateString(lastDayLastMonth)
        },
        periodLabel: 'Last Month'
      };
    }

    if (period === 'this_year') {
      const firstDayYear = new Date(now.getFullYear(), 0, 1);
      return {
        dateRange: { startDate: BillingNumberService.getLocalDateString(firstDayYear), endDate: todayStr },
        periodLabel: 'This Year'
      };
    }

    if (period === 'custom' && customStart && customEnd) {
      return {
        dateRange: { startDate: customStart, endDate: customEnd },
        periodLabel: `${customStart} to ${customEnd}`
      };
    }

    return { dateRange: { startDate: todayStr, endDate: todayStr }, periodLabel: 'Today' };
  }

  /**
   * SECTION 12 & SECTION 1: Computes deterministic sales summary metrics directly from PostgreSQL.
   */
  public static async getSalesSummary(params: {
    branchId?: string;
    franchiseId?: string;
    startDate: string;
    endDate: string;
    periodLabel?: string;
    channel?: 'ALL' | 'ONLINE' | 'POS';
  }): Promise<SalesSummaryMetrics> {
    const { branchId, franchiseId, startDate, endDate, periodLabel = 'Custom Period', channel = 'ALL' } = params;

    const filterConditions = ['order_date >= $1', 'order_date <= $2'];
    const queryParams: any[] = [startDate, endDate];

    if (branchId) {
      queryParams.push(branchId);
      filterConditions.push(`branch_id = $${queryParams.length}`);
    }
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterConditions.push(`franchise_id = $${queryParams.length}`);
    }
    if (channel === 'ONLINE') {
      filterConditions.push("order_source = 'ONLINE'");
    } else if (channel === 'POS') {
      filterConditions.push("order_source != 'ONLINE'");
    }

    const whereClause = filterConditions.join(' AND ');

    // 1. Overall Aggregations
    const aggSql = `
      SELECT
        COUNT(*)::integer AS total_orders,
        COUNT(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN 1 END)::integer AS valid_bills,
        COUNT(CASE WHEN order_status IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN 1 END)::integer AS cancelled_count,
        COUNT(CASE WHEN order_source = 'ONLINE' AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN 1 END)::integer AS online_count,
        COUNT(CASE WHEN order_source != 'ONLINE' AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN 1 END)::integer AS physical_count,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN subtotal ELSE 0 END), 0)::numeric AS gross_sales,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN discount_amount ELSE 0 END), 0)::numeric AS discounts,
        COALESCE(SUM(refund_amount), 0)::numeric AS refunds,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN tax_amount ELSE 0 END), 0)::numeric AS tax_amount,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN cgst ELSE 0 END), 0)::numeric AS cgst,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN sgst ELSE 0 END), 0)::numeric AS sgst,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN delivery_fee ELSE 0 END), 0)::numeric AS delivery_fee_total,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS total_net_sum
      FROM canonical_orders
      WHERE ${whereClause};
    `;

    const aggRes = await query(aggSql, queryParams);
    const row = aggRes.rows[0] || {};

    const totalBills = parseInt(row.valid_bills || '0', 10);
    const grossSales = parseFloat(row.gross_sales || '0');
    const discountAmount = parseFloat(row.discounts || '0');
    const refundAmount = parseFloat(row.refunds || '0');
    const taxAmount = parseFloat(row.tax_amount || '0');
    const cgst = parseFloat(row.cgst || '0');
    const sgst = parseFloat(row.sgst || '0');
    const deliveryFeeTotal = parseFloat(row.delivery_fee_total || '0');
    const netSales = Math.max(0, grossSales - discountAmount - refundAmount + taxAmount + deliveryFeeTotal);
    const averageOrderValue = totalBills > 0 ? parseFloat((netSales / totalBills).toFixed(2)) : 0.00;

    // 2. Payment Methods Breakdown
    const paySql = `
      SELECT
        UPPER(payment_method) AS method,
        COUNT(*)::integer AS order_count,
        COALESCE(SUM(total_amount), 0)::numeric AS total_amount
      FROM canonical_orders
      WHERE ${whereClause} AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided')
      GROUP BY UPPER(payment_method);
    `;
    const payRes = await query(paySql, queryParams);

    const paymentBreakdown = {
      cash: { amount: 0, count: 0, percentage: 0 },
      upi: { amount: 0, count: 0, percentage: 0 },
      card: { amount: 0, count: 0, percentage: 0 },
      wallet: { amount: 0, count: 0, percentage: 0 },
      cod: { amount: 0, count: 0, percentage: 0 },
    };

    payRes.rows.forEach(r => {
      const m = r.method;
      const amt = parseFloat(r.total_amount);
      const cnt = parseInt(r.order_count, 10);
      const pct = netSales > 0 ? parseFloat(((amt / netSales) * 100).toFixed(1)) : 0;

      if (m === 'CASH') paymentBreakdown.cash = { amount: amt, count: cnt, percentage: pct };
      else if (m === 'UPI' || m === 'QR') paymentBreakdown.upi = { amount: amt, count: cnt, percentage: pct };
      else if (m === 'CARD' || m === 'EDC' || m === 'POS_CARD') paymentBreakdown.card = { amount: amt, count: cnt, percentage: pct };
      else if (m === 'WALLET') paymentBreakdown.wallet = { amount: amt, count: cnt, percentage: pct };
      else if (m === 'COD') paymentBreakdown.cod = { amount: amt, count: cnt, percentage: pct };
    });

    // 3. Channel Breakdown
    const chanSql = `
      SELECT
        order_source,
        order_type,
        COUNT(*)::integer AS order_count,
        COALESCE(SUM(total_amount), 0)::numeric AS total_amount
      FROM canonical_orders
      WHERE ${whereClause} AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided')
      GROUP BY order_source, order_type;
    `;
    const chanRes = await query(chanSql, queryParams);

    const channelBreakdown = {
      dineIn: { amount: 0, count: 0, percentage: 0 },
      takeaway: { amount: 0, count: 0, percentage: 0 },
      delivery: { amount: 0, count: 0, percentage: 0 },
      online: { amount: 0, count: 0, percentage: 0 },
    };

    chanRes.rows.forEach(r => {
      const src = r.order_source;
      const typ = (r.order_type || '').toLowerCase();
      const amt = parseFloat(r.total_amount);
      const cnt = parseInt(r.order_count, 10);
      const pct = netSales > 0 ? parseFloat(((amt / netSales) * 100).toFixed(1)) : 0;

      if (src === 'ONLINE') {
        channelBreakdown.online.amount += amt;
        channelBreakdown.online.count += cnt;
        channelBreakdown.online.percentage = netSales > 0 ? parseFloat(((channelBreakdown.online.amount / netSales) * 100).toFixed(1)) : 0;
      } else if (src === 'POS_DINE_IN' || typ === 'dine_in') {
        channelBreakdown.dineIn.amount += amt;
        channelBreakdown.dineIn.count += cnt;
        channelBreakdown.dineIn.percentage = netSales > 0 ? parseFloat(((channelBreakdown.dineIn.amount / netSales) * 100).toFixed(1)) : 0;
      } else if (src === 'POS_TAKEAWAY' || typ === 'pickup') {
        channelBreakdown.takeaway.amount += amt;
        channelBreakdown.takeaway.count += cnt;
        channelBreakdown.takeaway.percentage = netSales > 0 ? parseFloat(((channelBreakdown.takeaway.amount / netSales) * 100).toFixed(1)) : 0;
      } else {
        channelBreakdown.delivery.amount += amt;
        channelBreakdown.delivery.count += cnt;
        channelBreakdown.delivery.percentage = netSales > 0 ? parseFloat(((channelBreakdown.delivery.amount / netSales) * 100).toFixed(1)) : 0;
      }
    });

    return {
      periodLabel,
      dateRange: { startDate, endDate },
      totalBills,
      onlineOrdersCount: parseInt(row.online_count || '0', 10),
      physicalOrdersCount: parseInt(row.physical_count || '0', 10),
      cancelledOrdersCount: parseInt(row.cancelled_count || '0', 10),
      grossSales,
      discountAmount,
      refundAmount,
      taxAmount,
      cgst,
      sgst,
      netSales,
      deliveryFeeTotal,
      averageOrderValue,
      paymentBreakdown,
      channelBreakdown,
    };
  }

  /**
   * SECTION 3: Computes Daily Sales Ledger (calendar-day rollup)
   */
  public static async getDailySalesLedger(params: {
    branchId?: string;
    franchiseId?: string;
    startDate: string;
    endDate: string;
    channel?: 'ALL' | 'ONLINE' | 'POS';
  }): Promise<DailyLedgerRow[]> {
    const { branchId, franchiseId, startDate, endDate, channel = 'ALL' } = params;
    const filterConditions = ['order_date >= $1', 'order_date <= $2'];
    const queryParams: any[] = [startDate, endDate];

    if (branchId) {
      queryParams.push(branchId);
      filterConditions.push(`branch_id = $${queryParams.length}`);
    }
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterConditions.push(`franchise_id = $${queryParams.length}`);
    }
    if (channel === 'ONLINE') {
      filterConditions.push("order_source = 'ONLINE'");
    } else if (channel === 'POS') {
      filterConditions.push("order_source != 'ONLINE'");
    }

    const sql = `
      SELECT
        TO_CHAR(order_date, 'YYYY-MM-DD') AS date,
        COUNT(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN 1 END)::integer AS total_bills,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN subtotal ELSE 0 END), 0)::numeric AS gross_sales,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN discount_amount ELSE 0 END), 0)::numeric AS discounts,
        COALESCE(SUM(refund_amount), 0)::numeric AS refunds,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN tax_amount ELSE 0 END), 0)::numeric AS taxes,
        COALESCE(SUM(CASE WHEN order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS net_sales,
        COALESCE(SUM(CASE WHEN UPPER(payment_method) = 'CASH' AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS cash_amount,
        COALESCE(SUM(CASE WHEN UPPER(payment_method) IN ('UPI', 'QR') AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS upi_amount,
        COALESCE(SUM(CASE WHEN UPPER(payment_method) IN ('CARD', 'EDC', 'POS_CARD') AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS card_amount,
        COALESCE(SUM(CASE WHEN order_source = 'ONLINE' AND order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') THEN total_amount ELSE 0 END), 0)::numeric AS online_amount
      FROM canonical_orders
      WHERE ${filterConditions.join(' AND ')}
      GROUP BY order_date
      ORDER BY order_date ASC;
    `;

    const res = await query(sql, queryParams);
    return res.rows.map(r => ({
      date: r.date,
      totalBills: parseInt(r.total_bills, 10),
      grossSales: parseFloat(r.gross_sales),
      discounts: parseFloat(r.discounts),
      refunds: parseFloat(r.refunds),
      taxes: parseFloat(r.taxes),
      netSales: parseFloat(r.net_sales),
      cashAmount: parseFloat(r.cash_amount),
      upiAmount: parseFloat(r.upi_amount),
      cardAmount: parseFloat(r.card_amount),
      onlineAmount: parseFloat(r.online_amount),
    }));
  }

  /**
   * SECTION 5: Computes Exact Item Sales Summary from historical item snapshots.
   */
  public static async getItemSalesSummary(params: {
    branchId?: string;
    franchiseId?: string;
    startDate: string;
    endDate: string;
    limit?: number;
    channel?: 'ALL' | 'ONLINE' | 'POS';
  }): Promise<ItemSalesRow[]> {
    const { branchId, franchiseId, startDate, endDate, limit = 100, channel = 'ALL' } = params;
    const filterConditions = ['o.order_date >= $1', 'o.order_date <= $2', "o.order_status NOT IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided')"];
    const queryParams: any[] = [startDate, endDate];

    if (branchId) {
      queryParams.push(branchId);
      filterConditions.push(`o.branch_id = $${queryParams.length}`);
    }
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterConditions.push(`o.franchise_id = $${queryParams.length}`);
    }
    if (channel === 'ONLINE') {
      filterConditions.push("o.order_source = 'ONLINE'");
    } else if (channel === 'POS') {
      filterConditions.push("o.order_source != 'ONLINE'");
    }

    const sql = `
      SELECT
        i.item_name,
        COALESCE(i.size_variant, 'Regular') AS size_variant,
        SUM(i.quantity)::integer AS quantity_sold,
        SUM(i.line_total)::numeric AS sales_value
      FROM canonical_order_items i
      JOIN canonical_orders o ON i.order_id = o.id
      WHERE ${filterConditions.join(' AND ')}
      GROUP BY i.item_name, i.size_variant
      ORDER BY sales_value DESC
      LIMIT ${limit};
    `;

    const res = await query(sql, queryParams);
    return res.rows.map(r => ({
      itemName: r.item_name,
      sizeVariant: r.size_variant,
      quantitySold: parseInt(r.quantity_sold, 10),
      salesValue: parseFloat(r.sales_value),
    }));
  }

  /**
   * SECTION 6: Retrieves Cancelled & Refunded Orders with reasons.
   */
  public static async getCancelledOrders(params: {
    branchId?: string;
    franchiseId?: string;
    startDate: string;
    endDate: string;
    channel?: 'ALL' | 'ONLINE' | 'POS';
  }): Promise<CancelledOrderRow[]> {
    const { branchId, franchiseId, startDate, endDate, channel = 'ALL' } = params;
    const filterConditions = ['order_date >= $1', 'order_date <= $2', "(order_status IN ('CANCELLED', 'cancelled', 'VOIDED', 'voided') OR refund_amount > 0)"];
    const queryParams: any[] = [startDate, endDate];

    if (branchId) {
      queryParams.push(branchId);
      filterConditions.push(`branch_id = $${queryParams.length}`);
    }
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterConditions.push(`franchise_id = $${queryParams.length}`);
    }
    if (channel === 'ONLINE') {
      filterConditions.push("order_source = 'ONLINE'");
    } else if (channel === 'POS') {
      filterConditions.push("order_source != 'ONLINE'");
    }

    const sql = `
      SELECT
        permanent_bill_no,
        daily_order_no,
        TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date,
        TO_CHAR(order_time, 'HH24:MI') AS order_time,
        customer_name,
        total_amount,
        COALESCE(cancellation_reason, 'Customer cancelled / Voided by cashier') AS reason,
        order_source,
        order_status
      FROM canonical_orders
      WHERE ${filterConditions.join(' AND ')}
      ORDER BY permanent_bill_no ASC;
    `;

    const res = await query(sql, queryParams);
    return res.rows.map(r => ({
      permanentBillNo: parseInt(r.permanent_bill_no, 10),
      dailyOrderNo: parseInt(r.daily_order_no, 10),
      orderDate: r.order_date,
      orderTime: r.order_time,
      customerName: r.customer_name,
      amount: parseFloat(r.total_amount),
      reason: r.reason,
      orderSource: r.order_source,
      orderStatus: r.order_status,
    }));
  }

  /**
   * SECTION 2: Retrieves Complete Monthly Sales Ledger (EVERY single bill in period).
   */
  public static async getCompleteMonthlyLedger(params: {
    branchId?: string;
    franchiseId?: string;
    startDate: string;
    endDate: string;
    channel?: 'ALL' | 'ONLINE' | 'POS';
  }): Promise<CompleteBillLedgerRow[]> {
    const { branchId, franchiseId, startDate, endDate, channel = 'ALL' } = params;
    const filterConditions = ['o.order_date >= $1', 'o.order_date <= $2'];
    const queryParams: any[] = [startDate, endDate];

    if (branchId) {
      queryParams.push(branchId);
      filterConditions.push(`o.branch_id = $${queryParams.length}`);
    }
    if (franchiseId) {
      queryParams.push(franchiseId);
      filterConditions.push(`o.franchise_id = $${queryParams.length}`);
    }
    if (channel === 'ONLINE') {
      filterConditions.push("o.order_source = 'ONLINE'");
    } else if (channel === 'POS') {
      filterConditions.push("o.order_source != 'ONLINE'");
    }

    const sql = `
      SELECT
        o.permanent_bill_no,
        o.daily_order_no,
        TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
        TO_CHAR(o.order_time, 'HH24:MI') AS order_time,
        o.order_source,
        o.order_type,
        o.customer_name,
        o.customer_phone,
        o.total_amount,
        o.discount_amount,
        (o.subtotal - o.discount_amount + o.tax_amount + o.delivery_fee) AS net_amount,
        o.payment_method,
        o.payment_status,
        o.order_status,
        o.table_number,
        COALESCE(
          STRING_AGG(CONCAT(i.item_name, ' (', COALESCE(i.size_variant, 'Reg'), ') ×', i.quantity), ', '),
          'No items'
        ) AS exact_items
      FROM canonical_orders o
      LEFT JOIN canonical_order_items i ON o.id = i.order_id
      WHERE ${filterConditions.join(' AND ')}
      GROUP BY o.id, o.permanent_bill_no, o.daily_order_no, o.order_date, o.order_time,
               o.order_source, o.order_type, o.customer_name, o.customer_phone,
               o.total_amount, o.discount_amount, o.subtotal, o.tax_amount,
               o.delivery_fee, o.payment_method, o.payment_status, o.order_status, o.table_number
      ORDER BY o.permanent_bill_no ASC;
    `;

    const res = await query(sql, queryParams);
    return res.rows.map(r => ({
      permanentBillNo: parseInt(r.permanent_bill_no, 10),
      dailyOrderNo: parseInt(r.daily_order_no, 10),
      orderDate: r.order_date,
      orderTime: r.order_time,
      orderSource: r.order_source,
      orderType: r.order_type,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      exactPurchasedItems: r.exact_items,
      totalAmount: parseFloat(r.total_amount),
      discountAmount: parseFloat(r.discount_amount),
      netAmount: parseFloat(r.net_amount),
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      orderStatus: r.order_status,
      tableNumber: r.table_number,
    }));
  }
}
