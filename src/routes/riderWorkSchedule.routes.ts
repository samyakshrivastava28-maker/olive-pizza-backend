import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { adminDb } from '../config/firebase.js';
import { RiderWorkScheduleService } from '../services/delivery/RiderWorkScheduleService.js';

import { pgPool } from '../config/postgres.js';

const router = Router();
router.use(verifyToken);
router.use(requireRole(['delivery_partner', 'delivery', 'rider']));

async function requireActiveRider(req: AuthRequest, res: Response): Promise<string | null> {
  const uid = req.user?.uid;
  if (!uid) {
    res.status(401).json({ success: false, error: 'Sign in is required.' });
    return null;
  }

  // 1. Authoritative Primary Check: PostgreSQL app_users and delivery_partners
  try {
    const pgUser = await pgPool.query(
      `SELECT id, role, is_active, allowed_apps FROM app_users WHERE id = $1 LIMIT 1`,
      [uid]
    );
    if (pgUser.rows.length > 0) {
      const u = pgUser.rows[0];
      const role = String(u.role || '').toLowerCase();
      const apps = Array.isArray(u.allowed_apps) ? u.allowed_apps.map((a: string) => String(a).toUpperCase()) : [];
      if (u.is_active !== false && (['delivery_partner', 'delivery', 'rider'].includes(role) || apps.includes('DELIVERY'))) {
        return uid;
      }
    }

    const pgRider = await pgPool.query(
      `SELECT id, status, is_online FROM delivery_partners WHERE id = $1 OR user_id = $1 LIMIT 1`,
      [uid]
    );
    if (pgRider.rows.length > 0) {
      const r = pgRider.rows[0];
      if (r.status !== 'REJECTED' && r.status !== 'REVOKED' && r.status !== 'DEACTIVATED') {
        return uid;
      }
    }
  } catch (pgErr: any) {
    console.warn('[RiderWorkSchedule] PostgreSQL rider check notice:', pgErr.message);
  }

  // 2. Secondary Fallback: Firestore
  try {
    const [userSnap, riderSnap] = await Promise.all([
      adminDb.collection('users').doc(uid).get().catch(() => null),
      adminDb.collection('delivery_partners').doc(uid).get().catch(() => null)
    ]);
    const user = userSnap?.exists ? userSnap.data() : {};
    const rider = riderSnap?.exists ? riderSnap.data() : {};
    const role = String(user?.role || rider?.role || req.user?.role || '').toLowerCase();
    const active = user?.isActive !== false && rider?.isActive !== false &&
      !['disabled', 'deactivated', 'rejected', 'revoked'].includes(String(user?.status || rider?.status || '').toLowerCase());

    if (['delivery_partner', 'delivery', 'rider'].includes(role) && active) {
      return uid;
    }
  } catch (fsErr: any) {
    console.warn('[RiderWorkSchedule] Firestore rider check notice:', fsErr.message);
  }

  res.status(403).json({ success: false, error: 'An active, authorized delivery partner account is required.' });
  return null;
}

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = await requireActiveRider(req, res);
    if (!uid) return;
    const schedule = await RiderWorkScheduleService.getSchedule(uid);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, schedule });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || 'Could not load your work schedule.' });
  }
});

router.put('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = await requireActiveRider(req, res);
    if (!uid) return;
    const schedule = await RiderWorkScheduleService.saveSchedule(uid, req.body || {});
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, schedule, message: 'Your weekly work schedule was saved.' });
  } catch (error: any) {
    const message = error?.message || 'Could not save your work schedule.';
    res.status(400).json({ success: false, error: message });
  }
});

router.post('/continue', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = await requireActiveRider(req, res);
    if (!uid) return;
    const minutes = Number(req.body?.minutes);
    const result = await RiderWorkScheduleService.extendWork(uid, minutes);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...result, message: 'Your work time has been extended.' });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Could not extend your work time.' });
  }
});

export default router;
