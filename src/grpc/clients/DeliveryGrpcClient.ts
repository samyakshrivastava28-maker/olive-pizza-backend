import * as grpc from '@grpc/grpc-js';
import { BaseGrpcClient, ClientOptions, mapGrpcError } from './BaseGrpcClient.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { StoreBoundDeliveryFleetService } from '../../services/delivery/StoreBoundDeliveryFleetService.ts';
import { OrderStateMachine } from '../../services/order/OrderStateMachine.ts';

export interface AssignRiderRequestDto {
  orderId: string;
  branchId?: string;
  riderId?: string;
  reason?: string;
  actorId?: string;
  actorRole?: string;
  actorName?: string;
}

export interface AssignRiderResponseDto {
  success: boolean;
  orderId: string;
  riderId: string;
  riderName: string;
  status: string;
  error?: string;
}

export interface LifecycleRequestDto {
  orderId?: string;
  riderId?: string;
  targetStage: string;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface LifecycleResponseDto {
  success: boolean;
  currentStage: string;
  error?: string;
}

export class DeliveryGrpcClient extends BaseGrpcClient {
  private client: any;

  constructor(options: ClientOptions = {}) {
    super(options);
    const proto = loadProtoDefinition('delivery/v1/delivery.proto') as any;
    const ServiceConstructor = proto.olivepizza.delivery.v1.DeliveryService;
    this.client = new ServiceConstructor(this.endpoint, grpc.credentials.createInsecure());
  }

  public close(): void {
    if (this.client) {
      this.client.close();
    }
  }

  public async assignRider(
    dto: AssignRiderRequestDto,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<AssignRiderResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackAssignRider(dto);
    }

    const reqPayload = {
      order_id: dto.orderId,
      branch_id: dto.branchId || 'main_branch',
      rider_id: dto.riderId || '',
      reason: dto.reason || '',
      actor_id: dto.actorId || 'system',
      actor_role: dto.actorRole || 'system',
      actor_name: dto.actorName || '',
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise((resolve, reject) => {
      this.client.assignRider(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            console.warn('[DeliveryGrpcClient] gRPC unavailable, executing modular fallback.');
            try {
              const fb = await this.fallbackAssignRider(dto);
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
          riderId: response.rider_id || dto.riderId || '',
          riderName: response.rider_name || dto.actorName || '',
          status: response.status || '',
          error: response.error || undefined,
        });
      });
    });
  }

  public async updateLifecycleStage(
    dto: LifecycleRequestDto,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<LifecycleResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackLifecycle(dto);
    }

    const reqPayload = {
      order_id: dto.orderId || '',
      rider_id: dto.riderId || '',
      target_stage: dto.targetStage,
      reason: dto.reason || '',
      metadata_json: dto.metadata ? JSON.stringify(dto.metadata) : '',
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise((resolve, reject) => {
      this.client.updateLifecycleStage(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            try {
              const fb = await this.fallbackLifecycle(dto);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          success: Boolean(response.success),
          currentStage: response.current_stage || dto.targetStage,
          error: response.error || undefined,
        });
      });
    });
  }

  private async fallbackAssignRider(dto: AssignRiderRequestDto): Promise<AssignRiderResponseDto> {
    if (dto.riderId) {
      const res = await StoreBoundDeliveryFleetService.manualAssignRider(
        dto.orderId,
        dto.riderId,
        { uid: dto.actorId || 'system', role: dto.actorRole || 'system', name: dto.actorName },
        dto.reason || 'Fallback assign'
      );
      return {
        success: res.success,
        orderId: dto.orderId,
        riderId: dto.riderId,
        riderName: dto.actorName || '',
        status: res.success ? 'ASSIGNED' : 'FAILED',
        error: res.error,
      };
    } else {
      const res = await StoreBoundDeliveryFleetService.assignOrderToFifoRider(dto.orderId, dto.branchId || 'main_branch');
      return {
        success: res.success,
        orderId: dto.orderId,
        riderId: res.rider ? res.rider.uid : '',
        riderName: res.rider ? res.rider.name : '',
        status: res.success ? 'ASSIGNED' : 'FAILED',
        error: res.reason,
      };
    }
  }

  private async fallbackLifecycle(dto: LifecycleRequestDto): Promise<LifecycleResponseDto> {
    const riderStates = ['AVAILABLE', 'RETURNING', 'PAUSED', 'OFFLINE', 'DISABLED'];
    if (dto.riderId && riderStates.includes(dto.targetStage.toUpperCase())) {
      const res = await StoreBoundDeliveryFleetService.updateRiderState(
        dto.riderId,
        dto.targetStage.toUpperCase() as any,
        { reason: dto.reason }
      );
      return {
        success: res.success,
        currentStage: res.state,
        error: res.error,
      };
    }

    if (dto.orderId) {
      const res = await OrderStateMachine.transition(
        dto.orderId,
        dto.targetStage.toLowerCase() as any,
        { uid: dto.riderId || 'system', role: 'delivery_partner' },
        { reason: dto.reason }
      );
      return {
        success: res.success,
        currentStage: res.currentStatus,
        error: res.error,
      };
    }

    return {
      success: false,
      currentStage: '',
      error: 'Invalid target stage or missing entity identifiers',
    };
  }
}
