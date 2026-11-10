import * as grpc from '@grpc/grpc-js';
import { OrderPersistenceArchiveService } from '../../services/order/OrderPersistenceArchiveService.ts';
import { loadProtoDefinition } from '../protoLoader.ts';
import { withAuth } from '../authInterceptor.ts';

export class ArchiveGrpcService {
  public static register(server: grpc.Server): void {
    const proto = loadProtoDefinition('archive/v1/archive.proto') as any;
    const serviceDef = proto.olivepizza.archive.v1.ArchiveService.service;

    server.addService(serviceDef, {
      ReconcileAndFinalizeOrder: withAuth(ArchiveGrpcService.reconcileAndFinalizeOrder),
      reconcileAndFinalizeOrder: withAuth(ArchiveGrpcService.reconcileAndFinalizeOrder),
    });
  }

  public static async reconcileAndFinalizeOrder(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    const req = call.request || {};
    const orderId = (req.order_id || req.orderId || '').trim();
    const forceReconcile = Boolean(req.force_reconcile ?? req.forceReconcile);

    if (!orderId) {
      return callback(null, {
        success: false,
        order_id: '',
        already_archived: false,
        verified: false,
        permanent_bill_no: 0,
        error: 'order_id is required',
      });
    }

    try {
      if (forceReconcile) {
        // Pre-sync live order to ensure PostgreSQL has the canonical row
        await OrderPersistenceArchiveService.syncLiveOrderToPostgres(orderId).catch(() => {});
      }

      const archiveResult = await OrderPersistenceArchiveService.finalizeAndArchiveTerminalOrder(orderId);

      return callback(null, {
        success: archiveResult.success,
        order_id: orderId,
        already_archived: Boolean(archiveResult.alreadyArchived),
        verified: archiveResult.success,
        permanent_bill_no: Number(archiveResult.permanentBillNo || 0),
        error: archiveResult.error || '',
      });
    } catch (err: any) {
      return callback(null, {
        success: false,
        order_id: orderId,
        already_archived: false,
        verified: false,
        permanent_bill_no: 0,
        error: err?.message || 'Finalization and archival error',
      });
    }
  }
}
