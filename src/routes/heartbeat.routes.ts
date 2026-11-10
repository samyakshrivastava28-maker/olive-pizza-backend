import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { heartbeatService } from '../services/HeartbeatService.js';

const router = Router();

// Public heartbeat check for frontend header status indicator
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Olive Pizza Owner Backend Service',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

router.post('/', requireAuth, async (req: any, res) => {
  try {
    const userId = req.user.uid;
    await heartbeatService.recordHeartbeat(userId, req.body);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ success: false, error: 'Failed to record heartbeat' });
  }
});

router.get('/devices', requireAuth, async (req: any, res) => {
  try {
    const userId = req.user.uid;
    const devices = await heartbeatService.getActiveDevices(userId);
    res.status(200).json({ success: true, devices });
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ success: false, error: 'Failed to get devices' });
  }
});

export default router;
