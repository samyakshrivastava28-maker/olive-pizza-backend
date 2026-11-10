import { Router, Response } from 'express';
import { adminDb, adminAuth } from '../config/firebase.js';
import { AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

const optionalAuth = async (req: AuthRequest, res: Response, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = authHeader.split('Bearer ')[1];
    const decoded = await adminAuth.verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: decoded.role || 'user'
    } as any;
  } catch {}
  next();
};

/**
 * Validates the device identity UUID and appType.
 */
function sanitizeParams(appType: any, deviceId: any): { valid: boolean; error?: string; cleanAppType?: string; cleanDeviceId?: string } {
  if (!appType || typeof appType !== 'string') {
    return { valid: false, error: 'appType is required and must be a string (RESTAURANT_MANAGER, DELIVERY, or POS)' };
  }
  const cleanAppType = appType.trim().toUpperCase();
  if (!['RESTAURANT_MANAGER', 'DELIVERY', 'POS'].includes(cleanAppType)) {
    return { valid: false, error: 'Invalid appType. Must be RESTAURANT_MANAGER, DELIVERY, or POS' };
  }

  if (!deviceId || typeof deviceId !== 'string') {
    return { valid: false, error: 'deviceId is required and must be a unique device identifier string' };
  }
  const cleanDeviceId = deviceId.trim();
  if (cleanDeviceId.length < 8 || cleanDeviceId.length > 128) {
    return { valid: false, error: 'deviceId must be between 8 and 128 characters' };
  }

  return { valid: true, cleanAppType, cleanDeviceId };
}

/**
 * GET /api/device/alarm-settings?appType=...&deviceId=...
 * Retrieves device-specific alarm setting. Defaults to true if never explicitly set.
 */
router.get('/alarm-settings', optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { appType, deviceId } = req.query;
    const check = sanitizeParams(appType, deviceId);
    if (!check.valid) {
      res.status(400).json({ success: false, error: check.error });
      return;
    }

    if (!adminDb) {
      res.json({ success: true, deviceId: check.cleanDeviceId, appType: check.cleanAppType, alarmEnabled: true });
      return;
    }

    const docKey = `${check.cleanAppType}_${check.cleanDeviceId}`;
    const docSnap = await adminDb.collection('device_alarm_settings').doc(docKey).get();

    if (!docSnap.exists) {
      res.json({
        success: true,
        deviceId: check.cleanDeviceId,
        appType: check.cleanAppType,
        alarmEnabled: true,
        isDefault: true
      });
      return;
    }

    const data = docSnap.data()!;
    res.json({
      success: true,
      deviceId: check.cleanDeviceId,
      appType: check.cleanAppType,
      alarmEnabled: data.alarmEnabled !== false,
      updatedAt: data.updatedAt || null
    });
  } catch (error: any) {
    console.error('[DeviceAlarm] Get error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve device alarm settings' });
  }
});

/**
 * PUT /api/device/alarm-settings
 * Updates device-specific alarm setting. Keyed by appType + deviceId.
 * Independent across physical devices, even if logged in with the same user account.
 */
router.put('/alarm-settings', optionalAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { appType, deviceId, alarmEnabled } = req.body;
    const check = sanitizeParams(appType, deviceId);
    if (!check.valid) {
      res.status(400).json({ success: false, error: check.error });
      return;
    }

    if (typeof alarmEnabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'alarmEnabled must be a boolean (true or false)' });
      return;
    }

    if (!adminDb) {
      res.status(503).json({ success: false, error: 'Database service unavailable' });
      return;
    }

    const docKey = `${check.cleanAppType}_${check.cleanDeviceId}`;
    const payload = {
      deviceId: check.cleanDeviceId,
      appType: check.cleanAppType,
      alarmEnabled,
      updatedByUid: req.user?.uid || 'unknown',
      updatedByEmail: req.user?.email || 'unknown',
      updatedAt: new Date().toISOString()
    };

    await adminDb.collection('device_alarm_settings').doc(docKey).set(payload, { merge: true });

    res.json({
      success: true,
      message: `Alarm ${alarmEnabled ? 'enabled' : 'disabled'} for this physical device.`,
      deviceId: check.cleanDeviceId,
      appType: check.cleanAppType,
      alarmEnabled,
      updatedAt: payload.updatedAt
    });
  } catch (error: any) {
    console.error('[DeviceAlarm] Put error:', error);
    res.status(500).json({ success: false, error: 'Failed to update device alarm settings' });
  }
});

export default router;
