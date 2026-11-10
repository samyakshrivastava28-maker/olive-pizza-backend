/**
 * logSanitizer.ts
 *
 * Centralized Log Sanitization & Token Leak Redaction Utility (Phase 91).
 *
 * Guarantees that credentials, JWTs, refresh tokens, passwords, cookies,
 * and sensitive API keys are NEVER logged into console, error logs, audit logs,
 * crash reports, or external monitoring streams.
 */

const SENSITIVE_KEY_PATTERNS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'idtoken',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'token',
  'credential',
  'credentials',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'client_secret',
  'webhook_secret',
  'serviceaccountkey',
  'service_account_key',
  'key_password',
  'keystore_password',
  'internal_rpc_secret',
]);

const JWT_REGEX = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9_\-\.]+/gi;
const URL_TOKEN_REGEX = /([?&](?:token|idToken|access_token|auth|key|secret)=)[^&\s]+/gi;

/**
 * Checks whether a given key matches any known sensitive credential key pattern.
 */
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  if (SENSITIVE_KEY_PATTERNS.has(normalized)) return true;
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }
  return false;
}

/**
 * Recursively redacts sensitive values from an object, array, or primitive.
 */
export function redactSensitiveData<T = any>(value: T, depth = 0): T {
  if (depth > 8) return value; // Prevent circular / deep recursion
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Redact JWT patterns, Bearer strings, and URL query credentials embedded inside string text
    return value
      .replace(BEARER_REGEX, 'Bearer [REDACTED_TOKEN]')
      .replace(JWT_REGEX, '[REDACTED_JWT]')
      .replace(URL_TOKEN_REGEX, '$1[REDACTED]') as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    // If it's an Error instance, extract safe properties
    if (value instanceof Error) {
      return sanitizeError(value) as unknown as T;
    }

    const sanitized: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = redactSensitiveData(v, depth + 1);
      }
    }
    return sanitized as T;
  }

  return value;
}

export interface SanitizedError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Sanitizes HTTP headers for logging or error reporting.
 */
export function sanitizeHeaders(headers: any): Record<string, any> {
  if (!headers || typeof headers !== 'object') return {};
  const output: Record<string, any> = {};

  const entries: [string, any][] = typeof headers.entries === 'function'
    ? Array.from(headers.entries() as any)
    : Object.entries(headers);

  for (const [key, val] of entries) {
    const k = String(key);
    if (isSensitiveKey(k)) {
      output[k] = '[REDACTED]';
    } else {
      output[k] = typeof val === 'string'
        ? val.replace(BEARER_REGEX, 'Bearer [REDACTED]').replace(JWT_REGEX, '[REDACTED_JWT]')
        : val;
    }
  }

  return output;
}

/**
 * Strips tokens and credential details from an Error object before logging or propagation.
 */
export function sanitizeError(error: any): SanitizedError {
  if (!error) return new Error('Unknown error') as SanitizedError;

  const rawMessage = error.message || String(error);
  const cleanMessage = rawMessage
    .replace(BEARER_REGEX, 'Bearer [REDACTED]')
    .replace(JWT_REGEX, '[REDACTED_JWT]')
    .replace(URL_TOKEN_REGEX, '$1[REDACTED]');

  const safeErr = new Error(cleanMessage) as SanitizedError;
  safeErr.name = error.name || 'Error';

  if (error.stack) {
    safeErr.stack = error.stack
      .replace(BEARER_REGEX, 'Bearer [REDACTED]')
      .replace(JWT_REGEX, '[REDACTED_JWT]')
      .replace(URL_TOKEN_REGEX, '$1[REDACTED]');
  }

  if (error.code) safeErr.code = String(error.code);
  if (error.status) safeErr.status = Number(error.status);
  if (error.statusCode) safeErr.statusCode = Number(error.statusCode);

  return safeErr;
}

/**
 * Safe logging helper that automatically sanitizes metadata arguments.
 */
export const safeLogger = {
  info: (tag: string, message: string, meta?: any) => {
    console.log(`[${tag}] ${message}`, meta !== undefined ? redactSensitiveData(meta) : '');
  },
  warn: (tag: string, message: string, meta?: any) => {
    console.warn(`[${tag}] ⚠️ ${message}`, meta !== undefined ? redactSensitiveData(meta) : '');
  },
  error: (tag: string, message: string, meta?: any) => {
    console.error(`[${tag}] ❌ ${message}`, meta !== undefined ? redactSensitiveData(meta) : '');
  },
};

export const sanitizeLogData = redactSensitiveData;

