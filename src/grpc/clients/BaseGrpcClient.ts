import * as grpc from '@grpc/grpc-js';
import { getInternalRpcSecret, createAuthMetadata } from '../authInterceptor.ts';

export class GrpcDomainError extends Error {
  public code: number;
  public grpcStatus: string;
  public isTimeout: boolean;
  public isAuthError: boolean;

  constructor(message: string, code: number = grpc.status.UNKNOWN) {
    super(message);
    this.name = 'GrpcDomainError';
    this.code = code;
    this.isTimeout = code === grpc.status.DEADLINE_EXCEEDED;
    this.isAuthError = code === grpc.status.UNAUTHENTICATED;
    this.grpcStatus = Object.keys(grpc.status).find((k) => (grpc.status as any)[k] === code) || 'UNKNOWN';
  }
}

export function mapGrpcError(err: any, timeoutMs: number): GrpcDomainError {
  if (!err) return new GrpcDomainError('Unknown gRPC error');
  if (err instanceof GrpcDomainError) return err;

  const code = err.code ?? grpc.status.UNKNOWN;
  let message = err.details || err.message || 'gRPC call failed';

  switch (code) {
    case grpc.status.DEADLINE_EXCEEDED:
      message = `Request deadline exceeded after ${timeoutMs}ms`;
      break;
    case grpc.status.UNAUTHENTICATED:
      message = 'Internal cluster authentication failed (x-internal-auth rejected)';
      break;
    case grpc.status.PERMISSION_DENIED:
      message = 'Permission denied: Insufficient cluster authority';
      break;
    case grpc.status.NOT_FOUND:
      message = `Resource not found: ${err.message}`;
      break;
    case grpc.status.INVALID_ARGUMENT:
      message = `Invalid argument: ${err.message}`;
      break;
    case grpc.status.UNAVAILABLE:
      message = 'gRPC service unavailable at endpoint';
      break;
    default:
      break;
  }

  return new GrpcDomainError(message, code);
}

export interface ClientOptions {
  endpoint?: string;
  secret?: string;
  defaultDeadlineMs?: number; // 2000 - 5000 ms
}

export abstract class BaseGrpcClient {
  protected endpoint: string;
  protected secret: string;
  protected defaultDeadlineMs: number;

  constructor(options: ClientOptions = {}) {
    const port = Number(process.env.INTERNAL_GRPC_PORT || 50051);
    this.endpoint = options.endpoint || `127.0.0.1:${port}`;
    this.secret = options.secret || getInternalRpcSecret();
    this.defaultDeadlineMs = options.defaultDeadlineMs || 5000; // 5 seconds default (in 2-5s requirement range)
  }

  protected isGrpcEnabled(): boolean {
    return process.env.GRPC_ENABLED !== 'false';
  }

  protected createCallMetadata(customSecret?: string): grpc.Metadata {
    return createAuthMetadata(customSecret || this.secret);
  }

  protected createDeadline(timeoutMs?: number): Date {
    const ms = timeoutMs || this.defaultDeadlineMs;
    return new Date(Date.now() + ms);
  }
}
