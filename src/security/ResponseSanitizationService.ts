/**
 * ResponseSanitizationService.ts — Enterprise Data Minimization & Role-Based DTO Serializers
 * Guarantees raw Firestore documents are NEVER returned directly to clients.
 * Filters sensitive fields, administrative secrets, internal notes, and PII based on caller role.
 */

export class ResponseSanitizationService {
  /**
   * Sanitizes customer user profile (never expose password hashes, internal permissions, or admin notes)
   */
  public static toCustomerProfileDTO(raw: any): any {
    if (!raw) return null;
    return {
      uid: raw.uid || raw.id,
      name: raw.name || raw.displayName || '',
      email: raw.email || '',
      phoneNumber: raw.phoneNumber || raw.phone || '',
      role: 'customer',
      location: raw.location || null,
      locations: Array.isArray(raw.locations) ? raw.locations : [],
      defaultLocationId: raw.defaultLocationId || 'location_1',
      locationSetupCompleted: Boolean(raw.locationSetupCompleted),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
  }

  /**
   * Customer Order DTO — customer sees their items, totals, delivery status, and tracking.
   * Internal notes, restaurant margins, delivery partner personal metadata are redacted.
   */
  public static toCustomerOrderDTO(raw: any): any {
    if (!raw) return null;

    // Only expose rider name and phone if order is actively out for delivery
    const isOutForDelivery = ['out_for_delivery', 'picked_up', 'in_transit'].includes(String(raw.status || '').toLowerCase());
    const riderInfo = isOutForDelivery && raw.deliveryPartner
      ? {
          name: raw.deliveryPartner.name || 'Delivery Partner',
          phone: raw.deliveryPartner.phone || raw.deliveryPartner.phoneNumber || ''
        }
      : undefined;

    return {
      id: raw.id,
      orderNumber: raw.orderNumber || raw.id,
      customerId: raw.customerId || raw.userId || raw.firebaseUid,
      status: raw.status || 'placed',
      items: Array.isArray(raw.items)
        ? raw.items.map((i: any) => ({
            id: i.id || i.productId,
            name: i.name || i.title,
            size: i.size,
            crust: i.crust,
            quantity: Number(i.quantity || 1),
            price: Number(i.price || 0),
            totalPrice: Number(i.totalPrice || i.price * (i.quantity || 1)),
            options: i.options || []
          }))
        : [],
      pricing: {
        subtotal: Number(raw.subtotal || raw.pricing?.subtotal || 0),
        tax: Number(raw.tax || raw.pricing?.tax || 0),
        deliveryFee: Number(raw.deliveryFee || raw.pricing?.deliveryFee || 0),
        discount: Number(raw.discount || raw.pricing?.discount || 0),
        total: Number(raw.total || raw.totalAmount || raw.pricing?.total || 0)
      },
      payment: {
        method: raw.paymentMethod || raw.payment?.method || 'cash',
        status: raw.paymentStatus || raw.payment?.status || 'pending'
      },
      deliveryAddress: raw.deliveryAddress || raw.addressLine || '',
      deliveryLocation: raw.location || raw.coordinates || null,
      branchName: raw.branchName || 'Olive Pizza',
      estimatedDeliveryMinutes: raw.estimatedDeliveryMinutes || 35,
      deliveryPartner: riderInfo,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    };
  }

  /**
   * Delivery Partner Order DTO — rider gets delivery address, recipient phone, coordinates, and collection amount.
   * Omits customer email, customer past history, restaurant profit margins.
   */
  public static toDeliveryOrderDTO(raw: any): any {
    if (!raw) return null;
    const isCOD = String(raw.paymentMethod || '').toLowerCase() === 'cod' || String(raw.payment?.method || '').toLowerCase() === 'cash';

    return {
      id: raw.id,
      orderNumber: raw.orderNumber || raw.id,
      status: raw.status || 'ready_for_pickup',
      branchId: raw.branchId,
      branchName: raw.branchName || 'Olive Pizza',
      customerName: raw.customerName || raw.userName || 'Customer',
      deliveryPhone: raw.customerPhone || raw.phone || raw.phoneNumber || '',
      deliveryAddress: raw.deliveryAddress || raw.addressLine || '',
      deliveryLocation: raw.location || raw.coordinates || null,
      deliveryInstructions: raw.deliveryInstructions || '',
      itemsSummary: Array.isArray(raw.items)
        ? raw.items.map((i: any) => ({
            name: i.name || i.title,
            size: i.size,
            quantity: Number(i.quantity || 1)
          }))
        : [],
      paymentMode: isCOD ? 'CASH_ON_DELIVERY' : 'PREPAID',
      amountToCollect: isCOD ? Number(raw.total || raw.totalAmount || 0) : 0,
      createdAt: raw.createdAt
    };
  }

  /**
   * Kitchen Order DTO — kitchen team needs prep instructions, item customizations, and order timer.
   * Omits customer email, customer phone, billing amounts, and delivery addresses.
   */
  public static toKitchenOrderDTO(raw: any): any {
    if (!raw) return null;
    return {
      id: raw.id,
      orderNumber: raw.orderNumber || raw.id,
      orderType: raw.orderType || (raw.tableNumber ? 'dine_in' : 'delivery'),
      tableNumber: raw.tableNumber || null,
      status: raw.status || 'received',
      prepNotes: raw.specialInstructions || raw.notes || '',
      items: Array.isArray(raw.items)
        ? raw.items.map((i: any) => ({
            id: i.id || i.productId,
            name: i.name || i.title,
            size: i.size,
            crust: i.crust,
            quantity: Number(i.quantity || 1),
            toppings: i.toppings || [],
            customizations: i.customizations || ''
          }))
        : [],
      createdAt: raw.createdAt,
      prepTimeMinutes: raw.prepTimeMinutes || 20
    };
  }

  /**
   * POS Order DTO — terminal operator needs itemized billing, customer contact for invoice, and payment status.
   */
  public static toPOSOrderDTO(raw: any): any {
    if (!raw) return null;
    return {
      id: raw.id,
      orderNumber: raw.orderNumber || raw.id,
      terminalId: raw.terminalId,
      branchId: raw.branchId,
      orderType: raw.orderType || 'pos',
      status: raw.status || 'completed',
      customerName: raw.customerName || 'Walk-in Customer',
      customerPhone: raw.customerPhone || raw.phone || '',
      items: Array.isArray(raw.items)
        ? raw.items.map((i: any) => ({
            name: i.name || i.title,
            quantity: Number(i.quantity || 1),
            price: Number(i.price || 0),
            totalPrice: Number(i.totalPrice || i.price * (i.quantity || 1))
          }))
        : [],
      pricing: {
        subtotal: Number(raw.subtotal || 0),
        tax: Number(raw.tax || 0),
        discount: Number(raw.discount || 0),
        total: Number(raw.total || raw.totalAmount || 0)
      },
      payment: {
        method: raw.paymentMethod || 'cash',
        status: raw.paymentStatus || 'paid'
      },
      createdAt: raw.createdAt
    };
  }

  /**
   * Franchise DTO — returns public/operational details, omits administrative secrets if caller is not owner.
   */
  public static toFranchiseDTO(raw: any, isGlobalOwner: boolean = false): any {
    if (!raw) return null;
    const base = {
      id: raw.id,
      name: raw.name || '',
      city: raw.city || '',
      state: raw.state || '',
      status: raw.status || (raw.isActive !== false ? 'active' : 'inactive'),
      isActive: raw.isActive !== false && raw.status !== 'deleted' && raw.status !== 'deactivated' && raw.status !== 'suspended',
      lat: Number(raw.lat ?? raw.coordinates?.lat ?? raw.location?.lat ?? 0),
      lng: Number(raw.lng ?? raw.coordinates?.lng ?? raw.location?.lng ?? 0),
      deliveryRadiusKm: Number(raw.deliveryRadiusKm || raw.maxDeliveryRadiusKm || 15),
      popularLocalities: Array.isArray(raw.popularLocalities) ? raw.popularLocalities : [],
      createdAt: raw.createdAt
    };

    if (isGlobalOwner) {
      return {
        ...base,
        revenueSharePercent: raw.revenueSharePercent,
        ownerEmail: raw.ownerEmail,
        ownerPhone: raw.ownerPhone,
        deletedAt: raw.deletedAt,
        deletionReason: raw.deletionReason,
        suspendedAt: raw.suspendedAt
      };
    }

    return base;
  }
}
