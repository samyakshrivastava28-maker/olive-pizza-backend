import { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';

dotenv.config();

const TURNSTILE_SECRET_KEY = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 🛡️ Cloudflare Turnstile Server-Side Verification Middleware
 * 
 * Protects sensitive public routes (OTP sending, user registration, public contact)
 * against automated bots, credential stuffing, and SMS toll fraud.
 */
export async function verifyTurnstile(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Bypass check for Local Development or Disabled Flag
  if (process.env.NODE_ENV !== 'production' && !process.env.FORCE_TURNSTILE_CHECK) {
    return next();
  }

  // 2. Bypass check for Native Mobile Container (Capacitor sends verified platform header or auth token)
  const isCapacitor = req.headers['x-platform'] === 'capacitor' || req.headers['x-requested-with'] === 'in.olivepizza.app';
  if (isCapacitor) {
    return next();
  }

  // If secret key is not configured, warn and allow (graceful degradation)
  if (!TURNSTILE_SECRET_KEY) {
    console.warn('[Turnstile] ⚠️ CLOUDFLARE_TURNSTILE_SECRET_KEY is not set. Allowing request in degraded mode.');
    return next();
  }

  const token = req.body?.turnstileToken || req.headers['cf-turnstile-response'] || req.body?.['cf-turnstile-response'];

  if (!token) {
    res.status(400).json({
      success: false,
      error: 'Security challenge token is required. Please complete the Turnstile verification.',
      code: 'TURNSTILE_TOKEN_MISSING'
    });
    return;
  }

  try {
    const clientIp = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', String(token));
    if (clientIp) {
      formData.append('remoteip', String(clientIp).split(',')[0].trim());
    }

    const verifyRes = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const outcome: any = await verifyRes.json();

    if (outcome.success) {
      return next();
    } else {
      console.warn('[Turnstile] Verification failed:', outcome['error-codes']);
      res.status(403).json({
        success: false,
        error: 'Security verification failed. Please try again.',
        code: 'TURNSTILE_VERIFICATION_FAILED',
        errorCodes: outcome['error-codes']
      });
      return;
    }
  } catch (err: any) {
    console.error('[Turnstile] Server verification error:', err.message);
    // Gracefully fail open or closed based on strictness; default allow with warning
    if (process.env.TURNSTILE_FAIL_CLOSED === 'true') {
      res.status(503).json({
        success: false,
        error: 'Security challenge service temporarily unavailable.',
        code: 'TURNSTILE_SERVICE_ERROR'
      });
      return;
    }
    return next();
  }
}