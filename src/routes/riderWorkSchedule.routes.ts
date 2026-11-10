import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { adminDb } from '../config/firebase.js';
import { RiderWorkScheduleService } from '../services/delivery/RiderWorkScheduleService.js';

const router = Router();
router.use(verifyToken);
router.use(requireRole(['delivery_partner', 'delivery', 'rider']));

async function requireActiveRider(req: AuthRequest, res: Response): Promise<string | null> {
  const uid = req.user?.uid;
  if (!uid) {
    res.status(401).json({ success: false, error: 'Sign in is required.' });
    return null;
  }

  const [userSnap, riderSnap] = await Promise.all([
    adminDb.collection('users').doc(uid).get(),
    adminDb.collection('delivery_partners').doc(uid).get().catch(() => null)
  ]);
  const user = userSnap.exists ? userSnap.data() : {};
  const rider = riderSnap?.exists ? riderSnap.data() : {};
  const role = String(user?.role || rider?.role || req.user?.role || '').toLowerCase();
  const active = user?.isActive !== false && rider?.isActive !== false &&
    !['disabled', 'deactivated', 'rejected', 'revoked'].includes(String(user?.status || rider?.status || '').toLowerCase());

  if (!userSnap.exists && !riderSnap?.exists) {
    res.status(403).json({ success: false, error: 'No delivery partner profile is linked to this account.' });
    return null;
  }
  if (!['delivery_partner', 'delivery', 'rider'].includes(role) || !active) {
    res.status(403).json({ success: false, error: 'An active, authorized delivery partner account is required.' });
    return null;
  }
  return uid;
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
