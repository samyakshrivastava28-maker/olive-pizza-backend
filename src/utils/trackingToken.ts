/**
 * Tracking Token — HMAC-SHA256 signed, expiring deep-link tokens
 *
 * Purpose: Secure the /order-tracking/:orderId route for non-authenticated
 * access (e.g. from push notification "Track Live" deep links).
 *
 * Token format:  base64url(orderId:exp:hmac)
 * expiry:        4 hours from issue (enough for any order lifecycle)
 *
 * Validation allows access if EITHER:
 *   1. Valid signed token is present
 *   2. Authenticated user is the order's customer / owner / delivery_partner
 */

import crypto from 'crypto';

function getSecret(): string {
  const secret = process.env.TRACKING_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL SECURITY ERROR: TRACKING_TOKEN_SECRET or JWT_SECRET must be set in production.');
    }
    return 'olive-tracking-dev-secret-only';
  }
  return secret;
}

const EXPIRY_HOURS = 4;

/**
 * Generate a signed tracking token for a given orderId.
 * Returns a URL-safe base64 string to append as ?trackingToken=<token>
 */
export function generateTrackingToken(orderId: string): string {
  const exp = Math.floor(Date.now() / 1000) + EXPIRY_HOURS * 3600;
  const payload = `${orderId}:${exp}`;
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  const raw = `${payload}:${hmac}`;
  return Buffer.from(raw).toString('base64url');
}

/**
 * Verify a tracking token.
 * Returns the orderId if valid, null if invalid or expired.
 */
export function verifyTrackingToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 3) return null;

    const [orderId, expStr, providedHmac] = parts;
    const exp = parseInt(expStr, 10);

    if (isNaN(exp) || Date.now() / 1000 > exp) return null; // expired

    const expectedHmac = crypto.createHmac('sha256', getSecret()).update(`${orderId}:${expStr}`).digest('hex');
    const providedHmacBuf = Buffer.from(providedHmac, 'utf8');
    const expectedHmacBuf = Buffer.from(expectedHmac, 'utf8');
    if (providedHmacBuf.length !== expectedHmacBuf.length) return null;
    if (!crypto.timingSafeEqual(providedHmacBuf, expectedHmacBuf)) return null;

    return orderId;
  } catch {
    return null;
  }
}
