import * as grpc from '@grpc/grpc-js';
import { BaseGrpcClient, ClientOptions, mapGrpcError } from './BaseGrpcClient.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { OrderStateMachine } from '../../services/order/OrderStateMachine.ts';
import { adminDb } from '../../config/firebase.ts';
import { query } from '../../config/postgres.ts';

export interface TransitionRequestDto {
  orderId: string;
  toStatus: string;
  actorId?: string;
  actorRole?: string;
  actorName?: string;
  branchId?: string;
  metadata?: Record<string, any>;
}

export interface TransitionResponseDto {
  success: boolean;
  orderId: string;
  previousStatus: string;
  currentStatus: string;
  version: number;
  message: string;
  error?: string;
}

export interface OrderResponseDto {
  found: boolean;
  orderId: string;
  status: string;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  userId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  branchId: string;
  franchiseId: string;
  permanentBillNo: number;
  dailyOrderNo: number;
  items: any[];
  rawJson?: string;
  error?: string;
}

export interface UpdatePaymentRequestDto {
  orderId: string;
  paymentStatus: string;
  paymentMethod?: string;
  providerPaymentId?: string;
  amountPaid?: number;
}

export class OrderGrpcClient extends BaseGrpcClient {
  private client: any;

  constructor(options: ClientOptions = {}) {
    super(options);
    const proto = loadProtoDefinition('order/v1/order.proto') as any;
    const ServiceConstructor = proto.olivepizza.order.v1.OrderService;
    this.client = new ServiceConstructor(this.endpoint, grpc.credentials.createInsecure());
  }

  public close(): void {
    if (this.client) {
      this.client.close();
    }
  }

  public async validateOrderTransition(
    dto: TransitionRequestDto,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<TransitionResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackValidateTransition(dto);
    }

    const reqPayload = {
      order_id: dto.orderId,
      to_status: dto.toStatus,
      actor_id: dto.actorId || 'system',
      actor_role: dto.actorRole || 'system',
      actor_name: dto.actorName || '',
      branch_id: dto.branchId || '',
      metadata_json: dto.metadata ? JSON.stringify(dto.metadata) : '',
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise<TransitionResponseDto>((resolve, reject) => {
      this.client.validateOrderTransition(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            console.warn('[OrderGrpcClient] gRPC unavailable, executing modular service fallback.');
            try {
              const fb = await this.fallbackValidateTransition(dto);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          success: Boolean(response.success),
          orderId: response.order_id || dto.orderId,
          previousStatus: response.previous_status || '',
          currentStatus: response.current_status || dto.toStatus,
          version: Number(response.version || 1),
          message: response.message || '',
          error: response.error || undefined,
        });
      });
    });
  }

  public async getAuthoritativeOrder(
    orderId: string,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<OrderResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackGetOrder(orderId);
    }

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise<OrderResponseDto>((resolve, reject) => {
      this.client.getAuthoritativeOrder({ order_id: orderId }, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            console.warn('[OrderGrpcClient] gRPC unavailable, executing modular fallback.');
            try {
              const fb = await this.fallbackGetOrder(orderId);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          found: Boolean(response.found),
          orderId: response.order_id || orderId,
          status: response.status || '',
          totalAmount: Number(response.total_amount || 0),
          paymentStatus: response.payment_status || '',
          paymentMethod: response.payment_method || '',
          userId: response.user_id || '',
          customerName: response.customer_name || '',
          customerPhone: response.customer_phone || '',
          deliveryAddress: response.delivery_address || '',
          branchId: response.branch_id || '',
          franchiseId: response.franchise_id || '',
          permanentBillNo: Number(response.permanent_bill_no || 0),
          dailyOrderNo: Number(response.daily_order_no || 0),
          items: response.items || [],
          rawJson: response.raw_json || '',
          error: response.error || undefined,
        });
      });
    });
  }

  public async updatePaymentState(
    dto: UpdatePaymentRequestDto,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<{ success: boolean; orderId: string; paymentStatus: string; error?: string }> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackUpdatePayment(dto);
    }

    const reqPayload = {
      order_id: dto.orderId,
      payment_status: dto.paymentStatus,
      payment_method: dto.paymentMethod || '',
      provider_payment_id: dto.providerPaymentId || '',
      amount_paid: dto.amountPaid || 0,
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise((resolve, reject) => {
      this.client.updatePaymentState(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            try {
              const fb = await this.fallbackUpdatePayment(dto);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          success: Boolean(response.success),
          orderId: response.order_id || dto.orderId,
          paymentStatus: response.payment_status || dto.paymentStatus,
          error: response.error || undefined,
        });
      });
    });
  }

  // Graceful in-process fallbacks
  private async fallbackValidateTransition(dto: TransitionRequestDto): Promise<TransitionResponseDto> {
    const res = await OrderStateMachine.transition(
      dto.orderId,
      dto.toStatus as any,
      {
        uid: dto.actorId || 'system',
        role: dto.actorRole || 'system',
        name: dto.actorName,
        branchId: dto.branchId,
      },
      dto.metadata || {}
    );

    return {
      success: res.success,
      orderId: res.orderId,
      previousStatus: res.previousStatus,
      currentStatus: res.currentStatus,
      version: res.version || 1,
      message: res.message || '',
      error: res.error,
    };
  }

  private async fallbackGetOrder(orderId: string): Promise<OrderResponseDto> {
    const snap = await adminDb.collection('orders').doc(orderId).get().catch(() => null);
    if (snap && snap.exists) {
      const d = snap.data()!;
      return {
        found: true,
        orderId,
        status: d.status || 'pending',
        totalAmount: Number(d.totalAmount || 0),
        paymentStatus: d.paymentStatus || 'PENDING',
        paymentMethod: d.paymentMethod || '',
        userId: d.userId || '',
        customerName: d.customerName || '',
        customerPhone: d.contactPhone || '',
        deliveryAddress: typeof d.deliveryAddress === 'string' ? d.deliveryAddress : '',
        branchId: d.branchId || '',
        franchiseId: d.franchiseId || '',
        permanentBillNo: Number(d.permanentBillNo || 0),
        dailyOrderNo: Number(d.dailyOrderNo || 0),
        items: d.items || [],
        rawJson: JSON.stringify(d),
      };
    }

    const pgRes = await query('SELECT * FROM canonical_orders WHERE id = $1', [orderId]).catch(() => ({ rows: [] }));
    if (pgRes.rows.length > 0) {
      const row = pgRes.rows[0];
      return {
        found: true,
        orderId,
        status: row.order_status,
        totalAmount: Number(row.total_amount || 0),
        paymentStatus: row.payment_status,
        paymentMethod: row.payment_method || '',
        userId: row.customer_id || '',
        customerName: row.customer_name || '',
        customerPhone: row.customer_phone || '',
        deliveryAddress: row.delivery_address || '',
        branchId: row.branch_id || '',
        franchiseId: row.franchise_id || '',
        permanentBillNo: Number(row.permanent_bill_no || 0),
        dailyOrderNo: Number(row.daily_order_no || 0),
        items: [],
      };
    }

    return {
      found: false,
      orderId,
      status: '',
      totalAmount: 0,
      paymentStatus: '',
      paymentMethod: '',
      userId: '',
      customerName: '',
      customerPhone: '',
      deliveryAddress: '',
      branchId: '',
      franchiseId: '',
      permanentBillNo: 0,
      dailyOrderNo: 0,
      items: [],
      error: 'Order not found',
    };
  }

  private async fallbackUpdatePayment(dto: UpdatePaymentRequestDto): Promise<{ success: boolean; orderId: string; paymentStatus: string; error?: string }> {
    await adminDb.collection('orders').doc(dto.orderId).set({
      paymentStatus: dto.paymentStatus,
      paymentMethod: dto.paymentMethod || undefined,
      providerPaymentId: dto.providerPaymentId || undefined,
      amountPaid: dto.amountPaid || undefined,
      updatedAt: new Date(),
    }, { merge: true }).catch(() => {});

    return {
      success: true,
      orderId: dto.orderId,
      paymentStatus: dto.paymentStatus,
    };
  }
}
