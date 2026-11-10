/**
 * Enterprise Notification Templates — Production v2
 *
 * KEY DESIGN DECISIONS:
 * - Every notification carries: eventId, orderId, currentStatus, previousStatus, version, eventTimestamp, serverTimestamp
 * - Android notification channels are role + priority specific (one sound per channel)
 * - Owner new orders use a SEPARATE notification ID per order (no grouping overwrite)
 * - Delivery assignments use a SEPARATE notification ID per order
 * - Customer tracker uses a SINGLE notification ID per order (live card updated in place)
 * - Sounds: order_alert | delivery_chime | success_ding | cancel_buzz | soft_pop | system_alert | order_confirmed
 *
 * ANDROID CHANNELS:
 *   olive_order_new          — Owner: New Orders    (MAX importance, order_alert sound)
 *   olive_order_status       — Updates              (HIGH importance, soft_pop sound)
 *   olive_order_completed    — Delivered/Cancelled  (HIGH importance, success_ding/cancel_buzz)
 *   olive_delivery_assignment— Delivery assignments (MAX importance, delivery_chime sound)
 *   olive_delivery_updates   — Navigation/progress  (HIGH importance, default)
 *   olive_marketing          — Promotions           (DEFAULT importance, soft_pop)
 *   olive_system             — Alerts               (HIGH importance, system_alert)
 */

import type { OrderEvent, OrderSnapshot } from '../order/OrderEventService.js';
import { generateTrackingToken } from '../../utils/trackingToken.js';

export type OrderStatus =
  | 'pending'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'partner_assigned'
  | 'picked_up'
  | 'out_for_delivery'
  | 'delivered'
  | 'completed'
  | 'cancelled';

export type NotificationType =
  | 'NEW_ORDER'
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'ORDER_PREPARING'
  | 'ORDER_READY'
  | 'ORDER_CANCELLED'
  | 'DELIVERY_ASSIGNED'
  | 'DELIVERY_PICKED_UP'
  | 'ORDER_DELIVERED'
  | 'PICKUP_READY';

export type NotificationRole =
  | 'customer'
  | 'owner'
  | 'delivery'
  | 'restaurant_manager'
  | 'cashier'
  | 'kitchen_staff'
  | 'franchise_owner'
  | 'admin'
  | 'developer'
  | 'platform_owner';
export type NotificationPriority = 'critical' | 'high' | 'normal';
export type NotificationCategory =
  | 'order'
  | 'delivery'
  | 'marketing'
  | 'coupon'
  | 'announcement'
  | 'alert'
  | 'reward'
  | 'system'
  | 'alarm_actionable'
  | 'pinned_live'
  | 'monthly_report'
  | 'report';

// ─── Android Channel IDs ──────────────────────────────────────────────────────
export const ANDROID_CHANNELS = {
  ORDER_NEW: 'olive_order_alarm_v3',
  ORDER_STATUS: 'olive_order_status',
  ORDER_TRACKING: 'olive_order_tracking',
  ORDER_COMPLETED: 'olive_order_completed_v2',
  DELIVERY_ASSIGNMENT: 'olive_delivery_alarm_v3',
  DELIVERY_UPDATES: 'olive_delivery_updates',
  MARKETING: 'olive_marketing',
  SYSTEM: 'olive_system',
} as const;

export type AndroidChannelId = typeof ANDROID_CHANNELS[keyof typeof ANDROID_CHANNELS];

// ─── Sound Mapping ────────────────────────────────────────────────────────────
export const SOUNDS = {
  new_order: 'new_order',        // Owner & Manager new order alarm (new_order.mp3)
  delivery_assigned: 'delivery_chime',     // Delivery partner — chime
  delivered: 'order_delivered',       // Delivered — pleasant success (order_delivered.mp3)
  cancelled: 'cancel_buzz',        // Cancelled — soft warning
  confirmed: 'order_confirmed',    // Customer order confirmed
  marketing: 'soft_pop',           // Promotions
  system: 'system_alert',       // System alerts
  default: 'default',
} as const;

// ─── Progress Bar (Unicode block characters) ──────────────────────────────────
const PROGRESS_STEPS: Record<OrderStatus, number> = {
  pending: 1, accepted: 2, preparing: 3, ready: 4,
  partner_assigned: 5, picked_up: 6, out_for_delivery: 7,
  delivered: 8, completed: 8, cancelled: 0,
};
const TOTAL_STEPS = 8;
const FILLED = '█';
const EMPTY = '░';

function progressBar(status: OrderStatus): string {
  if (status === 'cancelled') return '✖ Cancelled';
  const step = PROGRESS_STEPS[status] || 0;
  const filled = Math.round((step / TOTAL_STEPS) * 8);
  return FILLED.repeat(filled) + EMPTY.repeat(8 - filled);
}

function progressSteps(status: OrderStatus): string {
  const steps: [OrderStatus, string][] = [
    ['pending', 'Order Placed'],
    ['accepted', 'Confirmed'],
    ['preparing', 'Preparing'],
    ['ready', 'Packed'],
    ['partner_assigned', 'Delivery Assigned'],
    ['out_for_delivery', 'Out for Delivery'],
    ['delivered', 'Delivered'],
  ];
  const currentIdx = PROGRESS_STEPS[status] - 1;
  return steps.map(([s, label], i) => {
    if (i < currentIdx) return `✔ ${label}`;
    if (i === currentIdx) return `🟠 ${label}`;
    return `○ ${label}`;
  }).join('\n');
}

// ─── Brand ────────────────────────────────────────────────────────────────────
const ICON = 'ic_notification'; // Android drawable name
const LOGO = 'https://res.cloudinary.com/dxmlvkff1/image/upload/v1782376898/olive-pizza/brand/logo.png';

// ─── Payload Interface ────────────────────────────────────────────────────────
export interface NotificationPayload {
  notification?: { title: string; body: string; image?: string };
  data: {
    // Synchronization fields — ALL REQUIRED for stale guard
    eventId?: string;
    orderId?: string;
    previousStatus?: string;
    currentStatus?: string;
    version?: string;
    eventTimestamp?: string;
    serverTimestamp?: string;
    // Display
    tag?: string;
    url?: string;
    category?: NotificationCategory;
    priority?: NotificationPriority;
    role?: NotificationRole;
    sound?: string;
    stage?: string;
    // Feature flags
    ongoing?: string;        // 'true' — pinned tracker
    groupKey?: string;       // Android notification group
    notificationId?: string; // Unique ID within a group
    actions?: string;        // JSON serialized actions array
    requireInteraction?: string;
    alert?: string;          // 'continuous' | 'single'
    vibrate?: string;        // JSON serialized number[]
    [key: string]: string | undefined;
  };
  android?: {
    priority: 'normal' | 'high';
    collapseKey?: string;
    notification?: {
      title?: string;
      body?: string;
      sound?: string;
      channelId?: string;
      tag?: string;
      icon?: string;
      clickAction?: string;
      defaultVibrateTimings?: boolean;
      defaultSound?: boolean;
      vibrateTimingsMillis?: number[];
      notificationPriority?: 'PRIORITY_MIN' | 'PRIORITY_LOW' | 'PRIORITY_DEFAULT' | 'PRIORITY_HIGH' | 'PRIORITY_MAX';
      notificationCount?: number;
    };
  };
  apns?: {
    headers?: Record<string, string>;
    payload?: {
      aps: {
        alert?: { title?: string; body?: string };
        sound?: string;
        badge?: number;
        'mutable-content'?: number;
        'content-available'?: number;
        [key: string]: any;
      };
      [key: string]: any;
    };
    [key: string]: any;
  };
  webpush?: {
    headers?: { Urgency?: string; TTL?: string };
    notification?: {
      icon?: string;
      badge?: string;
      tag?: string;
      renotify?: boolean;
      requireInteraction?: boolean;
      silent?: boolean;
      vibrate?: number[];
      actions?: Array<{ action: string; title: string; icon?: string }>;
      data?: Record<string, unknown>;
    };
    fcm_options?: { link?: string };
  };
}

// ─── Base Builder ─────────────────────────────────────────────────────────────
interface BuildOptions {
  tag: string;
  channelId: AndroidChannelId;
  orderId?: string;
  url?: string;
  sound?: keyof typeof SOUNDS;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  role?: NotificationRole;
  requireInteraction?: boolean;
  actions?: Array<{ action: string; title: string }>;
  stage?: string;
  version?: number;
  alert?: 'continuous' | 'single';
  notificationId?: string;
  vibrate?: number[];
  ongoing?: boolean;
  groupKey?: string;
  // Custom action & branch fields
  actionUrlAccept?: string;
  actionUrlReject?: string;
  branchId?: string;
  image?: string;
  // Sync fields from OrderEvent
  eventId?: string;
  previousStatus?: string;
  currentStatus?: string;
  eventTimestamp?: string;
  serverTimestamp?: string;
  // Live Activity & ongoing order fields
  orderNumber?: string;
  etaMinutes?: string;
  riderName?: string;
  restaurantName?: string;
  isLive?: string;
  [key: string]: any;
}

function buildPayload(title: string, body: string, opts: BuildOptions): NotificationPayload {
  const soundKey = opts.sound || 'default';
  const soundFile = SOUNDS[soundKey as keyof typeof SOUNDS] || 'default';
  const isHigh = opts.priority === 'critical' || opts.priority === 'high';

  const safeData: Record<string, string> = {
    title,
    body,
    url: opts.url || '/',
    category: opts.category || 'order',
    priority: opts.priority || 'normal',
    sound: soundFile,
    version: String(opts.version || 1),
    tag: opts.tag,
  };

  // Synchronization fields
  if (opts.eventId) safeData.eventId = opts.eventId;
  if (opts.orderId) safeData.orderId = opts.orderId;
  if (opts.previousStatus) safeData.previousStatus = opts.previousStatus;
  if (opts.currentStatus) safeData.currentStatus = opts.currentStatus;
  if (opts.eventTimestamp) safeData.eventTimestamp = opts.eventTimestamp;
  if (opts.serverTimestamp) safeData.serverTimestamp = opts.serverTimestamp;

  // Live Activity & ongoing order fields
  if (opts.orderNumber) safeData.orderNumber = String(opts.orderNumber);
  if (opts.etaMinutes) safeData.etaMinutes = String(opts.etaMinutes);
  if (opts.riderName) safeData.riderName = String(opts.riderName);
  if (opts.restaurantName) safeData.restaurantName = String(opts.restaurantName);
  if (opts.isLive) safeData.isLive = String(opts.isLive);

  // Custom action & branch fields
  if (opts.channelId) safeData.channelId = opts.channelId;
  if (opts.actionUrlAccept) safeData.actionUrlAccept = opts.actionUrlAccept;
  if (opts.actionUrlReject) safeData.actionUrlReject = opts.actionUrlReject;
  if (opts.branchId) safeData.branchId = opts.branchId;
  if (opts.type) safeData.type = opts.type;
  if (opts.restaurantId) safeData.restaurantId = opts.restaurantId;
  if (opts.franchiseId) safeData.franchiseId = opts.franchiseId;

  // Feature flags
  if (opts.role) safeData.role = opts.role;
  if (opts.alert) safeData.alert = opts.alert;
  if (opts.stage) safeData.stage = opts.stage;
  if (opts.eventType) safeData.eventType = opts.eventType;
  if (opts.totalAmount) safeData.totalAmount = String(opts.totalAmount);
  if (opts.itemsSummary) safeData.itemsSummary = opts.itemsSummary;
  if (opts.notificationId) safeData.notificationId = opts.notificationId;
  if (opts.groupKey) safeData.groupKey = opts.groupKey;
  if (opts.ongoing) safeData.ongoing = 'true';
  if (opts.requireInteraction) safeData.requireInteraction = 'true';
  if (opts.actions) safeData.actions = JSON.stringify(opts.actions);
  if (opts.vibrate) safeData.vibrate = JSON.stringify(opts.vibrate);

  // Copy any additional custom string attributes (fullOrderJson, cashToCollect, orderType, etc.)
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== null && typeof v === 'string' && safeData[k] === undefined) {
      safeData[k] = v;
    }
  }

  const basePayload: any = {
    data: safeData,
    android: {
      priority: isHigh ? 'high' : 'normal',
      collapseKey: opts.ongoing ? opts.tag : undefined, // Live card collapse
    },
  };

  // Always include top-level notification block for restaurant manager, delivery partner, and critical alarms
  // so the OS tray notification displays and plays the channel sound even when app is closed/killed.
  if (
    opts.role === 'restaurant_manager' ||
    opts.role === 'delivery' ||
    opts.alert === 'continuous' ||
    (opts.category !== 'alarm_actionable' && opts.category !== 'pinned_live')
  ) {
    basePayload.notification = { title, body };
  }

    // For continuous alarms, use a dedicated clickAction so the system-tray tap
    // launches AlarmActivity (full-screen alarm) instead of MainActivity.
    const clickAction =
      opts.alert === 'continuous'
        ? 'olive_alarm'                       // → AlarmActivity (full-screen alarm)
        : opts.role === 'owner' ? 'owner_order_actions'
          : opts.role === 'delivery' ? 'delivery_actions'
            : 'customer_order_actions';
    basePayload.android.notification = {
      sound: soundFile,
      channelId: opts.channelId,
      tag: opts.tag,
      icon: ICON,
      clickAction,
      defaultVibrateTimings: !opts.vibrate,
      vibrateTimingsMillis: opts.vibrate,
      notificationPriority: opts.priority === 'critical' ? 'PRIORITY_MAX'
        : opts.priority === 'high' ? 'PRIORITY_HIGH' : 'PRIORITY_DEFAULT',
      // For continuous alarms, mark as high-priority so the system tray notification
      // surfaces immediately (heads-up) even in background/killed scenarios.
      ...(opts.alert === 'continuous' ? { notificationCount: 1 } : {}),
    };

  // Determine iOS APNs Category for interactive action buttons
  const apnsCategory =
    opts.role === 'restaurant_manager' || (opts.actions && opts.actions.length > 0 && opts.role !== 'delivery')
      ? 'ORDER_ACTION_CATEGORY'
      : opts.role === 'delivery'
        ? (opts.stage === 'picked_up' ? 'DELIVERY_ORDER_PICKED_UP'
           : opts.stage === 'out_for_delivery' || opts.stage === 'arrived_customer' ? 'DELIVERY_ORDER_OUT_FOR_DELIVERY'
           : opts.stage === 'arrived_restaurant' || opts.stage === 'navigate_restaurant' ? 'DELIVERY_ORDER_ACCEPTED'
           : 'DELIVERY_ASSIGNMENT_CATEGORY')
        : opts.category === 'marketing' || opts.category === 'coupon'
          ? 'PROMO_CATEGORY'
          : opts.category === 'system' || opts.role === 'owner'
            ? 'SECURITY_ALERT_CATEGORY'
            : 'ORDER_STATUS_CATEGORY';

  const apnsSound =
    soundFile === 'default'
      ? 'default'
      : ['new_order', 'order_delivered', 'delivery_chime'].includes(soundFile)
        ? `${soundFile}.wav`
        : `${soundFile}.mp3`;
  const interruptionLevel =
    opts.priority === 'critical' ? 'critical' : opts.priority === 'high' ? 'time-sensitive' : 'active';

  const apnsHeaders: Record<string, string> = {
    'apns-priority': isHigh ? '10' : '5',
    'apns-push-type': 'alert',
  };
  if (opts.ongoing && opts.tag) {
    apnsHeaders['apns-collapse-id'] = String(opts.tag);
  }

  const apnsPayload: any = {
    aps: {
      alert: { title, body },
      sound: opts.alert === 'continuous' ? { critical: 1, name: apnsSound, volume: 1.0 } : apnsSound,
      badge: 1,
      'mutable-content': 1,
      'content-available': 1,
      category: apnsCategory,
      'interruption-level': interruptionLevel,
    },
    ...safeData,
  };

  const fcmOptions: any = {};
  if (opts.image) {
    fcmOptions.image = opts.image;
    apnsPayload.image = opts.image;
  }

  return {
    ...basePayload,
    apns: {
      headers: apnsHeaders,
      payload: apnsPayload,
      ...(Object.keys(fcmOptions).length > 0 ? { fcmOptions } : {}),
    },
    webpush: {
      headers: { Urgency: isHigh ? 'high' : 'normal', TTL: '3600' },
      notification: {
        icon: LOGO,
        tag: opts.tag,
        renotify: true,
        requireInteraction: opts.requireInteraction,
        vibrate: opts.vibrate || [200, 100, 200],
        actions: opts.actions,
        data: {
          url: opts.url || '/',
          orderId: opts.orderId,
          sound: soundFile,
        },
        image: opts.image,
      },
      fcm_options: { link: opts.url || '/' },
    },
  };
}

// ─── iOS ActivityKit Live Activity Payload Builder ─────────────────────────
export function buildLiveActivityPayload(
  orderId: string,
  state: {
    event: 'start' | 'update' | 'end';
    status: OrderStatus;
    step: number;
    orderNumber: string;
    itemsSummary: string;
    totalAmount: number;
    etaMinutes?: number;
    riderName?: string;
    riderPhone?: string;
    restaurantName?: string;
    dismissalDate?: number; // Epoch timestamp in seconds for 'end'
  }
): NotificationPayload {
  const isEnd = state.event === 'end';
  return {
    notification: undefined, // Live Activities do not use top-level notification alerts
    data: {
      orderId,
      orderNumber: state.orderNumber,
      status: state.status,
      step: String(state.step),
      etaMinutes: String(state.etaMinutes || 0),
      totalAmount: String(state.totalAmount),
      isLiveActivity: 'true',
      activityEvent: state.event
    },
    apns: {
      headers: {
        'apns-push-type': 'liveactivity',
        'apns-priority': '10',
        'apns-topic': 'com.olivepizza.app.push-type.liveactivity'
      },
      payload: {
        aps: {
          timestamp: Math.floor(Date.now() / 1000),
          event: state.event,
          'dismissal-date': isEnd ? (state.dismissalDate || Math.floor(Date.now() / 1000) + 300) : undefined,
          'content-state': {
            orderNumber: state.orderNumber,
            status: state.status,
            step: state.step,
            itemsSummary: state.itemsSummary,
            totalAmount: state.totalAmount,
            etaMinutes: state.etaMinutes || 0,
            riderName: state.riderName || '',
            riderPhone: state.riderPhone || '',
            restaurantName: state.restaurantName || 'Olive Pizza',
            updatedAt: new Date().toISOString()
          }
        }
      }
    }
  };
}

// =============================================================================
// RESTAURANT MANAGEMENT TEMPLATES (Actionable Push for Branch Managers)
// =============================================================================
export class RestaurantTemplates {
  /**
   * New Order for Restaurant Management & Staff — FULL INFORMATION CRITICAL ORDER ALERT.
   * Delivers zero-truncation item lists, exact menu names, variant/size, crust, add-ons with prices,
   * complete financial breakdown, payment method/status with COD cash to collect, delivery address,
   * delivery instructions, customer notes, map coordinates, and actionable controls.
   */
  static newOrder(
    orderId: string,
    payload: {
      customerName: string;
      orderNumber: string;
      permanentBillNo?: number | string;
      orderType?: string;
      totalAmount: number;
      items: Array<{
        name: string;
        quantity: number;
        size?: string;
        crust?: string;
        customizations?: string[];
        addons?: Array<{ name: string; price?: number } | string>;
        unitPrice?: number;
        price?: number;
        subtotal?: number;
        instructions?: string;
        image?: string;
      }> | string[];
      paymentMethod: string;
      paymentStatus?: string;
      amountPaid?: number;
      amountRemaining?: number;
      cashToCollect?: number;
      deliveryAddress?: string;
      deliveryInstructions?: string;
      customerNotes?: string;
      lat?: number;
      lng?: number;
      phone?: string;
      orderTime?: string;
      branchId?: string;
      franchiseId?: string;
      version?: number;
      productImageThumbnail?: string;
      financials?: {
        subtotal?: number;
        additionsTotal?: number;
        discount?: number;
        deliveryFee?: number;
        packagingCharge?: number;
        taxes?: number;
        gst?: number;
        cgst?: number;
        sgst?: number;
        couponCode?: string;
        total?: number;
      };
      rawOrder?: any;
    }
  ): NotificationPayload {
    // 1. Format complete item lines (NO 3-item truncation — full item list)
    let itemStrings: string[] = [];
    let firstImage = payload.productImageThumbnail || '';

    if (Array.isArray(payload.items)) {
      itemStrings = payload.items.map(item => {
        if (typeof item === 'string') return `• ${item}`;
        if (!firstImage && item.image) firstImage = item.image;
        const sizePart = item.size ? ` (${item.size})` : '';
        const crustPart = item.crust ? ` [${item.crust}]` : '';
        const rawAddons = (item as any).addons || (item as any).addOns;
        const addonsList = Array.isArray(rawAddons)
          ? rawAddons.map((a: any) => typeof a === 'object' ? `${a.name}${a.price ? ` (+₹${a.price})` : ''}` : a).filter(Boolean)
          : (item.customizations || []);
        const customPart = addonsList.length > 0 ? ` +${addonsList.join(', ')}` : '';
        const price = item.subtotal || ((item.unitPrice || item.price || 0) * (item.quantity || 1));
        const pricePart = price ? ` — ₹${price}` : '';
        const instPart = item.instructions ? ` (Note: ${item.instructions})` : '';
        return `• ${item.quantity}× ${item.name}${sizePart}${crustPart}${customPart}${pricePart}${instPart}`;
      });
    }

    const isPickup = (payload.orderType || '').toLowerCase().includes('pickup') || (payload.orderType || '').toLowerCase().includes('takeaway');
    const orderTypeLabel = isPickup ? 'Pickup / Takeaway' : 'Home Delivery';

    const isCod = (payload.paymentMethod || '').toUpperCase() === 'COD' || (payload.paymentMethod || '').toUpperCase().includes('CASH');
    const paymentStatus = (payload.paymentStatus || (isCod ? 'PENDING' : 'PAID')).toUpperCase();
    const cashToCollect = payload.cashToCollect !== undefined ? payload.cashToCollect : (isCod ? payload.totalAmount : 0);

    const title = `🍕 NEW ORDER #${payload.orderNumber} • ₹${payload.totalAmount}`;

    // Financial breakdown summary line
    const fin = payload.financials;
    const finParts: string[] = [];
    if (fin) {
      if (fin.subtotal) finParts.push(`Subtotal: ₹${fin.subtotal}`);
      if (fin.discount) finParts.push(`Discount: -₹${fin.discount}${fin.couponCode ? ` (${fin.couponCode})` : ''}`);
      if (fin.deliveryFee) finParts.push(`Delivery: ₹${fin.deliveryFee}`);
      if (fin.packagingCharge) finParts.push(`Packaging: ₹${fin.packagingCharge}`);
      if (fin.taxes || fin.gst) finParts.push(`Taxes: ₹${fin.taxes || fin.gst}`);
    }

    const customerLine = `👤 Customer: ${payload.customerName}${payload.phone ? ` (${payload.phone})` : ''}`;
    const paymentLine = isCod
      ? `💵 Payment: CASH ON DELIVERY (${paymentStatus}) • CASH TO COLLECT: ₹${cashToCollect}`
      : `💳 Payment: ${(payload.paymentMethod || 'ONLINE').toUpperCase()} (${paymentStatus}) • Amount: ₹${payload.totalAmount}`;

    // Lock-screen safe notification body: customer phone number and home address are kept in the data payload
    const safeBody = `${itemStrings.length} item(s) • ${orderTypeLabel}${payload.permanentBillNo ? ` • Bill #${payload.permanentBillNo}` : ''}. Tap to review and accept order.`;

    // Build complete serialized order entity for instant in-app modal rendering without network roundtrips
    const fullOrderData = {
      orderId,
      orderNumber: payload.orderNumber,
      permanentBillNo: payload.permanentBillNo,
      orderType: payload.orderType || 'delivery',
      orderTypeLabel,
      orderTime: payload.orderTime || new Date().toISOString(),
      customerName: payload.customerName,
      phone: payload.phone,
      customer: {
        name: payload.customerName,
        phone: payload.phone,
        address: payload.deliveryAddress,
        instructions: payload.deliveryInstructions || payload.customerNotes,
        lat: payload.lat,
        lng: payload.lng
      },
      totalAmount: payload.totalAmount,
      paymentMethod: payload.paymentMethod,
      paymentStatus,
      cashToCollect,
      items: payload.items,
      financials: payload.financials,
      deliveryAddress: payload.deliveryAddress,
      deliveryInstructions: payload.deliveryInstructions,
      customerNotes: payload.customerNotes,
      lat: payload.lat,
      lng: payload.lng,
      branchId: payload.branchId || 'main_branch',
      franchiseId: payload.franchiseId || 'fra_rajnandgaon',
      status: 'pending'
    };

    return buildPayload(title, safeBody, {
      tag: `order_restaurant_${orderId}`,
      channelId: ANDROID_CHANNELS.ORDER_NEW,
      orderId,
      url: `/restaurant/live-orders?orderId=${encodeURIComponent(orderId)}`,
      sound: 'new_order',
      category: 'alarm_actionable' as any,
      priority: 'critical',
      role: 'restaurant_manager' as any,
      requireInteraction: true,
      stage: 'new_order',
      alert: 'continuous',
      type: 'NEW_ORDER',
      eventType: 'NEW_ORDER',
      eventId: `NEW_ORDER_${orderId}`,
      orderNumber: payload.orderNumber,
      totalAmount: String(payload.totalAmount || 0),
      restaurantId: payload.branchId || 'main_branch',
      franchiseId: payload.franchiseId || 'default',
      version: payload.version || 1,
      notificationId: `rest_new_${orderId}`,
      vibrate: [300, 200, 300, 200, 300],
      actions: [
        { action: 'ACCEPT', title: 'ACCEPT ORDER' },
        { action: 'REJECT', title: 'REJECT ORDER' },
        { action: 'VIEW', title: 'VIEW FULL ORDER' },
        { action: 'OPEN_LOCATION', title: 'OPEN LOCATION' },
      ],
      currentStatus: 'pending',
      serverTimestamp: new Date().toISOString(),
      actionUrlAccept: `/api/orders/${orderId}/accept`,
      actionUrlReject: `/api/orders/${orderId}/reject`,
      actionUrlAcknowledge: `/api/orders/${orderId}/acknowledge`,
      branchId: payload.branchId || 'main_branch',
      image: firstImage || undefined,
      fullOrderJson: JSON.stringify(fullOrderData),
      customerName: payload.customerName,
      deliveryAddress: payload.deliveryAddress || '',
      deliveryInstructions: payload.deliveryInstructions || '',
      orderType: payload.orderType || 'delivery',
      permanentBillNo: payload.permanentBillNo ? String(payload.permanentBillNo) : '',
      paymentMethod: payload.paymentMethod || 'COD',
      paymentStatus,
      cashToCollect: String(cashToCollect),
      lat: payload.lat ? String(payload.lat) : '',
      lng: payload.lng ? String(payload.lng) : ''
    });
  }

  /**
   * Order Delivered for Restaurant Management — celebratory notification with distinct sound.
   */
  static orderDelivered(
    orderId: string,
    payload: {
      orderNumber: string;
      customerName?: string;
      totalAmount?: number;
      branchId?: string;
      franchiseId?: string;
      riderName?: string;
      deliveryAddress?: string;
      deliveredAt?: string;
      version?: number;
    }
  ): NotificationPayload {
    const title = `🎉 ORDER DELIVERED #${payload.orderNumber}`;
    const body = `Order #${payload.orderNumber} for ${payload.customerName || 'Customer'} was successfully delivered${payload.riderName ? ` by ${payload.riderName}` : ''}.`;

    return buildPayload(title, body, {
      tag: `order_delivered_${orderId}`,
      channelId: ANDROID_CHANNELS.ORDER_COMPLETED,
      orderId,
      url: `/restaurant/order-history`,
      sound: 'delivered',
      category: 'simple_informational' as any,
      priority: 'high',
      role: 'restaurant_manager' as any,
      stage: 'delivered',
      alert: 'single',
      type: 'ORDER_DELIVERED',
      restaurantId: payload.branchId || 'main_branch',
      franchiseId: payload.franchiseId || 'default',
      version: payload.version || 1,
      notificationId: `rest_deliv_${orderId}`,
      vibrate: [200, 100, 200],
      currentStatus: 'delivered',
      serverTimestamp: new Date().toISOString(),
      branchId: payload.branchId || 'main_branch',
    });
  }
}

// =============================================================================
// OWNER TEMPLATES
// =============================================================================
export class OwnerTemplates {

  /**
   * New Order — CRITICAL wake-up.
   * Each order gets its OWN notification tag (never collapses with another order).
   */
  static newOrder(
    orderId: string,
    payload: {
      customerName: string;
      orderNumber: string;
      totalAmount: number;
      items: string[];
      paymentMethod: string;
      deliveryAddress: string;
      phone?: string;
      distance?: string;
      orderTime: string;
      version?: number;
      notificationId?: string;
      // Sync fields
      eventId?: string;
      previousStatus?: string;
      eventTimestamp?: string;
    }
  ): NotificationPayload {
    const title = `🍕 New Order Received`;
    const body = [
      `Order #${payload.orderNumber}`,
      `Customer:\n${payload.customerName}`,
      `Phone:\n${payload.phone || 'N/A'}`,
      `Delivery Address:\n${payload.deliveryAddress}`,
      `Items:\n${payload.items.slice(0, 5).map(item => `• ${item}`).join('\n')}${payload.items.length > 5 ? `\n• ... and ${payload.items.length - 5} more` : ''}`,
      `Total:\n₹${payload.totalAmount}`,
      `Payment:\n${payload.paymentMethod}`,
      payload.distance ? `Estimated Distance:\n${payload.distance}` : '',
      `Order Time:\n${payload.orderTime}`,
    ].filter(Boolean).join('\n\n');

    return buildPayload(title, body, {
      tag: `order_owner_${orderId}`,
      channelId: ANDROID_CHANNELS.ORDER_STATUS,
      orderId,
      url: `/owner/orders`,
      sound: 'default',
      category: 'simple_informational' as any,
      priority: 'high',
      role: 'owner',
      requireInteraction: false,
      stage: 'order_summary',
      version: payload.version || 1,
      notificationId: `owner_info_${orderId}`,
      groupKey: 'owner_orders',
      vibrate: [200, 100, 200],
      actions: [
        { action: 'view', title: '📊 View Details' },
      ],
      eventId: payload.eventId,
      previousStatus: payload.previousStatus,
      currentStatus: 'pending',
      eventTimestamp: payload.eventTimestamp,
      serverTimestamp: new Date().toISOString(),
    });
  }

  /** Live Order Status Update — updates the same notification in-place */
  static orderStatusUpdate(
    orderId: string,
    payload: {
      orderNumber: string;
      customerName: string;
      status: OrderStatus;
      eta?: string;
      deliveryPartnerName?: string;
      totalAmount: number;
      version?: number;
      notificationId?: string;
      eventId?: string;
      previousStatus?: string;
      eventTimestamp?: string;
    }
  ): NotificationPayload {
    const statusLabels: Record<OrderStatus, string> = {
      pending: '⏳ Pending', accepted: '✅ Accepted', preparing: '🔥 Preparing',
      ready: '🟢 Ready', partner_assigned: '🚴 Partner Assigned', picked_up: '📦 Picked Up',
      out_for_delivery: '🛵 Out for Delivery', delivered: '✅ Delivered',
      completed: '🏁 Completed', cancelled: '❌ Cancelled',
    };

    const isCompleted = payload.status === 'delivered' || payload.status === 'completed';
    const isCancelled = payload.status === 'cancelled';

    const title = `${statusLabels[payload.status]} • #${payload.orderNumber}`;
    const body = [
      `${payload.customerName} • ₹${payload.totalAmount}`,
      payload.eta ? `ETA: ${payload.eta}` : '',
      payload.deliveryPartnerName ? `Partner: ${payload.deliveryPartnerName}` : '',
    ].filter(Boolean).join(' • ');

    const actions: Array<{ action: string; title: string }> =
      payload.status === 'preparing'
        ? [{ action: 'ready', title: '🟢 Mark Ready' }, { action: 'assign_delivery', title: '🚴 Assign Partner' }, { action: 'open', title: '📊 View' }]
        : payload.status === 'ready'
          ? [{ action: 'assign_delivery', title: '🚴 Assign Partner' }, { action: 'open', title: '📊 View' }]
          : [{ action: 'open', title: '📊 Open Dashboard' }];

    return buildPayload(title, body, {
      tag: `order_owner_${orderId}`,
      channelId: isCompleted ? ANDROID_CHANNELS.ORDER_COMPLETED
        : isCancelled ? ANDROID_CHANNELS.ORDER_COMPLETED
          : ANDROID_CHANNELS.ORDER_STATUS,
      orderId,
      url: `/owner/orders`,
      sound: isCompleted ? 'delivered' : isCancelled ? 'cancelled' : undefined,
      category: 'order',
      priority: isCompleted || isCancelled ? 'high' : 'normal',
      role: 'owner',
      requireInteraction: !isCompleted && !isCancelled,
      stage: payload.status,
      version: payload.version,
      notificationId: `owner_status_${orderId}`,
      groupKey: 'owner_orders',
      actions,
      eventId: payload.eventId,
      previousStatus: payload.previousStatus,
      currentStatus: payload.status,
      eventTimestamp: payload.eventTimestamp,
      serverTimestamp: new Date().toISOString(),
    });
  }
}

// =============================================================================
// DELIVERY PARTNER TEMPLATES
// =============================================================================
export class DeliveryTemplates {

  /** New delivery assignment — CRITICAL, full rider information with actionable navigation */
  static newAssignment(
    orderId: string,
    payload: {
      orderNumber: string;
      customerName: string;
      customerPhone: string;
      deliveryAddress: string;
      deliveryInstructions?: string;
      distance: string;
      eta: string;
      totalAmount: number;
      paymentMethod: string;
      paymentStatus?: string;
      cashToCollect?: number;
      items?: any[];
      lat?: number;
      lng?: number;
      version?: number;
      notificationId?: string;
      eventId?: string;
      previousStatus?: string;
      eventTimestamp?: string;
    }
  ): NotificationPayload {
    const isCod = (payload.paymentMethod || '').toUpperCase() === 'COD' || (payload.paymentMethod || '').toUpperCase().includes('CASH');
    const paymentStatus = (payload.paymentStatus || (isCod ? 'PENDING' : 'PAID')).toUpperCase();
    const cashToCollect = payload.cashToCollect !== undefined ? payload.cashToCollect : (isCod ? payload.totalAmount : 0);

    const title = `🚴 NEW DELIVERY #${payload.orderNumber} • ₹${payload.totalAmount}`;
    const itemsFormatted = Array.isArray(payload.items)
      ? payload.items.map(it => typeof it === 'string' ? `• ${it}` : `• ${it.quantity || 1}× ${it.name}`).join('\n')
      : '';

    // Lock-screen safe notification body: customer phone number and home address are kept in the data payload
    const safeBody = `New delivery task #${payload.orderNumber} • ${payload.distance} • ${payload.eta}. Tap to view full customer and route details.`;

    return buildPayload(title, safeBody, {
      tag: `order_delivery_${orderId}`,
      channelId: ANDROID_CHANNELS.DELIVERY_ASSIGNMENT,
      orderId,
      url: `/delivery/live-orders?orderId=${encodeURIComponent(orderId)}`,
      sound: 'delivery_assigned',
      category: 'alarm_actionable' as any,
      priority: 'critical',
      role: 'delivery',
      requireInteraction: true,
      stage: 'delivery_assigned',
      alert: 'continuous',
      version: payload.version || 1,
      notificationId: `delivery_assign_${orderId}`,
      vibrate: [200, 100, 200, 100, 400],
      actions: [
        { action: 'ACCEPT_DELIVERY', title: 'ACCEPT DELIVERY' },
        { action: 'OPEN_LOCATION', title: 'OPEN LOCATION' },
        { action: 'CALL_CUSTOMER', title: 'CALL CUSTOMER' },
        { action: 'VIEW_ORDER', title: 'VIEW ORDER' },
      ],
      actionUrlAccept: `/api/delivery/rider/orders/${orderId}/accept`,
      actionUrlReject: `/api/delivery/rider/orders/${orderId}/decline`,
      eventId: payload.eventId,
      previousStatus: payload.previousStatus,
      currentStatus: 'partner_assigned',
      eventTimestamp: payload.eventTimestamp,
      serverTimestamp: new Date().toISOString(),
      customerPhone: payload.customerPhone,
      customerName: payload.customerName,
      deliveryAddress: payload.deliveryAddress,
      deliveryInstructions: payload.deliveryInstructions || '',
      cashToCollect: String(cashToCollect),
      paymentMethod: payload.paymentMethod,
      lat: payload.lat ? String(payload.lat) : '',
      lng: payload.lng ? String(payload.lng) : '',
    });
  }

  /** Live delivery status update — updates the same notification in-place */
  static deliveryUpdate(
    orderId: string,
    payload: {
      orderNumber: string;
      customerName: string;
      deliveryAddress: string;
      stage: 'navigate_restaurant' | 'arrived_restaurant' | 'picked_up' | 'out_for_delivery' | 'arrived_customer' | 'delivered';
      eta?: string;
      version?: number;
      notificationId?: string;
      eventId?: string;
      previousStatus?: string;
      eventTimestamp?: string;
    }
  ): NotificationPayload {
    const stageConfig: Record<string, { title: string; actions: Array<{ action: string; title: string }> }> = {
      navigate_restaurant: { title: '📍 Navigate to Restaurant', actions: [{ action: 'PICKED_UP', title: '📦 Picked Up' }] },
      arrived_restaurant: { title: '🍕 At Restaurant — Pick Up Order', actions: [{ action: 'PICKED_UP', title: '📦 Picked Up' }] },
      picked_up: { title: '🚴 Order Picked Up', actions: [{ action: 'OUT_FOR_DELIVERY', title: '🛵 Out for Delivery' }] },
      out_for_delivery: { title: `🛵 Delivering to ${payload.customerName}`, actions: [{ action: 'DELIVERED', title: '✅ Delivered' }] },
      arrived_customer: { title: '🏁 Arrived at Customer', actions: [{ action: 'DELIVERED', title: '✅ Delivered' }] },
      delivered: { title: '🎉 Delivery Complete', actions: [] },
    };

    const config = stageConfig[payload.stage] || stageConfig.navigate_restaurant;
    const isComplete = payload.stage === 'delivered';
    const body = [
      `#${payload.orderNumber} — ${payload.deliveryAddress}`,
      payload.eta ? `ETA: ${payload.eta}` : '',
    ].filter(Boolean).join('\n');

    return buildPayload(config.title, body, {
      tag: `order_delivery_${orderId}`,
      channelId: isComplete ? ANDROID_CHANNELS.ORDER_COMPLETED : ANDROID_CHANNELS.DELIVERY_UPDATES,
      orderId,
      url: `/delivery/dashboard`,
      sound: isComplete ? 'delivered' : undefined,
      category: 'delivery',
      priority: 'high',
      role: 'delivery',
      requireInteraction: !isComplete,
      stage: payload.stage,
      version: payload.version,
      notificationId: `delivery_update_${orderId}`,
      actions: config.actions,
      eventId: payload.eventId,
      previousStatus: payload.previousStatus,
      currentStatus: payload.stage === 'delivered' ? 'delivered' : 'out_for_delivery',
      eventTimestamp: payload.eventTimestamp,
      serverTimestamp: new Date().toISOString(),
    });
  }
}

// =============================================================================
// CUSTOMER TEMPLATES
// =============================================================================
export class CustomerTemplates {
  /**
   * Generic informational notification
   */
  static informational(title: string, body: string, url: string = '/'): NotificationPayload {
    return buildPayload(title, body, {
      priority: 'high',
      url,
      sound: 'default',
      tag: 'informational',
      channelId: ANDROID_CHANNELS.SYSTEM
    });
  }

  /**
   * Honest customer delay update notification
   */
  static orderDelay(orderId: string, orderNumber: string, delayMinutes: number = 10): NotificationPayload {
    return buildPayload(
      `Delivery Update • Order ${orderNumber}`,
      `Your order is experiencing a slight delay of approximately ${delayMinutes} minutes due to kitchen workload or transit. We are preparing it fresh and hot!`,
      {
        orderId,
        priority: 'high',
        url: `/orders/${orderId}`,
        sound: 'default',
        tag: `order_${orderId}`,
        channelId: ANDROID_CHANNELS.ORDER_TRACKING
      }
    );
  }

  /**
   * Live order tracker — ONE notification per order, updated in-place.
   * Uses `ongoing: true` for Android pinned notification and channel `olive_order_tracking`.
   */
  static orderUpdate(
    orderId: string,
    payload: {
      orderNumber: string;
      status: OrderStatus;
      step?: number;
      eta?: string;
      etaMinutes?: number;
      deliveryPartnerName?: string;
      riderPhone?: string;
      itemsSummary?: string;
      totalAmount: number;
      version?: number;
      notificationId?: string;
      eventId?: string;
      previousStatus?: string;
      eventTimestamp?: string;
      cancellationReason?: string;
      isPickup?: boolean;
      billReference?: string;
    }
  ): NotificationPayload {
    const isPickup = payload.isPickup || false;
    const stepNumber = payload.step || PROGRESS_STEPS[payload.status] || 1;
    const statusConfig: Record<OrderStatus, {
      title: string; body: string;
      sound?: keyof typeof SOUNDS;
      requireInteraction?: boolean;
      ongoing?: boolean;
    }> = {
      pending: {
        title: `🍕 Order Placed — #${payload.orderNumber}`,
        body: `₹${payload.totalAmount} • Waiting for restaurant confirmation.`,
        ongoing: true,
      },
      accepted: {
        title: `✅ Order Confirmed — #${payload.orderNumber}`,
        body: `Your Olive Pizza order has been accepted.${payload.eta ? ` Estimated arrival: ${payload.eta}.` : ''}`,
        sound: 'confirmed',
        ongoing: true,
      },
      preparing: {
        title: `🔥 Baking in Stone Ovens`,
        body: `Your order is being freshly prepared in our stone ovens.${payload.eta ? ` (Est. ${payload.eta})` : ''}`,
        ongoing: true,
      },
      ready: {
        title: isPickup ? `🍕 Order Ready for Pickup!` : `🟢 Order Ready for Delivery!`,
        body: isPickup 
          ? `Your order is ready for pickup at the restaurant counter.` 
          : `Your order is freshly packed and ready for delivery.`,
        ongoing: true,
      },
      partner_assigned: {
        title: `🚴 Delivery Partner Assigned`,
        body: `${payload.deliveryPartnerName || 'Delivery partner'} has been assigned and is heading to the restaurant.`,
        ongoing: true,
      },
      picked_up: {
        title: `📦 Order Picked Up`,
        body: `${payload.deliveryPartnerName || 'Delivery partner'} picked up your order and is heading your way.`,
        ongoing: true,
      },
      out_for_delivery: {
        title: `🛵 Out for Delivery!`,
        body: `${payload.deliveryPartnerName || 'Your delivery partner'} is on the way to your address.${payload.eta ? ` Arriving in ~${payload.eta}.` : ''}`,
        sound: 'delivery_assigned',
        ongoing: true,
      },
      delivered: {
        title: `✅ Delivered! Enjoy your pizza 🍕`,
        body: `Your order has been delivered. Enjoy your hot pizza!`,
        sound: 'delivered',
        requireInteraction: true,
        ongoing: false,
      },
      completed: {
        title: `🏁 Order Completed`,
        body: `Thank you for choosing Olive Pizza! See you again soon.`,
        ongoing: false,
      },
      cancelled: {
        title: `Order Cancelled`,
        body: payload.cancellationReason === 'RESTAURANT_ACCEPT_TIMEOUT' || (payload as any).cancellationSource === 'SYSTEM_TIMEOUT'
          ? `Sorry, your Olive Pizza order was cancelled because the restaurant could not accept it in time.`
          : `Sorry, your order was cancelled by the restaurant.${payload.cancellationReason && payload.cancellationReason !== 'CUSTOMER_CANCELLED' ? ` (${payload.cancellationReason})` : ''}`,
        sound: 'cancelled',
        ongoing: false,
      },
    };

    const cfg = statusConfig[payload.status];
    const isTerminal = payload.status === 'delivered' || payload.status === 'completed' || payload.status === 'cancelled';
    const isDelivered = payload.status === 'delivered';
    const isCancelled = payload.status === 'cancelled';

    const actions: Array<{ action: string; title: string }> =
      payload.status === 'out_for_delivery' || payload.status === 'partner_assigned'
        ? [{ action: 'track', title: '📍 Track Order' }, { action: 'view_bill', title: '📄 View Bill' }, ...(payload.riderPhone ? [{ action: 'call_partner', title: '📞 Call Rider' }] : [])]
        : isDelivered
          ? [{ action: 'view_bill', title: '📄 View Bill' }, { action: 'rate', title: '⭐ Rate Order' }, { action: 'reorder', title: '🔄 Reorder' }]
          : isCancelled
            ? [{ action: 'view_cancelled', title: 'Details' }, { action: 'reorder', title: 'Order Again' }]
            : [{ action: 'open', title: '📍 Track Order' }, { action: 'view_bill', title: '📄 View Bill' }];

    const trackingToken = generateTrackingToken(orderId);
    const trackingUrl = `/order-tracking/${orderId}?trackingToken=${trackingToken}`;
    const destinationUrl = isCancelled ? `/order-cancelled/${orderId}` : trackingUrl;

    const notificationTypeMap: Record<OrderStatus, NotificationType> = {
      pending: 'ORDER_ACCEPTED',
      accepted: 'ORDER_ACCEPTED',
      preparing: 'ORDER_PREPARING',
      ready: isPickup ? 'PICKUP_READY' : 'ORDER_READY',
      partner_assigned: 'DELIVERY_ASSIGNED',
      picked_up: 'DELIVERY_PICKED_UP',
      out_for_delivery: 'DELIVERY_PICKED_UP',
      delivered: 'ORDER_DELIVERED',
      completed: 'ORDER_DELIVERED',
      cancelled: 'ORDER_CANCELLED',
    };
    const notifType: NotificationType = notificationTypeMap[payload.status] || 'ORDER_ACCEPTED';

    const calculatedEta = payload.etaMinutes !== undefined 
      ? String(payload.etaMinutes)
      : (payload.eta ? String(parseInt(payload.eta) || 0) : '0');

    return buildPayload(cfg.title, cfg.body, {
      tag: `order_customer_${orderId}`,
      channelId: isTerminal ? ANDROID_CHANNELS.ORDER_COMPLETED : ANDROID_CHANNELS.ORDER_TRACKING,
      orderId,
      url: destinationUrl,
      sound: cfg.sound,
      category: (isTerminal ? 'simple_informational' : 'pinned_live') as any,
      priority: isTerminal ? 'high' : 'normal',
      role: 'customer',
      requireInteraction: cfg.requireInteraction,
      stage: payload.status,
      version: payload.version,
      notificationId: `customer_tracker_${orderId}`,
      ongoing: cfg.ongoing,
      actions,
      eventId: payload.eventId,
      previousStatus: payload.previousStatus,
      currentStatus: payload.status,
      eventTimestamp: payload.eventTimestamp,
      serverTimestamp: new Date().toISOString(),
      orderNumber: payload.orderNumber,
      step: String(stepNumber),
      etaMinutes: calculatedEta,
      riderName: payload.deliveryPartnerName || '',
      riderPhone: payload.riderPhone || '',
      itemsSummary: payload.itemsSummary || '',
      totalAmount: String(payload.totalAmount),
      restaurantName: 'Olive Pizza — Rajnandgaon HQ',
      isLive: isTerminal ? 'false' : 'true',
      type: notifType,
      notificationType: notifType,
      billReference: payload.billReference || orderId,
    });
  }

  /**
   * Helper for ActivityKit APNs Live Activity payload
   */
  static liveActivityUpdate(
    orderId: string,
    state: {
      event: 'start' | 'update' | 'end';
      status: OrderStatus;
      step: number;
      orderNumber: string;
      itemsSummary: string;
      totalAmount: number;
      etaMinutes?: number;
      riderName?: string;
      riderPhone?: string;
      restaurantName?: string;
      dismissalDate?: number;
    }
  ): NotificationPayload {
    return buildLiveActivityPayload(orderId, state);
  }
}

// =============================================================================
// MARKETING & SYSTEM TEMPLATES
// =============================================================================
export class MarketingTemplates {

  static couponAlert(payload: { title: string; body: string; couponCode: string; expiryDate: string }): NotificationPayload {
    return buildPayload(`🎟️ ${payload.title}`, `${payload.body}\nCode: ${payload.couponCode} • Expires: ${payload.expiryDate}`, {
      tag: `coupon_${payload.couponCode}`,
      channelId: ANDROID_CHANNELS.MARKETING,
      url: '/menu',
      sound: 'marketing',
      category: 'coupon',
      priority: 'high',
      actions: [{ action: 'use_coupon', title: '🛍️ Order Now' }],
    });
  }

  static announcement(payload: { title: string; body: string; url?: string }): NotificationPayload {
    return buildPayload(`📢 ${payload.title}`, payload.body, {
      tag: `announcement_${Date.now()}`,
      channelId: ANDROID_CHANNELS.MARKETING,
      url: payload.url || '/',
      sound: 'marketing',
      category: 'announcement',
      priority: 'normal',
      actions: [{ action: 'open', title: '📖 Read More' }],
    });
  }

  static rewardEarned(payload: { customerName: string; points: number; message: string }): NotificationPayload {
    return buildPayload(`🏆 ${payload.points} Points Earned!`, payload.message, {
      tag: `reward_${Date.now()}`,
      channelId: ANDROID_CHANNELS.ORDER_COMPLETED,
      url: '/dashboard',
      sound: 'delivered',
      category: 'reward',
      priority: 'high',
    });
  }

  static systemAlert(payload: { title: string; body: string }): NotificationPayload {
    return buildPayload(payload.title, payload.body, {
      tag: `system_${Date.now()}`,
      channelId: ANDROID_CHANNELS.SYSTEM,
      url: '/',
      sound: 'system',
      category: 'system',
      priority: 'high',
    });
  }
}
