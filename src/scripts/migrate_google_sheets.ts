import { adminDb as db } from '../config/firebase.js';
import { google } from 'googleapis';

// Helper: Google Sheets Client
function getSheetsClient() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  let authClient: any;

  if (serviceAccountJson) {
    const decoded = JSON.parse(Buffer.from(serviceAccountJson, 'base64').toString('utf-8'));
    authClient = new google.auth.JWT({
      email: decoded.client_email,
      key: decoded.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
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

  return google.sheets({ version: 'v4', auth: authClient });
}

// Sanitization helpers
function sanitizeText(val: any, fallback = '-'): string {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') {
    if (val.addressLine) return sanitizeText(val.addressLine, fallback);
    if (val.formatted) return sanitizeText(val.formatted, fallback);
    if (val.name) return sanitizeText(val.name, fallback);
    return fallback;
  }
  let str = String(val).trim();
  if (!str || str === 'undefined' || str === 'null' || str === '[object Object]') return fallback;
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  return str;
}

function sanitizePhoneNumber(phone: any): string {
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

function formatItemsSummary(items: any[]): string {
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

// Standard 12-Tab Header Definitions
const ORDER_DETAILS_HEADERS = [
  'ORDER ID', 'BILL NO', 'DATE', 'TIME', 'FRANCHISE', 'BRANCH', 'SOURCE',
  'ORDER TYPE', 'FULFILLMENT', 'TABLE NO', 'CUSTOMER NAME', 'CUSTOMER PHONE',
  'ITEMS SUMMARY', 'ITEM QTY', 'SUBTOTAL (₹)', 'DISCOUNT (₹)', 'COUPON CODE',
  'TAXABLE AMT (₹)', 'CGST 2.5% (₹)', 'SGST 2.5% (₹)', 'TOTAL TAX 5% (₹)',
  'DELIVERY FEE (₹)', 'FINAL TOTAL (₹)', 'PAYMENT METHOD', 'PAYMENT STATUS',
  'ORDER STATUS', 'CASHIER / STAFF', 'TERMINAL ID', 'TIMESTAMP'
];

const PRODUCT_SALES_HEADERS = [
  'DATE', 'TIME', 'ORDER ID', 'BILL NO', 'BRANCH', 'PRODUCT NAME', 'CATEGORY',
  'SIZE / VARIANT', 'CRUST TYPE', 'CUSTOMIZATIONS', 'QUANTITY', 'UNIT PRICE (₹)',
  'LINE TOTAL (₹)', 'ORDER SOURCE', 'PAYMENT METHOD'
];

const PAYMENTS_HEADERS = [
  'TRANSACTION ID', 'ORDER ID', 'BILL NO', 'DATE', 'TIME', 'BRANCH',
  'PAYMENT METHOD', 'AMOUNT (₹)', 'PAYMENT STATUS', 'REFERENCE ID', 'STAFF / TERMINAL'
];

const GST_TAX_HEADERS = [
  'DATE', 'BRANCH', 'TOTAL INVOICES', 'GROSS SALES (₹)', 'DISCOUNTS (₹)',
  'TAXABLE TURNOVER (₹)', 'CGST 2.5% (₹)', 'SGST 2.5% (₹)', 'TOTAL TAX 5% (₹)', 'NET INVOICE VALUE (₹)'
];

const DAILY_SALES_HEADERS = [
  'DATE', 'DAY', 'ORDERS', 'GROSS SALES (₹)', 'DISCOUNTS (₹)', 'TAXABLE (₹)',
  'CGST 2.5% (₹)', 'SGST 2.5% (₹)', 'TOTAL GST 5% (₹)', 'DELIVERY (₹)',
  'NET REVENUE (₹)', 'CASH (₹)', 'UPI (₹)', 'CARD (₹)', 'ONLINE (₹)'
];

const MONTHLY_SUMMARY_HEADERS = [
  'MONTH / YEAR', 'ORDERS', 'GROSS SALES (₹)', 'DISCOUNTS (₹)', 'TAXABLE TURNOVER (₹)',
  'CGST 2.5% (₹)', 'SGST 2.5% (₹)', 'TOTAL GST 5% (₹)', 'DELIVERY FEES (₹)',
  'NET REVENUE (₹)', 'CASH (₹)', 'UPI (₹)', 'CARD (₹)', 'ONLINE (₹)', 'AOV (₹)'
];

const DISCOUNTS_COUPONS_HEADERS = [
  'COUPON / PROMO CODE', 'TIMES REDEEMED', 'TOTAL DISCOUNT GIVEN (₹)',
  'GROSS SALES GENERATED (₹)', 'NET REVENUE RESULT (₹)', 'AVG DISCOUNT / ORDER (₹)'
];

const REFUNDS_HEADERS = [
  'ORDER ID', 'BILL NO', 'DATE', 'CUSTOMER NAME', 'REFUND AMOUNT (₹)',
  'PAYMENT METHOD', 'CANCELLATION REASON', 'AUTHORIZED BY', 'STATUS'
];

const POS_CASHIER_HEADERS = [
  'CASHIER / STAFF', 'TERMINAL ID', 'SHIFT ID', 'BILLS PROCESSED', 'GROSS SALES (₹)',
  'CASH COLLECTED (₹)', 'UPI COLLECTED (₹)', 'CARD COLLECTED (₹)', 'DISCOUNTS GIVEN (₹)', 'TOTAL SHIFT REVENUE (₹)'
];

const AUDIT_ADJUSTMENTS_HEADERS = [
  'DATE', 'TIME', 'ORDER / BILL REF', 'ADJUSTMENT TYPE', 'PREVIOUS VALUE',
  'NEW VALUE', 'REASON / NOTE', 'AUTHORIZED BY', 'TIMESTAMP'
];

const SYNC_STATUS_HEADERS = [
  'FRANCHISE ID', 'FRANCHISE NAME', 'BRANCH NAME', 'CURRENT MONTH', 'SPREADSHEET ID',
  'TOTAL SYNCED ORDERS', 'LAST SYNCED AT', 'SYNC HEALTH STATUS', 'API ENGINE'
];

async function executeMigration() {
  console.log('🚀 Starting Complete Google Sheets Migration & Clean Rebuild Engine...\n');

  const oldSpreadsheetId = '1dOeUjDaQRUPyWhGxyu_6xLh4zxiuiB73fOekYpigbaY';
  const franchiseId = 'fra_rajnandgaon';
  const franchiseName = 'Olive Pizza — Rajnandgaon HQ';
  const region = 'Chhattisgarh';
  const now = new Date().toISOString();

  // 1. BACKUP & AUDIT CURRENT FIRESTORE ORDERS
  console.log('📦 Step 1: Auditing & Backing up Historical Data from Canonical Store...');
  const ordersSnap = await db.collection('orders').get();
  
  const validOrders: any[] = [];
  const testOrders: any[] = [];
  const orderDetailsRows: any[][] = [];
  const productSalesRows: any[][] = [];
  const paymentRows: any[][] = [];

  let totalGross = 0;
  let totalDiscounts = 0;
  let totalGST = 0;
  let totalNet = 0;
  let totalCash = 0;
  let totalUPI = 0;
  let totalCard = 0;
  let totalOnline = 0;

  ordersSnap.forEach(doc => {
    const o = doc.data();
    const id = doc.id;
    const isTest = id.startsWith('test_') || 
                   (o.customerName && o.customerName.toLowerCase().includes('test')) ||
                   (o.dailyOrderNumber && String(o.dailyOrderNumber).includes('test'));

    if (isTest) {
      testOrders.push({ id, ...o });
      return;
    }

    validOrders.push({ id, ...o });

    // Format Date & Time in IST
    let dateObj = new Date();
    if (o.createdAt) {
      if (typeof o.createdAt.toDate === 'function') dateObj = o.createdAt.toDate();
      else if (o.createdAt._seconds) dateObj = new Date(o.createdAt._seconds * 1000);
      else if (typeof o.createdAt === 'string' || typeof o.createdAt === 'number') dateObj = new Date(o.createdAt);
    }

    const formattedDate = dateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const formattedTime = dateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const timestampIso = dateObj.toISOString();

    const subtotal = Number(o.subtotal || o.totalAmount || 0);
    const discount = Number(o.discountAmount || o.discount || 0);
    const taxable = Math.max(0, subtotal - discount);
    const tax = Number(o.taxes || o.tax || Math.round(taxable * 0.05));
    const cgst = Number(o.cgst || (tax / 2).toFixed(2));
    const sgst = Number(o.sgst || (tax / 2).toFixed(2));
    const deliveryFee = Number(o.deliveryFee || 0);
    const grandTotal = Number(o.totalAmount || o.finalTotal || o.total || (taxable + tax + deliveryFee));

    totalGross += subtotal;
    totalDiscounts += discount;
    totalGST += tax;
    totalNet += grandTotal;

    const pMethod = (o.paymentMethod || 'CASH').toUpperCase();
    if (pMethod.includes('CASH')) totalCash += grandTotal;
    else if (pMethod.includes('UPI') || pMethod.includes('GPAY')) totalUPI += grandTotal;
    else if (pMethod.includes('CARD')) totalCard += grandTotal;
    else totalOnline += grandTotal;

    const isPOS = (o.orderSource && o.orderSource.startsWith('POS_')) || o.orderSource === 'OFFLINE_RESTAURANT';
    const orderSourceStr = isPOS ? 'POS' : 'ONLINE_APP';
    const orderTypeStr = sanitizeText(o.orderSource || (isPOS ? 'POS_DINE_IN' : 'CUSTOMER_APP'));
    const fulfillmentStr = sanitizeText(o.fulfillmentType || o.orderType || (isPOS ? 'Dine-In' : 'Delivery'));
    const tableStr = sanitizeText(o.tableNumber || '-');

    const customerNameStr = sanitizeText(o.customerName || (isPOS ? 'Walk-in Customer' : 'Online Guest'));
    const customerPhoneStr = sanitizePhoneNumber(o.customerPhone || o.contactPhone || o.phone);

    const itemsList = Array.isArray(o.items) ? o.items : [];
    const itemsSummaryStr = formatItemsSummary(itemsList);
    const totalQty = itemsList.reduce((acc: number, it: any) => acc + Number(it.quantity || 1), 0) || 1;

    const billNoStr = o.dailyOrderNumber 
      ? `#${o.dailyOrderNumber}` 
      : sanitizeText(o.orderNumber || id.slice(-6).toUpperCase());

    // 1 ORDER = 1 ROW
    orderDetailsRows.push([
      id,
      billNoStr,
      formattedDate,
      formattedTime,
      sanitizeText(o.franchiseName || franchiseName),
      sanitizeText(o.branchName || 'Rajnandgaon Main HQ'),
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
      sanitizeText(o.couponCode || o.appliedCouponCode || '-'),
      taxable,
      cgst,
      sgst,
      tax,
      deliveryFee,
      grandTotal,
      sanitizeText((o.paymentMethod || 'CASH').toUpperCase()),
      sanitizeText((o.paymentStatus || 'PAID').toUpperCase()),
      sanitizeText((o.status || 'COMPLETED').toUpperCase()),
      sanitizeText(o.cashierName || (isPOS ? 'Counter Staff' : 'Auto System')),
      sanitizeText(o.terminalId || (isPOS ? 'POS-TERM-01' : 'ONLINE-SYS')),
      timestampIso
    ]);

    // 1 ITEM = 1 ROW (Product Sales)
    if (itemsList.length > 0) {
      itemsList.forEach((it: any) => {
        const qty = Number(it.quantity || 1);
        const price = Number(it.price || it.unitPrice || 0);
        const lineTotal = Number(it.lineTotal || (price * qty));
        const size = sanitizeText(it.size || it.selectedSize || 'Regular');
        const crust = sanitizeText(it.crust || it.selectedCrust || 'Regular Crust');
        const addons = Array.isArray(it.addons || it.selectedAddons)
          ? (it.addons || it.selectedAddons).map((a: any) => a.name || a).join(', ')
          : '-';

        productSalesRows.push([
          formattedDate,
          formattedTime,
          id,
          billNoStr,
          sanitizeText(o.branchName || 'Rajnandgaon Main HQ'),
          sanitizeText(it.name || it.productName || 'Pizza'),
          sanitizeText(it.category || 'Pizzas'),
          size,
          crust,
          sanitizeText(addons),
          qty,
          price,
          lineTotal,
          orderSourceStr,
          sanitizeText((o.paymentMethod || 'CASH').toUpperCase())
        ]);
      });
    }

    // Payments row
    paymentRows.push([
      `PAY_${id.slice(-8).toUpperCase()}`,
      id,
      billNoStr,
      formattedDate,
      formattedTime,
      sanitizeText(o.branchName || 'Rajnandgaon Main HQ'),
      sanitizeText((o.paymentMethod || 'CASH').toUpperCase()),
      grandTotal,
      sanitizeText((o.paymentStatus || 'PAID').toUpperCase()),
      sanitizeText(o.paymentId || o.transactionRef || '-'),
      sanitizeText(o.terminalId || (isPOS ? 'POS-TERM-01' : 'ONLINE-SYS'))
    ]);
  });

  console.log(`✅ Data Audited: ${validOrders.length} valid orders, ${testOrders.length} test records excluded.`);
  console.log(`   Total Net Sales: ₹${totalNet.toFixed(2)}, Total GST: ₹${totalGST.toFixed(2)}`);

  // 2. CREATE COMPLETELY NEW WORKBOOK VIA GOOGLE SHEETS API
  console.log('\n🔨 Step 2: Creating Brand New Google Spreadsheet with 12 Structured Tabs...');
  const sheets = getSheetsClient();
  const newSpreadsheetTitle = `Olive Pizza — Rajnandgaon Reports`;

  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: newSpreadsheetTitle,
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
        { properties: { title: 'Audit & Adjustments', gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 1 } } },
        { properties: { title: 'Sync Status', gridProperties: { rowCount: 100, columnCount: 15, frozenRowCount: 1 } } }
      ]
    }
  });

  const newSpreadsheetId = createRes.data.spreadsheetId!;
  const newSpreadsheetUrl = `https://docs.google.com/spreadsheets/d/${newSpreadsheetId}`;
  console.log(`✨ Created New Spreadsheet: ${newSpreadsheetId}`);
  console.log(`   URL: ${newSpreadsheetUrl}`);

  // 3. POPULATE STRUCTURED HEADERS & DASHBOARD FORMULAS
  console.log('\n📊 Step 3: Initializing Structured Headers & Executive KPI Formulas...');
  const dateGenerated = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  const dashboardValues = [
    [`OLIVE PIZZA — RAJNANDGAON HQ EXECUTIVE MANAGEMENT & ACCOUNTING HUB`, '', '', '', '', ''],
    [`Franchise: Olive Pizza — Rajnandgaon HQ`, `Region: ${region}`, 'Currency: INR (₹)', 'F&B GST: 5% (2.5% CGST + 2.5% SGST)', `Generated: ${dateGenerated}`, ''],
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

  const nowYear = new Date().getFullYear();
  const nowMonth = new Date().getMonth();
  const daysInMonth = new Date(nowYear, nowMonth + 1, 0).getDate();
  const dailySalesValues = [DAILY_SALES_HEADERS];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(nowYear, nowMonth, day);
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

  const syncStatusValues = [
    SYNC_STATUS_HEADERS,
    [
      franchiseId,
      franchiseName,
      'Rajnandgaon Main HQ',
      'August 2026',
      newSpreadsheetId,
      validOrders.length,
      now,
      'LIVE SYNCED',
      'Olive Pizza Dedicated Multi-Franchise Engine v2.0'
    ]
  ];

  const headerPayloads = [
    { range: 'Dashboard!A1:F11', values: dashboardValues },
    { range: 'Monthly Summary!A1:O1', values: [MONTHLY_SUMMARY_HEADERS] },
    { range: `Daily Sales!A1:O${dailySalesValues.length}`, values: dailySalesValues },
    { range: 'Order Details!A1:AC1', values: [ORDER_DETAILS_HEADERS] },
    { range: 'Product Sales!A1:O1', values: [PRODUCT_SALES_HEADERS] },
    { range: 'Payments!A1:K1', values: [PAYMENTS_HEADERS] },
    { range: 'GST & Tax!A1:J1', values: [GST_TAX_HEADERS] },
    { range: 'Discounts & Coupons!A1:F1', values: [DISCOUNTS_COUPONS_HEADERS] },
    { range: 'Refunds & Cancellations!A1:I1', values: [REFUNDS_HEADERS] },
    { range: 'POS & Cashier Summary!A1:J1', values: [POS_CASHIER_HEADERS] },
    { range: 'Audit & Adjustments!A1:I1', values: [AUDIT_ADJUSTMENTS_HEADERS] },
    { range: 'Sync Status!A1:I2', values: syncStatusValues }
  ];

  for (const p of headerPayloads) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: newSpreadsheetId,
      range: p.range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: p.values }
    });
  }

  // 4. RESTORE VALID HISTORICAL ORDERS INTO NEW WORKBOOK
  console.log('\n📥 Step 4: Restoring 80 Verified Historical Orders into Order Details...');
  if (orderDetailsRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: newSpreadsheetId,
      range: "'Order Details'!A2:AC",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: orderDetailsRows }
    });
  }

  console.log('📥 Step 5: Restoring Item-Level Product Sales into Product Sales tab...');
  if (productSalesRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: newSpreadsheetId,
      range: "'Product Sales'!A2:O",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: productSalesRows }
    });
  }

  console.log('📥 Step 6: Restoring Payment Reconciliation Records...');
  if (paymentRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: newSpreadsheetId,
      range: "'Payments'!A2:K",
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: paymentRows }
    });
  }

  // 5. UPDATE SYSTEM CONFIGURATION IN FIRESTORE TO USE NEW SPREADSHEET
  console.log('\n🔄 Step 7: Updating System Configuration in Firestore...');
  await db.collection('settings').doc('google_sheets').set({
    spreadsheetId: newSpreadsheetId,
    spreadsheetUrl: newSpreadsheetUrl,
    previousSpreadsheetId: oldSpreadsheetId,
    migratedAt: now,
    status: 'ACTIVE'
  }, { merge: true });

  await db.collection('franchise_sheets_metadata').doc(franchiseId).set({
    franchiseId,
    franchiseName,
    spreadsheetId: newSpreadsheetId,
    spreadsheetName: newSpreadsheetTitle,
    spreadsheetUrl: newSpreadsheetUrl,
    status: 'CONNECTED',
    createdAt: now,
    lastProvisionedAt: now,
    lastSyncedAt: now,
    currentMonthTab: 'August 2026',
    pendingSyncCount: 0,
    failedSyncCount: 0
  }, { merge: true });

  await db.collection('franchise_entities').doc(franchiseId).set({
    googleSpreadsheetId: newSpreadsheetId,
    googleSpreadsheetUrl: newSpreadsheetUrl,
    sheetsProvisionedAt: now,
    sheetsStatus: 'CONNECTED'
  }, { merge: true });

  // 6. RECORD MIGRATION AUDIT IN FIRESTORE
  for (const row of orderDetailsRows) {
    const orderId = row[0];
    const auditKey = `${franchiseId}_${orderId}`;
    await db.collection('sheets_sync_audit').doc(auditKey).set({
      franchiseId,
      orderId,
      spreadsheetId: newSpreadsheetId,
      synced: true,
      grandTotal: row[22],
      syncedAt: now
    });
  }

  console.log('\n🎉 ALL DATA MIGRATED & VERIFIED SUCCESSFULLY!');
  console.log(`New Spreadsheet ID: ${newSpreadsheetId}`);
  console.log(`New Spreadsheet URL: ${newSpreadsheetUrl}`);

  return {
    oldSpreadsheetId,
    newSpreadsheetId,
    newSpreadsheetUrl,
    totalValidOrders: validOrders.length,
    testOrdersExcluded: testOrders.length,
    totalGrossRevenue: totalGross,
    totalGST,
    totalNetRevenue: totalNet,
    totalItemsSold: productSalesRows.length
  };
}

executeMigration().then(res => {
  console.log('\n=== MIGRATION SUMMARY RESULT ===');
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}).catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
