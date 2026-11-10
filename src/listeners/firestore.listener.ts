/**
 * Firestore Listener — uses Firebase Admin SDK (bypasses security rules)
 * This is the SINGLE SOURCE OF TRUTH for all order notifications.
 */
import { adminDb as db } from '../config/firebase.js';
import { pgPool } from '../config/postgres.js';
import { notificationQueue } from '../services/notification/NotificationQueueService.js';

import { OwnerTemplates, CustomerTemplates, DeliveryTemplates, RestaurantTemplates } from '../services/notification/NotificationTemplates.js';
import { queueEmail } from '../services/email.service.js';
import { buildOrderStatusEmail } from '../services/emailTemplates.service.js';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { appEventBus } from '../services/eventBus/AppEventBus.js';

export class FirestoreListener {
  private static readonly serverBootTime = Date.now();
  private static orderStatusCache = new Map<string, string>();
  private static processedOrderIds = new Set<string>();

  // Cleanup processedOrderIds every 30 min to prevent unbounded memory growth.
  // On Render, server rarely runs >24h without a deploy, but belt-and-suspenders.
  private static cleanupTimer = setInterval(() => {
    const beforeSize = FirestoreListener.processedOrderIds.size;
    FirestoreListener.processedOrderIds.clear();
    if (beforeSize > 0) {
      console.log(`[FirestoreListener] Cleared ${beforeSize} processed order IDs from dedup cache`);
    }
  }, 30 * 60 * 1000);

  public static markOrderProcessed(orderId: string): void {
    FirestoreListener.processedOrderIds.add(orderId);
  }

  public static isOrderProcessed(orderId: string): boolean {
    return FirestoreListener.processedOrderIds.has(orderId);
  }

  static async init() {
    try {
      await this.hydrateActiveOrdersCache();
      this.listenToOrders();
      this.listenToActivityLogs();
      console.log('🎧 Firestore Listeners (Admin SDK) initialized for Unified Notifications.');
    } catch (err: any) {
      console.error('❌ Failed to initialize Firestore Listeners:', err.message || err);
    }
  }

  /**
   * Fix 4: Hydrate all active (non-terminal) orders into orderStatusCache at startup
   */
  private static async hydrateActiveOrdersCache() {
    try {
      const activeSnap = await db.collection('orders')
        .where('status', 'not-in', ['delivered', 'completed', 'cancelled'])
        .get();
      activeSnap.docs.forEach((doc: any) => {
        this.orderStatusCache.set(doc.id, doc.data()?.status);
        this.processedOrderIds.add(doc.id);
      });
      console.log(`[FirestoreListener] Hydrated ${activeSnap.size} active order statuses into cache.`);
    } catch (err: any) {
      console.warn('[FirestoreListener] Active orders cache hydration notice:', err.message);
    }
  }

  /**
   * Fix 1: Unified Owner Recipient Resolution (Postgres fcm_tokens + Firestore users)
   */
  private static async getOwnerRecipients(): Promise<string[]> {
    try {
      return await notificationEngine.resolveByRole('owner');
    } catch (err: any) {
      console.error('[FirestoreListener] Error resolving owner recipients:', err.message);
      return [];
    }
  }

  private static isInitialOrdersLoad = true;

  private static listenToOrders() {
    this.isInitialOrdersLoad = true;
    db.collection('orders').onSnapshot(
      async (snapshot: any) => {
        // Initial snapshot baseline hydration: prevents false notifications on server startup/redeploy
        if (this.isInitialOrdersLoad) {
          this.isInitialOrdersLoad = false;
          console.log(`[FirestoreListener] Initial orders snapshot received (${snapshot.size} orders). Establishing baseline cache without replaying alerts.`);
          for (const doc of snapshot.docs) {
            const data = doc.data() || {};
            this.orderStatusCache.set(doc.id, data.status);
            this.processedOrderIds.add(doc.id);
          }
          return;
        }

        for (const change of snapshot.docChanges()) {
          const orderData = { id: change.doc.id, ...change.doc.data() } as any;

          // ── SYNTHETIC / TEST ORDER SAFEGUARD ──────────────────────────────────
          // Strictly drop test/mock/synthetic orders from alerting restaurant staff or riders
          const isSynthetic = 
            orderData.id.startsWith('test_') ||
            orderData.id.startsWith('mock_') ||
            orderData.id.startsWith('synthetic_') ||
            orderData.id.startsWith('dummy_') ||
            orderData.id.startsWith('online_test_') ||
            orderData.id.startsWith('ord_test_') ||
            (orderData.customerName && /^(test|mock|synthetic|dummy|fake|archival test|idempotency test)/i.test(orderData.customerName)) ||
            (orderData.orderSource && /test|mock|synthetic/i.test(orderData.orderSource)) ||
            (orderData.orderNumber && /test/i.test(String(orderData.orderNumber))) ||
            orderData.isTest === true ||
            orderData.isMock === true;

          if (isSynthetic) {
            console.warn(`[FirestoreListener] Safeguard: Dropping synthetic/test order ${orderData.id}. Suppressing alarms, FCM pushes, and rider assignments.`);
            this.orderStatusCache.set(orderData.id, orderData.status);
            this.processedOrderIds.add(orderData.id);
            continue;
          }

          // ── NEW ORDER ────────────────────────────────────────────────────────
          if (change.type === 'added') {
            let createdAt: Date = new Date(0);
            if (orderData.createdAt) {
              if (typeof orderData.createdAt?.toDate === 'function') {
                createdAt = orderData.createdAt.toDate();
              } else if (typeof orderData.createdAt === 'string' || typeof orderData.createdAt === 'number') {
                createdAt = new Date(orderData.createdAt);
              } else if (orderData.createdAt instanceof Date) {
                createdAt = orderData.createdAt;
              } else if (orderData.createdAt?._seconds) {
                createdAt = new Date(orderData.createdAt._seconds * 1000);
              }
            } else if (orderData.created_at) {
              if (typeof orderData.created_at?.toDate === 'function') {
                createdAt = orderData.created_at.toDate();
              } else if (typeof orderData.created_at === 'string' || typeof orderData.created_at === 'number') {
                createdAt = new Date(orderData.created_at);
              } else if (orderData.created_at?._seconds) {
                createdAt = new Date(orderData.created_at._seconds * 1000);
              }
            }
            if (isNaN(createdAt.getTime())) {
              createdAt = new Date(0);
            }

            // ALWAYS set status cache for state tracking, even for historical orders
            this.orderStatusCache.set(orderData.id, orderData.status);

            // Skip trigger push alarms for terminal or old orders (server restart replay protection)
            if (createdAt.getTime() <= FirestoreListener.serverBootTime) {
              this.processedOrderIds.add(orderData.id);
              continue;
            }
            if (Date.now() - createdAt.getTime() > 10 * 60 * 1000) {
              this.processedOrderIds.add(orderData.id);
              continue;
            }
            
            // Only genuinely new, pending orders trigger kitchen alarms (never partner_assigned, ready, delivered, etc.)
            const normStatus = (orderData.status || '').toLowerCase().trim();
            if (!['pending', 'placed', 'pending_acceptance'].includes(normStatus)) {
              this.processedOrderIds.add(orderData.id);
              continue;
            }
            
            // Prevent duplicate triggers if already processed or dispatched by authoritative order creation
            if (orderData.notificationDispatched || this.processedOrderIds.has(orderData.id) || FirestoreListener.isOrderProcessed(orderData.id)) {
              this.processedOrderIds.add(orderData.id);
              continue;
            }
            this.processedOrderIds.add(orderData.id);

            const shortId = orderData.id.slice(-6).toUpperCase();
            const orderNumber = orderData.dailyOrderNumber
              ? `#${orderData.dailyOrderNumber}`
              : (orderData.dailyOrderNumber || orderData.daily_order_number || `OP-${shortId}`);
            const totalAmount = Number(orderData.totalAmount || orderData.total_amount || 0);
            
            console.log(`🍕 New order: ${orderNumber} — triggering Unified Pipeline`);

            if (orderData.orderTiming === 'scheduled') continue; // Skip push alarms for scheduled until ready

            // 1. FCM PUSH NOTIFICATION FOR NEW ORDER (STRICTLY SCOPED RESTAURANT ALARM & CUSTOMER CONFIRMATION)
            (async () => {
              try {
                const branchId = (orderData.branchId || '').trim();
                const franchiseId = (orderData.franchiseId || '').trim();
                if (!branchId) {
                  console.warn(`[FirestoreListener] Order ${orderData.id} missing authoritative branchId; skipping alarm dispatch.`);
                  return;
                }
                const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId || orderData.user_id;

                // Dispatch strictly via NotificationRouter (enforces franchise & branch isolation; never leaks to owner or delivery)
                const { NotificationRouter } = await import('../services/notification/NotificationRouter.js');
                await NotificationRouter.routeOrderEvent({
                  orderId: orderData.id,
                  orderNumber,
                  dailyOrderNumber: orderData.dailyOrderNumber || orderData.daily_order_number,
                  permanentBillNo: orderData.permanentBillNo,
                  orderType: orderData.deliveryType || orderData.fulfillmentType || 'delivery',
                  totalAmount,
                  items: Array.isArray(orderData.items) ? orderData.items : [],
                  paymentMethod: orderData.paymentMethod || 'COD',
                  paymentStatus: orderData.paymentStatus || 'PENDING',
                  cashToCollect: orderData.cashToCollect,
                  deliveryAddress: orderData.deliveryAddress,
                  deliveryInstructions: orderData.deliveryInstructions || orderData.instructions,
                  customerNotes: orderData.customerNotes || orderData.notes,
                  lat: orderData.lat,
                  lng: orderData.lng,
                  contactPhone: orderData.contactPhone || orderData.phone,
                  customerName: orderData.customerName || orderData.customer_name || 'Customer',
                  userId: customerUid,
                  franchiseId,
                  branchId,
                  orderTime: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
                  rawOrderData: orderData,
                }, 'RESTAURANT_NEW_ORDER_ALARM');

                // Dispatch Customer Confirmation
                if (customerUid) {
                  const customerPayload = CustomerTemplates.orderUpdate(orderData.id, {
                    orderNumber,
                    status: 'pending',
                    totalAmount,
                  });
                  await notificationEngine.send(customerUid, customerPayload, {
                    eventId: `ORDER_CREATED:customer:${orderData.id}`,
                    orderId: orderData.id,
                    category: 'pinned_live',
                    tag: `order_${orderData.id}`,
                    targetApp: 'customer'
                  });
                }
              } catch (notifErr: any) {
                console.warn('[FirestoreListener] Push notification error on new order:', notifErr.message);
              }
            })();

            // 2. EMAIL TO CUSTOMER & OWNER
            this.sendOrderEmail(orderData, 'pending');

            // 3. SYNC LIVE ORDER TO GOOGLE SHEETS
            import('../services/reports/GoogleSheetsReportService.js').then(({ GoogleSheetsReportService }) => {
              GoogleSheetsReportService.syncOrderToMonthlySheet(orderData).catch(err => {
                console.warn('[FirestoreListener] Google Sheet sync warning:', err.message);
              });
            }).catch(() => {});

            // 4. Emit AppEventBus domain event for WebSocket live updates
            appEventBus.emitTyped('order.created', {
              orderId: orderData.id,
              orderNumber,
              userId: orderData.userId || orderData.firebaseUid || '',
              customerName: orderData.customerName || orderData.customer_name || 'Customer',
              franchiseId: orderData.franchiseId || 'main',
              branchId: orderData.branchId || 'main',
              totalAmount,
              items: Array.isArray(orderData.items) ? orderData.items : [],
              paymentMethod: orderData.paymentMethod || 'COD',
              deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Pickup',
              contactPhone: orderData.contactPhone || '',
              orderTiming: orderData.orderTiming,
              timestamp: new Date().toISOString(),
              rawOrderData: orderData,
            });
          }

          // ── ORDER MODIFIED (STATUS TRANSITION) ────────────────────────────────
          else if (change.type === 'modified') {
            const currentStatus: string = orderData.status;
            const prevStatus = this.orderStatusCache.get(orderData.id);

            if (!currentStatus || currentStatus === prevStatus) continue;
            this.orderStatusCache.set(orderData.id, currentStatus);

            const shortId = orderData.id.slice(-6).toUpperCase();
            const orderNumber = orderData.dailyOrderNumber
              ? `#${orderData.dailyOrderNumber}`
              : (orderData.daily_order_number || `OP-${shortId}`);
            const totalAmount = Number(orderData.totalAmount || orderData.total_amount || 0);

            console.log(`🔄 Order ${orderNumber} Status Transition: ${prevStatus} → ${currentStatus}`);

            type StatusCfg = { emoji: string; label: string; category: 'orders' | 'delivery' };
            const statusConfig: Record<string, StatusCfg> = {
              accepted:         { emoji: '✅', label: 'Order Accepted',            category: 'orders' },
              preparing:        { emoji: '🍳', label: 'Preparing Your Order',      category: 'orders' },
              ready:            { emoji: '🟢', label: 'Order Ready',               category: 'orders' },
              packed:           { emoji: '📦', label: 'Order Packed & Ready',       category: 'orders' },
              partner_assigned: { emoji: '🛵', label: 'Delivery Partner Assigned',  category: 'delivery' },
              picked_up:        { emoji: '📦', label: 'Order Picked Up',            category: 'delivery' },
              out_for_delivery: { emoji: '🚀', label: 'Out for Delivery',           category: 'delivery' },
              delivered:        { emoji: '🎉', label: 'Order Delivered',            category: 'delivery' },
              cancelled:        { emoji: '❌', label: 'Order Cancelled',            category: 'orders' },
              payment_failed:   { emoji: '💳', label: 'Payment Failed',             category: 'orders' },
            };

            const cfg = statusConfig[currentStatus];
            if (!cfg) continue;

            // 1. FCM PUSH NOTIFICATIONS FOR ORDER STATUS UPDATES
            (async () => {
              try {
                const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId || orderData.user_id;
                if (customerUid) {
                  let itemsSummary = '';
                  if (Array.isArray(orderData.items) && orderData.items.length > 0) {
                    itemsSummary = orderData.items.map((i: any) => typeof i === 'string' ? i : `${i.quantity || 1}× ${i.name || 'Item'}`).join(', ');
                  } else if (orderData.itemsSummary) {
                    itemsSummary = String(orderData.itemsSummary);
                  }
                  const stepMap: Record<string, number> = {
                    pending: 1, accepted: 2, preparing: 3, ready: 4, packed: 4, partner_assigned: 5, picked_up: 5, out_for_delivery: 6, delivered: 7, cancelled: 0
                  };
                  const currentStep = stepMap[currentStatus] || 1;
                  const etaMinutes = orderData.estimatedDeliveryMinutes || (orderData.estimatedDeliveryTime ? parseInt(orderData.estimatedDeliveryTime) : 25);

                  const customerPayload = CustomerTemplates.orderUpdate(orderData.id, {
                    orderNumber,
                    status: currentStatus as any,
                    step: currentStep,
                    eta: orderData.estimatedDeliveryTime || `${etaMinutes} mins`,
                    etaMinutes,
                    totalAmount,
                    deliveryPartnerName: orderData.deliveryPartnerName,
                    riderPhone: orderData.deliveryPartnerPhone || orderData.riderPhone,
                    itemsSummary,
                    cancellationReason: orderData.cancellationReason,
                  });
                  await notificationEngine.send(customerUid, customerPayload, {
                    orderId: orderData.id,
                    category: ['delivered', 'cancelled'].includes(currentStatus) ? 'simple_informational' : 'pinned_live',
                    tag: `order_${orderData.id}`,
                    targetApp: 'customer',
                  });

                  // ActivityKit APNs Dispatch
                  try {
                    const activityRes = await pgPool.query(
                      `SELECT token FROM order_activity_tokens WHERE order_id = $1`,
                      [orderData.id]
                    );
                    if (activityRes.rows.length > 0) {
                      const isEnd = currentStatus === 'delivered' || currentStatus === 'cancelled';
                      const livePayload = CustomerTemplates.liveActivityUpdate(orderData.id, {
                        event: isEnd ? 'end' : (currentStatus === 'accepted' ? 'start' : 'update'),
                        status: currentStatus as any,
                        step: currentStep,
                        orderNumber,
                        itemsSummary: itemsSummary || 'Olive Pizza Order',
                        totalAmount,
                        etaMinutes,
                        riderName: orderData.deliveryPartnerName || '',
                        riderPhone: orderData.deliveryPartnerPhone || orderData.riderPhone || '',
                        restaurantName: 'Olive Pizza',
                        dismissalDate: isEnd ? Math.floor(Date.now() / 1000) + 300 : undefined,
                      });

                      const tokens = activityRes.rows.map(r => r.token);
                      await notificationEngine.sendToTokens(tokens, livePayload, {
                        category: 'pinned_live',
                        orderId: orderData.id,
                        targetApp: 'customer',
                      });

                      if (isEnd) {
                        await pgPool.query(`DELETE FROM order_activity_tokens WHERE order_id = $1`, [orderData.id]).catch(() => {});
                      }
                    }
                  } catch (actErr: any) {
                    console.warn('[FirestoreListener] ActivityKit push dispatch warning:', actErr.message);
                  }
                }

                // If partner assigned, notify assigned delivery partner ONLY (strictly delivery role, never owner)
                if (currentStatus === 'partner_assigned' && (orderData.deliveryPartnerId || orderData.delivery_partner_id)) {
                  const partnerId = orderData.deliveryPartnerId || orderData.delivery_partner_id;
                  const { NotificationRouter } = await import('../services/notification/NotificationRouter.js');
                  await NotificationRouter.routeOrderEvent({
                    orderId: orderData.id,
                    orderNumber,
                    dailyOrderNumber: orderData.dailyOrderNumber || orderData.daily_order_number,
                    permanentBillNo: orderData.permanentBillNo,
                    orderType: orderData.deliveryType || orderData.fulfillmentType || 'delivery',
                    totalAmount,
                    items: Array.isArray(orderData.items) ? orderData.items : [],
                    paymentMethod: orderData.paymentMethod || 'COD',
                    paymentStatus: orderData.paymentStatus || 'PENDING',
                    cashToCollect: orderData.cashToCollect,
                    deliveryAddress: orderData.deliveryAddress,
                    deliveryInstructions: orderData.deliveryInstructions || orderData.instructions,
                    customerNotes: orderData.customerNotes || orderData.notes,
                    lat: orderData.lat,
                    lng: orderData.lng,
                    contactPhone: orderData.contactPhone || orderData.phone,
                    customerName: orderData.customerName || orderData.customer_name || 'Customer',
                    deliveryPartnerId: partnerId,
                    franchiseId: (orderData.franchiseId || '').trim(),
                    branchId: (orderData.branchId || '').trim(),
                    orderTime: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
                    rawOrderData: orderData,
                  }, 'DELIVERY_ASSIGNED');
                }

                // If order was delivered, notify the branch restaurant staff with delivery success sound
                if (currentStatus === 'delivered') {
                  const branchId = (orderData.branchId || '').trim();
                  const franchiseId = (orderData.franchiseId || '').trim();
                  if (branchId) {
                    const branchStaff = await notificationEngine.resolveBranchStaff(branchId, franchiseId);
                    if (branchStaff.length > 0) {
                      const deliveredPayload = RestaurantTemplates.orderDelivered(orderData.id, {
                        orderNumber,
                        customerName: orderData.customerName || 'Customer',
                        totalAmount,
                        branchId,
                        franchiseId,
                        riderName: orderData.deliveryPartnerName,
                        deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Delivery Address',
                        deliveredAt: new Date().toISOString(),
                      });
                      await notificationEngine.sendBulk(branchStaff, deliveredPayload, {
                        orderId: orderData.id,
                        category: 'simple_informational',
                        priority: 'high',
                        tag: `order_delivered_${orderData.id}`,
                        targetApp: 'restaurant'
                      });
                    }
                  }
                }
              } catch (notifErr: any) {
                console.warn(`[FirestoreListener] Status change push notification error:`, notifErr.message);
              }
            })();

            // 2. EMAIL FALLBACK / TRANSACTIONAL EMAILS
            this.sendOrderEmail(orderData, currentStatus);

            // 3. SYNC ORDER STATUS UPDATE TO GOOGLE SHEETS
            import('../services/reports/GoogleSheetsReportService.js').then(({ GoogleSheetsReportService }) => {
              GoogleSheetsReportService.syncOrderToMonthlySheet(orderData).catch(err => {
                console.warn('[FirestoreListener] Google Sheet status sync warning:', err.message);
              });
            }).catch(() => {});

            // 4. Emit AppEventBus domain event for WebSocket live updates
            appEventBus.emitTyped('order.status_changed', {
              orderId: orderData.id,
              orderNumber,
              userId: orderData.userId || orderData.firebaseUid || '',
              customerName: orderData.customerName || orderData.customer_name || 'Customer',
              previousStatus: prevStatus || '',
              currentStatus,
              totalAmount,
              deliveryPartnerId: orderData.deliveryPartnerId || orderData.delivery_partner_id,
              deliveryPartnerName: orderData.deliveryPartnerName,
              timestamp: new Date().toISOString(),
              rawOrderData: orderData,
            });

            // 5. Emit granular canonical domain events across the 12 domain states
            const baseDomainEvent = {
              orderId: orderData.id,
              orderNumber,
              permanentBillNo: orderData.permanentBillNo ? Number(orderData.permanentBillNo) : undefined,
              userId: orderData.userId || orderData.firebaseUid || '',
              customerName: orderData.customerName || orderData.customer_name || 'Customer',
              franchiseId: (orderData.franchiseId || '').trim(),
              branchId: (orderData.branchId || '').trim(),
              totalAmount,
              timestamp: new Date().toISOString(),
              rawOrderData: orderData,
            };

            switch (currentStatus) {
              case 'accepted':
                appEventBus.emitTyped('order.accepted', baseDomainEvent);
                break;
              case 'preparing':
                appEventBus.emitTyped('order.preparing', baseDomainEvent);
                break;
              case 'ready':
                appEventBus.emitTyped('order.ready', { ...baseDomainEvent, orderType: (orderData.deliveryType || 'delivery') as any });
                break;
              case 'partner_assigned':
                appEventBus.emitTyped('order.partner_assigned', {
                  ...baseDomainEvent,
                  deliveryPartnerId: orderData.deliveryPartnerId || '',
                  deliveryPartnerName: orderData.deliveryPartnerName || 'Assigned Partner'
                });
                break;
              case 'picked_up':
                appEventBus.emitTyped('order.picked_up', {
                  ...baseDomainEvent,
                  deliveryPartnerId: orderData.deliveryPartnerId || ''
                });
                break;
              case 'out_for_delivery':
                appEventBus.emitTyped('order.out_for_delivery', {
                  ...baseDomainEvent,
                  deliveryPartnerId: orderData.deliveryPartnerId || ''
                });
                break;
              case 'delivered':
              case 'completed':
                appEventBus.emitTyped('order.delivered', {
                  ...baseDomainEvent,
                  deliveredAt: new Date().toISOString()
                });
                break;
              case 'rejected':
                appEventBus.emitTyped('order.rejected', {
                  ...baseDomainEvent,
                  reason: orderData.rejectionReason || 'Order rejected',
                  rejectedBy: orderData.rejectedBy || 'Restaurant Staff'
                });
                break;
              case 'cancelled':
                appEventBus.emitTyped('order.cancelled', {
                  ...baseDomainEvent,
                  reason: orderData.cancellationReason || 'Order cancelled',
                  cancelledBy: orderData.cancelledBy || 'User'
                });
                break;
            }
          }
        }
      },
      (error: any) => {
        console.error('❌ Order snapshot listener error:', error.message);
      }
    );
  }

  private static async sendOrderEmail(orderData: any, status: string) {
    try {
      const customerUid = orderData.customerUid || orderData.firebaseUid || orderData.customerId || orderData.userId || orderData.user_id;
      let email = orderData.customerEmail || orderData.email || orderData.contactEmail;
      let customerData: any = null;
      
      if (customerUid) {
        const customerDoc = await db.collection('users').doc(customerUid).get();
        if (customerDoc.exists) {
          customerData = customerDoc.data();
          if (!email) email = customerData?.email;
        }
      }
      if (!email) return;

      const shortId = orderData.id.slice(-6).toUpperCase();
      const orderNumber = orderData.dailyOrderNumber || orderData.daily_order_number || `OP-${shortId}`;
      const totalAmount = Number(orderData.totalAmount || orderData.total_amount || 0);

      let subject = '';
      switch (status) {
        case 'pending':
          subject = `Order Placed — #${orderNumber}`;
          break;
        case 'accepted':
          subject = `Order Accepted — #${orderNumber}`;
          break;
        case 'cancelled':
          subject = `Order Cancelled — #${orderNumber}`;
          break;
        case 'delivered':
          subject = `Order Delivered — #${orderNumber}`;
          break;
        default:
          return; // Don't email for every minor step like preparing
      }

      const fullOrderData = {
        items: Array.isArray(orderData.items) ? orderData.items : [],
        subtotal: totalAmount, total_amount: totalAmount,
        deliveryAddress: orderData.deliveryAddress?.addressLine || orderData.deliveryAddress || 'Pickup',
        customerName: orderData.customerName || customerData?.name || 'Customer',
        contactPhone: orderData.contactPhone || customerData?.phone,
        paymentMethod: orderData.paymentMethod || 'COD',
      };

      const htmlBody = buildOrderStatusEmail({
        customerName: fullOrderData.customerName, subject, stage: status as any, orderId: orderData.id,
        data: { orderNumber, totalAmount: String(totalAmount), paymentMethod: fullOrderData.paymentMethod, deliveryAddress: fullOrderData.deliveryAddress },
        orderData: fullOrderData
      });

      // 1. Send Customer Email to customer's registered email account
      await queueEmail(email, subject, htmlBody, 'transactional');
      console.log(`[Email] Customer order email queued for ${email} (Stage: ${status})`);
    } catch (e) {
      console.warn('❌ Email dispatch failed:', e);
    }
  }

  private static listenToActivityLogs() {
    let initialLoad = true;
    db.collection('activity_logs').orderBy('timestamp', 'desc').limit(20).onSnapshot((snapshot: any) => {
      if (initialLoad) { initialLoad = false; return; }
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue;
        const data = change.doc.data() as any;
        const action: string = data.action || '';
        let category: 'security' | 'inventory' | 'support' | 'general' = 'general';
        if (/security|login|permission|admin/i.test(action)) category = 'security';
        else if (/stock|inventory|product/i.test(action)) category = 'inventory';
        else if (/customer|support|ticket/i.test(action)) category = 'support';
      }
    });
  }
}
