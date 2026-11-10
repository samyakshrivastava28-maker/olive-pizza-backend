import * as grpc from '@grpc/grpc-js';
import { notificationEngine } from '../../services/notification/NotificationEngine.ts';
import { NotificationRouter } from '../../services/notification/NotificationRouter.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { withAuth } from '../authInterceptor.ts';

export class NotificationGrpcService {
  public static register(server: grpc.Server): void {
    const proto = loadProtoDefinition('notification/v1/notification.proto') as any;
    const serviceDef = proto.olivepizza.notification.v1.NotificationService.service;

    server.addService(serviceDef, {
      DispatchOrderNotification: withAuth(NotificationGrpcService.dispatchOrderNotification),
      dispatchOrderNotification: withAuth(NotificationGrpcService.dispatchOrderNotification),
    });
  }

  public static async dispatchOrderNotification(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = (req.order_id || req.orderId || '').trim();
    const eventType = (req.event_type || req.eventType || '').trim();
    const recipientUid = (req.recipient_uid || req.recipientUid || '').trim();
    const title = req.title || 'Olive Pizza Update';
    const body = req.body || '';
    const category = req.category || 'simple_informational';
    const priority = (req.priority || 'normal').toLowerCase();
    const sound = req.sound || undefined;
    const eventId = req.event_id || req.eventId || undefined;
    const targetApp = (req.target_app || req.targetApp || undefined) as any;

    let dataObj: Record<string, any> = {};
    const rawData = req.data_json || req.dataJson;
    if (rawData) {
      try {
        dataObj = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
      } catch (e) {
        dataObj = {};
      }
    }

    try {
      // 1. Direct recipient dispatch if recipient_uid is present
      if (recipientUid) {
        const payload: any = {
          notification: {
            title,
            body,
          },
          data: {
            orderId,
            eventType,
            category,
            ...dataObj,
          },
        };

        if (sound) {
          payload.sound = sound;
        }

        const res = await notificationEngine.send(recipientUid, payload, {
          orderId: orderId || undefined,
          category,
          priority: priority === 'critical' ? 'critical' : priority === 'high' ? 'high' : 'normal',
          targetApp,
          eventId,
        });

        return callback(null, {
          success: res.successCount > 0,
          dispatched_count: res.successCount,
          status: res.successCount > 0 ? 'DELIVERED' : 'NO_TOKENS',
          error: res.errors.length > 0 ? res.errors.join('; ') : '',
        });
      }

      // 2. Event-based order routing if order_id is present
      if (orderId && eventType) {
        // Load order details from Firestore to build context
        const { adminDb } = await import('../../config/firebase.ts');
        const snap = await adminDb.collection('orders').doc(orderId).get().catch(() => null);

        if (snap && snap.exists) {
          const oData = snap.data()!;
          const routerResult = await NotificationRouter.routeOrderEvent(
            {
              orderId,
              orderNumber: oData.orderNumber || `#${orderId.slice(-6).toUpperCase()}`,
              totalAmount: Number(oData.totalAmount || 0),
              branchId: oData.branchId || 'main_branch',
              franchiseId: oData.franchiseId || 'fra_primary',
              deliveryPartnerId: oData.deliveryPartnerId || null,
              userId: oData.userId || oData.customerId,
              items: oData.items || [],
              rawOrderData: oData,
            },
            eventType as any
          );

          return callback(null, {
            success: routerResult.dispatchedCount > 0,
            dispatched_count: routerResult.dispatchedCount,
            status: routerResult.status,
            error: '',
          });
        }
      }

      return callback(null, {
        success: false,
        dispatched_count: 0,
        status: 'FAILED',
        error: 'Neither recipient_uid nor valid order_id with event_type was provided',
      });
    } catch (err: any) {
      return callback(null, {
        success: false,
        dispatched_count: 0,
        status: 'ERROR',
        error: err?.message || 'Notification dispatch error',
      });
    }
  }
}
