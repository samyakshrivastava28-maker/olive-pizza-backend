/**
 * AiHealthMonitorService.ts
 *
 * Runs on the Main Olive Pizza Backend.
 * Every 5 minutes, checks the `_ai_status_/current` Firestore document.
 * If the AI heartbeat is older than 10 minutes, it fires an email + dashboard
 * alert to the developer and owner.
 *
 * This is the inverse of the AIHeartbeatJob in the AI app — the AI says "I'm alive",
 * and this service says "the AI hasn't said it's alive recently — ALERT!"
 */

import cron from 'node-cron';
import { adminDb } from '../config/firebase.js';

const ALERT_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const DEVELOPER_EMAIL = process.env.DEVELOPER_EMAIL || 'webhub2811@gmail.com';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'olivepizzarjn@gmail.com';

let hasAlertedForCurrentOutage = false;

async function checkAIHeartbeat() {
  try {
    const statusDoc = await adminDb.collection('_ai_status_').doc('current').get();

    if (!statusDoc.exists) {
      console.warn('[AI Health Monitor] No AI status document found. AI may never have connected.');
      return;
    }

    const data = statusDoc.data()!;
    const lastHeartbeatMs: number = data.lastHeartbeatMs || 0;
    const age = Date.now() - lastHeartbeatMs;
    const isStale = age > ALERT_THRESHOLD_MS;

    if (isStale && !hasAlertedForCurrentOutage) {
      hasAlertedForCurrentOutage = true;
      const minutesAgo = Math.round(age / 60000);

      console.error(`🚨 [AI Health Monitor] AI heartbeat is ${minutesAgo} minutes old! Sending alert...`);

      // Mark as offline in Firestore
      await adminDb.collection('_ai_status_').doc('current').set(
        { online: false },
        { merge: true }
      );

      // Fire notification via the email queue
      try {
        const { queueEmail } = await import('./email.service.js');
        const subject = `🚨 Olive Pizza AI is OFFLINE — Last heartbeat ${minutesAgo} minutes ago`;
        const html = buildAlertEmail(minutesAgo, data);

        await queueEmail(DEVELOPER_EMAIL, subject, html, 'transactional');
        if (OWNER_EMAIL !== DEVELOPER_EMAIL) {
          await queueEmail(OWNER_EMAIL, subject, html, 'transactional');
        }
        console.log('[AI Health Monitor] Alert email queued.');
      } catch (emailErr: any) {
        console.error('[AI Health Monitor] Failed to send alert email:', emailErr.message);
      }

      // Also log to Firestore for dashboard visibility
      await adminDb.collection('_ai_alerts_').add({
        type: 'HEARTBEAT_FAILURE',
        message: `AI has been offline for ${minutesAgo} minutes`,
        lastKnownVersion: data.version || 'unknown',
        lastHeartbeat: data.lastHeartbeat || null,
        timestamp: new Date().toISOString(),
        notifiedEmails: [DEVELOPER_EMAIL, OWNER_EMAIL],
      });

    } else if (!isStale && hasAlertedForCurrentOutage) {
      // AI recovered — reset the alert flag
      hasAlertedForCurrentOutage = false;
      console.log('✅ [AI Health Monitor] AI heartbeat restored. Clearing alert state.');
    }

  } catch (err: any) {
    console.error('[AI Health Monitor] Error during health check:', err.message);
  }
}

function buildAlertEmail(minutesAgo: number, statusData: any): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b0f19; color: #f3f4f6; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #111827; border: 2px solid #ef4444; border-radius: 12px; overflow: hidden; }
    .header { background: linear-gradient(135deg, #b91c1c, #7f1d1d); padding: 24px; }
    .header h1 { margin: 0; font-size: 22px; color: #fff; }
    .body { padding: 24px; }
    .stat { background: #1f2937; padding: 12px 16px; border-radius: 8px; margin-bottom: 10px; }
    .stat-label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-value { font-size: 16px; font-weight: 700; color: #f87171; font-family: monospace; margin-top: 2px; }
    .footer { padding: 16px 24px; background: #0f172a; font-size: 12px; color: #6b7280; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚨 Olive Pizza AI — Heartbeat Failure</h1>
      <p style="color:#fca5a5;margin:4px 0 0;">Automated alert from the Olive Pizza Main Backend</p>
    </div>
    <div class="body">
      <div class="stat">
        <div class="stat-label">Status</div>
        <div class="stat-value">🔴 OFFLINE — ${minutesAgo} minutes since last heartbeat</div>
      </div>
      <div class="stat">
        <div class="stat-label">Last Known Version</div>
        <div class="stat-value">${statusData?.version || 'unknown'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Last Heartbeat Received</div>
        <div class="stat-value">${statusData?.lastHeartbeat || 'never'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Active Users at Last Check</div>
        <div class="stat-value">${statusData?.activeUsers || 0}</div>
      </div>
      <div style="margin-top:20px;padding:14px;background:#1e293b;border-radius:8px;font-size:13px;color:#d1d5db;">
        <strong>Action Required:</strong> Check the Olive Pizza AI Render deployment at
        <a href="https://dashboard.render.com" style="color:#60a5fa;">dashboard.render.com</a>.
        If the service has crashed, restart it manually or check logs.
      </div>
    </div>
    <div class="footer">Olive Pizza Main Backend — Automated AI Health Monitor</div>
  </div>
</body>
</html>`;
}

export class AiHealthMonitorService {
  public static start() {
    console.log('🩺 Starting AI Health Monitor (checking every 5 minutes)...');
    // Run immediately on boot, then every 5 minutes
    checkAIHeartbeat();
    cron.schedule('*/5 * * * *', checkAIHeartbeat);
  }
}
