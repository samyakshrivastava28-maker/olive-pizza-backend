import * as grpc from '@grpc/grpc-js';
import { StoreBoundDeliveryFleetService } from '../../services/delivery/StoreBoundDeliveryFleetService.ts';
import { OrderStateMachine } from '../../services/order/OrderStateMachine.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { withAuth } from '../authInterceptor.ts';

export class DeliveryGrpcService {
  public static register(server: grpc.Server): void {
    const proto = loadProtoDefinition('delivery/v1/delivery.proto') as any;
    const serviceDef = proto.olivepizza.delivery.v1.DeliveryService.service;

    server.addService(serviceDef, {
      AssignRider: withAuth(DeliveryGrpcService.assignRider),
      assignRider: withAuth(DeliveryGrpcService.assignRider),

      UpdateLifecycleStage: withAuth(DeliveryGrpcService.updateLifecycleStage),
      updateLifecycleStage: withAuth(DeliveryGrpcService.updateLifecycleStage),
    });
  }

  public static async assignRider(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = (req.order_id || req.orderId || '').trim();
    const branchId = (req.branch_id || req.branchId || 'main_branch').trim();
    const riderId = (req.rider_id || req.riderId || '').trim();
    const reason = req.reason || 'Assigned via internal gRPC call';
    const actorId = req.actor_id || req.actorId || 'system';
    const actorRole = req.actor_role || req.actorRole || 'system';
    const actorName = req.actor_name || req.actorName || 'Internal gRPC Service';

    if (!orderId) {
      return callback(null, {
        success: false,
        order_id: '',
        rider_id: '',
        rider_name: '',
        status: 'FAILED',
        error: 'order_id is required',
      });
    }

    try {
      if (riderId) {
        // Manual specific rider assignment
        const result = await StoreBoundDeliveryFleetService.manualAssignRider(
          orderId,
          riderId,
          { uid: actorId, role: actorRole, name: actorName },
          reason
        );

        return callback(null, {
          success: result.success,
          order_id: orderId,
          rider_id: riderId,
          rider_name: actorName,
          status: result.success ? 'ASSIGNED' : 'ASSIGNMENT_FAILED',
          error: result.error || '',
        });
      } else {
        // Automatic FIFO rider assignment
        const result = await StoreBoundDeliveryFleetService.assignOrderToFifoRider(orderId, branchId);

        return callback(null, {
          success: result.success,
          order_id: orderId,
          rider_id: result.rider ? result.rider.uid : '',
          rider_name: result.rider ? result.rider.name : '',
          status: result.success ? 'ASSIGNED' : 'NO_AVAILABLE_RIDERS',
          error: result.reason || '',
        });
      }
    } catch (err: any) {
      return callback(null, {
        success: false,
        order_id: orderId,
        rider_id: riderId,
        rider_name: '',
        status: 'ERROR',
        error: err?.message || 'Rider assignment exception',
      });
    }
  }

  public static async updateLifecycleStage(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = (req.order_id || req.orderId || '').trim();
    const riderId = (req.rider_id || req.riderId || '').trim();
    const targetStage = (req.target_stage || req.targetStage || '').trim();
    const reason = req.reason || '';

    if (!targetStage) {
      return callback(null, {
        success: false,
        current_stage: '',
        error: 'target_stage is required',
      });
    }

    try {
      const riderStates = ['AVAILABLE', 'RETURNING', 'PAUSED', 'OFFLINE', 'DISABLED'];
      const isRiderState = riderStates.includes(targetStage.toUpperCase());

      if (isRiderState && riderId) {
        // Update rider operational status
        const riderRes = await StoreBoundDeliveryFleetService.updateRiderState(
          riderId,
          targetStage.toUpperCase() as any,
          { reason }
        );

        return callback(null, {
          success: riderRes.success,
          current_stage: riderRes.state,
          error: riderRes.error || '',
        });
      }

      if (orderId) {
        // Update order stage in OrderStateMachine
        const transRes = await OrderStateMachine.transition(
          orderId,
          targetStage.toLowerCase() as any,
          {
            uid: riderId || 'system',
            role: 'delivery_partner',
          },
          { reason }
        );

        return callback(null, {
          success: transRes.success,
          current_stage: transRes.currentStatus,
          error: transRes.error || '',
        });
      }

      return callback(null, {
        success: false,
        current_stage: '',
        error: 'Either rider_id or order_id must be provided with appropriate target_stage',
      });
    } catch (err: any) {
      return callback(null, {
        success: false,
        current_stage: '',
        error: err?.message || 'Delivery lifecycle transition failed',
      });
    }
  }
}
