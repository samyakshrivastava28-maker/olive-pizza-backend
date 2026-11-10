/**
 * Premium Olive Pizza Email Template System
 *
 * Design System:
 * - Brand: Olive Green (#4a7c59), Orange Accent (#f97316), Dark Background (#0B0F14)
 * - Compatible with: Gmail, Outlook, Apple Mail, Yahoo Mail, Proton Mail
 * - Inline styles only (email client compatibility)
 * - Responsive via media queries and fluid widths
 * - Dark mode aware (prefers-color-scheme)
 *
 * Structure:
 *   baseWrapper()           — Shared HTML/head/body frame
 *   buildOrderStatusEmail() — Automatic router for all order stage emails
 *   Customer templates (17 types)
 *   Owner templates (6 types)
 *   Delivery templates (3 types)
 */

import { FRONTEND_URL } from '../config/urls.js';
import { escapeHtml } from '../utils/escapeHtml.js';

// ── Brand Tokens ──────────────────────────────────────────────────────────────
const BRAND_GREEN   = '#4a7c59';
const BRAND_ORANGE  = '#f97316';
const BRAND_DARK    = '#0B0F14';
const BRAND_CARD    = '#111827';
const BRAND_BORDER  = '#1f2937';
const TEXT_PRIMARY  = '#f9fafb';
const TEXT_SECONDARY= '#9ca3af';
const TEXT_MUTED    = '#6b7280';
const LOGO_URL      = 'https://res.cloudinary.com/dxmlvkff1/image/upload/v1782376898/olive-pizza/brand/logo.png';
const PIZZA_HERO    = 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&q=80&auto=format';

// ── Shared Base Wrapper ───────────────────────────────────────────────────────
function baseWrapper(content: string, preheader = ''): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="color-scheme" content="dark light">
  <meta name="supported-color-schemes" content="dark light">
  <title>Olive Pizza</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    body { margin: 0; padding: 0; background-color: ${BRAND_DARK}; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .email-wrapper { width: 100%; background-color: ${BRAND_DARK}; padding: 32px 16px; box-sizing: border-box; }
    .email-card { max-width: 580px; margin: 0 auto; background-color: ${BRAND_CARD}; border-radius: 20px; overflow: hidden; border: 1px solid ${BRAND_BORDER}; }
    .btn { display: inline-block; padding: 14px 28px; border-radius: 12px; font-weight: 700; font-size: 15px; text-decoration: none; letter-spacing: 0.3px; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, ${BRAND_GREEN}, #3d6b4a); color: #ffffff; }
    .btn-accent { background: linear-gradient(135deg, ${BRAND_ORANGE}, #ea6c0a); color: #ffffff; }
    .btn-ghost { background: rgba(255,255,255,0.07); color: ${TEXT_SECONDARY}; border: 1px solid ${BRAND_BORDER}; }
    .divider { height: 1px; background: linear-gradient(90deg, transparent, ${BRAND_BORDER} 30%, ${BRAND_BORDER} 70%, transparent); margin: 28px 0; }
    .item-card { background: rgba(255,255,255,0.03); border: 1px solid ${BRAND_BORDER}; border-radius: 12px; padding: 16px; margin-bottom: 10px; }
    .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    @media (max-width: 600px) {
      .email-wrapper { padding: 0 !important; }
      .email-card { border-radius: 0 !important; border-left: none !important; border-right: none !important; }
      .content-pad { padding: 24px 20px !important; }
      .btn-row { display: flex !important; flex-direction: column !important; gap: 10px !important; }
      .btn { display: block !important; text-align: center !important; width: 100% !important; box-sizing: border-box !important; }
      .item-flex { flex-direction: column !important; }
    }
    @media (prefers-color-scheme: light) {
      body { background-color: #f3f4f6 !important; }
      .email-card { background-color: #ffffff !important; border-color: #e5e7eb !important; }
      .item-card { background: #f9fafb !important; border-color: #e5e7eb !important; }
    }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;overflow:hidden;height:0;max-height:0;max-width:0;opacity:0;visibility:hidden;">${preheader}&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌&nbsp;‌</div>` : ''}
  <div class="email-wrapper">
    <div class="email-card">
      ${emailHeader()}
      <div class="content-pad" style="padding: 32px 36px;">
        ${content}
      </div>
      ${emailFooter()}
    </div>
  </div>
</body>
</html>`;
}

function emailHeader(): string {
  return `<div style="background: linear-gradient(135deg, ${BRAND_DARK} 0%, #0f1a12 100%); padding: 28px 36px; text-align: center; border-bottom: 1px solid ${BRAND_BORDER};">
    <img src="${LOGO_URL}" alt="Olive Pizza" width="56" height="56" style="border-radius: 14px; margin-bottom: 10px; display: block; margin: 0 auto 10px;" />
    <div style="font-size: 22px; font-weight: 800; color: ${TEXT_PRIMARY}; letter-spacing: -0.5px;">Olive Pizza</div>
    <div style="font-size: 12px; color: ${TEXT_MUTED}; letter-spacing: 1px; text-transform: uppercase; margin-top: 2px;">Premium Pizza Experience</div>
  </div>`;
}

function emailFooter(): string {
  return `<div style="background: rgba(0,0,0,0.3); padding: 24px 36px; text-align: center; border-top: 1px solid ${BRAND_BORDER};">
    <div style="margin-bottom: 16px;">
      <a href="${FRONTEND_URL}/menu" style="color: ${TEXT_MUTED}; text-decoration: none; font-size: 13px; margin: 0 12px;">Menu</a>
      <a href="${FRONTEND_URL}/customer/dashboard" style="color: ${TEXT_MUTED}; text-decoration: none; font-size: 13px; margin: 0 12px;">My Orders</a>
      <a href="${FRONTEND_URL}/contact" style="color: ${TEXT_MUTED}; text-decoration: none; font-size: 13px; margin: 0 12px;">Support</a>
    </div>
    <div style="font-size: 12px; color: ${TEXT_MUTED}; line-height: 1.6;">
      © ${new Date().getFullYear()} Olive Pizza. All rights reserved.<br/>
      <span style="color: #4b5563;">You received this because you placed an order or have an account.</span>
    </div>
  </div>`;
}

function statusBadge(label: string, color: string): string {
  return `<span class="badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44;">${label}</span>`;
}

function orderMetaRow(label: string, value: string): string {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid ${BRAND_BORDER};">
    <span style="font-size:13px;color:${TEXT_MUTED};">${escapeHtml(label)}</span>
    <span style="font-size:13px;color:${TEXT_PRIMARY};font-weight:500;">${escapeHtml(value)}</span>
  </div>`;
}

function ctaButton(label: string, url: string, style: 'primary' | 'accent' | 'ghost' = 'primary'): string {
  const bg = style === 'primary' ? `linear-gradient(135deg, ${BRAND_GREEN}, #3d6b4a)` 
           : style === 'accent'  ? `linear-gradient(135deg, ${BRAND_ORANGE}, #ea6c0a)` 
           : 'rgba(255,255,255,0.07)';
  const border = style === 'ghost' ? `border: 1px solid ${BRAND_BORDER};` : '';
  const color = '#ffffff';
  const safeUrl = escapeHtml(url);
  return `<a href="${safeUrl}" class="btn" style="background:${bg};${border}color:${color};display:inline-block;padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function progressTimeline(steps: string[], activeIndex: number): string {
  return `<div style="margin: 24px 0; padding: 20px; background: rgba(0,0,0,0.2); border-radius: 14px; border: 1px solid ${BRAND_BORDER};">
    ${steps.map((step, i) => {
      const done = i < activeIndex;
      const active = i === activeIndex;
      const color = done || active ? BRAND_GREEN : TEXT_MUTED;
      const icon = done ? '✓' : active ? '●' : '○';
      return `<div style="display:flex;align-items:center;gap:12px;${i < steps.length - 1 ? 'margin-bottom:14px;' : ''}">
        <div style="width:28px;height:28px;border-radius:50%;background:${done || active ? BRAND_GREEN : 'rgba(255,255,255,0.06)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:12px;color:#fff;font-weight:700;">${icon}</div>
        <span style="font-size:14px;color:${active ? TEXT_PRIMARY : (done ? '#d1d5db' : TEXT_MUTED)};font-weight:${active ? 700 : 400};">${escapeHtml(step)}</span>
        ${active ? `<span style="margin-left:auto;font-size:11px;background:${BRAND_GREEN}22;color:${BRAND_GREEN};padding:2px 10px;border-radius:20px;border:1px solid ${BRAND_GREEN}44;font-weight:600;">Current</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER STATUS ROUTER
// Used by NotificationQueueService email fallback
// ─────────────────────────────────────────────────────────────────────────────
export function buildOrderStatusEmail(params: {
  customerName: string;
  subject: string;
  stage: string;
  orderId: string | null;
  data: Record<string, string>;
  orderData?: any; // FULL ORDER OBJECT if provided by NotifQueue
}): string {
  const { customerName, stage, orderId, data, orderData } = params;
  const safeCustomerName = escapeHtml(customerName);
  const safePartner = escapeHtml(data.deliveryPartnerName || 'Your partner');
  const orderNumber = data.orderNumber || data.dailyOrderNumber || orderData?.order_number || orderData?.daily_order_number || '';
  const totalAmount = data.totalAmount || orderData?.total_amount || '';
  const eta = data.eta || orderData?.estimated_delivery_time || '';
  const trackUrl = orderId ? `${FRONTEND_URL}/tracking/${orderId}` : `${FRONTEND_URL}/customer/dashboard`;
  const orderUrl = `${FRONTEND_URL}/customer/dashboard`;

  const stageMap: Record<string, () => string> = {
    pending:           () => buildOrderPlacedEmailSimple(safeCustomerName, orderNumber, totalAmount, eta, trackUrl, orderData),
    accepted:          () => buildOrderConfirmedEmailSimple(safeCustomerName, orderNumber, eta, trackUrl, orderData),
    preparing:         () => buildOrderPreparingEmailSimple(safeCustomerName, orderNumber, eta, trackUrl, orderData),
    baking:            () => buildOrderBakingEmailSimple(safeCustomerName, orderNumber, eta, trackUrl, orderData),
    ready:             () => buildOrderPackedEmailSimple(safeCustomerName, orderNumber, eta, trackUrl, orderData),
    partner_assigned:  () => buildDeliveryAssignedEmailSimple(safeCustomerName, orderNumber, safePartner, eta, trackUrl, orderData),
    picked_up:         () => buildDeliveryAssignedEmailSimple(safeCustomerName, orderNumber, safePartner, eta, trackUrl, orderData),
    out_for_delivery:  () => buildOutForDeliveryEmailSimple(safeCustomerName, orderNumber, safePartner, eta, trackUrl, orderData),
    delivered:         () => buildOrderDeliveredEmailSimple(safeCustomerName, orderNumber, orderUrl, trackUrl, orderData),
    cancelled:         () => buildOrderCancelledEmailSimple(safeCustomerName, orderNumber, orderUrl, orderData),
  };

  const builder = stageMap[stage] || stageMap['pending'];
  return builder();
}

function renderOrderSummary(orderData: any): string {
  if (!orderData || !orderData.items) return '';
  
  const itemsHtml = orderData.items.map((item: any) => {
    const productName = escapeHtml(item.product_name || item.name || 'Item');
    const itemImage = item.image_url || item.image;
    const safeImage = itemImage && String(itemImage).startsWith('http') ? escapeHtml(itemImage) : null;
    const itemPrice = Number(item.unit_price || item.price || 0);
    const variantRaw = item.variant_name || (item.size && item.size !== 'regular' ? `${item.size} ${item.crust && item.crust !== 'normal' ? '- ' + item.crust : ''}` : '');
    const variantName = variantRaw ? escapeHtml(variantRaw) : '';
    const quantity = Number(item.quantity || 1);
    const itemTotal = quantity * itemPrice;
    
    return `
    <div style="display:flex;padding:12px 0;border-bottom:1px solid ${BRAND_BORDER};">
      ${safeImage ? `<img src="${safeImage}" width="60" height="60" style="border-radius:8px;object-fit:cover;margin-right:16px;background:#1f2937;" />` : ''}
      <div style="flex-grow:1;">
        <div style="font-weight:700;color:${TEXT_PRIMARY};font-size:15px;margin-bottom:4px;">${productName}</div>
        ${variantName ? `<div style="font-size:12px;color:${TEXT_SECONDARY};margin-bottom:4px;">Variant: ${variantName}</div>` : ''}
        <div style="font-size:13px;color:${TEXT_MUTED};">Qty: ${quantity} × ₹${itemPrice.toFixed(2)}</div>
      </div>
      <div style="font-weight:700;color:${TEXT_PRIMARY};font-size:15px;">
        ₹${itemTotal.toFixed(2)}
      </div>
    </div>
  `}).join('');

  const safeCustomerName = escapeHtml(orderData.customerName || (orderData.delivery_address && orderData.delivery_address.fullName) || 'Customer');
  const rawAddr = orderData.deliveryAddress?.addressLine || (orderData.delivery_address && orderData.delivery_address.addressLine1) || orderData.deliveryAddress || '';
  const safeAddrLine1 = escapeHtml(rawAddr);
  const safeAddrLine2 = orderData.delivery_address?.addressLine2 ? escapeHtml(orderData.delivery_address.addressLine2) : '';
  const safeCity = orderData.delivery_address?.city ? escapeHtml(orderData.delivery_address.city) : '';
  const safeState = orderData.delivery_address?.state ? escapeHtml(orderData.delivery_address.state) : '';
  const safePostal = orderData.delivery_address?.postalCode ? escapeHtml(orderData.delivery_address.postalCode) : '';
  const safePhone = escapeHtml(orderData.contactPhone || (orderData.delivery_address && orderData.delivery_address.phone) || '');
  const rawPaymentMethod = orderData.payment_method || orderData.paymentMethod;
  const safePaymentMethod = rawPaymentMethod ? escapeHtml(String(rawPaymentMethod).toUpperCase()) : '';

  return `
    <div style="margin:24px 0;background:rgba(255,255,255,0.03);border:1px solid ${BRAND_BORDER};border-radius:14px;padding:20px;">
      <h3 style="margin:0 0 16px 0;color:${TEXT_PRIMARY};font-size:16px;border-bottom:1px solid ${BRAND_BORDER};padding-bottom:12px;">Order Summary</h3>
      ${itemsHtml}
      <div style="margin-top:16px;">
        ${orderMetaRow('Subtotal', `₹${orderData.subtotal || 0}`)}
        ${orderMetaRow('Taxes (GST)', `₹${orderData.tax_amount || 0}`)}
        ${orderData.discount_amount ? orderMetaRow('Discount', `-₹${orderData.discount_amount}`) : ''}
        ${orderData.delivery_fee ? orderMetaRow('Delivery Fee', `₹${orderData.delivery_fee}`) : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;margin-top:12px;border-top:1px dashed ${BRAND_BORDER};">
          <span style="font-size:16px;font-weight:700;color:${TEXT_PRIMARY};">Total</span>
          <span style="font-size:18px;font-weight:800;color:${BRAND_GREEN};">₹${orderData.total_amount || 0}</span>
        </div>
      </div>
    </div>
    ${(orderData.deliveryAddress || orderData.delivery_address) ? `
    <div style="margin:24px 0;background:rgba(255,255,255,0.03);border:1px solid ${BRAND_BORDER};border-radius:14px;padding:20px;">
      <h3 style="margin:0 0 12px 0;color:${TEXT_PRIMARY};font-size:14px;text-transform:uppercase;letter-spacing:1px;">Delivery Details</h3>
      <p style="margin:0;color:${TEXT_SECONDARY};font-size:14px;line-height:1.5;">
        ${safeCustomerName}<br/>
        ${safeAddrLine1}<br/>
        ${safeAddrLine2 ? safeAddrLine2 + '<br/>' : ''}
        ${safeCity ? safeCity + ', ' : ''}${safeState} ${safePostal ? safePostal + '<br/>' : ''}
        📞 ${safePhone}
      </p>
      ${safePaymentMethod ? `<p style="margin:12px 0 0 0;color:${TEXT_MUTED};font-size:13px;">Payment: <strong>${safePaymentMethod}</strong></p>` : ''}
    </div>
    ` : ''}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

export function buildOrderPlacedEmailSimple(customerName: string, orderNumber: string, total: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🍕</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">${customerName ? `Hey ${customerName}!` : 'Order Placed!'}</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Your order has been placed and is waiting for restaurant confirmation.</p>
    </div>
    ${statusBadge('Order Received', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${eta ? orderMetaRow('Estimated Delivery', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered'], 0)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Your Order', trackUrl, 'primary')}
    </div>`;
  return baseWrapper(content, `Your order is received! Waiting for restaurant confirmation.`);
}

export function buildOrderConfirmedEmailSimple(customerName: string, orderNumber: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Order Confirmed!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Great news${customerName ? `, ${customerName}` : ''}! The kitchen has confirmed your order.</p>
    </div>
    ${statusBadge('Confirmed', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${eta ? orderMetaRow('Estimated Delivery', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed ✓', 'Preparing', 'Out for Delivery', 'Delivered'], 1)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Live', trackUrl, 'primary')}
    </div>`;
  return baseWrapper(content, `Your order is confirmed! The kitchen is getting ready.`);
}

export function buildOrderPreparingEmailSimple(customerName: string, orderNumber: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">👨‍🍳</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Your Order is Being Prepared</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Our chefs are crafting your pizza${eta ? ` — estimated ${eta}` : ''}.</p>
    </div>
    ${statusBadge('Preparing', '#f59e0b')}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${eta ? orderMetaRow('Estimated Delivery', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Preparing 🔥', 'Out for Delivery', 'Delivered'], 2)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Live', trackUrl, 'primary')}
    </div>`;
  return baseWrapper(content, `Your pizza is being prepared by our chefs!`);
}

export function buildOrderBakingEmailSimple(customerName: string, orderNumber: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🔥</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Pizza in the Oven!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Your pizza is baking to perfection at 450°F right now.</p>
    </div>
    ${statusBadge('Baking', '#f97316')}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${eta ? orderMetaRow('Estimated Delivery', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Baking 🔥', 'Out for Delivery', 'Delivered'], 2)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Live', trackUrl, 'accent')}
    </div>`;
  return baseWrapper(content, `Your pizza is in the oven!`);
}

export function buildOrderPackedEmailSimple(customerName: string, orderNumber: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">📦</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Order Packed & Ready!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Your order is packed and ready for pickup. Assigning a delivery partner now.</p>
    </div>
    ${statusBadge('Packed', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${eta ? orderMetaRow('Estimated Delivery', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Prepared & Packed ✓', 'Out for Delivery', 'Delivered'], 2)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Live', trackUrl, 'primary')}
    </div>`;
  return baseWrapper(content, `Your order is packed and ready!`);
}

export function buildDeliveryAssignedEmailSimple(customerName: string, orderNumber: string, partnerName: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🚴</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Delivery Partner Assigned</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;"><strong style="color:${TEXT_PRIMARY};">${partnerName}</strong> is on the way to pick up your order.</p>
    </div>
    ${statusBadge('Partner Assigned', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${orderMetaRow('Delivery Partner', partnerName)}
      ${eta ? orderMetaRow('Arriving By', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Prepared', 'Partner Assigned 🚴', 'Delivered'], 3)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track on Map', trackUrl, 'accent')}
    </div>`;
  return baseWrapper(content, `${partnerName} is picking up your order!`);
}

export function buildOutForDeliveryEmailSimple(customerName: string, orderNumber: string, partnerName: string, eta: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🛵</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Your Pizza is On the Way!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${partnerName} is heading to your location${eta ? ` — arriving in ~${eta}` : ''}.</p>
    </div>
    ${statusBadge('Out for Delivery', BRAND_ORANGE)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${orderMetaRow('Delivery Partner', partnerName)}
      ${eta ? orderMetaRow('Arriving In', eta) : ''}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Prepared', 'Out for Delivery 🛵', 'Delivered'], 3)}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📍 Track Live on Map', trackUrl, 'accent')}
    </div>`;
  return baseWrapper(content, `${partnerName} is on the way with your order!`);
}

export function buildOrderDeliveredEmailSimple(customerName: string, orderNumber: string, orderUrl: string, trackUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Order Delivered! Enjoy 🍕</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${customerName ? `Thanks for ordering, ${customerName}! ` : ''}Your order has been delivered successfully.</p>
    </div>
    ${statusBadge('Delivered', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${orderMetaRow('Status', '✅ Delivered Successfully')}
    </div>
    ${renderOrderSummary(orderData)}
    ${progressTimeline(['Order Placed', 'Confirmed', 'Prepared', 'Out for Delivery', '✅ Delivered'], 4)}
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('⭐ Rate Your Order', `${orderUrl}?rate=${orderNumber}`, 'primary')}
      &nbsp;&nbsp;
      ${ctaButton('🔄 Order Again', `${FRONTEND_URL}/menu`, 'ghost')}
    </div>`;
  return baseWrapper(content, `Your order has been delivered. Enjoy your meal!`);
}

export function buildOrderCancelledEmailSimple(customerName: string, orderNumber: string, orderUrl: string, orderData?: any): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">😔</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Order Cancelled</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${customerName ? `Sorry, ${customerName}. ` : ''}Your order has been cancelled. Any payment will be refunded within 5–7 business days.</p>
    </div>
    ${statusBadge('Cancelled', '#ef4444')}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${orderMetaRow('Refund', 'Processed in 5–7 business days')}
    </div>
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('🍕 Order Again', `${FRONTEND_URL}/menu`, 'primary')}
      &nbsp;&nbsp;
      ${ctaButton('📞 Contact Support', `${FRONTEND_URL}/contact`, 'ghost')}
    </div>`;
  return baseWrapper(content, `Your order has been cancelled. We apologize for the inconvenience.`);
}

export function buildPaymentSuccessEmail(customerName: string, orderNumber: string, amount: string, method: string, trackUrl: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">💳</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Payment Successful</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Your payment has been processed successfully.</p>
    </div>
    ${statusBadge('Payment Confirmed', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${amount ? orderMetaRow('Amount Paid', amount) : ''}
      ${method ? orderMetaRow('Payment Method', method) : ''}
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('View Order', trackUrl, 'primary')}
    </div>`;
  return baseWrapper(content, `Payment confirmed for your Olive Pizza order.`);
}

export function buildPaymentFailedEmail(customerName: string, orderNumber: string, amount: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">⚠️</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Payment Failed</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">We couldn't process your payment${amount ? ` of ${amount}` : ''}. Please try again or use a different payment method.</p>
    </div>
    ${statusBadge('Payment Failed', '#ef4444')}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
    </div>
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('🔄 Try Again', `${FRONTEND_URL}/cart`, 'accent')}
      &nbsp;&nbsp;
      ${ctaButton('📞 Contact Support', `${FRONTEND_URL}/contact`, 'ghost')}
    </div>`;
  return baseWrapper(content, `Your payment was unsuccessful. Please try again.`);
}

export function buildRefundProcessedEmail(customerName: string, orderNumber: string, amount: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">💰</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Refund Processed</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Your refund of <strong style="color:${BRAND_GREEN};">${amount}</strong> has been processed and will appear in your account within 5–7 business days.</p>
    </div>
    ${statusBadge('Refund Initiated', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderNumber ? orderMetaRow('Order #', orderNumber) : ''}
      ${amount ? orderMetaRow('Refund Amount', amount) : ''}
      ${orderMetaRow('Processing Time', '5–7 Business Days')}
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('🍕 Order Again', `${FRONTEND_URL}/menu`, 'primary')}
    </div>`;
  return baseWrapper(content, `Your refund has been processed.`);
}

export function buildWelcomeEmail(customerName: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <img src="${PIZZA_HERO}" alt="Olive Pizza" style="width:100%;max-height:200px;object-fit:cover;border-radius:14px;margin-bottom:24px;" />
      <h1 style="font-size:28px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Welcome to Olive Pizza! 🍕</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Hello${customerName ? ` ${customerName}` : ''}! Your account is ready. Explore our premium menu and place your first order.</p>
    </div>
    <div style="background:${BRAND_GREEN}11;border:1px solid ${BRAND_GREEN}33;border-radius:14px;padding:20px;margin:24px 0;">
      <p style="color:${TEXT_SECONDARY};font-size:14px;margin:0 0 8px;text-align:center;">🎉 <strong style="color:${BRAND_GREEN};">First Order Offer:</strong> Free delivery on your first order!</p>
    </div>
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('🍕 Browse Menu', `${FRONTEND_URL}/menu`, 'primary')}
      &nbsp;&nbsp;
      ${ctaButton('My Account', `${FRONTEND_URL}/customer/dashboard`, 'ghost')}
    </div>`;
  return baseWrapper(content, `Welcome to Olive Pizza — your premium pizza experience!`);
}

export function buildPasswordResetEmail(customerName: string, resetLink: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">🔑</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Password Reset Request</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${customerName ? `Hi ${customerName}, w` : 'W'}e received a request to reset your Olive Pizza password. Click the button below to proceed.</p>
    </div>
    <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:12px;padding:16px;margin:20px 0;text-align:center;">
      <p style="color:#f87171;font-size:13px;margin:0;">⏰ This link expires in <strong>1 hour</strong>. If you didn't request this, ignore this email.</p>
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('🔑 Reset Password', resetLink, 'accent')}
    </div>`;
  return baseWrapper(content, `Reset your Olive Pizza password. Link expires in 1 hour.`);
}

export function buildEmailVerificationEmail(customerName: string, verificationLink: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;margin-bottom:12px;">✉️</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Verify Your Email</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${customerName ? `Hi ${customerName}! ` : ''}Please verify your email address to complete your Olive Pizza account setup.</p>
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('✅ Verify Email Address', verificationLink, 'primary')}
    </div>
    <p style="text-align:center;color:${TEXT_MUTED};font-size:12px;margin-top:16px;">If you didn't create an account, you can safely ignore this email.</p>`;
  return baseWrapper(content, `Please verify your email to get started with Olive Pizza.`);
}

export function buildPromoEmail(params: {
  customerName?: string;
  title: string;
  description: string;
  couponCode?: string;
  expiryDate?: string;
  bannerImage?: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const content = `
    ${params.bannerImage ? `<img src="${params.bannerImage}" alt="${params.title}" style="width:100%;max-height:220px;object-fit:cover;border-radius:14px;margin-bottom:24px;" />` : `<div style="font-size:48px;text-align:center;margin-bottom:16px;">🎉</div>`}
    <div style="text-align:center;margin-bottom:20px;">
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">${params.title}</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${params.description}</p>
    </div>
    ${params.couponCode ? `<div style="background:${BRAND_ORANGE}11;border:2px dashed ${BRAND_ORANGE}55;border-radius:14px;padding:20px;margin:20px 0;text-align:center;">
      <div style="font-size:12px;color:${TEXT_MUTED};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your Exclusive Code</div>
      <div style="font-size:28px;font-weight:800;color:${BRAND_ORANGE};letter-spacing:4px;">${params.couponCode}</div>
      ${params.expiryDate ? `<div style="font-size:12px;color:${TEXT_MUTED};margin-top:8px;">Expires: ${params.expiryDate}</div>` : ''}
    </div>` : ''}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton(params.ctaLabel || '🍕 Order Now', params.ctaUrl || `${FRONTEND_URL}/menu`, 'accent')}
    </div>`;
  return baseWrapper(content, `${params.title} — Grab this offer before it expires!`);
}

export function buildNewProductEmail(params: {
  productName: string;
  productImage?: string;
  description: string;
  price?: string;
}): string {
  const content = `
    ${params.productImage ? `<img src="${params.productImage}" alt="${params.productName}" style="width:100%;max-height:220px;object-fit:cover;border-radius:14px;margin-bottom:24px;" />` : `<div style="font-size:48px;text-align:center;margin-bottom:16px;">🆕</div>`}
    <div style="text-align:center;margin-bottom:20px;">
      <span style="font-size:11px;color:${BRAND_GREEN};text-transform:uppercase;letter-spacing:2px;font-weight:700;">New on the Menu</span>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:8px 0;">${params.productName}</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${params.description}</p>
      ${params.price ? `<div style="font-size:22px;font-weight:800;color:${BRAND_GREEN};margin-top:12px;">Starting at ${params.price}</div>` : ''}
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('🍕 Try It Now', `${FRONTEND_URL}/menu`, 'primary')}
    </div>`;
  return baseWrapper(content, `Introducing ${params.productName} — now available at Olive Pizza!`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

export function buildOwnerNewOrderEmail(params: {
  orderNumber: string;
  dailyOrderNumber?: string;
  customerName: string;
  totalAmount: string;
  paymentMethod: string;
  deliveryAddress?: string;
  deliveryType: string;
  itemsSummary: string;
  orderId: string;
}): string {
  const content = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;margin-bottom:12px;">🔔</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">New Order Received!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">A new order is waiting for your confirmation.</p>
    </div>
    ${statusBadge('New Order', BRAND_ORANGE)}
    <div style="margin:20px 0;">
      ${orderMetaRow('Order #', params.orderNumber)}
      ${params.dailyOrderNumber ? orderMetaRow("Today's Order #", `#${params.dailyOrderNumber}`) : ''}
      ${orderMetaRow('Customer', params.customerName)}
      ${orderMetaRow('Total', params.totalAmount)}
      ${orderMetaRow('Payment', params.paymentMethod)}
      ${orderMetaRow('Type', params.deliveryType)}
      ${params.deliveryAddress ? orderMetaRow('Address', params.deliveryAddress) : ''}
    </div>
    <div style="background:rgba(255,255,255,0.03);border:1px solid ${BRAND_BORDER};border-radius:12px;padding:16px;margin:16px 0;">
      <div style="font-size:13px;color:${TEXT_MUTED};margin-bottom:8px;text-transform:uppercase;letter-spacing:1px;">Items Ordered</div>
      <div style="font-size:14px;color:${TEXT_PRIMARY};">${params.itemsSummary}</div>
    </div>
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('✅ Accept Order', `${FRONTEND_URL}/owner/orders`, 'primary')}
      &nbsp;&nbsp;
      ${ctaButton('📊 View Dashboard', `${FRONTEND_URL}/owner/dashboard`, 'ghost')}
    </div>`;
  return baseWrapper(content, `New order from ${params.customerName} — ${params.totalAmount}`);
}

export function buildOwnerDailySummaryEmail(params: {
  date: string;
  totalOrders: number;
  totalRevenue: string;
  completedOrders: number;
  cancelledOrders: number;
  avgOrderValue: string;
  topItem?: string;
}): string {
  const content = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;margin-bottom:12px;">📊</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Daily Sales Summary</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${params.date}</p>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0;">
      ${[
        { label: 'Total Orders', value: String(params.totalOrders), color: BRAND_GREEN },
        { label: 'Revenue', value: params.totalRevenue, color: BRAND_ORANGE },
        { label: 'Completed', value: String(params.completedOrders), color: BRAND_GREEN },
        { label: 'Cancelled', value: String(params.cancelledOrders), color: '#ef4444' },
      ].map(s => `<div style="background:rgba(255,255,255,0.03);border:1px solid ${BRAND_BORDER};border-radius:12px;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:${s.color};">${s.value}</div>
        <div style="font-size:12px;color:${TEXT_MUTED};margin-top:4px;">${s.label}</div>
      </div>`).join('')}
    </div>
    <div style="margin:16px 0;">
      ${orderMetaRow('Avg. Order Value', params.avgOrderValue)}
      ${params.topItem ? orderMetaRow('Top Selling Item', params.topItem) : ''}
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📈 View Full Analytics', `${FRONTEND_URL}/owner/reports`, 'primary')}
    </div>`;
  return baseWrapper(content, `Daily summary for ${params.date} — ${params.totalRevenue} revenue`);
}

export function buildOwnerCriticalAlertEmail(subject: string, message: string, details?: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;margin-bottom:12px;">🚨</div>
      <h1 style="font-size:26px;font-weight:800;color:#ef4444;margin:0 0 8px;">${subject}</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${message}</p>
    </div>
    ${details ? `<div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25);border-radius:12px;padding:16px;margin:20px 0;font-size:13px;color:#f87171;font-family:monospace;white-space:pre-wrap;word-break:break-all;">${details}</div>` : ''}
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('🔍 Open Dashboard', `${FRONTEND_URL}/owner/dashboard`, 'accent')}
    </div>`;
  return baseWrapper(content, `Critical Alert: ${subject}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY PARTNER TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

export function buildDeliveryNewAssignmentEmail(params: {
  partnerName: string;
  orderNumber: string;
  pickupAddress: string;
  deliveryAddress: string;
  distance?: string;
  totalAmount: string;
  eta?: string;
  customerPhone?: string;
  orderId: string;
}): string {
  const content = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;margin-bottom:12px;">📦</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">New Delivery Request</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">${params.partnerName ? `Hi ${params.partnerName}! ` : ''}A delivery is waiting for you.</p>
    </div>
    ${statusBadge('New Assignment', BRAND_ORANGE)}
    <div style="margin:20px 0;">
      ${orderMetaRow('Order #', params.orderNumber)}
      ${orderMetaRow('Order Value', params.totalAmount)}
      ${orderMetaRow('Pickup', params.pickupAddress)}
      ${orderMetaRow('Delivery To', params.deliveryAddress)}
      ${params.distance ? orderMetaRow('Distance', params.distance) : ''}
      ${params.eta ? orderMetaRow('Est. Time', params.eta) : ''}
      ${params.customerPhone ? orderMetaRow('Customer Phone', params.customerPhone) : ''}
    </div>
    <div style="text-align:center;margin-top:28px;" class="btn-row">
      ${ctaButton('✅ Accept Delivery', `${FRONTEND_URL}/delivery/dashboard`, 'primary')}
      &nbsp;&nbsp;
      ${ctaButton('🗺️ Navigate', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(params.pickupAddress)}`, 'accent')}
    </div>`;
  return baseWrapper(content, `New delivery from Olive Pizza — ${params.totalAmount}`);
}

export function buildDeliveryCompletedEmail(partnerName: string, orderNumber: string, amount: string): string {
  const content = `
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;margin-bottom:12px;">✅</div>
      <h1 style="font-size:26px;font-weight:800;color:${TEXT_PRIMARY};margin:0 0 8px;">Delivery Completed!</h1>
      <p style="color:${TEXT_SECONDARY};font-size:15px;margin:0;">Great job${partnerName ? `, ${partnerName}` : ''}! Order #${orderNumber} has been delivered successfully.</p>
    </div>
    ${statusBadge('Completed', BRAND_GREEN)}
    <div style="margin:20px 0;">
      ${orderMetaRow('Order #', orderNumber)}
      ${amount ? orderMetaRow('Order Value', amount) : ''}
    </div>
    <div style="text-align:center;margin-top:28px;">
      ${ctaButton('📊 View Earnings', `${FRONTEND_URL}/delivery/earnings`, 'primary')}
    </div>`;
  return baseWrapper(content, `Delivery completed for Order #${orderNumber}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY EXPORTS (backward compatibility with existing callers)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use buildOrderPlacedEmailSimple instead */
export const buildOrderPlacedEmail = (order: any): string => {
  return buildOrderPlacedEmailSimple(
    order.customerInfo?.name || order.customerName || '',
    String(order.dailyOrderNumber || order.id),
    `₹${(order.totalAmount || 0).toFixed(2)}`,
    '',
    `${FRONTEND_URL}/tracking/${order.id}`
  );
};

/** @deprecated Use buildOrderConfirmedEmailSimple instead */
export const buildOrderConfirmedEmail = (order: any): string => {
  return buildOrderConfirmedEmailSimple(
    order.customerInfo?.name || order.customerName || '',
    String(order.dailyOrderNumber || order.id),
    '',
    `${FRONTEND_URL}/tracking/${order.id}`
  );
};

/** @deprecated Use buildDeliveryAssignedEmailSimple instead */
export const buildDeliveryPartnerAssignedEmail = (order: any, partnerName: string, _partnerPhoto: string, _vehicleInfo: string): string => {
  return buildDeliveryAssignedEmailSimple(
    order.customerInfo?.name || order.customerName || '',
    String(order.dailyOrderNumber || order.id),
    partnerName,
    '',
    `${FRONTEND_URL}/tracking/${order.id}`
  );
};

/** @deprecated Use buildOrderDeliveredEmailSimple instead */
export const buildOrderDeliveredEmail = (order: any, _recommendedProducts: any[] = []): string => {
  return buildOrderDeliveredEmailSimple(
    order.customerInfo?.name || order.customerName || '',
    String(order.dailyOrderNumber || order.id),
    `${FRONTEND_URL}/customer/dashboard`,
    `${FRONTEND_URL}/tracking/${order.id}`
  );
};
