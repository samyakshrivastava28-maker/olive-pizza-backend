/**
 * WebSocketServer — Real-Time In-App Updates & Live GPS Tracking
 *
 * Only for users who are ACTIVELY using the application.
 * FCM handles background/killed-app notifications.
 *
 * Use cases:
 *  - 500ms Live driver location streaming (Customer Live Track + Owner Fleet Map)
 *  - Live order status updates in FloatingTracker
 *  - Live order created alerts for Owner Dashboard
 *  - Delivery dashboard live orders
 *  - FloatingCart badge updates
 */

import { WebSocketServer as WSSNative, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { appEventBus, OrderStatusChangedEvent, OrderCreatedEvent } from '../eventBus/AppEventBus.js';
import { adminAuth, adminDb } from '../../config/firebase.js';
import { sanitizeError } from '../../utils/logSanitizer.js';
import { redisEventBusBridge } from '../eventBus/RedisEventBusBridge.js';
import { query } from '../../lib/db.js';
import { verifyTrackingToken } from '../../utils/trackingToken.js';

export interface AuthoritativeUserInfo {
  role: string;
  branchId?: string;
  franchiseId?: string;
}

async function resolveAuthoritativeUserInfo(uid: string, tokenClaims?: any): Promise<AuthoritativeUserInfo> {
  let role = tokenClaims?.role || 'customer';
  let branchId = tokenClaims?.branchId || tokenClaims?.branch_id;
  let franchiseId = tokenClaims?.franchiseId || tokenClaims?.franchise_id;

  try {
    const userDoc = await adminDb.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      if (data?.role) role = data.role;
      if (data?.branchId) branchId = data.branchId;
      if (data?.franchiseId) franchiseId = data.franchiseId;
    }
    const dpDoc = await adminDb.collection('delivery_partners').doc(uid).get();
    if (dpDoc.exists && dpDoc.data()?.isActive !== false) {
      role = 'delivery_partner';
      if (dpDoc.data()?.branchId) branchId = dpDoc.data()?.branchId;
    }
  } catch (err) {
    console.warn('[WebSocketServer] Failed to resolve user info for', uid, err);
  }
  return { role, branchId, franchiseId };
}

export interface ConnectedClient {
  ws: WebSocket;
  uid: string;
  role?: string;
  branchId?: string;
  franchiseId?: string;
  terminalId?: string;
  connectedAt: number;
  lastSeenSeq?: number;
  subscribedOrders: Set<string>;
}

export interface BranchRingBufferEvent {
  seq: number;
  eventId: string;
  type: string;
  timestamp: string;
  data: any;
}

export interface DriverLocationData {
  deliveryPartnerId: string;
  orderId?: string | null;
  lat: number;
  lng: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  battery?: number;
  isMoving?: boolean;
  timestamp: string | number;
  status?: 'ONLINE' | 'OFFLINE' | 'STALE' | 'DELIVERING';
}

class OliveWebSocketServer {
  private wss: WSSNative | null = null;
  private clients = new Map<string, Set<ConnectedClient>>();
  private orderSubscribers = new Map<string, Set<ConnectedClient>>();
  private driverLocations = new Map<string, DriverLocationData>();
  private totalConnections = 0;
  // Monotonic sequence numbering & ring buffer per branch (franchise:branch -> buffer)
  private branchRingBuffers = new Map<string, { currentSeq: number; events: BranchRingBufferEvent[] }>();

  /**
   * Helper key for branch ring buffer map
   */
  private getBranchKey(franchiseId?: string, branchId?: string): string {
    return `${franchiseId || 'default'}:${branchId || 'main_branch'}`;
  }

  /**
   * Records an event into the branch ring buffer with monotonic sequence number.
   * Buffer retains the last 200 events for reconnection sync.
   */
  public recordBranchEvent(franchiseId: string, branchId: string, type: string, eventId: string, data: any): BranchRingBufferEvent {
    const key = this.getBranchKey(franchiseId, branchId);
    let buf = this.branchRingBuffers.get(key);
    if (!buf) {
      buf = { currentSeq: 0, events: [] };
      this.branchRingBuffers.set(key, buf);
    }

    buf.currentSeq += 1;
    const event: BranchRingBufferEvent = {
      seq: buf.currentSeq,
      eventId: eventId || `${type}_${Date.now()}_${buf.currentSeq}`,
      type,
      timestamp: new Date().toISOString(),
      data
    };

    buf.events.push(event);
    if (buf.events.length > 200) {
      buf.events = buf.events.slice(-200); // Keep last 200 events
    }

    return event;
  }

  /**
   * Retrieve missed events for a client reconnecting with a known lastSequence.
   */
  public getMissedEvents(franchiseId: string, branchId: string, lastSequence: number): { currentSeq: number; missedEvents: BranchRingBufferEvent[] } {
    const key = this.getBranchKey(franchiseId, branchId);
    const buf = this.branchRingBuffers.get(key);
    if (!buf) {
      return { currentSeq: 0, missedEvents: [] };
    }
    const missed = buf.events.filter(e => e.seq > lastSequence);
    return { currentSeq: buf.currentSeq, missedEvents: missed };
  }

  /**
   * Gracefully close the WebSocket server and terminate active connections.
   */
  public close(): void {
    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
      this.wss = null;
    }
  }

  /**
   * Attach to an existing Node.js HTTP server.
   */
  attach(httpServer: any): void {
    if (this.wss) return; // Already attached

    redisEventBusBridge.registerWebSocketServer(this);
    redisEventBusBridge.init().catch((err: any) => {
      console.warn('[WebSocketServer] RedisEventBusBridge notice:', err.message);
    });

    this.wss = new WSSNative({ server: httpServer, path: '/ws' });

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', `ws://${req.headers.host || 'localhost'}`);

      // PHASE 91: Reject tokens in URL query strings to avoid leaking credentials in access logs & proxy histories
      if (url.searchParams.has('token') || url.searchParams.has('idToken') || url.searchParams.has('access_token') || url.searchParams.has('auth')) {
        console.warn('[WebSocketServer] Connection rejected: Token in query string forbidden.');
        ws.close(1008, 'Token in URL query string is forbidden. Use Authorization header or in-band auth message.');
        return;
      }

      // Check Authorization header for handshake auth
      let token: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split('Bearer ')[1].trim();
      }

      const branchIdParam = url.searchParams.get('branchId') || undefined;
      const franchiseIdParam = url.searchParams.get('franchiseId') || undefined;
      const terminalIdParam = url.searchParams.get('terminalId') || undefined;
      let branchId: string | undefined = branchIdParam;
      let franchiseId: string | undefined = franchiseIdParam;
      let uid = 'anonymous';
      let role = 'customer';

      // Verify token if supplied via handshake Authorization header
      if (token) {
        try {
          const decoded = await adminAuth.verifyIdToken(token);
          uid = decoded.uid;
          const info = await resolveAuthoritativeUserInfo(uid, decoded);
          role = info.role;
          branchId = info.branchId || branchIdParam;
          franchiseId = info.franchiseId || franchiseIdParam;
        } catch (tokenErr: any) {
          const safeErr = sanitizeError(tokenErr);
          console.warn('[WebSocketServer] Handshake token verification failed:', safeErr.message);
          uid = 'anonymous';
          role = 'customer';
        }
      } else {
        // If unauthenticated at handshake, default to anonymous customer.
        // Client can authenticate in-band via { type: 'auth', token: '...' } message.
        uid = 'anonymous';
        role = 'customer';
      }

      const client: ConnectedClient = { 
        ws, 
        uid, 
        role,
        branchId,
        franchiseId,
        terminalId: terminalIdParam,
        connectedAt: Date.now(),
        subscribedOrders: new Set<string>()
      };
      this.totalConnections++;

      // Register client
      if (!this.clients.has(uid)) this.clients.set(uid, new Set());
      this.clients.get(uid)!.add(client);

      console.log(`[WebSocketServer] Client connected uid=${uid} role=${role} branch=${client.branchId || 'none'} total=${this.totalConnections}`);

      // Send connection acknowledgment
      this.safeSend(ws, { 
        type: 'connected', 
        data: { 
          uid, 
          role,
          branchId: client.branchId,
          franchiseId: client.franchiseId,
          timestamp: new Date().toISOString(),
          activeDriversCount: this.driverLocations.size
        } 
      });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          
          // 1. Keepalive ping/pong
          if (msg.type === 'ping') {
            this.safeSend(ws, { type: 'pong', data: { timestamp: new Date().toISOString() } });
            return;
          }

          // 2. Post-connect Message-Based Authentication (avoids passing tokens in URL query strings)
          if (msg.type === 'auth' && msg.token) {
            try {
              let authUid = client.uid;
              let authRole = client.role || 'customer';

              const decoded = await adminAuth.verifyIdToken(msg.token);
              authUid = decoded.uid;
              const info = await resolveAuthoritativeUserInfo(authUid, decoded);
              authRole = info.role;

              // Update client registration with verified identity
              const oldSet = this.clients.get(client.uid);
              if (oldSet) oldSet.delete(client);

              client.uid = authUid;
              client.role = authRole;
              client.branchId = info.branchId || msg.branchId || client.branchId;
              client.franchiseId = info.franchiseId || msg.franchiseId || client.franchiseId;
              if (msg.terminalId) client.terminalId = msg.terminalId;

              if (!this.clients.has(authUid)) this.clients.set(authUid, new Set());
              this.clients.get(authUid)!.add(client);

              console.log(`[WebSocketServer] Client authenticated via message: uid=${authUid} role=${authRole} branch=${client.branchId || 'none'}`);
              this.safeSend(ws, {
                type: 'auth_success',
                data: { uid: authUid, role: authRole, branchId: client.branchId, franchiseId: client.franchiseId, timestamp: new Date().toISOString() }
              });
            } catch (err: any) {
              const safeErr = sanitizeError(err);
              console.warn('[WebSocketServer] Message auth failed:', safeErr.message);
              this.safeSend(ws, { type: 'auth_error', data: { message: 'Invalid token' } });
            }
            return;
          }

          // 2b. Branch Registration (allows kitchen/POS terminals to associate with their branch & franchise)
          if (msg.type === 'register_branch') {
            if (!client.uid || client.uid === 'anonymous') {
              this.safeSend(ws, { type: 'error', data: { message: 'Authentication required to register branch' } });
              return;
            }

            const userRole = (client.role || 'customer').toLowerCase();
            const isPrivileged = ['owner', 'admin', 'developer'].includes(userRole);
            const isAuthorizedStaff = ['restaurant_manager', 'branch_manager', 'pos', 'cashier', 'kitchen_staff'].includes(userRole);

            if (!isPrivileged && !isAuthorizedStaff) {
              this.safeSend(ws, { type: 'error', data: { message: 'Forbidden: role not authorized to register branch' } });
              return;
            }

            if (isPrivileged) {
              if (msg.branchId) client.branchId = msg.branchId;
              if (msg.franchiseId) client.franchiseId = msg.franchiseId;
            } else if (client.branchId) {
              if (msg.branchId && msg.branchId !== client.branchId) {
                this.safeSend(ws, { type: 'error', data: { message: 'Cannot register for unassigned branch' } });
                return;
              }
            } else {
              client.branchId = msg.branchId;
            }
            if (msg.terminalId) client.terminalId = msg.terminalId;

            this.safeSend(ws, {
              type: 'register_branch_success',
              data: {
                branchId: client.branchId,
                franchiseId: client.franchiseId,
                terminalId: client.terminalId,
                timestamp: new Date().toISOString()
              }
            });
            return;
          }

          // 2c. Monotonic Sequence Synchronization on Reconnect (Resilience against slow / dropped Wi-Fi)
          if (msg.type === 'sync_request') {
            if (!client.uid || client.uid === 'anonymous') {
              this.safeSend(ws, { type: 'error', data: { message: 'Authentication required for sync_request' } });
              return;
            }

            const userRole = (client.role || 'customer').toLowerCase();
            const isPrivileged = ['owner', 'admin', 'developer'].includes(userRole);
            const isAuthorizedStaff = ['restaurant_manager', 'branch_manager', 'pos', 'cashier', 'kitchen_staff'].includes(userRole);

            if (!isPrivileged && !isAuthorizedStaff) {
              this.safeSend(ws, { type: 'error', data: { message: 'Forbidden: sync_request only permitted for branch operations' } });
              return;
            }

            const branchId = isPrivileged ? (msg.branchId || client.branchId || 'main_branch') : (client.branchId || 'main_branch');
            const franchiseId = isPrivileged ? (msg.franchiseId || client.franchiseId || 'default') : (client.franchiseId || 'default');
            const lastSeq = typeof msg.lastSequence === 'number' ? msg.lastSequence : 0;
            const { currentSeq, missedEvents } = this.getMissedEvents(franchiseId, branchId, lastSeq);
            client.lastSeenSeq = currentSeq;

            this.safeSend(ws, {
              type: 'sync_response',
              data: {
                branchId,
                franchiseId,
                currentSeq,
                missedEvents,
                count: missedEvents.length,
                timestamp: new Date().toISOString()
              }
            });
            return;
          }

          // 3. Subscribe to specific order updates
          if (msg.type === 'subscribe_order' && msg.orderId) {
            const orderId = String(msg.orderId).trim();
            const rawTrackingToken = msg.trackingToken ? String(msg.trackingToken).trim() : null;
            const hasValidTrackingToken = rawTrackingToken ? verifyTrackingToken(rawTrackingToken) === orderId : false;

            if ((!client.uid || client.uid === 'anonymous') && !hasValidTrackingToken) {
              this.safeSend(ws, { type: 'error', data: { message: 'Authentication or valid tracking token required to subscribe to order updates' } });
              return;
            }

            try {
              const orderDoc = await adminDb.collection('orders').doc(orderId).get();
              if (!orderDoc.exists) {
                this.safeSend(ws, { type: 'error', data: { message: 'Order not found', orderId } });
                return;
              }
              const orderData = orderDoc.data() || {};
              const userRole = (client.role || 'customer').toLowerCase();
              const isPrivileged = ['owner', 'admin', 'developer'].includes(userRole);
              const isStaff = ['restaurant_manager', 'branch_manager', 'cashier', 'kitchen_staff'].includes(userRole);
              const isAssignedDriver = ['delivery_partner', 'rider', 'delivery'].includes(userRole) &&
                (orderData.deliveryPartnerId === client.uid || orderData.assignedDeliveryPartnerId === client.uid);
              const isOrderOwner = (
                orderData.userId === client.uid || 
                orderData.customerUid === client.uid || 
                orderData.customerId === client.uid
              );
              const isBranchStaff = isStaff && Boolean(client.branchId && client.branchId === orderData.branchId);

              if (!isPrivileged && !isOrderOwner && !isBranchStaff && !isAssignedDriver && !hasValidTrackingToken) {
                this.safeSend(ws, { type: 'error', data: { message: 'Forbidden: You do not have access to this order', orderId } });
                return;
              }

              client.subscribedOrders.add(orderId);
              if (!this.orderSubscribers.has(orderId)) {
                this.orderSubscribers.set(orderId, new Set());
              }
              this.orderSubscribers.get(orderId)!.add(client);
              this.safeSend(ws, { type: 'subscribed', data: { orderId } });
            } catch (err: any) {
              this.safeSend(ws, { type: 'error', data: { message: 'Failed to subscribe to order', error: err.message } });
            }
            return;
          }

          // 4. Unsubscribe from order
          if (msg.type === 'unsubscribe_order' && msg.orderId) {
            client.subscribedOrders.delete(msg.orderId);
            const set = this.orderSubscribers.get(msg.orderId);
            if (set) {
              set.delete(client);
              if (set.size === 0) this.orderSubscribers.delete(msg.orderId);
            }
            return;
          }

          // 5. Driver GPS location update (500ms streaming from delivery app)
          if (msg.type === 'driver_location' && msg.data) {
            const allowedDriverRoles = ['delivery_partner', 'delivery', 'rider', 'owner', 'admin', 'developer'];
            if (!client.role || !allowedDriverRoles.includes(client.role) || !client.uid || client.uid === 'anonymous') {
              this.safeSend(ws, { type: 'error', data: { message: 'Unauthorized location publisher' } });
              return;
            }

            const targetOrderId = msg.data.orderId ? String(msg.data.orderId).trim() : null;
            let verifiedOrderId: string | null = null;

            if (targetOrderId) {
              try {
                const orderDoc = await adminDb.collection('orders').doc(targetOrderId).get();
                if (orderDoc.exists) {
                  const oData = orderDoc.data() || {};
                  const isAssigned = (oData.deliveryPartnerId === client.uid || oData.assignedDeliveryPartnerId === client.uid);
                  const isPrivileged = ['owner', 'admin', 'developer'].includes(client.role);
                  const status = String(oData.status || '').toUpperCase();
                  const isActiveStage = ['OUT_FOR_DELIVERY', 'PICKED_UP', 'IN_TRANSIT'].includes(status);

                  if ((isAssigned || isPrivileged) && isActiveStage) {
                    verifiedOrderId = targetOrderId;
                  } else {
                    console.warn(`[WebSocketServer] Driver location discarded for order ${targetOrderId}: assigned=${isAssigned}, stage=${status}`);
                  }
                }
              } catch (e: any) {
                console.warn(`[WebSocketServer] Failed to verify order for driver location:`, e.message);
              }
            }

            const loc: DriverLocationData = {
              ...msg.data,
              orderId: verifiedOrderId,
              deliveryPartnerId: client.uid,
              timestamp: Date.now()
            };
            this.driverLocations.set(client.uid, loc);

            // Broadcast to any clients watching this driver's verified order
            if (verifiedOrderId) {
              this.broadcastToOrder(verifiedOrderId, {
                type: 'driver_location',
                data: loc
              });
            }

            // Also broadcast to fleet watchers (owners/managers)
            this.broadcastToRole('owner', {
              type: 'fleet_location_update',
              data: loc
            });
            this.broadcastToRole('restaurant_manager', {
              type: 'fleet_location_update',
              data: loc
            });
            return;
          }

        } catch (parseErr) {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.totalConnections = Math.max(0, this.totalConnections - 1);
        
        // Remove from user client map
        const userSet = this.clients.get(client.uid);
        if (userSet) {
          userSet.delete(client);
          if (userSet.size === 0) this.clients.delete(client.uid);
        }

        // Remove from order subscriptions
        for (const orderId of client.subscribedOrders) {
          const orderSet = this.orderSubscribers.get(orderId);
          if (orderSet) {
            orderSet.delete(client);
            if (orderSet.size === 0) this.orderSubscribers.delete(orderId);
          }
        }

        console.log(`[WebSocketServer] Client disconnected uid=${client.uid} total=${this.totalConnections}`);
      });

      ws.on('error', (err) => {
        console.error(`[WebSocketServer] WS error uid=${client.uid}:`, err.message);
      });
    });

    this.wss.on('error', (err) => {
      console.error('[WebSocketServer] Server error:', err.message);
    });

    // Subscribe to AppEventBus to broadcast live updates
    appEventBus.on('order.status_changed', (event: OrderStatusChangedEvent) => {
      // 1. Broadcast to user directly
      this.broadcastToUser(event.userId, {
        type: 'order.status_changed',
        data: {
          orderId: event.orderId,
          orderNumber: event.orderNumber,
          status: event.currentStatus,
          previousStatus: event.previousStatus,
          deliveryPartnerName: event.deliveryPartnerName,
          timestamp: event.timestamp,
        },
      });

      // 2. Broadcast to all clients watching this order channel
      this.broadcastToOrder(event.orderId, {
        type: 'order.status_changed',
        data: {
          orderId: event.orderId,
          orderNumber: event.orderNumber,
          status: event.currentStatus,
          previousStatus: event.previousStatus,
          deliveryPartnerName: event.deliveryPartnerName,
          timestamp: event.timestamp,
        },
      });
    });

    appEventBus.on('order.created', (event: OrderCreatedEvent) => {
      const raw = event.rawOrderData || {};
      const branchId = raw.branchId || raw.branch_id || 'main_branch';
      const franchiseId = raw.franchiseId || raw.franchise_id || 'default';

      console.log('[NOTIFICATION_ROUTED]', {
        event: 'order.created',
        orderId: event.orderId,
        franchiseId,
        branchId,
        targetRoles: ['restaurant', 'manager', 'restaurant_manager', 'pos']
      });

      const items = Array.isArray(raw.items) && raw.items.length > 0 ? raw.items : (event.items || []);
      const formattedItems = items.map((it: any) => ({
        name: it.name || it.title || 'Item',
        quantity: Number(it.quantity || 1),
        size: it.size || it.selectedSize || undefined,
        crust: it.crust || it.selectedCrust || undefined,
        addOns: Array.isArray(it.addOns || it.addons) ? (it.addOns || it.addons).map((a: any) => typeof a === 'string' ? a : a.name) : [],
        price: Number(it.price || it.unitPrice || 0),
        totalPrice: Number(it.totalItemPrice || it.totalPrice || ((it.price || 0) * (it.quantity || 1)))
      }));

      const pricing = {
        subtotal: Number(raw.subtotal || raw.subTotal || 0),
        packagingFee: Number(raw.packagingFee || raw.packaging_fee || 0),
        deliveryFee: Number(raw.deliveryFee || raw.delivery_fee || 0),
        tax: Number(raw.tax || raw.taxAmount || raw.tax_amount || 0),
        discount: Number(raw.discount || raw.discountAmount || raw.discount_amount || 0),
        total: Number(raw.finalTotal || raw.totalAmount || raw.total_amount || event.totalAmount || 0)
      };

      const isPaid = (raw.paymentStatus || raw.payment_status || '').toUpperCase() === 'PAID' ||
                     (raw.paymentMethod || '').toUpperCase() === 'PAID' ||
                     ((raw.paymentMethod || '').toUpperCase() !== 'COD' && (raw.paymentStatus || '').toUpperCase() === 'SUCCESS');
      const cashToCollect = isPaid ? 0 : pricing.total;

      const customer = {
        name: event.customerName || raw.customerName || 'Customer',
        phone: event.contactPhone || raw.customerPhone || raw.contactPhone || '',
        address: typeof raw.deliveryAddress === 'string' ? raw.deliveryAddress : (raw.deliveryAddress?.addressLine || event.deliveryAddress || 'Pickup'),
        instructions: raw.deliveryInstructions || raw.customerNotes || raw.notes || raw.instructions || '',
        lat: raw.deliveryAddress?.coordinates?.lat || raw.lat || undefined,
        lng: raw.deliveryAddress?.coordinates?.lng || raw.lng || undefined
      };

      const fullOrderPayload = {
        orderId: event.orderId,
        orderNumber: event.orderNumber,
        franchiseId,
        branchId,
        orderType: raw.orderType || raw.order_type || 'delivery',
        customer,
        items: formattedItems,
        pricing,
        payment: {
          method: event.paymentMethod || raw.paymentMethod || 'COD',
          status: isPaid ? 'PAID' : 'PENDING',
          cashToCollect
        },
        timing: event.orderTiming || raw.orderTiming || 'ASAP',
        timestamp: event.timestamp,
        actions: {
          acceptUrl: `/api/orders/${event.orderId}/accept`,
          rejectUrl: `/api/orders/${event.orderId}/reject`,
          acknowledgeUrl: `/api/orders/${event.orderId}/acknowledge`,
          openLocationUrl: customer.lat && customer.lng ? `https://www.google.com/maps/search/?api=1&query=${customer.lat},${customer.lng}` : undefined
        }
      };

      // 1. Sequenced, ring-buffered broadcast to targeted branch & supervisors
      this.broadcastToBranch(franchiseId, branchId, {
        type: 'order.created',
        eventId: `order_${event.orderId}`,
        data: fullOrderPayload
      });

      // 2. Legacy backwards-compatible role broadcasts
      this.broadcastToRole('restaurant', { type: 'order.created', data: fullOrderPayload });
      this.broadcastToRole('manager', { type: 'order.created', data: fullOrderPayload });
      this.broadcastToRole('restaurant_manager', { type: 'order.created', data: fullOrderPayload });
      this.broadcastToRole('pos', { type: 'order.created', data: fullOrderPayload });
    });

    console.log('[WebSocketServer] Attached to HTTP server on path /ws');
  }

  /**
   * Processes a live location update from a driver.
   */
  public handleDriverLocationUpdate(data: DriverLocationData, fromRemote = false): void {
    if (!data || !data.deliveryPartnerId || data.lat === undefined || data.lng === undefined) {
      return;
    }

    const normalizedData: DriverLocationData = {
      deliveryPartnerId: data.deliveryPartnerId,
      orderId: data.orderId || null,
      lat: Number(data.lat),
      lng: Number(data.lng),
      accuracy: data.accuracy ? Number(data.accuracy) : 5,
      speed: data.speed !== undefined ? Number(data.speed) : 0,
      heading: data.heading !== undefined ? Number(data.heading) : 0,
      battery: data.battery !== undefined ? Number(data.battery) : 100,
      isMoving: data.isMoving !== undefined ? Boolean(data.isMoving) : (Number(data.speed || 0) > 1),
      timestamp: data.timestamp || new Date().toISOString(),
      status: 'ONLINE'
    };

    // Cache latest location in memory
    this.driverLocations.set(data.deliveryPartnerId, normalizedData);

    const broadcastMsg = {
      type: 'driver.location_update',
      data: normalizedData
    };

    // 1. If assigned to an active order, broadcast to all clients subscribed to that order (Customer tracking)
    if (normalizedData.orderId) {
      this.broadcastToOrder(normalizedData.orderId, broadcastMsg, true);
    }

    // 2. Scoped broadcast for real-time fleet map (Branch/Franchise isolation)
    const driverFranchise = (data as any).franchiseId;
    const driverBranch = (data as any).branchId;
    if (driverFranchise && driverBranch) {
      this.broadcastToBranch(driverFranchise, driverBranch, {
        type: 'driver.location_update',
        data: normalizedData
      }, true);
    } else {
      this.broadcastToRole('owner', broadcastMsg, true);
      this.broadcastToRole('admin', broadcastMsg, true);
    }

    // Inter-node cluster distribution
    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('driverLocationUpdate', { payload: data }).catch(() => {});
    }
  }

  /**
   * Broadcast to all clients subscribed to a specific order ID.
   */
  public broadcastToOrder(orderId: string, message: object, fromRemote = false): void {
    const subs = this.orderSubscribers.get(orderId);
    if (subs && subs.size > 0) {
      const payload = JSON.stringify(message);
      for (const client of subs) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }

    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('broadcastToOrder', { targetOrderId: orderId, payload: message }).catch(() => {});
    }
  }

  /**
   * Send a message to all WebSocket connections for a specific Firebase UID.
   */
  broadcastToUser(uid: string, message: object, fromRemote = false): void {
    const userClients = this.clients.get(uid);
    if (userClients && userClients.size > 0) {
      const payload = JSON.stringify(message);
      for (const client of userClients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }

    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('broadcastToUser', { targetUserId: uid, payload: message }).catch(() => {});
    }
  }

  /**
   * Broadcast to all users with a specific role (for targeted operational dashboards).
   */
  broadcastToRole(role: string, message: object, fromRemote = false): void {
    const payload = JSON.stringify(message);
    for (const userClients of this.clients.values()) {
      for (const client of userClients) {
        if (client.role === role && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(payload);
        }
      }
    }

    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('broadcastToRole', { targetRole: role, payload: message }).catch(() => {});
    }
  }

  /**
   * Broadcast to all users in a specific branch & franchise, plus global supervisors.
   * Employs the branch ring buffer to guarantee monotonic sequence numbering.
   */
  broadcastToBranch(franchiseId: string, branchId: string, message: { type: string; data: any; eventId?: string }, fromRemote = false): BranchRingBufferEvent {
    const ringEvent = this.recordBranchEvent(franchiseId, branchId, message.type, message.eventId || '', message.data);
    const envelope = {
      type: message.type,
      seq: ringEvent.seq,
      eventId: ringEvent.eventId,
      timestamp: ringEvent.timestamp,
      branchId,
      franchiseId,
      data: message.data
    };
    const payload = JSON.stringify(envelope);

    for (const userClients of this.clients.values()) {
      for (const client of userClients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;

        // Direct branch match
        const isBranchMatch = (!client.branchId || client.branchId === branchId) &&
                             (!client.franchiseId || client.franchiseId === franchiseId);

        // Supervisors (Owner / Admin / Developer) get all branches ONLY IF they are platform-wide (no franchiseId attached)
        const isSupervisor = (client.role === 'owner' || client.role === 'admin' || client.role === 'developer') && !client.franchiseId;

        // Franchise manager or franchise owner gets their franchise
        const isFranchiseManager = (client.role === 'franchise_manager' || client.role === 'franchise_owner' || client.role === 'owner') && 
                                   client.franchiseId === franchiseId;

        if (isBranchMatch || isSupervisor || isFranchiseManager) {
          client.lastSeenSeq = ringEvent.seq;
          client.ws.send(payload);
        }
      }
    }

    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('broadcastToBranch', { franchiseId, branchId, payload: message }).catch(() => {});
    }

    return ringEvent;
  }

  /**
   * Broadcast to ALL connected clients.
   */
  broadcastToAll(message: object, fromRemote = false): void {
    if (this.wss) {
      const payload = JSON.stringify(message);
      for (const userClients of this.clients.values()) {
        for (const client of userClients) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(payload);
          }
        }
      }
    }

    if (!fromRemote) {
      redisEventBusBridge.publishWsBroadcast('broadcastToAll', { payload: message }).catch(() => {});
    }
  }

  /**
   * Returns all active cached driver locations with offline detection (>30s stale check)
   */
  getActiveDriverLocations(): DriverLocationData[] {
    const now = Date.now();
    const result: DriverLocationData[] = [];

    for (const [id, loc] of this.driverLocations.entries()) {
      const locTime = typeof loc.timestamp === 'number' ? loc.timestamp : new Date(loc.timestamp).getTime();
      const isStale = (now - locTime) > 30000; // > 30 seconds without GPS signal

      result.push({
        ...loc,
        status: isStale ? 'STALE' : 'ONLINE'
      });
    }

    return result;
  }

  /**
   * Statistics for diagnostics overlay.
   */
  stats(): { totalConnections: number; uniqueUsers: number; activeDrivers: number; activeOrdersWatched: number } {
    return {
      totalConnections: this.totalConnections,
      uniqueUsers: this.clients.size,
      activeDrivers: this.driverLocations.size,
      activeOrdersWatched: this.orderSubscribers.size,
    };
  }

  private safeSend(ws: WebSocket, data: object): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    } catch {
      // Ignore send errors
    }
  }
}

export const webSocketServer = new OliveWebSocketServer();

