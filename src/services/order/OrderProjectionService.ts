/**
 * OrderProjectionService.ts — Field-Level Data Minimization & Security Projections
 *
 * ARCHITECTURAL INVARIANTS:
 * 1. ONE CANONICAL ORDER: Stored in Firestore collection `orders/{orderId}` and PostgreSQL.
 *    No duplicate collections (no `customerOrders/`, `deliveryOrders/`, etc.).
 * 2. FIELD-LEVEL MINIMIZATION: Each role/application receives ONLY the authorized projection
 *    required for legitimate business operations.
 * 3. SECURITY ON SERVER: Stripping happens at the backend/API level before sending to clients.
 *    Zero reliance on frontend UI hiding or CSS.
 */

export interface DeliveryRiderOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  customerName: string;
  contactPhone: string;
  deliveryAddress: {
    addressLine: string;
    landmark?: string;
    lat?: number;
    lng?: number;
  } | string;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  deliveryInstructions?: string;
  pickupInfo: {
    branchName: string;
    branchAddress: string;
    branchPhone: string;
  };
  status: string;
  timing: {
    acceptedAt?: string;
    preparingAt?: string;
    readyAt?: string;
    estimatedReadyAt?: string;
    riderAssignedAt?: string;
    pickedUpAt?: string;
    outForDeliveryAt?: string;
    deliveredAt?: string;
  };
  items: Array<{
    name: string;
    quantity: number;
    size?: string;
    crust?: string;
  }>;
  updatedAt: string;
  version?: number;
}

export interface RestaurantManagerOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  branchId: string;
  branchName: string;
  customerName: string;
  contactPhone: string;
  deliveryAddress: any;
  fulfillmentType: string;
  deliveryType: string;
  items: Array<{
    menuItemId?: string;
    name: string;
    price: number;
    quantity: number;
    size?: string;
    variant?: string;
    crust?: string;
    addons?: any[];
    notes?: string;
  }>;
  subtotal: number;
  discountAmount: number;
  couponCode?: string | null;
  packagingCharge: number;
  deliveryFee: number;
  taxes: number;
  cgst?: number;
  sgst?: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  riderAssignment: {
    deliveryPartnerId: string | null;
    deliveryPartnerName: string | null;
    deliveryPartnerPhone: string | null;
    riderAssignmentStatus: string;
    riderAssignedAt?: string;
  };
  timing: {
    createdAt: string;
    acceptedAt?: string;
    preparingAt?: string;
    readyAt?: string;
    estimatedReadyAt?: string;
    pickedUpAt?: string;
    outForDeliveryAt?: string;
    deliveredAt?: string;
    cancelledAt?: string;
  };
  notes?: string;
  expectedReadyAt?: string;
  estimatedPreparationMinutes?: number;
  updatedAt: string;
}

export interface POSOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  billNumber?: string;
  permanentBillNo?: number;
  terminalId?: string;
  cashierName?: string;
  branchId: string;
  tableNumber?: string | null;
  orderSource: string;
  fulfillmentType: string;
  customerName: string;
  contactPhone: string;
  customerPhone?: string;
  deliveryAddress?: any;
  items: Array<{
    menuItemId?: string;
    name: string;
    price: number;
    quantity: number;
    size?: string;
    crust?: string;
    addons?: any[];
  }>;
  subtotal: number;
  discountAmount: number;
  couponCode?: string | null;
  taxes: number;
  taxAmount?: number;
  cgst?: number;
  sgst?: number;
  deliveryFee: number;
  packagingCharge: number;
  totalAmount: number;
  finalTotal?: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  permanentBillNo?: number;
  billNumber?: string;
  billReference?: string;
  orderSource?: string;
  status: string;
  items: Array<{
    id?: string;
    menuItemId?: string;
    name: string;
    price: number;
    quantity: number;
    size?: string;
    variant?: string;
    crust?: string;
    addons?: any[];
    image?: string;
  }>;
  subtotal: number;
  discountAmount: number;
  couponCode?: string | null;
  taxes: number;
  deliveryFee: number;
  packagingCharge: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  fulfillmentType: string;
  deliveryAddress: any;
  deliveryPartner?: {
    name: string;
    phone: string;
    liveLocation?: { lat: number; lng: number };
  } | null;
  timing: {
    createdAt: string;
    acceptedAt?: string;
    preparingAt?: string;
    readyAt?: string;
    estimatedReadyAt?: string;
    outForDeliveryAt?: string;
    deliveredAt?: string;
  };
  updatedAt: string;
}

export interface FranchiseManagerOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  branchId: string;
  branchName?: string;
  franchiseId: string;
  orderSource: string;
  fulfillmentType: string;
  customerName: string;
  contactPhone: string;
  deliveryAddress?: any;
  itemsCount: number;
  subtotal: number;
  discountAmount: number;
  taxes: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OwnerOrderProjection {
  id: string;
  orderNumber: string;
  dailyOrderNumber?: number;
  permanentBillNo?: number;
  billNumber?: string;
  branchId: string;
  branchName?: string;
  franchiseId?: string;
  userId?: string;
  customerName: string;
  contactPhone: string;
  customerEmail?: string;
  deliveryAddress?: any;
  orderSource: string;
  fulfillmentType: string;
  deliveryType: string;
  items: any[];
  subtotal: number;
  discountAmount: number;
  couponCode?: string | null;
  packagingCharge: number;
  deliveryFee: number;
  taxes: number;
  cgst?: number;
  sgst?: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  status: string;
  deliveryPartnerId?: string | null;
  deliveryPartnerName?: string | null;
  deliveryPartnerPhone?: string | null;
  riderAssignmentStatus?: string;
  timing: {
    createdAt: string;
    acceptedAt?: string;
    preparingAt?: string;
    readyAt?: string;
    estimatedReadyAt?: string;
    partnerAssignedAt?: string;
    riderAssignedAt?: string;
    pickedUpAt?: string;
    outForDeliveryAt?: string;
    deliveredAt?: string;
    cancelledAt?: string;
  };
  cancellationReason?: string;
  cancellationSource?: string;
  cancellationExplanation?: string;
  updatedAt: string;
}

export class OrderProjectionService {
  /**
   * Helper: formats date/timestamp safely to ISO string
   */
  private static toIsoString(val: any, fallback: string = new Date().toISOString()): string {
    if (!val) return fallback;
    if (typeof val === 'string') return val;
    if (val.toDate && typeof val.toDate === 'function') return val.toDate().toISOString();
    if (val._seconds) return new Date(val._seconds * 1000).toISOString();
    if (val instanceof Date) return val.toISOString();
    return fallback;
  }

  /**
   * 1. Delivery Rider Data Projection
   * Strictly minimizes order data to what is required to complete delivery.
   * NEVER exposes customer email, customer profile history, profit margins, or payment secrets.
   */
  public static projectForDeliveryRider(order: any, id?: string): DeliveryRiderOrderProjection {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    const branchName = order.branchName || 'Olive Pizza — Rajnandgaon HQ';
    const branchAddress = order.branchAddress || 'Dongargaon Rd, near Saraswati school, Rajnandgaon, CG 491441';
    const branchPhone = order.branchPhone || '+91 91799 44445';

    // Minimal item summary (handover verification only; no pricing secrets or margins)
    const items = Array.isArray(order.items)
      ? order.items.map((i: any) => ({
          name: String(i.name || i.productName || 'Artisan Pizza'),
          quantity: Number(i.quantity || 1),
          size: i.size || i.variant || undefined,
          crust: i.crust || undefined,
        }))
      : [];

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      customerName: order.customerName || order.userName || order.deliveryAddress?.customerName || 'Customer',
      contactPhone: order.contactPhone || order.phone || order.deliveryAddress?.phone || 'N/A',
      deliveryAddress: order.deliveryAddress || 'Delivery Address',
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      paymentStatus: (order.paymentStatus || 'PENDING').toUpperCase(),
      paymentMethod: (order.paymentMethod || 'COD').toUpperCase(),
      deliveryInstructions: order.deliveryInstructions || order.notes || order.deliveryAddress?.notes || undefined,
      pickupInfo: {
        branchName,
        branchAddress,
        branchPhone,
      },
      status: (order.status || 'partner_assigned').toLowerCase(),
      timing: {
        acceptedAt: order.acceptedAt ? this.toIsoString(order.acceptedAt) : undefined,
        preparingAt: order.preparingAt ? this.toIsoString(order.preparingAt) : undefined,
        readyAt: order.readyAt ? this.toIsoString(order.readyAt) : undefined,
        estimatedReadyAt: order.estimatedReadyAt || order.expectedReadyAt ? this.toIsoString(order.estimatedReadyAt || order.expectedReadyAt) : undefined,
        riderAssignedAt: order.riderAssignedAt || order.partnerAssignedAt ? this.toIsoString(order.riderAssignedAt || order.partnerAssignedAt) : undefined,
        pickedUpAt: order.pickedUpAt ? this.toIsoString(order.pickedUpAt) : undefined,
        outForDeliveryAt: order.outForDeliveryAt ? this.toIsoString(order.outForDeliveryAt) : undefined,
        deliveredAt: order.deliveredAt ? this.toIsoString(order.deliveredAt) : undefined,
      },
      items,
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
      version: order.notification_version || 1,
    };
  }

  /**
   * 2. Restaurant Management Data Projection
   * Data required for kitchen preparation, packing, and dispatch.
   * Strictly branch-scoped; excludes customer passwords, auth tokens, and unrelated franchise data.
   */
  public static projectForRestaurantManager(order: any, id?: string): RestaurantManagerOrderProjection {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    const items = Array.isArray(order.items)
      ? order.items.map((i: any) => ({
          menuItemId: i.menuItemId || i.id || i.productId,
          name: String(i.name || i.productName || 'Pizza Item'),
          price: Number(i.price || 0),
          quantity: Number(i.quantity || 1),
          size: i.size || i.variant || 'Regular',
          variant: i.variant || i.size || 'Regular',
          crust: i.crust || 'Classic Hand Tossed',
          addons: Array.isArray(i.addons) ? i.addons : [],
          notes: i.notes || undefined,
        }))
      : [];

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      branchId: order.branchId || 'main_branch',
      branchName: order.branchName || 'Olive Pizza — Rajnandgaon HQ',
      customerName: order.customerName || order.userName || order.deliveryAddress?.customerName || 'Customer',
      contactPhone: order.contactPhone || order.phone || order.deliveryAddress?.phone || 'N/A',
      deliveryAddress: order.deliveryAddress || null,
      fulfillmentType: (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase(),
      deliveryType: (order.deliveryType || order.fulfillmentType || 'delivery').toLowerCase(),
      items,
      subtotal: Number(order.subtotal || order.totalAmount || 0),
      discountAmount: Number(order.discountAmount || 0),
      couponCode: order.couponCode || order.appliedCouponCode || null,
      packagingCharge: Number(order.packagingCharge || 0),
      deliveryFee: Number(order.deliveryFee || 0),
      taxes: Number(order.taxes || 0),
      cgst: order.cgst !== undefined ? Number(order.cgst) : undefined,
      sgst: order.sgst !== undefined ? Number(order.sgst) : undefined,
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      paymentMethod: (order.paymentMethod || 'COD').toUpperCase(),
      paymentStatus: (order.paymentStatus || 'PENDING').toUpperCase(),
      status: (order.status || 'pending').toLowerCase(),
      riderAssignment: {
        deliveryPartnerId: order.deliveryPartnerId || null,
        deliveryPartnerName: order.deliveryPartnerName || null,
        deliveryPartnerPhone: order.deliveryPartnerPhone || null,
        riderAssignmentStatus: order.riderAssignmentStatus || (order.deliveryPartnerId ? 'assigned' : 'unassigned'),
        riderAssignedAt: order.riderAssignedAt || order.partnerAssignedAt ? this.toIsoString(order.riderAssignedAt || order.partnerAssignedAt) : undefined,
      },
      timing: {
        createdAt: this.toIsoString(order.createdAt, nowIso),
        acceptedAt: order.acceptedAt ? this.toIsoString(order.acceptedAt) : undefined,
        preparingAt: order.preparingAt ? this.toIsoString(order.preparingAt) : undefined,
        readyAt: order.readyAt ? this.toIsoString(order.readyAt) : undefined,
        estimatedReadyAt: order.estimatedReadyAt || order.expectedReadyAt ? this.toIsoString(order.estimatedReadyAt || order.expectedReadyAt) : undefined,
        pickedUpAt: order.pickedUpAt ? this.toIsoString(order.pickedUpAt) : undefined,
        outForDeliveryAt: order.outForDeliveryAt ? this.toIsoString(order.outForDeliveryAt) : undefined,
        deliveredAt: order.deliveredAt ? this.toIsoString(order.deliveredAt) : undefined,
        cancelledAt: order.cancelledAt ? this.toIsoString(order.cancelledAt) : undefined,
      },
      notes: order.deliveryInstructions || order.notes || undefined,
      expectedReadyAt: order.expectedReadyAt || order.estimatedReadyAt ? this.toIsoString(order.expectedReadyAt || order.estimatedReadyAt) : undefined,
      estimatedPreparationMinutes: order.estimatedPreparationMinutes ? Number(order.estimatedPreparationMinutes) : undefined,
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
    };
  }

  /**
   * 3. POS Data Projection
   * Data required for physical/online billing, receipt printing, and payment reconciliation.
   */
  public static projectForPOS(order: any, id?: string): POSOrderProjection {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    const items = Array.isArray(order.items)
      ? order.items.map((i: any) => ({
          menuItemId: i.menuItemId || i.id,
          name: String(i.name || i.productName || 'Pizza'),
          price: Number(i.price || 0),
          quantity: Number(i.quantity || 1),
          size: i.size || i.variant || 'Regular',
          crust: i.crust || 'Classic Hand Tossed',
          addons: Array.isArray(i.addons) ? i.addons : [],
        }))
      : [];

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      billNumber: order.billNumber || (order.permanentBillNo ? `#${order.permanentBillNo}` : undefined),
      permanentBillNo: order.permanentBillNo ? Number(order.permanentBillNo) : undefined,
      terminalId: order.terminalId || 'POS-TERM-01',
      cashierName: order.cashierName || 'Cashier',
      branchId: order.branchId || 'main_branch',
      tableNumber: order.tableNumber || null,
      orderSource: order.orderSource || (order.deliveryType ? 'ONLINE' : 'POS_DINE_IN'),
      fulfillmentType: (order.fulfillmentType || order.deliveryType || 'dine_in').toLowerCase(),
      customerName: order.customerName || order.userName || 'Walk-in Customer',
      contactPhone: order.contactPhone || order.customerPhone || order.phone || 'N/A',
      customerPhone: order.customerPhone || order.contactPhone || order.phone || 'N/A',
      deliveryAddress: order.deliveryAddress || null,
      items,
      subtotal: Number(order.subtotal || order.totalAmount || 0),
      discountAmount: Number(order.discountAmount || 0),
      couponCode: order.couponCode || null,
      taxes: Number(order.taxes || order.taxAmount || 0),
      taxAmount: Number(order.taxAmount || order.taxes || 0),
      cgst: order.cgst !== undefined ? Number(order.cgst) : undefined,
      sgst: order.sgst !== undefined ? Number(order.sgst) : undefined,
      deliveryFee: Number(order.deliveryFee || 0),
      packagingCharge: Number(order.packagingCharge || 0),
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      finalTotal: Number(order.finalTotal || order.totalAmount || 0),
      paymentMethod: (order.paymentMethod || 'CASH').toUpperCase(),
      paymentStatus: (order.paymentStatus || 'PAID').toUpperCase(),
      status: (order.status || 'completed').toLowerCase(),
      createdAt: this.toIsoString(order.createdAt, nowIso),
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
    };
  }

  /**
   * 4. Customer Data Projection
   * Customers receive ONLY their own orders.
   * Strips internal notes, kitchen audit logs, rider private details, and franchise margins.
   */
  public static projectForCustomer(order: any, callerUid: string, id?: string): CustomerOrderProjection | null {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    // Strict ownership: customer can only access their own order
    if (order.userId && order.userId !== callerUid) {
      return null;
    }

    const items = Array.isArray(order.items)
      ? order.items.map((i: any) => ({
          id: i.id || i.menuItemId,
          menuItemId: i.menuItemId || i.id,
          name: String(i.name || i.productName || 'Artisan Pizza'),
          price: Number(i.price || 0),
          quantity: Number(i.quantity || 1),
          size: i.size || i.variant || 'Regular',
          variant: i.variant || i.size || 'Regular',
          crust: i.crust || 'Classic Hand Tossed',
          addons: Array.isArray(i.addons) ? i.addons : [],
          image: i.image || i.imageUrl || undefined,
        }))
      : [];

    // Rider contact info only exposed when active delivery is in progress
    const isDeliveryActive = ['out_for_delivery', 'picked_up'].includes((order.status || '').toLowerCase());
    const deliveryPartner = (isDeliveryActive && order.deliveryPartnerName) ? {
      name: order.deliveryPartnerName,
      phone: order.deliveryPartnerPhone || '+91 91799 44445',
      liveLocation: order.driverLocation ? {
        lat: Number(order.driverLocation.lat || order.driverLocation.latitude),
        lng: Number(order.driverLocation.lng || order.driverLocation.longitude),
      } : undefined,
    } : null;

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      permanentBillNo: order.permanentBillNo ? Number(order.permanentBillNo) : undefined,
      billNumber: order.billNumber || (order.permanentBillNo ? `#${order.permanentBillNo}` : undefined),
      billReference: order.billReference || orderId,
      orderSource: order.orderSource || 'ONLINE',
      status: (order.status || 'pending').toLowerCase(),
      items,
      subtotal: Number(order.subtotal || order.totalAmount || 0),
      discountAmount: Number(order.discountAmount || 0),
      couponCode: order.couponCode || order.appliedCouponCode || null,
      taxes: Number(order.taxes || 0),
      deliveryFee: Number(order.deliveryFee || 0),
      packagingCharge: Number(order.packagingCharge || 0),
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      paymentMethod: (order.paymentMethod || 'COD').toUpperCase(),
      paymentStatus: (order.paymentStatus || 'PENDING').toUpperCase(),
      fulfillmentType: (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase(),
      deliveryAddress: order.deliveryAddress || null,
      deliveryPartner,
      timing: {
        createdAt: this.toIsoString(order.createdAt, nowIso),
        acceptedAt: order.acceptedAt ? this.toIsoString(order.acceptedAt) : undefined,
        preparingAt: order.preparingAt ? this.toIsoString(order.preparingAt) : undefined,
        readyAt: order.readyAt ? this.toIsoString(order.readyAt) : undefined,
        estimatedReadyAt: order.estimatedReadyAt || order.expectedReadyAt ? this.toIsoString(order.estimatedReadyAt || order.expectedReadyAt) : undefined,
        outForDeliveryAt: order.outForDeliveryAt ? this.toIsoString(order.outForDeliveryAt) : undefined,
        deliveredAt: order.deliveredAt ? this.toIsoString(order.deliveredAt) : undefined,
      },
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
    };
  }

  /**
   * 5. Franchise Manager Data Projection
   * Scoped strictly to the franchise's branch records.
   * Strips cross-franchise records and customer private auth fields.
   */
  public static projectForFranchiseManager(order: any, id?: string): FranchiseManagerOrderProjection {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      branchId: order.branchId || 'main_branch',
      branchName: order.branchName || 'Branch',
      franchiseId: order.franchiseId || 'fra_primary',
      orderSource: order.orderSource || (order.deliveryType ? 'ONLINE' : 'POS_DINE_IN'),
      fulfillmentType: (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase(),
      customerName: order.customerName || order.userName || 'Customer',
      contactPhone: order.contactPhone || order.phone || 'N/A',
      deliveryAddress: order.deliveryAddress || null,
      itemsCount: Array.isArray(order.items) ? order.items.reduce((acc: number, item: any) => acc + Number(item.quantity || 1), 0) : 0,
      subtotal: Number(order.subtotal || order.totalAmount || 0),
      discountAmount: Number(order.discountAmount || 0),
      taxes: Number(order.taxes || 0),
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      paymentMethod: (order.paymentMethod || 'COD').toUpperCase(),
      paymentStatus: (order.paymentStatus || 'PENDING').toUpperCase(),
      status: (order.status || 'pending').toLowerCase(),
      createdAt: this.toIsoString(order.createdAt, nowIso),
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
    };
  }

  /**
   * 6. Owner Data Projection
   * Cross-branch operational surveillance view (strictly read-only for operational transitions).
   * Strips payment gateway secret keys and customer password hashes.
   */
  public static projectForOwner(order: any, id?: string): OwnerOrderProjection {
    const orderId = id || order.id || order.orderId || '';
    const nowIso = new Date().toISOString();

    return {
      id: orderId,
      orderNumber: order.orderNumber || `#${orderId.slice(0, 6).toUpperCase()}`,
      dailyOrderNumber: order.dailyOrderNumber,
      permanentBillNo: order.permanentBillNo ? Number(order.permanentBillNo) : undefined,
      billNumber: order.billNumber || (order.permanentBillNo ? `#${order.permanentBillNo}` : undefined),
      branchId: order.branchId || 'main_branch',
      branchName: order.branchName || 'Olive Pizza — Rajnandgaon HQ',
      franchiseId: order.franchiseId || 'fra_primary',
      userId: order.userId,
      customerName: order.customerName || order.userName || order.deliveryAddress?.customerName || 'Customer',
      contactPhone: order.contactPhone || order.phone || order.deliveryAddress?.phone || 'N/A',
      customerEmail: order.customerEmail || order.userEmail || undefined,
      deliveryAddress: order.deliveryAddress || null,
      orderSource: order.orderSource || (order.deliveryType ? 'ONLINE' : 'POS_DINE_IN'),
      fulfillmentType: (order.fulfillmentType || order.deliveryType || 'delivery').toLowerCase(),
      deliveryType: (order.deliveryType || order.fulfillmentType || 'delivery').toLowerCase(),
      items: Array.isArray(order.items) ? order.items : [],
      subtotal: Number(order.subtotal || order.totalAmount || 0),
      discountAmount: Number(order.discountAmount || 0),
      couponCode: order.couponCode || order.appliedCouponCode || null,
      packagingCharge: Number(order.packagingCharge || 0),
      deliveryFee: Number(order.deliveryFee || 0),
      taxes: Number(order.taxes || 0),
      cgst: order.cgst !== undefined ? Number(order.cgst) : undefined,
      sgst: order.sgst !== undefined ? Number(order.sgst) : undefined,
      totalAmount: Number(order.totalAmount || order.finalTotal || 0),
      paymentMethod: (order.paymentMethod || 'COD').toUpperCase(),
      paymentStatus: (order.paymentStatus || 'PENDING').toUpperCase(),
      status: (order.status || 'pending').toLowerCase(),
      deliveryPartnerId: order.deliveryPartnerId || null,
      deliveryPartnerName: order.deliveryPartnerName || null,
      deliveryPartnerPhone: order.deliveryPartnerPhone || null,
      riderAssignmentStatus: order.riderAssignmentStatus || (order.deliveryPartnerId ? 'assigned' : 'unassigned'),
      timing: {
        createdAt: this.toIsoString(order.createdAt, nowIso),
        acceptedAt: order.acceptedAt ? this.toIsoString(order.acceptedAt) : undefined,
        preparingAt: order.preparingAt ? this.toIsoString(order.preparingAt) : undefined,
        readyAt: order.readyAt ? this.toIsoString(order.readyAt) : undefined,
        estimatedReadyAt: order.estimatedReadyAt || order.expectedReadyAt ? this.toIsoString(order.estimatedReadyAt || order.expectedReadyAt) : undefined,
        partnerAssignedAt: order.partnerAssignedAt ? this.toIsoString(order.partnerAssignedAt) : undefined,
        riderAssignedAt: order.riderAssignedAt || order.partnerAssignedAt ? this.toIsoString(order.riderAssignedAt || order.partnerAssignedAt) : undefined,
        pickedUpAt: order.pickedUpAt ? this.toIsoString(order.pickedUpAt) : undefined,
        outForDeliveryAt: order.outForDeliveryAt ? this.toIsoString(order.outForDeliveryAt) : undefined,
        deliveredAt: order.deliveredAt ? this.toIsoString(order.deliveredAt) : undefined,
        cancelledAt: order.cancelledAt ? this.toIsoString(order.cancelledAt) : undefined,
      },
      cancellationReason: order.cancellationReason,
      cancellationSource: order.cancellationSource,
      cancellationExplanation: order.cancellationExplanation,
      updatedAt: this.toIsoString(order.updatedAt, nowIso),
    };
  }

  /**
   * 7. Role-Based Dispatcher
   * Automatically projects any canonical order record to the caller's authorized schema.
   */
  public static projectByRole(order: any, user: { uid?: string; role?: string; email?: string } | undefined): any {
    const role = (user?.role || 'customer').toLowerCase();
    const emailLower = (user?.email || '').toLowerCase();
    const isMasterOwner = emailLower === 'olivepizzarjn@gmail.com' || emailLower === 'webhub2811@gmail.com';

    if (role === 'owner' || isMasterOwner || role === 'developer' || role === 'admin' || role === 'platform_owner') {
      return this.projectForOwner(order);
    }
    if (role === 'restaurant_manager' || role === 'manager' || role === 'kitchen_staff') {
      return this.projectForRestaurantManager(order);
    }
    if (role === 'delivery_partner' || role === 'delivery') {
      return this.projectForDeliveryRider(order);
    }
    if (role === 'cashier') {
      return this.projectForPOS(order);
    }
    if (role === 'franchise_manager' || role === 'franchise_owner') {
      return this.projectForFranchiseManager(order);
    }

    // Default: Customer
    return this.projectForCustomer(order, user?.uid || '');
  }
}
