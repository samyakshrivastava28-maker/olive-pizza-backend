import * as grpc from '@grpc/grpc-js';
import { BaseGrpcClient, ClientOptions, mapGrpcError } from './BaseGrpcClient.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { OrderPersistenceArchiveService } from '../../services/order/OrderPersistenceArchiveService.ts';

export interface FinalizeOrderResponseDto {
  success: boolean;
  orderId: string;
  alreadyArchived: boolean;
  verified: boolean;
  permanentBillNo: number;
  error?: string;
}

export class ArchiveGrpcClient extends BaseGrpcClient {
  private client: any;

  constructor(options: ClientOptions = {}) {
    super(options);
    const proto = loadProtoDefinition('archive/v1/archive.proto') as any;
    const ServiceConstructor = proto.olivepizza.archive.v1.ArchiveService;
    this.client = new ServiceConstructor(this.endpoint, grpc.credentials.createInsecure());
  }

  public close(): void {
    if (this.client) {
      this.client.close();
    }
  }

  public async reconcileAndFinalizeOrder(
    orderId: string,
    forceReconcile: boolean = false,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<FinalizeOrderResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackFinalize(orderId, forceReconcile);
    }

    const reqPayload = {
      order_id: orderId,
      force_reconcile: forceReconcile,
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise((resolve, reject) => {
      this.client.reconcileAndFinalizeOrder(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            console.warn('[ArchiveGrpcClient] gRPC unavailable, executing modular fallback.');
            try {
              const fb = await this.fallbackFinalize(orderId, forceReconcile);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          success: Boolean(response.success),
          orderId: response.order_id || orderId,
          alreadyArchived: Boolean(response.already_archived),
          verified: Boolean(response.verified),
          permanentBillNo: Number(response.permanent_bill_no || 0),
          error: response.error || undefined,
        });
      });
    });
  }

  private async fallbackFinalize(orderId: string, forceReconcile: boolean): Promise<FinalizeOrderResponseDto> {
    if (forceReconcile) {
      await OrderPersistenceArchiveService.syncLiveOrderToPostgres(orderId).catch(() => {});
    }

    const res = await OrderPersistenceArchiveService.finalizeAndArchiveTerminalOrder(orderId);
    return {
      success: res.success,
      orderId,
      alreadyArchived: Boolean(res.alreadyArchived),
      verified: res.success,
      permanentBillNo: Number(res.permanentBillNo || 0),
      error: res.error,
    };
  }
}
