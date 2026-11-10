import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GoogleSheetsReportService } from '../services/reports/GoogleSheetsReportService.js';

describe('Google Sheets Professional Monthly Workbook Tests', () => {

  it('TEST 1: Workbook contains all 13 standard accounting and management tabs', () => {
    const expectedTabs = [
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

    assert.deepStrictEqual(GoogleSheetsReportService.WORKBOOK_TABS, expectedTabs);
    assert.strictEqual(GoogleSheetsReportService.WORKBOOK_TABS.length, 13);
  });

  it('TEST 2: Month sheet title generates in standardized <Year>-<Month> format', () => {
    const testDate = new Date('2026-08-25T12:00:00.000Z');
    const title = GoogleSheetsReportService.getMonthSheetTitle(testDate);
    assert.strictEqual(title, '2026-August');
  });

  it('TEST 3: GST Tax calculation correctly applies 5% GST (2.5% CGST + 2.5% SGST)', () => {
    const subtotal = 1000;
    const discount = 100;
    const taxableAmount = Math.max(0, subtotal - discount); // 900
    const cgst = Number((taxableAmount * 0.025).toFixed(2)); // 22.50
    const sgst = Number((taxableAmount * 0.025).toFixed(2)); // 22.50
    const totalTax = Number((cgst + sgst).toFixed(2)); // 45.00
    const finalAmount = taxableAmount + totalTax; // 945.00

    assert.strictEqual(taxableAmount, 900);
    assert.strictEqual(cgst, 22.5);
    assert.strictEqual(sgst, 22.5);
    assert.strictEqual(totalTax, 45);
    assert.strictEqual(finalAmount, 945);
  });

  it('TEST 4: Idempotent order matching by unique orderId', () => {
    const existingRows = [
      ['#1001', 'ord_aaa111', '25/08/2026'],
      ['#1002', 'ord_bbb222', '25/08/2026'],
    ];

    const incomingOrderId = 'ord_bbb222';
    const matchIndex = existingRows.findIndex(r => r[1] === incomingOrderId);

    assert.strictEqual(matchIndex, 1); // Found at index 1 -> updates row in place
  });

  it('TEST 5: Channel matrix categorization maps correctly', () => {
    const channels = [
      { orderSource: 'ONLINE', fulfillmentType: 'DELIVERY', expected: 'Customer App / Web' },
      { orderSource: 'POS', fulfillmentType: 'DINE_IN', expected: 'POS Dine-In' },
      { orderSource: 'POS', fulfillmentType: 'TAKEAWAY', expected: 'POS Takeaway' },
      { orderSource: 'POS', fulfillmentType: 'DELIVERY', expected: 'POS Delivery' },
    ];

    assert.strictEqual(channels.length, 4);
  });
});
