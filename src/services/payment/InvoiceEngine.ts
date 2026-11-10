import { getPaymentConfig } from '../../config/payment.config.js';

export interface InvoiceParams {
  orderId: string;
  paymentId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  items: any[];
  totalAmount: number;
  paymentMethod: string;
  createdAt: string;
}

function escapeHtml(str: any): string {
  if (str == null) return '';
  return String(str)
    .replace(/\bon[a-zA-Z]+\s*=\s*(['"][^'"]*['"]|[^\s>]+)/gi, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export class InvoiceEngine {
  public static generateInvoiceHtml(params: InvoiceParams): string {
    const config = getPaymentConfig();
    const subtotal = Math.round(params.totalAmount / 1.05); // 5% GST calculation
    const gstAmount = params.totalAmount - subtotal;
    const shortOrderId = escapeHtml(params.orderId.slice(0, 8).toUpperCase());
    const dateStr = escapeHtml(new Date(params.createdAt || Date.now()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));

    const safeCustomerName = escapeHtml(params.customerName || 'Gourmet Customer');
    const safeCustomerPhone = escapeHtml(params.customerPhone || 'N/A');
    const safeCustomerAddress = escapeHtml(params.customerAddress || 'Customer Address');
    const safePaymentId = escapeHtml(params.paymentId || 'N/A');
    const safePaymentMethod = escapeHtml(params.paymentMethod ? params.paymentMethod.toUpperCase() : 'COD');
    const safeBusinessName = escapeHtml(config.businessName || 'Olive Pizza');
    const safeGstNumber = escapeHtml(config.gstNumber || 'N/A');
    const safeSupportEmail = escapeHtml(config.supportEmail || 'support@olivepizza.com');
    const safeSupportPhone = escapeHtml(config.supportPhone || '+91 99999 99999');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tax Invoice — Olive Pizza #${shortOrderId}</title>
  <style>
    body { font-family: 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
    .invoice-card { max-width: 600px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 30px; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #f97316; padding-bottom: 15px; margin-bottom: 20px; }
    .brand { font-size: 24px; font-weight: bold; color: #f97316; }
    .meta { text-align: right; font-size: 12px; color: #94a3b8; }
    .table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .table th { text-align: left; border-bottom: 1px solid #475569; padding: 8px; color: #cbd5e1; }
    .table td { padding: 10px 8px; border-bottom: 1px solid #334155; }
    .total-row { font-weight: bold; font-size: 16px; color: #f97316; }
    .badge { background: #166534; color: #4ade80; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="invoice-card">
    <div class="header">
      <div>
        <div class="brand">🍕 ${safeBusinessName}</div>
        <div style="font-size:12px; color:#94a3b8;">100% Pure Veg Gourmet Pizzeria</div>
        <div style="font-size:12px; color:#94a3b8;">GSTIN: ${safeGstNumber}</div>
      </div>
      <div class="meta">
        <div><strong>INVOICE #${shortOrderId}</strong></div>
        <div>Date: ${dateStr}</div>
        <div>Payment: <span class="badge">${safePaymentMethod}</span></div>
      </div>
    </div>

    <div style="margin-bottom: 15px; font-size: 13px;">
      <div><strong>Billed To:</strong> ${safeCustomerName} (${safeCustomerPhone})</div>
      <div><strong>Delivery Address:</strong> ${safeCustomerAddress}</div>
      <div><strong>Transaction ID:</strong> ${safePaymentId}</div>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>Item Description</th>
          <th style="text-align:center;">Qty</th>
          <th style="text-align:right;">Price</th>
        </tr>
      </thead>
      <tbody>
        ${(params.items || []).map(item => {
          const itemName = escapeHtml(item.name || item.title || 'Item');
          const itemSize = item.size ? ` (${escapeHtml(item.size)})` : '';
          const itemQty = Number(item.quantity || 1);
          const itemPrice = Number(item.price || 0);
          return `
          <tr>
            <td>${itemName}${itemSize}</td>
            <td style="text-align:center;">${itemQty}</td>
            <td style="text-align:right;">₹${(itemPrice * itemQty).toFixed(2)}</td>
          </tr>
        `;
        }).join('')}
      </tbody>
    </table>

    <div style="text-align: right; line-height: 1.8; font-size: 14px;">
      <div>Subtotal: ₹${subtotal.toFixed(2)}</div>
      <div>GST (5% SGST/CGST): ₹${gstAmount.toFixed(2)}</div>
      <div class="total-row" style="margin-top: 10px;">Grand Total: ₹${Number(params.totalAmount || 0).toFixed(2)}</div>
    </div>

    <div class="footer">
      Thank you for ordering with ${safeBusinessName}! <br/>
      For support contact ${safeSupportEmail} | ${safeSupportPhone}
    </div>
  </div>
</body>
</html>`;
  }
}
