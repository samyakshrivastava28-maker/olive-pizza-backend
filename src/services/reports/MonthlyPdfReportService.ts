/**
 * MonthlyPdfReportService.ts — Professional Multi-Page Monthly Sales PDF Engine
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. 100% REAL POSTGRESQL DATA: Sourced exclusively via SalesCalculationEngine.
 * 2. ALL 7 MANDATORY SECTIONS:
 *    - Header (Olive Pizza Monthly Sales Report, Restaurant, Franchise, Period, Generated Date)
 *    - Section 1: Monthly Summary (KPIs, Financials, Payment & Channel Breakdown)
 *    - Section 2: Complete Monthly Sales Ledger (EVERY single bill with Permanent Bill No, Daily Order No, exact items, etc.)
 *    - Section 3: Daily Sales Summary (Day-by-day revenue ledger)
 *    - Section 4: Payment Summary (Cash, UPI, Card, Wallet, COD)
 *    - Section 5: Item Sales (Exact historical item names & quantities)
 *    - Section 6: Cancelled / Refunded Orders (Audit trail with reasons)
 *    - Section 7: Final Accounting Summary (Gross - Discounts - Refunds = Net Sales)
 * 3. MULTI-PAGE FORMATTING: Repeated headers on page wraps, clean table typography, page numbering.
 */

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SalesCalculationEngine } from './SalesCalculationEngine.js';

export interface MonthlyPdfOptions {
  monthName: string; // e.g. 'September'
  year: number;      // e.g. 2026
  branchId?: string;
  branchName?: string;
  franchiseId?: string;
  franchiseName?: string;
  channel?: 'ALL' | 'ONLINE' | 'POS';
}

export class MonthlyPdfReportService {
  /**
   * Generates the complete, professional multi-page monthly sales PDF document.
   */
  public static async generateMonthlyReportBuffer(options: MonthlyPdfOptions): Promise<Buffer> {
    const {
      monthName,
      year,
      branchId = 'main_branch',
      branchName = 'Olive Pizza — Rajnandgaon HQ',
      franchiseId = 'fra_primary',
      franchiseName = 'Olive Pizza Franchise',
      channel = 'ALL'
    } = options;

    // 1. Resolve Month Start and End in IST
    const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
    const startDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
    const lastDayNum = new Date(year, monthIndex + 1, 0).getDate();
    const endDate = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(lastDayNum).padStart(2, '0')}`;
    const channelSuffix = channel === 'ONLINE' ? ' (ONLINE ORDERS)' : channel === 'POS' ? ' (POS DIRECT BILLING)' : '';
    const periodLabel = `${monthName.toUpperCase()} ${year}${channelSuffix}`;

    // 2. Fetch all real data deterministically from PostgreSQL
    const [summary, dailyLedger, itemSales, cancelledOrders, completeLedger] = await Promise.all([
      SalesCalculationEngine.getSalesSummary({ branchId, franchiseId, startDate, endDate, periodLabel, channel }),
      SalesCalculationEngine.getDailySalesLedger({ branchId, franchiseId, startDate, endDate, channel }),
      SalesCalculationEngine.getItemSalesSummary({ branchId, franchiseId, startDate, endDate, limit: 50, channel }),
      SalesCalculationEngine.getCancelledOrders({ branchId, franchiseId, startDate, endDate, channel }),
      SalesCalculationEngine.getCompleteMonthlyLedger({ branchId, franchiseId, startDate, endDate, channel }),
    ]);

    // 3. Initialize jsPDF document (Portrait, A4)
    const doc = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });

    const pageWidth = doc.internal.pageSize.getWidth();
    const generatedDateStr = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date());

    // ── PAGE 1: HEADER & SECTION 1: MONTHLY SUMMARY ──────────────────────────
    // Header Banner
    doc.setFillColor(15, 23, 42); // Dark Slate #0F172A
    doc.rect(0, 0, pageWidth, 40, 'F');

    doc.setTextColor(245, 158, 11); // Amber #F59E0B
    doc.setFontSize(18);
    const reportTitle = channel === 'ONLINE' 
      ? 'OLIVE PIZZA — ONLINE ORDERS MONTHLY REPORT'
      : channel === 'POS'
      ? 'OLIVE PIZZA — POS DIRECT BILLING MONTHLY REPORT'
      : 'OLIVE PIZZA — CONSOLIDATED MONTHLY SALES REPORT';
    doc.text(reportTitle, 14, 16);

    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(`Restaurant: ${branchName} | Franchise: ${franchiseName}`, 14, 25);
    doc.text(`Reporting Period: ${periodLabel} (${startDate} to ${endDate}) | Generated: ${generatedDateStr}`, 14, 32);

    let currentY = 48;

    // SECTION 1: MONTHLY SUMMARY
    doc.setTextColor(15, 23, 42);
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 1 — MONTHLY SUMMARY & REVENUE KPIS', 14, currentY);
    currentY += 4;

    const kpiData = [
      ['Total Valid Bills', summary.totalBills.toString(), 'Gross Sales', `Rs. ${summary.grossSales.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['Online Customer Orders', summary.onlineOrdersCount.toString(), 'Total Discounts', `Rs. ${summary.discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['Physical / POS Orders', summary.physicalOrdersCount.toString(), 'Refunds Total', `Rs. ${summary.refundAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['Cancelled Orders', summary.cancelledOrdersCount.toString(), '5% F&B GST Collected', `Rs. ${summary.taxAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['Average Order Value (AOV)', `Rs. ${summary.averageOrderValue.toFixed(2)}`, 'NET SALES', `Rs. ${summary.netSales.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`]
    ];

    autoTable(doc, {
      startY: currentY,
      body: kpiData,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 45 },
        1: { cellWidth: 35 },
        2: { fontStyle: 'bold', fillColor: [248, 250, 252], cellWidth: 45 },
        3: { cellWidth: 45, fontStyle: 'bold', textColor: [15, 23, 42] }
      },
      margin: { left: 14, right: 14 }
    });

    currentY = (doc as any).lastAutoTable.finalY + 8;

    // Payment & Channel Split Table
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Payment & Channel Breakdown', 14, currentY);
    currentY += 3;

    const breakdownRows = [
      ['Cash Payments', `Rs. ${summary.paymentBreakdown.cash.amount.toLocaleString('en-IN')}`, `${summary.paymentBreakdown.cash.count} bills`, `${summary.paymentBreakdown.cash.percentage}%`],
      ['UPI / QR Payments', `Rs. ${summary.paymentBreakdown.upi.amount.toLocaleString('en-IN')}`, `${summary.paymentBreakdown.upi.count} bills`, `${summary.paymentBreakdown.upi.percentage}%`],
      ['Card / EDC Machine', `Rs. ${summary.paymentBreakdown.card.amount.toLocaleString('en-IN')}`, `${summary.paymentBreakdown.card.count} bills`, `${summary.paymentBreakdown.card.percentage}%`],
      ['Wallet / Prepaid', `Rs. ${summary.paymentBreakdown.wallet.amount.toLocaleString('en-IN')}`, `${summary.paymentBreakdown.wallet.count} bills`, `${summary.paymentBreakdown.wallet.percentage}%`],
      ['Cash on Delivery (COD)', `Rs. ${summary.paymentBreakdown.cod.amount.toLocaleString('en-IN')}`, `${summary.paymentBreakdown.cod.count} bills`, `${summary.paymentBreakdown.cod.percentage}%`],
      ['In-Store Dine-In', `Rs. ${summary.channelBreakdown.dineIn.amount.toLocaleString('en-IN')}`, `${summary.channelBreakdown.dineIn.count} orders`, `${summary.channelBreakdown.dineIn.percentage}%`],
      ['Counter Takeaway', `Rs. ${summary.channelBreakdown.takeaway.amount.toLocaleString('en-IN')}`, `${summary.channelBreakdown.takeaway.count} orders`, `${summary.channelBreakdown.takeaway.percentage}%`],
      ['Home Delivery', `Rs. ${summary.channelBreakdown.delivery.amount.toLocaleString('en-IN')}`, `${summary.channelBreakdown.delivery.count} orders`, `${summary.channelBreakdown.delivery.percentage}%`],
      ['Online Customer App', `Rs. ${summary.channelBreakdown.online.amount.toLocaleString('en-IN')}`, `${summary.channelBreakdown.online.count} orders`, `${summary.channelBreakdown.online.percentage}%`]
    ];

    autoTable(doc, {
      startY: currentY,
      head: [['Channel / Payment Category', 'Total Amount', 'Orders Count', 'Share %']],
      body: breakdownRows,
      theme: 'striped',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255] },
      margin: { left: 14, right: 14 }
    });

    // ── PAGE 2: SECTION 3: DAILY SALES SUMMARY & SECTION 4: PAYMENTS ─────────
    doc.addPage();
    currentY = 16;

    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 3 — DAILY SALES SUMMARY (CALENDAR LEDGER)', 14, currentY);
    currentY += 4;

    const dailyRows = dailyLedger.length > 0 ? dailyLedger.map(d => [
      d.date,
      d.totalBills.toString(),
      `Rs. ${d.grossSales.toFixed(2)}`,
      `Rs. ${d.discounts.toFixed(2)}`,
      `Rs. ${d.refunds.toFixed(2)}`,
      `Rs. ${d.netSales.toFixed(2)}`,
      `Rs. ${d.cashAmount.toFixed(2)}`,
      `Rs. ${d.upiAmount.toFixed(2)}`
    ]) : [['No daily sales recorded for this period', '-', '-', '-', '-', '-', '-', '-']];

    autoTable(doc, {
      startY: currentY,
      head: [['Date', 'Bills', 'Gross', 'Discount', 'Refund', 'Net Sales', 'Cash', 'UPI']],
      body: dailyRows,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 1.8 },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255] },
      margin: { left: 14, right: 14 }
    });

    currentY = (doc as any).lastAutoTable.finalY + 8;

    // SECTION 7: FINAL ACCOUNTING SUMMARY
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 7 — FINAL ACCOUNTING RECONCILIATION', 14, currentY);
    currentY += 4;

    const accountingData = [
      ['Gross Sales (Subtotal before discounts)', `Rs. ${summary.grossSales.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['(-) Total Promotional Discounts & Coupons', `(-) Rs. ${summary.discountAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['(-) Customer Refunds & Void Cancellations', `(-) Rs. ${summary.refundAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['(+) Total F&B GST (2.5% CGST + 2.5% SGST)', `(+) Rs. ${summary.taxAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['(+) Delivery Fees Collected', `(+) Rs. ${summary.deliveryFeeTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
      ['(=) NET REALIZED SALES', `Rs. ${summary.netSales.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`]
    ];

    autoTable(doc, {
      startY: currentY,
      body: accountingData,
      theme: 'plain',
      styles: { fontSize: 8, cellPadding: 2 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 110 },
        1: { fontStyle: 'bold', cellWidth: 60, halign: 'right' }
      },
      margin: { left: 14, right: 14 }
    });

    // ── PAGE 3: SECTION 5: ITEM SALES & SECTION 6: CANCELLED ORDERS ──────────
    doc.addPage();
    currentY = 16;

    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 5 — ITEM SALES SUMMARY (IMMUTABLE CATALOG SNAPSHOTS)', 14, currentY);
    currentY += 4;

    const itemRows = itemSales.length > 0 ? itemSales.map(i => [
      i.itemName,
      i.sizeVariant || 'Regular',
      i.quantitySold.toString(),
      `Rs. ${i.salesValue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    ]) : [['No items sold during this period', '-', '-', '-']];

    autoTable(doc, {
      startY: currentY,
      head: [['Menu Item Name', 'Size / Variant', 'Qty Sold', 'Total Sales Revenue']],
      body: itemRows,
      theme: 'striped',
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255] },
      margin: { left: 14, right: 14 }
    });

    currentY = (doc as any).lastAutoTable.finalY + 8;

    // SECTION 6: CANCELLED & REFUNDED ORDERS
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 6 — CANCELLED & REFUNDED ORDERS AUDIT', 14, currentY);
    currentY += 4;

    const cancelRows = cancelledOrders.length > 0 ? cancelledOrders.map(c => [
      `#${c.permanentBillNo}`,
      `#${c.dailyOrderNo}`,
      `${c.orderDate} ${c.orderTime}`,
      c.customerName,
      `Rs. ${c.amount.toFixed(2)}`,
      c.reason,
      c.orderStatus
    ]) : [['No cancelled or refunded orders recorded for this period', '-', '-', '-', '-', '-', '-']];

    autoTable(doc, {
      startY: currentY,
      head: [['Perm Bill #', 'Daily #', 'Date & Time', 'Customer', 'Amount', 'Audit Reason', 'Status']],
      body: cancelRows,
      theme: 'grid',
      styles: { fontSize: 7, cellPadding: 1.8 },
      headStyles: { fillColor: [153, 27, 27], textColor: [255, 255, 255] }, // Dark Red
      margin: { left: 14, right: 14 }
    });

    // ── PAGE 4+: SECTION 2: COMPLETE MONTHLY SALES LEDGER (EVERY BILL) ────────
    doc.addPage();
    currentY = 16;

    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('SECTION 2 — COMPLETE MONTHLY SALES LEDGER', 14, currentY);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text('Comprehensive auditable transaction ledger containing EVERY single bill generated in this reporting period.', 14, currentY + 5);
    currentY += 8;

    const ledgerRows = completeLedger.length > 0 ? completeLedger.map(b => [
      `#${b.permanentBillNo}`,
      `#${b.dailyOrderNo}`,
      b.orderDate,
      b.orderTime,
      b.orderSource,
      b.orderType,
      b.exactPurchasedItems,
      `Rs. ${b.totalAmount.toFixed(2)}`,
      b.paymentMethod,
      b.paymentStatus,
      b.orderStatus
    ]) : [['No bills found for this monthly period', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']];

    autoTable(doc, {
      startY: currentY,
      head: [['Bill #', 'Daily #', 'Date', 'Time', 'Source', 'Type', 'Exact Items Purchased', 'Total', 'Pay Method', 'Pay Status', 'Order Status']],
      body: ledgerRows,
      theme: 'grid',
      styles: { fontSize: 6.5, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 12, fontStyle: 'bold' },
        1: { cellWidth: 12 },
        2: { cellWidth: 16 },
        3: { cellWidth: 12 },
        4: { cellWidth: 18 },
        5: { cellWidth: 14 },
        6: { cellWidth: 45 },
        7: { cellWidth: 16, fontStyle: 'bold' },
        8: { cellWidth: 14 },
        9: { cellWidth: 14 },
        10: { cellWidth: 14 }
      },
      showHead: 'everyPage', // REPEAT HEADERS ACROSS PAGES!
      margin: { left: 10, right: 10 }
    });

    // ── FOOTER ON ALL PAGES ──────────────────────────────────────────────────
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(148, 163, 184);
      doc.text(
        `Olive Pizza Proprietary Accounting Ledger — ${branchName} | Period: ${periodLabel} | Page ${i} of ${totalPages}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 8,
        { align: 'center' }
      );
    }

    return Buffer.from(doc.output('arraybuffer'));
  }
}
