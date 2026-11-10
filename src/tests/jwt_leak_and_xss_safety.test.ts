/**
 * jwt_leak_and_xss_safety.test.ts
 *
 * Phase 91 (JWT / Auth Token Leak Safety) & Phase 92 (XSS / CSRF Attack Safety)
 * Verification Test Suite for Olive Pizza Ecosystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveData, sanitizeHeaders, sanitizeError } from '../utils/logSanitizer.js';
import { escapeHtml, escapeHtmlObject } from '../utils/escapeHtml.js';
import { verifyToken, optionalAuth } from '../middleware/auth.middleware.js';

describe('Phase 91: JWT & Auth Token Leak Safety', () => {
  it('should redact raw JWT string patterns from arbitrary logs and messages', () => {
    const rawJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const logMessage = `User login failed with token: ${rawJwt}`;
    const sanitized = redactSensitiveData(logMessage);

    assert.ok(!sanitized.includes(rawJwt), 'Raw JWT should not be present in sanitized output');
    assert.ok(sanitized.includes('[REDACTED_JWT]'), 'Sanitized output should indicate redacted JWT');
  });

  it('should redact Bearer authorization headers and embedded Bearer tokens', () => {
    const bearerStr = 'Authorization: Bearer mock_firebase_id_token_1234567890';
    const sanitized = redactSensitiveData(bearerStr);

    assert.ok(!sanitized.includes('mock_firebase_id_token_1234567890'), 'Bearer token value must be stripped');
    assert.ok(sanitized.includes('Bearer [REDACTED_TOKEN]'), 'Should contain Bearer [REDACTED_TOKEN]');
  });

  it('should redact sensitive keys recursively in complex JSON structures', () => {
    const sensitivePayload = {
      orderId: 'ORD_101',
      customer: {
        name: 'Rahul',
        authorization: 'Bearer secret_token_xyz',
        idToken: 'token_abc123',
        password: 'PlainTextPassword123!',
        apiKey: 'SECRET_API_KEY_999'
      },
      headers: {
        cookie: 'session_id=abcdef123456; path=/',
        authorization: 'Bearer sensitive_auth'
      },
      items: [
        { name: 'Veggie Pizza', price: 299, token: 'item_token_leak' }
      ]
    };

    const redacted = redactSensitiveData(sensitivePayload);

    assert.equal(redacted.customer.authorization, '[REDACTED]');
    assert.equal(redacted.customer.idToken, '[REDACTED]');
    assert.equal(redacted.customer.password, '[REDACTED]');
    assert.equal(redacted.customer.apiKey, '[REDACTED]');
    assert.equal(redacted.headers.cookie, '[REDACTED]');
    assert.equal(redacted.headers.authorization, '[REDACTED]');
    assert.equal(redacted.items[0].token, '[REDACTED]');
    // Unsensitive fields remain intact
    assert.equal(redacted.orderId, 'ORD_101');
    assert.equal(redacted.customer.name, 'Rahul');
    assert.equal(redacted.items[0].name, 'Veggie Pizza');
  });

  it('should sanitize HTTP headers removing authorization and cookie headers', () => {
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer super_secret_token',
      cookie: 'jwt=secret_value; session=123',
      host: 'api.olivepizza.in'
    };

    const sanitized = sanitizeHeaders(headers);
    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized.cookie, '[REDACTED]');
    assert.equal(sanitized['content-type'], 'application/json');
    assert.equal(sanitized.host, 'api.olivepizza.in');
  });

  it('should sanitize Error objects to strip tokens and sensitive query parameters', () => {
    const error = new Error('Request to https://api.olivepizza.in/orders?token=leaked_jwt_123 failed');
    const sanitized = sanitizeError(error);

    assert.ok(!sanitized.message.includes('token=leaked_jwt_123'), 'Error message must not include URL query token');
    assert.ok(sanitized.message.includes('[REDACTED]'), 'Error message should contain redacted marker');
  });

  it('verifyToken middleware MUST strictly reject tokens passed via query strings with 400 Bad Request', async () => {
    let statusCalled: number | null = null;
    let jsonCalled: any = null;

    const mockReq: any = {
      headers: {},
      query: { token: 'malicious_query_param_token' },
      originalUrl: '/api/v1/orders?token=malicious_query_param_token'
    };
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return {
          json: (body: any) => { jsonCalled = body; }
        };
      }
    };
    const mockNext = () => {
      assert.fail('next() must not be called when token is in query string');
    };

    await verifyToken(mockReq, mockRes, mockNext);

    assert.equal(statusCalled, 400, 'Should return HTTP 400 Bad Request');
    assert.equal(jsonCalled?.code, 'TOKEN_IN_QUERY_FORBIDDEN');
  });

  it('optionalAuth middleware MUST strictly reject tokens passed via query strings with 400 Bad Request', async () => {
    let statusCalled: number | null = null;
    let jsonCalled: any = null;

    const mockReq: any = {
      headers: {},
      query: { idToken: 'malicious_idToken' },
      originalUrl: '/api/v1/home/bootstrap?idToken=malicious_idToken'
    };
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return {
          json: (body: any) => { jsonCalled = body; }
        };
      }
    };
    const mockNext = () => {
      assert.fail('next() must not be called when token is in query string');
    };

    await optionalAuth(mockReq, mockRes, mockNext);

    assert.equal(statusCalled, 400, 'Should return HTTP 400 Bad Request');
    assert.equal(jsonCalled?.code, 'TOKEN_IN_QUERY_FORBIDDEN');
  });

  it('verifyToken middleware returns 401 when no token is provided in Authorization header', async () => {
    let statusCalled: number | null = null;
    let jsonCalled: any = null;

    const mockReq: any = {
      headers: {},
      query: {}
    };
    const mockRes: any = {
      status: (code: number) => {
        statusCalled = code;
        return {
          json: (body: any) => { jsonCalled = body; }
        };
      }
    };
    const mockNext = () => {
      assert.fail('next() should not be called without token');
    };

    await verifyToken(mockReq, mockRes, mockNext);

    assert.equal(statusCalled, 401);
    assert.ok(jsonCalled?.error.includes('No token provided'));
  });
});

describe('Phase 92: XSS & HTML Injection Safety', () => {
  it('should escape dangerous HTML characters to prevent script injection', () => {
    const rawInput = '<script>alert("XSS")</script>';
    const escaped = escapeHtml(rawInput);

    assert.equal(escaped, '&lt;script&gt;alert(&quot;XSS&quot;)&lt;&#x2F;script&gt;');
    assert.ok(!escaped.includes('<script>'), 'Must not contain unescaped script tag');
  });

  it('should escape attribute injection vectors (quotes and ampersands)', () => {
    const maliciousAttr = `" onfocus="alert('pwned')" & href="javascript:alert(1)`;
    const escaped = escapeHtml(maliciousAttr);

    assert.ok(!escaped.includes('"'));
    assert.ok(!escaped.includes("'"));
    assert.ok(escaped.includes('&quot;'));
    assert.ok(escaped.includes('&#x27;'));
    assert.ok(escaped.includes('&amp;'));
  });

  it('escapeHtmlObject should recursively sanitize all string fields in complex order receipt objects', () => {
    const orderData = {
      customerName: '<img src=x onerror=alert(1)> John',
      deliveryAddress: '123 Fake Street <script>bad()</script>',
      items: [
        {
          name: 'Cheesy Pizza <b onmouseover=evil()>',
          addons: ['Extra Cheese <script>', 'Jalapeno']
        }
      ]
    };

    const sanitized = escapeHtmlObject(orderData);

    assert.ok(!sanitized.customerName.includes('<img'));
    assert.ok(!sanitized.deliveryAddress.includes('<script'));
    assert.ok(!sanitized.items[0].name.includes('<b'));
    assert.ok(!sanitized.items[0].addons[0].includes('<script'));
    assert.ok(sanitized.customerName.includes('&lt;img'));
    assert.ok(sanitized.items[0].addons[0].includes('&lt;script&gt;'));
  });

  it('should handle null and undefined safely without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtmlObject(null), null);
    assert.equal(escapeHtmlObject(undefined), undefined);
  });
});
