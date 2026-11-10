import * as grpc from '@grpc/grpc-js';
import { adminDb } from '../../config/firebase.ts';
import { query } from '../../config/postgres.ts';
import { OrderStateMachine } from '../../services/order/OrderStateMachine.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { withAuth } from '../authInterceptor.ts';

function formatItem(it: any): any {
  return {
    id: it.id || it.menuItemId || '',
    name: it.name || it.item_name || it.productName || 'Pizza',
    quantity: Number(it.quantity || 1),
    price: Number(it.price || it.unit_price || 0),
    line_total: Number(it.lineTotal || it.line_total || 0),
    size: it.size || it.size_variant || 'Regular',
    crust: it.crust || 'Normal',
  };
}

export class OrderGrpcService {
  public static register(server: grpc.Server): void {
    const proto = loadProtoDefinition('order/v1/order.proto') as any;
    const serviceDef = proto.olivepizza.order.v1.OrderService.service;

    server.addService(serviceDef, {
      ValidateOrderTransition: withAuth(OrderGrpcService.validateOrderTransition),
      validateOrderTransition: withAuth(OrderGrpcService.validateOrderTransition),

      GetAuthoritativeOrder: withAuth(OrderGrpcService.getAuthoritativeOrder),
      getAuthoritativeOrder: withAuth(OrderGrpcService.getAuthoritativeOrder),

      UpdatePaymentState: withAuth(OrderGrpcService.updatePaymentState),
      updatePaymentState: withAuth(OrderGrpcService.updatePaymentState),
    });
  }

  public static async validateOrderTransition(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = req.order_id || req.orderId;
    const toStatus = req.to_status || req.toStatus;
    const actorId = req.actor_id || req.actorId || 'system';
    const actorRole = req.actor_role || req.actorRole || 'system';
    const actorName = req.actor_name || req.actorName;
    const branchId = req.branch_id || req.branchId;

    if (!orderId || !toStatus) {
      return callback(null, {
        success: false,
        order_id: orderId || '',
        previous_status: '',
        current_status: '',
        version: 0,
        message: '',
        error: 'order_id and to_status are required parameters',
      });
    }

    let metadata = {};
    const rawMeta = req.metadata_json || req.metadataJson;
    if (rawMeta) {
      try {
        metadata = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta;
      } catch (e) {
        metadata = {};
      }
    }

    try {
      const result = await OrderStateMachine.transition(
        orderId,
        toStatus,
        {
          uid: actorId,
          role: actorRole,
          name: actorName,
          branchId,
        },
        metadata
      );

      return callback(null, {
        success: result.success,
        order_id: result.orderId,
        previous_status: result.previousStatus || '',
        current_status: result.currentStatus || toStatus,
        version: result.version || 1,
        message: result.message || (result.success ? 'Order state transition successful' : ''),
        error: result.error || '',
      });
    } catch (err: any) {
      return callback(null, {
        success: false,
        order_id: orderId,
        previous_status: '',
        current_status: '',
        version: 0,
        message: '',
        error: err?.message || 'Order transition exception',
      });
    }
  }

  public static async getAuthoritativeOrder(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = req.order_id || req.orderId;

    if (!orderId) {
      return callback(null, {
        found: false,
        order_id: '',
        status: '',
        total_amount: 0,
        payment_status: '',
        payment_method: '',
        user_id: '',
        customer_name: '',
        customer_phone: '',
        delivery_address: '',
        branch_id: '',
        franchise_id: '',
        permanent_bill_no: 0,
        daily_order_no: 0,
        items: [],
        raw_json: '',
        error: 'order_id is required',
      });
    }

    try {
      // 1. Check live Firestore
      let snap: any = null;
      try {
        snap = await adminDb.collection('orders').doc(orderId).get();
      } catch (fsErr) {
        // Fallback to PostgreSQL
      }

      if (snap && snap.exists) {
        const d = snap.data()!;
        const rawItems = Array.isArray(d.items) ? d.items : [];
        const address = typeof d.deliveryAddress === 'string'
          ? d.deliveryAddress
          : (d.deliveryAddress?.addressLine || d.deliveryAddress?.fullAddress || '');

        return callback(null, {
          found: true,
          order_id: orderId,
          status: d.status || 'pending',
          total_amount: Number(d.totalAmount || 0),
          payment_status: d.paymentStatus || 'PENDING',
          payment_method: d.paymentMethod || '',
          user_id: d.userId || d.customerId || '',
          customer_name: d.customerName || '',
          customer_phone: d.contactPhone || d.customerPhone || '',
          delivery_address: address,
          branch_id: d.branchId || '',
          franchise_id: d.franchiseId || '',
          permanent_bill_no: Number(d.permanentBillNo || 0),
          daily_order_no: Number(d.dailyOrderNo || 0),
          items: rawItems.map(formatItem),
          raw_json: JSON.stringify(d),
          error: '',
        });
      }

      // 2. Transparent fallback to PostgreSQL
      const pgRes = await query('SELECT * FROM canonical_orders WHERE id = $1', [orderId]).catch(() => ({ rows: [] }));
      if (pgRes.rows && pgRes.rows.length > 0) {
        const row = pgRes.rows[0];
        const itemsRes = await query('SELECT * FROM canonical_order_items WHERE order_id = $1', [orderId]).catch(() => ({ rows: [] }));
        const pgItems = itemsRes.rows || [];

        return callback(null, {
          found: true,
          order_id: orderId,
          status: row.order_status || 'delivered',
          total_amount: Number(row.total_amount || 0),
          payment_status: row.payment_status || 'PAID',
          payment_method: row.payment_method || '',
          user_id: row.customer_id || '',
          customer_name: row.customer_name || '',
          customer_phone: row.customer_phone || '',
          delivery_address: row.delivery_address || '',
          branch_id: row.branch_id || '',
          franchise_id: row.franchise_id || '',
          permanent_bill_no: Number(row.permanent_bill_no || 0),
          daily_order_no: Number(row.daily_order_no || 0),
          items: pgItems.map(formatItem),
          raw_json: JSON.stringify(row),
          error: '',
        });
      }

      return callback(null, {
        found: false,
        order_id: orderId,
        status: '',
        total_amount: 0,
        payment_status: '',
        payment_method: '',
        user_id: '',
        customer_name: '',
        customer_phone: '',
        delivery_address: '',
        branch_id: '',
        franchise_id: '',
        permanent_bill_no: 0,
        daily_order_no: 0,
        items: [],
        raw_json: '',
        error: `Order ${orderId} not found in Firestore or PostgreSQL`,
      });
    } catch (err: any) {
      return callback(null, {
        found: false,
        order_id: orderId,
        status: '',
        total_amount: 0,
        payment_status: '',
        payment_method: '',
        user_id: '',
        customer_name: '',
        customer_phone: '',
        delivery_address: '',
        branch_id: '',
        franchise_id: '',
        permanent_bill_no: 0,
        daily_order_no: 0,
        items: [],
        raw_json: '',
        error: err?.message || 'Lookup failure',
      });
    }
  }

  public static async updatePaymentState(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = req.order_id || req.orderId;
    const paymentStatus = req.payment_status || req.paymentStatus;
    const paymentMethod = req.payment_method || req.paymentMethod;
    const providerPaymentId = req.provider_payment_id || req.providerPaymentId;
    const amountPaid = req.amount_paid != null ? Number(req.amount_paid) : (req.amountPaid != null ? Number(req.amountPaid) : 0);

    if (!orderId || !paymentStatus) {
      return callback(null, {
        success: false,
        order_id: orderId || '',
        payment_status: '',
        error: 'order_id and payment_status are required',
      });
    }

    try {
      // 1. Update Firestore
      await adminDb.collection('orders').doc(orderId).set({
        paymentStatus,
        paymentMethod: paymentMethod || undefined,
        providerPaymentId: providerPaymentId || undefined,
        amountPaid: amountPaid > 0 ? amountPaid : undefined,
        paymentUpdatedAt: new Date().toISOString(),
        updatedAt: new Date(),
      }, { merge: true }).catch(() => {});

      // 2. Update PostgreSQL
      await query(
        `UPDATE canonical_orders SET payment_status = $1, payment_method = COALESCE($2, payment_method), updated_at = NOW() WHERE id = $3`,
        [paymentStatus, paymentMethod || null, orderId]
      ).catch(() => {});

      return callback(null, {
        success: true,
        order_id: orderId,
        payment_status: paymentStatus,
        error: '',
      });
    } catch (err: any) {
      return callback(null, {
        success: false,
        order_id: orderId,
        payment_status: paymentStatus,
        error: err?.message || 'Failed to update payment state',
      });
    }
  }
}
