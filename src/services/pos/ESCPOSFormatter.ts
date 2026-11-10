/**
 * ESCPOSFormatter.ts — Thermal Receipt & ESC/POS Raw Command Engine
 * 
 * Supports:
 * - 80mm (48 columns) & 58mm (32 columns) thermal receipt layouts
 * - Standard ESC/POS commands: Bold, Underline, Center/Left/Right alignment, Inverted, Double-height/width
 * - Automatic Paper Cut command (\x1D\x56\x41\x00)
 * - Cash Drawer Kick Pulse command (\x1B\x70\x00\x19\xFA / ESC p 0 25 250)
 * - Plain ASCII text fallback for direct browser / virtual print previews
 */

export interface ReceiptItem {
  name: string;
  quantity: number;
  price: number;
  size?: string;
  crust?: string;
  addons?: string[];
  notes?: string;
}

export interface ReceiptData {
  orderNumber: string;
  billId: string;
  permanentBillNo?: number;
  billNumber?: string;
  date: string;
  time: string;
  orderType: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | string;
  tableNumber?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  cashierName: string;
  terminalId: string;
  branchName: string;
  branchAddress?: string;
  branchPhone?: string;
  gstNumber?: string;
  fssaiNumber?: string;
  items: ReceiptItem[];
  subtotal: number;
  discountAmount: number;
  couponCode?: string;
  taxes: number;
  deliveryFee: number;
  finalTotal: number;
  paymentMethod: string;
  paymentStatus: string;
  amountReceived?: number;
  changeDue?: number;
  edcAuthCode?: string;
}

export class ESCPOSFormatter {
  // ESC/POS Command Constants
  public static readonly ESC = '\x1B';
  public static readonly GS = '\x1D';
  public static readonly INIT = '\x1B\x40';                // ESC @ — Initialize printer
  public static readonly ALIGN_LEFT = '\x1B\x61\x00';       // ESC a 0 — Left align
  public static readonly ALIGN_CENTER = '\x1B\x61\x01';     // ESC a 1 — Center align
  public static readonly ALIGN_RIGHT = '\x1B\x61\x02';      // ESC a 2 — Right align
  public static readonly BOLD_ON = '\x1B\x45\x01';          // ESC E 1 — Bold ON
  public static readonly BOLD_OFF = '\x1B\x45\x00';         // ESC E 0 — Bold OFF
  public static readonly DOUBLE_ON = '\x1D\x21\x11';        // GS ! 0x11 — Double width & height
  public static readonly DOUBLE_OFF = '\x1D\x21\x00';       // GS ! 0x00 — Normal text
  public static readonly CUT_FULL = '\x1D\x56\x41\x00';      // GS V A 0 — Full cut
  public static readonly CUT_PARTIAL = '\x1D\x56\x01';      // GS V 1 — Partial cut
  public static readonly CASH_DRAWER_KICK = '\x1B\x70\x00\x19\xFA'; // ESC p 0 25 250 — Pin 2 pulse

  /**
   * Generates a structured ASCII string representation of the receipt
   * formatted for 80mm thermal paper (48 columns) or 58mm (32 columns).
   */
  public static generatePlainTextReceipt(data: ReceiptData, width: 48 | 32 = 48): string {
    const divider = '-'.repeat(width);
    const doubleDivider = '='.repeat(width);
    const lines: string[] = [];

    // Helper: Center text
    const center = (text: string) => {
      const pad = Math.max(0, Math.floor((width - text.length) / 2));
      return ' '.repeat(pad) + text;
    };

    // Helper: Justify two strings (Left & Right)
    const justify = (left: string, right: string) => {
      const spaces = Math.max(1, width - left.length - right.length);
      return left + ' '.repeat(spaces) + right;
    };

    // Header
    lines.push(center('OLIVE PIZZA'));
    lines.push(center('Authentic Woodfired Artisan Pizzas'));
    lines.push(center(data.branchName || 'Olive Pizza — Rajnandgaon HQ'));
    if (data.branchAddress) lines.push(center(data.branchAddress));
    if (data.branchPhone) lines.push(center(`Ph: ${data.branchPhone}`));
    if (data.gstNumber) lines.push(center(`GSTIN: ${data.gstNumber}`));
    if (data.fssaiNumber) lines.push(center(`FSSAI: ${data.fssaiNumber}`));
    lines.push(doubleDivider);

    // Bill & Order Metadata (Permanent Bill No + Daily Order No)
    const permBillText = data.billNumber || (data.permanentBillNo ? `#${data.permanentBillNo}` : data.orderNumber);
    lines.push(justify(`PERM BILL: ${permBillText}`, `DATE: ${data.date}`));
    lines.push(justify(`DAILY ORD: ${data.orderNumber}`, `TIME: ${data.time}`));
    lines.push(justify(`CASHIER: ${data.cashierName}`, `MODE: ${data.orderType}`));

    if (data.orderType === 'DINE_IN' && data.tableNumber) {
      lines.push(justify('Table:', `[ ${data.tableNumber} ]`));
    }

    if (data.customerName && data.customerName !== 'Walk-in Customer') {
      lines.push(justify('Customer:', data.customerName));
    }
    if (data.customerPhone && data.customerPhone !== 'N/A') {
      lines.push(justify('Phone:', data.customerPhone));
    }
    if (data.orderType === 'DELIVERY' && data.deliveryAddress) {
      lines.push(`DELIVERY ADDR: ${data.deliveryAddress}`);
    }

    lines.push(divider);

    // Column Headers
    if (width === 48) {
      lines.push(justify('ITEM', 'QTY  PRICE   TOTAL'));
    } else {
      lines.push(justify('ITEM', 'QTY  TOTAL'));
    }
    lines.push(divider);

    // Line Items
    for (const item of data.items) {
      let itemTitle = item.name;
      if (item.size && item.size !== 'regular' && item.size !== 'Regular') {
        itemTitle += ` (${item.size})`;
      }
      if (item.crust && item.crust !== 'normal' && item.crust !== 'Classic') {
        itemTitle += ` [${item.crust}]`;
      }

      const totalItemPrice = item.price * item.quantity;

      if (width === 48) {
        const rightCol = `${String(item.quantity).padStart(3)}  ${String(item.price).padStart(5)}  ${String(totalItemPrice).padStart(6)}`;
        if (itemTitle.length > 28) {
          lines.push(itemTitle);
          lines.push(' '.repeat(width - rightCol.length) + rightCol);
        } else {
          lines.push(justify(itemTitle, rightCol));
        }
      } else {
        const rightCol = `${item.quantity}x ${totalItemPrice}`;
        lines.push(justify(itemTitle.slice(0, 20), rightCol));
      }

      // Addons & Customizations
      if (item.addons && item.addons.length > 0) {
        lines.push(`  + ${item.addons.join(', ')}`);
      }
      if (item.notes) {
        lines.push(`  * Note: ${item.notes}`);
      }
    }

    lines.push(divider);

    // Financial Breakdown
    lines.push(justify('Subtotal:', `Rs. ${data.subtotal.toFixed(2)}`));

    if (data.discountAmount > 0) {
      const discountLabel = data.couponCode ? `Discount (${data.couponCode}):` : 'Discount:';
      lines.push(justify(discountLabel, `- Rs. ${data.discountAmount.toFixed(2)}`));
    }

    lines.push(justify('GST (5% Included):', `Rs. ${data.taxes.toFixed(2)}`));

    if (data.deliveryFee > 0) {
      lines.push(justify('Delivery Fee:', `Rs. ${data.deliveryFee.toFixed(2)}`));
    }

    lines.push(doubleDivider);
    lines.push(justify('GRAND TOTAL:', `Rs. ${data.finalTotal.toFixed(2)}`));
    lines.push(doubleDivider);

    // Payment Tender Info
    lines.push(justify('Payment Mode:', data.paymentMethod.toUpperCase()));
    lines.push(justify('Payment Status:', data.paymentStatus.toUpperCase()));

    if (data.amountReceived && data.amountReceived > 0) {
      lines.push(justify('Cash Tendered:', `Rs. ${data.amountReceived.toFixed(2)}`));
      lines.push(justify('Change Return:', `Rs. ${(data.changeDue || 0).toFixed(2)}`));
    }

    if (data.edcAuthCode) {
      lines.push(justify('EDC Ref / Auth:', data.edcAuthCode));
    }

    lines.push(divider);

    // Footer & Gratitude
    lines.push(center('Thank you for dining with us!'));
    lines.push(center('Visit again: https://olivepizza.in'));
    lines.push(center('*** 100% Pure Vegetarian ***'));
    lines.push('\n\n\n'); // Paper feed for tear-off

    return lines.join('\n');
  }

  /**
   * Generates a raw ESC/POS command Buffer suitable for direct network (port 9100)
   * or raw USB thermal receipt printing, including cut and cash drawer pulse.
   */
  public static generateRawESCPOSBuffer(data: ReceiptData, openCashDrawer = false, width: 48 | 32 = 48): Buffer {
    const chunks: Buffer[] = [];

    // Initialize Printer
    chunks.push(Buffer.from(this.INIT, 'binary'));

    // Kick Cash Drawer if requested on cash payment
    if (openCashDrawer) {
      chunks.push(Buffer.from(this.CASH_DRAWER_KICK, 'binary'));
    }

    // Double-Height Title Header
    chunks.push(Buffer.from(this.ALIGN_CENTER + this.BOLD_ON + this.DOUBLE_ON, 'binary'));
    chunks.push(Buffer.from('OLIVE PIZZA\n', 'utf-8'));
    chunks.push(Buffer.from(this.DOUBLE_OFF + this.BOLD_OFF, 'binary'));

    // Header info
    chunks.push(Buffer.from(
      `${data.branchName || 'Olive Pizza — Rajnandgaon HQ'}\n` +
      `${data.branchAddress ? data.branchAddress + '\n' : ''}` +
      `${data.branchPhone ? 'Ph: ' + data.branchPhone + '\n' : ''}` +
      `${data.gstNumber ? 'GSTIN: ' + data.gstNumber + '\n' : ''}`,
      'utf-8'
    ));

    chunks.push(Buffer.from(this.ALIGN_LEFT, 'binary'));

    // Generate formatted plain text body
    const bodyText = this.generatePlainTextReceipt(data, width);
    chunks.push(Buffer.from(bodyText, 'utf-8'));

    // Paper Cut
    chunks.push(Buffer.from(this.CUT_FULL, 'binary'));

    return Buffer.concat(chunks);
  }
}
