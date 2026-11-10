/**
 * requireDeveloper — Authoritative Developer / DevOps Route Guard
 *
 * Enforces:
 *   1. Cryptographically valid Firebase ID token (Bearer in Authorization header)
 *   2. PostgreSQL verification: account must exist in `app_users` where `id = uid`,
 *      `role IN ('platform_owner', 'developer')`, `status = 'APPROVED'`, and `is_active = true`.
 *   3. Zero email string matching, zero client-side claims bypass.
 */
import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../config/firebase.js';
import { query } from '../config/postgres.js';
import { logSecurityEventServer } from './auth.middleware.js';

export interface DevRequest extends Request {
  developer?: {
    uid: string;
    email: string;
    role: string;
  };
}

export const requireDeveloper = async (
  req: DevRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  const ip = req.ip || 'unknown';

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: No token provided' });
    return;
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;

    // Authoritative PostgreSQL lookup by verified Firebase UID
    const userRes = await query(
      `SELECT id, email, role, status, is_active
       FROM app_users
       WHERE id = $1
       LIMIT 1`,
      [uid]
    );

    if (userRes.rows.length === 0) {
      await logSecurityEventServer({
        action: 'devops_access_denied_account_not_found',
        route: req.originalUrl,
        uid,
        email: decoded.email,
        ip,
      });
      res.status(403).json({ error: 'Forbidden: Developer access strictly restricted to authorized platform administrators' });
      return;
    }

    const user = userRes.rows[0];

    if (!user.is_active || user.status !== 'APPROVED' || !['platform_owner', 'developer'].includes((user.role || '').toLowerCase())) {
      await logSecurityEventServer({
        action: 'devops_access_denied_insufficient_role',
        route: req.originalUrl,
        uid,
        email: decoded.email,
        ip,
      });
      res.status(403).json({ error: 'Forbidden: Insufficient platform privileges for developer routes' });
      return;
    }

    req.developer = { uid: user.id, email: user.email || decoded.email || '', role: user.role };
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};
