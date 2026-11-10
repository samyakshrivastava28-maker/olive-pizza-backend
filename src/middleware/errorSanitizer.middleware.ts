import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function generateReferenceId(): string {
  return 'OP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Checks if a string contains internal technical leaks:
 * Firebase auth codes, Firestore collection paths, Postgres SQL, stack traces, file paths.
 */
export function containsTechnicalLeak(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  const lower = str.toLowerCase();
  return (
    lower.includes('auth/') ||
    lower.includes('firebase') ||
    lower.includes('firestore') ||
    lower.includes('at ') ||
    lower.includes('node_modules') ||
    lower.includes('stack') ||
    lower.includes('select ') ||
    lower.includes('from ') ||
    lower.includes('relation ') ||
    lower.includes('syntax error') ||
    lower.includes('violates foreign key') ||
    lower.includes('column ') ||
    lower.includes('c:\\') ||
    lower.includes('/var/') ||
    lower.includes('/usr/') ||
    lower.includes('internal error') ||
    lower.includes('permission_denied') ||
    lower.includes('not_found') ||
    lower.includes('failed_precondition') ||
    lower.includes('database error')
  );
}

/**
 * Normalizes technical error messages and status codes to safe codes and friendly user messages.
 */
export function sanitizeErrorDetails(errOrMsg: any, statusCode: number): {
  code: string;
  message: string;
  retryAfter?: number;
} {
  const rawMsg = typeof errOrMsg === 'string' 
    ? errOrMsg 
    : (errOrMsg?.message || errOrMsg?.error || errOrMsg?.reason || '');
  const lower = (rawMsg || '').toLowerCase();
  const rawCode = (errOrMsg?.code || '').toString().toUpperCase();

  // 1. Rate Limits
  if (
    statusCode === 429 ||
    rawCode.includes('RATE_LIMIT') ||
    rawCode.includes('TOO_MANY_REQUESTS') ||
    lower.includes('rate limit') ||
    lower.includes('too many')
  ) {
    const retryAfter = errOrMsg?.retryAfter || errOrMsg?.retryAfterSeconds || 120;
    return {
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      retryAfter: Number(retryAfter)
    };
  }

  // 2. Firebase Auth Exceptions
  if (lower.includes('auth/user-not-found') || lower.includes('auth/wrong-password') || lower.includes('invalid-credential') || lower.includes('invalid email or password')) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: 'Invalid credentials. Please verify and try again.'
    };
  }
  if (lower.includes('auth/email-already-in-use') || lower.includes('auth/email-already-exists') || lower.includes('already registered')) {
    return {
      code: 'EMAIL_ALREADY_IN_USE',
      message: 'An account with this email address already exists.'
    };
  }
  if (lower.includes('auth/id-token-expired') || lower.includes('auth/session-expired') || lower.includes('token expired') || lower.includes('session has expired')) {
    return {
      code: 'SESSION_EXPIRED',
      message: 'Your session has expired. Please sign in again.'
    };
  }
  if (lower.includes('auth/invalid-id-token') || lower.includes('auth/argument-error') || lower.includes('unauthorized') || statusCode === 401) {
    return {
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Please sign in.'
    };
  }
  if (lower.includes('auth/user-disabled')) {
    return {
      code: 'ACCOUNT_DISABLED',
      message: 'This account has been disabled. Please contact support.'
    };
  }

  // 3. Permissions / RBAC
  const SAFE_AUTH_CODES = [
    'APP_ACCESS_DENIED',
    'ACCESS_DENIED',
    'STAFF_GRANT_REQUIRED',
    'TERMINAL_NOT_PERMITTED',
    'TERMINAL_REQUIRED',
    'BRANCH_SCOPE_VIOLATION',
    'BRANCH_SCOPE_REQUIRED',
    'CROSS_FRANCHISE_VIOLATION',
    'ACCOUNT_REVOKED',
    'NOT_REGISTERED',
    'BRANCH_INACTIVE',
    'BRANCH_NOT_FOUND',
    'ROLE_RESTRICTED',
    'DATABASE_UNAVAILABLE'
  ];

  if (SAFE_AUTH_CODES.includes(rawCode)) {
    return {
      code: rawCode,
      message: containsTechnicalLeak(rawMsg) ? 'You do not have permission to perform this action.' : (rawMsg || 'Access denied.')
    };
  }

  if (lower.includes('permission-denied') || lower.includes('permission_denied') || lower.includes('insufficient permissions') || statusCode === 403) {
    // If there is an explicit safe reason (e.g. Owner operational boundary)
    if (lower.includes('restricted from pos') || lower.includes('restricted from restaurant') || lower.includes('restricted from delivery')) {
      return {
        code: 'ROLE_RESTRICTED',
        message: rawMsg
      };
    }
    return {
      code: 'PERMISSION_DENIED',
      message: 'You do not have permission to perform this action.'
    };
  }

  // 4. Not Found
  if (statusCode === 404 || lower.includes('not found') || rawCode === 'NOT_FOUND') {
    return {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.'
    };
  }

  // 5. Conflicts
  if (statusCode === 409 || lower.includes('already exists') || lower.includes('conflict')) {
    return {
      code: 'RESOURCE_CONFLICT',
      message: 'A conflicting record already exists.'
    };
  }

  // 6. Database / SQL / Stack / Internal Leaks
  if (containsTechnicalLeak(rawMsg) || statusCode >= 500) {
    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected system error occurred. Please try again later.'
    };
  }

  // 7. Safe fallback for client validation messages
  if (statusCode === 400 || statusCode === 422) {
    return {
      code: rawCode || 'VALIDATION_FAILED',
      message: rawMsg || 'Invalid request parameters.'
    };
  }

  return {
    code: rawCode || 'OPERATION_FAILED',
    message: rawMsg || 'The operation could not be completed.'
  };
}

/**
 * Express Middleware:
 * Intercepts all outgoing JSON responses with statusCode >= 400.
 * Automatically sanitizes technical messages, strips stack traces,
 * injects referenceId ('OP-XXXXXX'), and logs full diagnostics server-side.
 */
export function errorSanitizerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: any): Response {
    if (res.statusCode >= 400 && body && typeof body === 'object') {
      const referenceId = body.referenceId || generateReferenceId();
      const sanitized = sanitizeErrorDetails(body, res.statusCode);

      // Server-side audit log for developers with full detail
      console.error(
        `[ErrorSanitizer][${referenceId}][HTTP ${res.statusCode}][${req.method} ${req.originalUrl}] Raw:`,
        body.error || body.message || body.reason || body
      );

      // Construct production-safe error envelope
      const safePayload: Record<string, any> = {
        success: false,
        code: sanitized.code,
        message: sanitized.message,
        referenceId
      };

      // Preserve safe app authorization fields if present
      if (typeof body.authorized === 'boolean') {
        safePayload.authorized = body.authorized;
      }
      if (body.app) {
        safePayload.app = body.app;
      }
      if (body.email && !containsTechnicalLeak(body.email)) {
        safePayload.email = body.email;
      }

      // Preserve retryAfter if present
      const retryAfter = sanitized.retryAfter || body.retryAfter || body.retryAfterSeconds;
      if (retryAfter) {
        safePayload.retryAfter = Number(retryAfter);
        safePayload.retryAfterSeconds = Number(retryAfter);
        res.setHeader('Retry-After', String(retryAfter));
      }

      // Backward compatibility: provide error and reason matching safe message
      safePayload.error = sanitized.message;
      if (body.reason) {
        safePayload.reason = sanitized.message;
      }

      return originalJson(safePayload);
    }

    return originalJson(body);
  };

  next();
}
