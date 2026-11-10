/**
 * Security Logging Sanitizer
 * Redacts sensitive fields (passwords, OTPs, auth tokens, secrets, private keys)
 * before logging objects to stdout or logs directory.
 */

const SENSITIVE_KEYS = /password|pass|otp|token|secret|authorization|auth|jwt|private_key|service_account/i;

export function sanitizeForLog(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Redact Bearer tokens in headers
    if (data.startsWith('Bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(item => sanitizeForLog(item));
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEYS.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeForLog(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  return data;
}

export function logSecurityEvent(type: string, message: string, details?: any): void {
  const timestamp = new Date().toISOString();
  const sanitizedDetails = details ? sanitizeForLog(details) : undefined;
  console.log(`[SECURITY][${type}][${timestamp}] ${message}`, sanitizedDetails ? JSON.stringify(sanitizedDetails) : '');
}
