import * as grpc from '@grpc/grpc-js';
import { OrderGrpcService } from './services/OrderGrpcService.ts';
import { PaymentGrpcService } from './services/PaymentGrpcService.ts';
import { NotificationGrpcService } from './services/NotificationGrpcService.ts';
import { DeliveryGrpcService } from './services/DeliveryGrpcService.ts';
import { ArchiveGrpcService } from './services/ArchiveGrpcService.ts';

let grpcServerInstance: grpc.Server | null = null;
let boundAddress: string | null = null;

export function getGrpcServer(): grpc.Server | null {
  return grpcServerInstance;
}

export function createGrpcServer(): grpc.Server {
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 16 * 1024 * 1024,
    'grpc.max_send_message_length': 16 * 1024 * 1024,
  });

  OrderGrpcService.register(server);
  PaymentGrpcService.register(server);
  NotificationGrpcService.register(server);
  DeliveryGrpcService.register(server);
  ArchiveGrpcService.register(server);

  return server;
}

export async function startGrpcServer(customPort?: number): Promise<{ server: grpc.Server; port: number; address: string }> {
  if (process.env.NODE_ENV === 'production' && !process.env.INTERNAL_RPC_SECRET) {
    if (process.env.RENDER) {
      console.warn('⚠️ [gRPC Server Notice] INTERNAL_RPC_SECRET not set in Render environment. Generating ephemeral internal cluster secret.');
      process.env.INTERNAL_RPC_SECRET = `ephemeral-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    } else {
      console.error('FATAL: INTERNAL_RPC_SECRET must be configured in production for gRPC cluster security.');
      process.exit(1);
    }
  }

  if (grpcServerInstance && boundAddress) {
    const port = Number(boundAddress.split(':')[1]);
    return { server: grpcServerInstance, port, address: boundAddress };
  }

  const port = customPort != null ? customPort : Number(process.env.INTERNAL_GRPC_PORT || 50051);
  const host = '127.0.0.1';
  const target = `${host}:${port}`;

  const server = createGrpcServer();

  return new Promise((resolve, reject) => {
    server.bindAsync(target, grpc.ServerCredentials.createInsecure(), (err, actualPort) => {
      if (err) {
        console.error(`❌ [gRPC Server] Failed to bind to ${target}:`, err.message);
        return reject(err);
      }

      grpcServerInstance = server;
      boundAddress = `${host}:${actualPort}`;
      console.log(`🔒 [gRPC Server] Internal cluster service listening privately on ${boundAddress}`);
      resolve({ server, port: actualPort, address: boundAddress });
    });
  });
}

export async function stopGrpcServer(force: boolean = false): Promise<void> {
  if (!grpcServerInstance) return;

  const server = grpcServerInstance;
  grpcServerInstance = null;
  boundAddress = null;

  return new Promise((resolve) => {
    if (force) {
      server.forceShutdown();
      console.log('🛑 [gRPC Server] Forcefully stopped');
      resolve();
    } else {
      server.tryShutdown((err) => {
        if (err) {
          server.forceShutdown();
        }
        console.log('🛑 [gRPC Server] Gracefully stopped');
        resolve();
      });
    }
  });
}
