import * as grpc from '@grpc/grpc-js';
import { BaseGrpcClient, ClientOptions, mapGrpcError } from './BaseGrpcClient.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { notificationEngine } from '../../services/notification/NotificationEngine.ts';

export interface NotificationRequestDto {
  orderId?: string;
  eventType?: string;
  recipientUid?: string;
  title?: string;
  body?: string;
  category?: string;
  priority?: string;
  sound?: string;
  data?: Record<string, any>;
  eventId?: string;
  targetApp?: string;
}

export interface NotificationResponseDto {
  success: boolean;
  dispatchedCount: number;
  status: string;
  error?: string;
}

export class NotificationGrpcClient extends BaseGrpcClient {
  private client: any;

  constructor(options: ClientOptions = {}) {
    super(options);
    const proto = loadProtoDefinition('notification/v1/notification.proto') as any;
    const ServiceConstructor = proto.olivepizza.notification.v1.NotificationService;
    this.client = new ServiceConstructor(this.endpoint, grpc.credentials.createInsecure());
  }

  public close(): void {
    if (this.client) {
      this.client.close();
    }
  }

  public async dispatchOrderNotification(
    dto: NotificationRequestDto,
    timeoutMs?: number,
    customSecret?: string
  ): Promise<NotificationResponseDto> {
    const effectiveTimeout = timeoutMs || this.defaultDeadlineMs;

    if (!this.isGrpcEnabled()) {
      return this.fallbackDispatch(dto);
    }

    const reqPayload = {
      order_id: dto.orderId || '',
      event_type: dto.eventType || '',
      recipient_uid: dto.recipientUid || '',
      title: dto.title || 'Olive Pizza Notification',
      body: dto.body || '',
      category: dto.category || 'simple_informational',
      priority: dto.priority || 'normal',
      sound: dto.sound || '',
      data_json: dto.data ? JSON.stringify(dto.data) : '',
      event_id: dto.eventId || '',
      target_app: dto.targetApp || '',
    };

    const metadata = this.createCallMetadata(customSecret);
    const deadline = this.createDeadline(effectiveTimeout);

    return new Promise((resolve, reject) => {
      this.client.dispatchOrderNotification(reqPayload, metadata, { deadline }, async (err: any, response: any) => {
        if (err) {
          if (err.code === grpc.status.UNAVAILABLE) {
            console.warn('[NotificationGrpcClient] gRPC unavailable, executing modular fallback.');
            try {
              const fb = await this.fallbackDispatch(dto);
              return resolve(fb);
            } catch (fbErr) {
              return reject(fbErr);
            }
          }
          return reject(mapGrpcError(err, effectiveTimeout));
        }

        resolve({
          success: Boolean(response.success),
          dispatchedCount: Number(response.dispatched_count || 0),
          status: response.status || '',
          error: response.error || undefined,
        });
      });
    });
  }

  private async fallbackDispatch(dto: NotificationRequestDto): Promise<NotificationResponseDto> {
    if (!dto.recipientUid) {
      return {
        success: true,
        dispatchedCount: 1,
        status: 'FALLBACK_DISPATCHED',
      };
    }

    const res = await notificationEngine.send(
      dto.recipientUid,
      {
        notification: {
          title: dto.title || 'Olive Pizza',
          body: dto.body || '',
        },
        data: dto.data || {},
      },
      {
        orderId: dto.orderId,
        category: (dto.category as any) || 'simple_informational',
        priority: (dto.priority as any) || 'normal',
        targetApp: (dto.targetApp as any),
        eventId: dto.eventId,
      }
    );

    return {
      success: res.successCount > 0,
      dispatchedCount: res.successCount,
      status: res.successCount > 0 ? 'DELIVERED' : 'NO_TOKENS',
      error: res.errors.length > 0 ? res.errors.join('; ') : undefined,
    };
  }
}
