import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// ============================================================================
// 1. RATE LIMITERS (Configurable via Environment Variables)
// ============================================================================

const getEnvNumber = (key: string, defaultValue: number): number => {
  const val = process.env[key];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) return parsed;
  }
  const isDev = process.env.NODE_ENV !== 'production';
  return isDev ? defaultValue * 10 : defaultValue;
};

export const getClientIp = (req: Request): string => {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) {
    return cfIp.trim();
  }
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim();
  }
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
};

// Auth Limiter: Login, Signup, OTP Sending, Phone Verification, Truecaller
export const authLimiter = rateLimit({
  windowMs: getEnvNumber('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 mins
  max: getEnvNumber('AUTH_RATE_LIMIT_MAX', 60), // Max 60 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again after 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

// OTP Limiter: Stricter limit on SMS sending to prevent gateway exhaustion
export const otpLimiter = rateLimit({
  windowMs: getEnvNumber('OTP_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000), // 10 mins
  max: getEnvNumber('OTP_RATE_LIMIT_MAX', 5), // Max 5 OTP requests per 10 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Too many OTP requests. Please wait 10 minutes before requesting again.',
    code: 'OTP_RATE_LIMIT_EXCEEDED'
  }
});

// Public Limiter: Menu, Search, Categories, SEO, Public Offers
export const publicLimiter = rateLimit({
  windowMs: getEnvNumber('PUBLIC_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 mins
  max: getEnvNumber('PUBLIC_RATE_LIMIT_MAX', 300), // 300 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Too many requests to public API. Please slow down.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

// User Limiter: Authenticated Cart, Orders, Profile, Reviews, Notifications
export const userLimiter = rateLimit({
  windowMs: getEnvNumber('USER_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 mins
  max: getEnvNumber('USER_RATE_LIMIT_MAX', 200), // 200 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Too many user actions. Please wait a moment before trying again.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

// Admin / Owner Limiter: Management, Delivery Zone, Users, Coupons
export const adminLimiter = rateLimit({
  windowMs: getEnvNumber('ADMIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 mins
  max: getEnvNumber('ADMIN_RATE_LIMIT_MAX', 150), // 150 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Too many admin operations. Please slow down.',
    code: 'RATE_LIMIT_EXCEEDED'
  }
});

// Expensive Operations Limiter: AI Chat, PDF Report Gen, Drive Upload, Broadcast Push
export const expensiveLimiter = rateLimit({
  windowMs: getEnvNumber('EXPENSIVE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), // 15 mins
  max: getEnvNumber('EXPENSIVE_RATE_LIMIT_MAX', 20), // 20 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => getClientIp(req),
  message: {
    success: false,
    error: 'Heavy resource quota exceeded. Please wait a few minutes before trying again.',
    code: 'QUOTA_EXCEEDED'
  }
});


// ============================================================================
// 2. INPUT VALIDATION SCHEMAS (ZOD)
// ============================================================================

export const Schemas = {
  // Auth & Phone
  sendOtp: z.object({
    phoneNumber: z.string().trim().min(3, 'Invalid phone number format'), // 🚨 BYPASS: Relaxed for fake numbers
  }),

  verifyOtp: z.object({
    phoneNumber: z.string().trim().min(3, 'Invalid phone number format'), // 🚨 BYPASS: Relaxed for fake numbers
    otp: z.string().trim().min(4, 'OTP must be at least 4 digits'), // 🚨 BYPASS: Relaxed for fake OTPs
  }),

  login: z.object({
    email: z.string().email('Invalid email address').optional(),
    phone: z.string().optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  }),

  // Orders
  createOrder: z.object({
    items: z.array(z.object({
      id: z.string().min(1, 'Item ID required'),
      name: z.string().min(1, 'Item name required'),
      price: z.number().positive('Price must be positive'),
      quantity: z.number().int().positive('Quantity must be at least 1'),
      customizations: z.any().optional(),
    })).min(1, 'Order must contain at least 1 item'),
    totalAmount: z.number().positive('Total amount must be positive'),
    paymentMethod: z.enum(['COD', 'UPI', 'CARD', 'WALLET']).default('COD'),
    deliveryType: z.enum(['delivery', 'pickup']).default('delivery'),
    deliveryAddress: z.union([
      z.string(),
      z.object({
        addressLine: z.string().min(1),
        lat: z.number().optional(),
        lng: z.number().optional(),
        houseNumber: z.string().optional(),
        apartment: z.string().optional(),
        landmark: z.string().optional(),
        instructions: z.string().optional(),
      })
    ]).optional(),
    contactPhone: z.string().optional(),
    customerName: z.string().optional(),
  }),

  // Owner Notifications Broadcast
  customNotification: z.object({
    title: z.string().trim().min(2, 'Title must be at least 2 characters').max(100, 'Title too long'),
    message: z.string().trim().min(2, 'Message must be at least 2 characters').max(500, 'Message too long'),
    targetAudience: z.enum(['customers', 'delivery', 'owners', 'all', 'specific']).default('all'),
    targetUser: z.string().optional(),
    category: z.string().optional(),
    deepLink: z.string().optional(),
    actionUrl: z.string().optional(),
  }),

  // Reviews
  createReview: z.object({
    orderId: z.string().min(1, 'Order ID required'),
    rating: z.number().min(1).max(5),
    comment: z.string().max(500, 'Comment max 500 chars').optional(),
  })
};

// ============================================================================
// 3. EXPRESS VALIDATION MIDDLEWARE HELPER
// ============================================================================

export const validateBody = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errorDetails = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
      res.status(400).json({
        success: false,
        error: 'Invalid request data',
        details: errorDetails,
        code: 'VALIDATION_ERROR'
      });
      return;
    }
    req.body = result.data; // Assign validated & sanitized data
    next();
  };
};

export const validateQuery = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errorDetails = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
      res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        details: errorDetails,
        code: 'VALIDATION_ERROR'
      });
      return;
    }
    req.query = result.data as any;
    next();
  };
};
