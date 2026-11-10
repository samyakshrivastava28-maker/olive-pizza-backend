import crypto from 'node:crypto';
import * as grpc from '@grpc/grpc-js';

export function getInternalRpcSecret(): string {
  let secret = process.env.INTERNAL_RPC_SECRET;
  if (!secret) {
    if (process.env.RENDER) {
      secret = `render-ephemeral-rpc-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
      process.env.INTERNAL_RPC_SECRET = secret;
      console.warn('⚠️ [authInterceptor] INTERNAL_RPC_SECRET not set in Render environment. Generated ephemeral cluster secret.');
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: INTERNAL_RPC_SECRET environment variable is missing in production!');
      process.exit(1);
    }
    const devSecret = process.env.DEV_INTERNAL_RPC_SECRET || 'dev-internal-rpc-secret-1234567890';
    return devSecret;
  }
  return secret;
}

export function createAuthMetadata(secret?: string): grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.add('x-internal-auth', secret || getInternalRpcSecret());
  return metadata;
}

export function verifyInternalAuth(metadata: grpc.Metadata): boolean {
  try {
    const expectedSecret = getInternalRpcSecret();
    const values = metadata.get('x-internal-auth');
    if (!values || values.length === 0) {
      return false;
    }
    const token = String(values[0]);
    if (!token || !expectedSecret) return false;

    const tokenBuf = Buffer.from(token, 'utf8');
    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    if (tokenBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(tokenBuf, expectedBuf);
  } catch {
    return false;
  }
}

export type GrpcUnaryHandler<Req = any, Res = any> = (
  call: grpc.ServerUnaryCall<Req, Res>,
  callback: grpc.sendUnaryData<Res>
) => void | Promise<void>;

/**
 * Wraps gRPC service handlers with strict internal token verification.
 * Rejects with UNAUTHENTICATED if 'x-internal-auth' is missing or incorrect.
 */
export function withAuth<Req = any, Res = any>(handler: GrpcUnaryHandler<Req, Res>): GrpcUnaryHandler<Req, Res> {
  return async (call: grpc.ServerUnaryCall<Req, Res>, callback: grpc.sendUnaryData<Res>) => {
    if (!verifyInternalAuth(call.metadata)) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        name: 'Unauthenticated',
        message: 'Missing or invalid internal authorization token (x-internal-auth mismatch)',
      });
    }

    try {
      await handler(call, callback);
    } catch (err: any) {
      console.error('[gRPC Handler Exception]:', err?.message || err);
      return callback({
        code: grpc.status.INTERNAL,
        name: 'InternalError',
        message: err?.message || 'Internal gRPC execution error',
      });
    }
  };
}
