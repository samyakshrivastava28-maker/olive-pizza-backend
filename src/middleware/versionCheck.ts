import { Request, Response, NextFunction } from 'express';
import { adminDb } from '../config/firebase.js';
import semver from 'semver';

// Cache settings for a short time to avoid hitting the DB on every single request
let cachedSettings: any = null;
let lastCheckTime = 0;
const CACHE_TTL = 30000; // 30 seconds

export const versionCheck = async (req: Request, res: Response, next: NextFunction) => {
  const clientVersion = req.headers['x-app-version'] as string;
  const clientPlatform = req.headers['x-platform'] as string || 'web';
  
  // Skip version check for certain endpoints
  if (req.path.startsWith('/health') || req.path.startsWith('/version')) {
    return next();
  }

  try {
    const now = Date.now();
    if (!cachedSettings || now - lastCheckTime > CACHE_TTL) {
      lastCheckTime = now;
      try {
        const doc = await adminDb.collection('settings').doc('app_update').get();
        if (doc.exists) {
          cachedSettings = doc.data();
        }
      } catch (dbErr: any) {
        // When Firestore quota is exceeded or offline, fallback safely without hanging subsequent requests
        if (!cachedSettings) {
          cachedSettings = { minimum_version: '1.0.0', maintenance_mode: false };
        }
      }
    }

    if (cachedSettings && clientVersion) {
      const minVersion = cachedSettings.minimum_version;
      const updateMode = cachedSettings.update_mode;

      // If client version is less than minimum supported, force upgrade
      if (semver.valid(clientVersion) && semver.valid(minVersion)) {
        if (semver.lt(clientVersion, minVersion)) {
          return res.status(426).json({
            error: 'Upgrade Required',
            message: 'Your version of Olive Pizza is no longer supported. Please update to the latest version.',
            latestVersion: cachedSettings.latest_version,
            updateMode: 'required'
          });
        }
      }
    }

    // Maintenance mode check
    if (cachedSettings?.maintenance_mode && req.path !== '/admin/maintenance') {
        return res.status(503).json({
            error: 'Maintenance',
            message: 'System is under maintenance. Please try again later.'
        });
    }

  } catch (err) {
    console.error('Version check error:', err);
  }

  next();
};
