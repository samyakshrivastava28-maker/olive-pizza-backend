/**
 * logger.ts
 *
 * Production structured logging utility for Olive Pizza backend services.
 * Outputs clean, parseable JSON log entries with timestamp, level, service,
 * message, and sanitized context metadata without emoji noise.
 */

import { sanitizeLogData } from './logSanitizer.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogContext {
  requestId?: string;
  orderId?: string;
  userId?: string;
  franchiseId?: string;
  branchId?: string;
  errorCode?: string;
  [key: string]: any;
}

export interface StructuredLogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context?: Record<string, any>;
}

// Regex to strip emojis and non-standard symbols from production log messages
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

function cleanMessage(msg: string): string {
  return msg.replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
}

class StructuredLogger {
  private defaultService: string;

  constructor(defaultService = 'backend') {
    this.defaultService = defaultService;
  }

  public forService(serviceName: string): StructuredLogger {
    return new StructuredLogger(serviceName);
  }

  private write(level: LogLevel, message: string, context?: LogContext, serviceOverride?: string): void {
    const service = serviceOverride || this.defaultService;
    const cleanedMessage = cleanMessage(message);
    const sanitizedContext = context ? (sanitizeLogData(context) as Record<string, any>) : undefined;

    const record: StructuredLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service,
      message: cleanedMessage,
      ...(sanitizedContext && Object.keys(sanitizedContext).length > 0 ? { context: sanitizedContext } : {})
    };

    const serialized = JSON.stringify(record);

    if (level === 'ERROR') {
      console.error(serialized);
    } else if (level === 'WARN') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  public info(message: string, context?: LogContext, service?: string): void {
    this.write('INFO', message, context, service);
  }

  public warn(message: string, context?: LogContext, service?: string): void {
    this.write('WARN', message, context, service);
  }

  public error(message: string, context?: LogContext, service?: string): void {
    this.write('ERROR', message, context, service);
  }

  public debug(message: string, context?: LogContext, service?: string): void {
    if (process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'DEBUG') {
      this.write('DEBUG', message, context, service);
    }
  }
}

export const logger = new StructuredLogger('backend');
export default logger;
