import express from 'express';
import { adminDb, adminMessaging } from '../config/firebase.js';
import { query } from '../lib/db.js';
import { execSync } from 'child_process';

const router = express.Router();

// Check version update (public)
router.get('/check', async (req, res) => {
  try {
    const clientVersion = (req.query.version as string) || '1.0.0';
    const currentVersion = process.env.npm_package_version || '1.0.0';
    const isUpdateAvailable = clientVersion !== currentVersion;
    res.json({
      latestVersion: currentVersion,
      clientVersion,
      updateAvailable: isUpdateAvailable,
      mandatory: false,
      releaseNotes: 'Enjoy a faster experience, improved ordering and new features.',
      downloadUrl: 'https://github.com/samyakshrivastava28-maker/Olive-Pizza/releases/latest',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get version settings (public) - Authoritative source: Firestore settings/app_update
router.get('/settings', async (req, res) => {
  try {
    const doc = await adminDb.collection('settings').doc('app_update').get();
    if (doc.exists) {
      const data = doc.data() || {};
      return res.json({
        id: 1,
        latest_version: data.latest_version || process.env.npm_package_version || '1.0.0',
        minimum_version: data.minimum_version || '1.0.0',
        update_mode: data.update_mode || 'optional',
        mandatory_update: Boolean(data.mandatory_update),
        maintenance_mode: Boolean(data.maintenance_mode),
        release_notes: data.release_notes || 'Enjoy a faster experience, improved ordering and new features.',
        release_date: data.release_date || new Date().toISOString(),
        download_url: data.download_url || 'https://github.com/samyakshrivastava28-maker/Olive-Pizza/releases/latest',
      });
    }
  } catch (err: any) {
    // Firestore read fallback
  }

  // Fallback to PostgreSQL or default app settings
  try {
    const { pgPool } = await import('../config/postgres.js');
    const pgRes = await pgPool.query("SELECT * FROM platform_configs WHERE key = 'app_update_settings' LIMIT 1").catch(() => null);
    if (pgRes && pgRes.rows && pgRes.rows[0]) {
      const cfg = pgRes.rows[0].value;
      return res.json({
        id: 1,
        latest_version: cfg.latest_version || process.env.npm_package_version || '1.0.0',
        minimum_version: cfg.minimum_version || '1.0.0',
        update_mode: cfg.update_mode || 'optional',
        mandatory_update: Boolean(cfg.mandatory_update),
        maintenance_mode: Boolean(cfg.maintenance_mode),
        release_notes: cfg.release_notes || 'Enjoy a faster experience, improved ordering and new features.',
        release_date: cfg.release_date || new Date().toISOString(),
        download_url: 'https://github.com/samyakshrivastava28-maker/Olive-Pizza/releases/latest',
      });
    }
  } catch {}

  res.json({
    id: 1,
    latest_version: process.env.npm_package_version || '1.0.0',
    minimum_version: '1.0.0',
    update_mode: 'optional',
    mandatory_update: false,
    maintenance_mode: false,
    release_notes: 'Enjoy a faster experience, improved ordering and new features.',
    release_date: new Date().toISOString(),
    download_url: 'https://github.com/samyakshrivastava28-maker/Olive-Pizza/releases/latest',
  });
});

// Get backend live status and version info (public)
router.get('/status', async (req, res) => {
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
  } catch (e) {}

  let dbStatus = 'disconnected';
  try {
    const dbRes = await query('SELECT 1');
    if (dbRes) dbStatus = 'connected';
  } catch (e) {}

  res.json({
    build_number: process.env.npm_package_version || '1.0.0',
    git_commit: gitCommit,
    build_timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    db_status: dbStatus
  });
});

// Admin ONLY routes below
router.get('/history', async (req, res) => {
  try {
    const snapshot = await adminDb.collection('app_versions')
      .orderBy('created_at', 'desc')
      .limit(50)
      .get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/publish', async (req, res) => {
  try {
    const { version_string, build_number, release_notes, features, bug_fixes, update_mode, update_minimum } = req.body;

    const versionDoc = {
      version_string,
      build_number: build_number || null,
      release_notes: release_notes || '',
      features: features || [],
      bug_fixes: bug_fixes || [],
      status: 'published',
      created_at: new Date().toISOString()
    };

    // Insert new version into Firestore
    const newVersionRef = await adminDb.collection('app_versions').add(versionDoc);

    // Fetch current settings to preserve existing fields
    const settingsRef = adminDb.collection('settings').doc('app_update');
    const currentSnap = await settingsRef.get();
    const currentSettings = currentSnap.exists ? currentSnap.data() || {} : {};

    const updates = {
      latest_version: version_string,
      update_mode: update_mode || currentSettings.update_mode || 'optional',
      minimum_version: update_minimum ? version_string : (currentSettings.minimum_version || '1.0.0'),
      updated_at: new Date().toISOString()
    };

    await settingsRef.set(updates, { merge: true });

    // Trigger FCM Broadcast
    let successCount = 0;
    let failureCount = 0;
    try {
      const usersSnapshot = await adminDb.collection('users').where('notificationEnabled', '==', true).get();
      let tokens: string[] = [];
      usersSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.fcmTokens && Array.isArray(data.fcmTokens)) tokens.push(...data.fcmTokens);
      });
      if (tokens.length > 0) {
        tokens = [...new Set(tokens)];
        const payload = {
          notification: {
            title: 'Olive Pizza Update Available 🍕',
            body: `Version ${version_string} is now available! Update now for new features.`,
          },
          data: {
            title: 'Olive Pizza Update Available 🍕',
            body: `Version ${version_string} is now available! Update now for new features.`,
            type: 'APP_UPDATE',
            version: version_string,
            mode: update_mode || currentSettings.update_mode || 'optional',
            releaseNotes: release_notes || ''
          }
        };
        for (let i = 0; i < tokens.length; i += 500) {
          const response = await adminMessaging.sendEachForMulticast({ tokens: tokens.slice(i, i + 500), ...payload });
          successCount += response.successCount;
          failureCount += response.failureCount;
        }
      }
    } catch (fcmError) {
      console.error("FCM Broadcast failed:", fcmError);
    }

    res.json({
      success: true,
      version: { id: newVersionRef.id, ...versionDoc },
      stats: { successCount, failureCount }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const { update_mode, minimum_version, maintenance_mode } = req.body;
    
    const updates: any = { updated_at: new Date().toISOString() };
    if (update_mode !== undefined) updates.update_mode = update_mode;
    if (minimum_version !== undefined) updates.minimum_version = minimum_version;
    if (maintenance_mode !== undefined) updates.maintenance_mode = maintenance_mode;

    const settingsRef = adminDb.collection('settings').doc('app_update');
    await settingsRef.set(updates, { merge: true });
    const updatedSnap = await settingsRef.get();
    
    res.json({ id: 1, ...updatedSnap.data() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
