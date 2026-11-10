import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Olive Pizza Structured Observability & Correlation Logger
 * Injects a unique `x-correlation-id` into every incoming request and produces
 * JSON structured logs with latency, status codes, user identity, and route paths.
 */
export interface StructuredLog {
  timestamp: string;
  correlationId: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  event: string;
  method?: string;
  path?: string;
  statusCode?: number;
  latencyMs?: number;
  userId?: string;
  role?: string;
  franchiseId?: string;
  branchId?: string;
  ip?: string;
  details?: any;
}

export class CorrelationLogger {
  public static middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const correlationId = (req.headers['x-correlation-id'] as string) || `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      (req as any).correlationId = correlationId;
      res.setHeader('x-correlation-id', correlationId);

      const startTime = Date.now();

      res.on('finish', () => {
        const latencyMs = Date.now() - startTime;
        const user = (req as any).user;
        const statusCode = res.statusCode;

        const level = statusCode >= 500 ? 'ERROR' : (statusCode >= 400 ? 'WARN' : 'INFO');

        const logEntry: StructuredLog = {
          timestamp: new Date().toISOString(),
          correlationId,
          level,
          event: 'http_request_finished',
          method: req.method,
          path: (req.originalUrl || req.path || '').replace(/([?&](?:trackingToken|token|access_token|key|secret|password|idToken|auth)=)[^&]+/gi, '[REDACTED]'),
          statusCode,
          latencyMs,
          userId: user?.uid,
          role: user?.role,
          franchiseId: user?.franchiseId,
          branchId: user?.branchId,
          ip: (req.headers['x-forwarded-for'] as string) || req.ip
        };

        if (level === 'ERROR') {
          console.error(JSON.stringify(logEntry));
        } else if (level === 'WARN') {
          console.warn(JSON.stringify(logEntry));
        } else {
          console.log(JSON.stringify(logEntry));
        }
      });

      next();
    };
  }

  public static logEvent(event: string, details?: any, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
    const entry: StructuredLog = {
      timestamp: new Date().toISOString(),
      correlationId: `sys_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      level,
      event,
      details
    };
    if (level === 'ERROR') console.error(JSON.stringify(entry));
    else if (level === 'WARN') console.warn(JSON.stringify(entry));
    else console.log(JSON.stringify(entry));
  }
}
