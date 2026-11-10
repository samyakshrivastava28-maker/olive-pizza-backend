import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware.js';
import { adminDb } from '../config/firebase.js';
import { RedisService } from '../services/redis/RedisService.js';

interface CachedResponse {
  status: number;
  body: any;
  timestamp: string;
  inFlight: boolean;
}

// In-memory fallback map for sub-second rapid duplicate clicks
const inMemoryCache = new Map<string, CachedResponse>();

// Clean up local in-memory cache periodically (retain for 15 minutes locally)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of inMemoryCache.entries()) {
    const age = now - new Date(v.timestamp).getTime();
    if (age > 15 * 60 * 1000) {
      inMemoryCache.delete(k);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * IdempotencyMiddleware ensures that requests with an `Idempotency-Key` header
 * are executed at most once, preventing duplicate billing, order creation, or transactions.
 */
export function idempotency(options: { ttlSeconds?: number } = {}) {
  const ttlSeconds = options.ttlSeconds || 86400; // default 24 hours

  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = (req.headers['idempotency-key'] || req.headers['x-idempotency-key']) as string;

    if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
      // If no idempotency key provided, proceed normally
      next();
      return;
    }

    const idempotencyKey = rawKey.trim();
    const userId = req.user?.uid || req.ip || 'anonymous';
    const compositeKey = `${userId}:${idempotencyKey}`;

    // 0. Redis Fast Replay & Distributed Atomic Lock
    if (RedisService.isAvailable()) {
      try {
        const cachedPayload = await RedisService.get(`idemp_res:${compositeKey}`);
        if (cachedPayload) {
          const parsed = JSON.parse(cachedPayload);
          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(parsed.status).send(parsed.body);
          return;
        }

        const acquired = await RedisService.checkAndSetIdempotency(`idemp_lock:${compositeKey}`, 120);
        if (!acquired) {
          res.status(409).json({
            error: 'A request with this Idempotency-Key is currently being processed. Please wait.',
            code: 'IDEMPOTENT_REQUEST_IN_FLIGHT'
          });
          return;
        }
      } catch (redisErr) {
        console.warn('[Idempotency] Redis check error, proceeding to storage fallback:', redisErr);
      }
    }

    // 1. Fast path: check in-memory cache
    const memoryRecord = inMemoryCache.get(compositeKey);
    if (memoryRecord) {
      if (memoryRecord.inFlight) {
        res.status(409).json({
          error: 'A request with this Idempotency-Key is currently being processed. Please wait.',
          code: 'IDEMPOTENT_REQUEST_IN_FLIGHT'
        });
        return;
      }
      res.setHeader('X-Idempotent-Replay', 'true');
      res.status(memoryRecord.status).send(memoryRecord.body);
      return;
    }

    // 2. Authoritative check: Firestore collection 'idempotency_keys'
    try {
      const docRef = adminDb.collection('idempotency_keys').doc(compositeKey);
      const docSnap = await docRef.get();

      if (docSnap.exists) {
        const data = docSnap.data() as CachedResponse;
        if (data.inFlight) {
          res.status(409).json({
            error: 'A request with this Idempotency-Key is currently being processed. Please wait.',
            code: 'IDEMPOTENT_REQUEST_IN_FLIGHT'
          });
          return;
        }

        // Cache hit from Firestore
        inMemoryCache.set(compositeKey, data);
        res.setHeader('X-Idempotent-Replay', 'true');
        res.status(data.status).send(data.body);
        return;
      }

      // 3. Mark as in-flight
      const initialRecord: CachedResponse = {
        status: 0,
        body: null,
        timestamp: new Date().toISOString(),
        inFlight: true
      };

      inMemoryCache.set(compositeKey, initialRecord);
      await docRef.set({
        ...initialRecord,
        userId,
        route: req.originalUrl || req.url,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
      }).catch(err => console.warn('[Idempotency] Could not mark in-flight in Firestore:', err));

      // 4. Intercept response to store result
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);

      let captured = false;
      const captureAndStore = (body: any, status: number) => {
        if (captured) return;
        captured = true;

        const finalizedRecord: CachedResponse = {
          status,
          body,
          timestamp: new Date().toISOString(),
          inFlight: false
        };

        inMemoryCache.set(compositeKey, finalizedRecord);
        if (RedisService.isAvailable()) {
          RedisService.set(`idemp_res:${compositeKey}`, JSON.stringify(finalizedRecord), Math.min(ttlSeconds, 86400)).catch(() => {});
        }
        docRef.set({
          ...finalizedRecord,
          userId,
          route: req.originalUrl || req.url,
          completedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
        }, { merge: true }).catch(err => console.warn('[Idempotency] Could not persist response in Firestore:', err));
      };

      res.json = function (body: any) {
        captureAndStore(body, res.statusCode);
        return originalJson(body);
      };

      res.send = function (body: any) {
        captureAndStore(body, res.statusCode);
        return originalSend(body);
      };

      next();
    } catch (err) {
      console.warn('[Idempotency] Middleware error, passing through:', err);
      next();
    }
  };
}
