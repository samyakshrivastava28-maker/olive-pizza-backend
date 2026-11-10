/**
 * AppEventBus — Lightweight In-Memory Backend Event Bus
 *
 * Decouples domain events from notification, email, analytics, and accounting consumers.
 * Routes and services emit events here instead of calling notification or reporting code directly.
 * 
 * Supports all 12 canonical domain events without Kafka or microservice overhead.
 */

import { EventEmitter } from 'events';

export enum DomainEventType {
  ORDER_CREATED = 'order.created',
  ORDER_ACCEPTED = 'order.accepted',
  ORDER_PREPARING = 'order.preparing',
  ORDER_READY = 'order.ready',
  ORDER_PARTNER_ASSIGNED = 'order.partner_assigned',
  ORDER_PICKED_UP = 'order.picked_up',
  ORDER_OUT_FOR_DELIVERY = 'order.out_for_delivery',
  ORDER_DELIVERED = 'order.delivered',
  ORDER_REJECTED = 'order.rejected',
  ORDER_CANCELLED = 'order.cancelled',
  PAYMENT_RECEIVED = 'payment.received',
  BILL_GENERATED = 'bill.generated'
}

export interface BaseOrderEvent {
  orderId: string;
  orderNumber: string;
  permanentBillNo?: number;
  userId: string;
  customerName: string;
  franchiseId?: string;
  branchId?: string;
  totalAmount: number;
  timestamp: string;
  rawOrderData?: any;
}

export interface OrderCreatedEvent extends BaseOrderEvent {
  items: any[];
  paymentMethod: string;
  deliveryAddress: string;
  contactPhone: string;
  orderTiming?: string;
  orderSource?: string;
}

export interface OrderAcceptedEvent extends BaseOrderEvent {
  prepTimeMinutes?: number;
  acceptedBy?: string;
}

export interface OrderPreparingEvent extends BaseOrderEvent {
  kitchenStaffId?: string;
}

export interface OrderReadyEvent extends BaseOrderEvent {
  orderType: 'delivery' | 'pickup' | 'dine_in';
}

export interface OrderPartnerAssignedEvent extends BaseOrderEvent {
  deliveryPartnerId: string;
  deliveryPartnerName: string;
  deliveryPartnerPhone?: string;
}

export interface OrderPickedUpEvent extends BaseOrderEvent {
  deliveryPartnerId: string;
}

export interface OrderOutForDeliveryEvent extends BaseOrderEvent {
  deliveryPartnerId: string;
  etaMinutes?: number;
}

export interface OrderDeliveredEvent extends BaseOrderEvent {
  deliveryPartnerId?: string;
  deliveredAt: string;
}

export interface OrderRejectedEvent extends BaseOrderEvent {
  reason: string;
  rejectedBy: string;
}

export interface OrderCancelledEvent extends BaseOrderEvent {
  reason: string;
  cancelledBy: string;
  refundInitiated?: boolean;
}

export interface PaymentReceivedEvent {
  paymentId: string;
  orderId: string;
  permanentBillNo?: number;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
  franchiseId: string;
  branchId: string;
  timestamp: string;
}

export interface BillGeneratedEvent {
  billNumber: number;
  billFormattedNumber: string;
  orderId: string;
  source: 'ONLINE' | 'POS';
  franchiseId: string;
  branchId: string;
  terminalId?: string;
  totalAmount: number;
  paymentMethod: string;
  timestamp: string;
}

// Backward-compatible generic status event
export interface OrderStatusChangedEvent {
  orderId: string;
  orderNumber: string;
  userId: string;
  customerName: string;
  previousStatus: string;
  currentStatus: string;
  totalAmount: number;
  deliveryPartnerId?: string;
  deliveryPartnerName?: string;
  timestamp: string;
  rawOrderData?: any;
}

export interface DomainEventMap {
  'order.created': OrderCreatedEvent;
  'order.accepted': OrderAcceptedEvent;
  'order.preparing': OrderPreparingEvent;
  'order.ready': OrderReadyEvent;
  'order.partner_assigned': OrderPartnerAssignedEvent;
  'order.picked_up': OrderPickedUpEvent;
  'order.out_for_delivery': OrderOutForDeliveryEvent;
  'order.delivered': OrderDeliveredEvent;
  'order.rejected': OrderRejectedEvent;
  'order.cancelled': OrderCancelledEvent;
  'payment.received': PaymentReceivedEvent;
  'bill.generated': BillGeneratedEvent;
  'order.status_changed': OrderStatusChangedEvent;
}

// Backward compatibility alias
export type OrderEventMap = DomainEventMap;

class AppEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // High limit for multi-subscriber event architecture
    console.log('[AppEventBus] Initialized — 12 canonical domain events supported');
  }

  /** Type-safe emit for all canonical domain events */
  emitTyped<K extends keyof DomainEventMap>(event: K, data: DomainEventMap[K]): boolean {
    return this.emit(event, data);
  }

  /** Type-safe subscription for all canonical domain events */
  onTyped<K extends keyof DomainEventMap>(event: K, handler: (data: DomainEventMap[K]) => void): this {
    return this.on(event, handler);
  }
}

export const appEventBus = new AppEventBus();
