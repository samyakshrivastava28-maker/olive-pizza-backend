/**
 * Enterprise Notification Queue Service — Production v2
 *
 * Responsibilities:
 * 1. Enqueue notifications with dedup (tag-based live cards)
 * 2. PRE-FLIGHT STALE GUARD — reject notifications older than current DB state
 * 3. Fetch FCM tokens from Postgres (with invalid token cleanup)
 * 4. Send via Firebase Messaging with intelligent retry/backoff
 * 5. EMAIL RULES ENGINE — enforce role and stage-based email sending
 * 6. Write to notification_inbox so nothing is lost (offline recovery)
 * 7. Full analytics lifecycle (Created → Queued → Sent → Delivered → Opened → Failed)
 * 8. Auto-cleanup expired and processed queue items
 *
 * EMAIL RULES:
 *   Customer + pending/accepted/delivered/cancelled  → ALWAYS email (transactional)
 *   Customer + all other stages                      → email ONLY if FCM completely fails
 *   Owner (any stage)                                → NEVER email (operational)
 *   Delivery (any stage)                             → NEVER email (operational)
 */

import { adminDb as db, adminAuth, adminMessaging } from '../../config/firebase.js';
import * as admin from 'firebase-admin';
import crypto from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { notificationDebugger } from './NotificationDebugger.js';
import { NotificationLogger } from './NotificationLogger.js';
import { sanitizeApnsConfig } from './NotificationEngine.js';
import { pgPool } from '../../config/postgres.js';
import { queueEmail } from '../email.service.js';
import { buildOrderStatusEmail } from '../emailTemplates.service.js';
import { orderEventService } from '../order/OrderEventService.js';
import { fcmTokenCache } from './FCMTokenCache.js';

export interface EnqueueOptions {
  tag?: string;
  orderId?: string;
  notificationId?: string;
  version?: number;
  category?: string;
  priority?: 'critical' | 'high' | 'normal';
  role?: 'customer' | 'owner' | 'delivery';
  groupKey?: string;
  expiresInSeconds?: number;
}

// ─── Email Rules Engine ───────────────────────────────────────────────────────

// Stages where customer ALWAYS gets an email regardless of push success
const CUSTOMER_ALWAYS_EMAIL_STAGES = new Set([
  'pending',     // Order Placed
  'delivered',   // Order Delivered
]);

// Owner and Delivery NEVER get operational emails
const NO_EMAIL_ROLES = new Set(['owner', 'delivery']);

class EmailRulesEngine {
  /**
   * Determine if an email should be sent.
   * @param role         - The recipient's role
   * @param stage        - The order stage triggering the notification
   * @param fcmSuccess   - Whether FCM push succeeded (>0 tokens received)
   * @returns true if email should be sent
   */
  static shouldSend(role: string, stage: string, fcmSuccess: boolean, isFinalFailure: boolean = false): boolean {
    // Owner and Delivery: NEVER get operational emails
    if (NO_EMAIL_ROLES.has(role)) return false;

    // Customer: ONLY send transactional emails for Place Order and Delivered
    // Per explicit instruction: do NOT send emails for intermediate buttons/stages
    if (role === 'customer' && CUSTOMER_ALWAYS_EMAIL_STAGES.has(stage)) return true;

    return false;
  }

  static isAlwaysEmail(role: string, stage: string): boolean {
    return role === 'customer' && CUSTOMER_ALWAYS_EMAIL_STAGES.has(stage);
  }
}

// ─── NotificationQueueService ─────────────────────────────────────────────────

export class NotificationQueueService {
  private isProcessing = false;
  private processingTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    this.start();
  }

  /**
   * Start the polling processor with explicit AbortController lifecycle.
   */
  public start(): void {
    if (this.processingTimer) return;
    this.abortController = new AbortController();
    this.processingTimer = setInterval(() => {
      if (this.abortController?.signal.aborted) return;
      this.processQueue().catch(err => {
        // Only log real errors, not "no work" cases
        if (err && err.message !== 'No work' && !err.message.includes('calling end on the pool')) {
          console.error('[NotifQueue] Polling processQueue error:', err.message);
        }
      });
    }, 5000);
    if (this.processingTimer.unref) this.processingTimer.unref();
    console.log('[NotifQueue] Background polling processor started (5s interval).');
  }

  /**
   * Stop the polling processor (for graceful shutdown / tests).
   */
  public stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
      console.log('[NotifQueue] Background polling processor stopped.');
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  public async enqueue(
    firebaseUserId: string,
    payload: any,
    priorityOverride?: 'normal' | 'high' | 'silent',
    options: EnqueueOptions = {}
  ): Promise<string> {
    let client: any = null;
    try {
      client = await pgPool.connect();
      // ── Canonical user key: Firebase UID ──────────────────────────────────
      // The entire infrastructure schema (fcm_tokens.user_id, notification_queue.target_user_id,
      // notification_inbox.user_id, notification_preferences.user_id) stores the Firebase UID
      // directly. There is no separate Postgres UUID for users — business data lives in Firestore.
      // The previous "UUID resolver" block was a hardcoded literal (`{ rows: [{ id: firebaseUserId }] }`)
      // that was a no-op and masked the real ID flow. We now use the Firebase UID directly everywhere.
      const pgUserId = firebaseUserId;

      const priority = priorityOverride || (options.priority === 'critical' ? 'high' : options.priority || 'normal');
      const tag = options.tag || payload.data?.tag || null;
      const orderId = options.orderId || payload.data?.orderId || null;
      const category = options.category || payload.data?.category || 'general';
      const version = options.version || parseInt(payload.data?.version || '1');
      const role = options.role || payload.data?.role || 'customer';
      const stage = payload.data?.stage || payload.data?.currentStatus || category;
      const expiresAt = options.expiresInSeconds
        ? new Date(Date.now() + options.expiresInSeconds * 1000)
        : null;

      // ── PRE-FLIGHT STALE GUARD ───────────────────────────────────────────
      if (orderId && version) {
        const isStale = await orderEventService.isStale(orderId, version, stage);
        if (isStale) {
          console.log(`[NotifQueue] STALE — dropping notification for order ${orderId} v${version} stage=${stage}`);
          return 'stale_dropped';
        }
      }

      // ── DND Check ────────────────────────────────────────────────────────
      if (await this.shouldSuppressByDND(pgUserId, category, priority)) {
        console.log(`[NotifQueue] DND suppressed for ${pgUserId} category=${category}`);
        await this.writeToInbox(client, pgUserId, payload, tag, orderId, category, options, expiresAt);
        return 'dnd_suppressed';
      }

      let queueId: string;

      // ── Live Card Dedup ───────────────────────────────────────────────────
      if (tag) {
        const existing = await client.query(
          `SELECT id, version FROM notification_queue
           WHERE target_user_id = $1 AND tag = $2 AND status IN ('queued','sending')
           LIMIT 1`,
          [pgUserId, tag]
        );

        if (existing.rows.length > 0) {
          // Only update if this version is newer
          if (version >= (existing.rows[0].version || 0)) {
            const upd = await client.query(
              `UPDATE notification_queue
               SET payload = $1, version = $2, priority = $3, updated_at = NOW(), status = 'queued'
               WHERE id = $4 RETURNING id`,
              [JSON.stringify(payload), version, priority, existing.rows[0].id]
            );
            queueId = upd.rows[0].id;
            console.log(`[NotifQueue] Updated live card id=${queueId} tag=${tag} v${version}`);
          } else {
            console.log(`[NotifQueue] Skipped older v${version} < existing v${existing.rows[0].version} for tag ${tag}`);
            return 'older_version_skipped';
          }
        } else {
          const ins = await client.query(
            `INSERT INTO notification_queue
               (target_user_id, payload, priority, status, tag, order_id, notification_id, version, category, expires_at)
             VALUES ($1,$2,$3,'queued',$4,NULL,$5,$6,$7,$8) RETURNING id`,
            [pgUserId, JSON.stringify(payload), priority, tag, options.notificationId, version, category, expiresAt]
          );
          queueId = ins.rows[0].id;
        }
      } else {
        const ins = await client.query(
          `INSERT INTO notification_queue
             (target_user_id, payload, priority, status, order_id, notification_id, version, category, expires_at)
           VALUES ($1,$2,$3,'queued',NULL,$4,$5,$6,$7) RETURNING id`,
          [pgUserId, JSON.stringify(payload), priority, options.notificationId, version, category, expiresAt]
        );
        queueId = ins.rows[0].id;
      }

      // Inbox write (never lose a notification)
      await this.writeToInbox(client, pgUserId, payload, tag, orderId, category, options, expiresAt);

      // Analytics: Created
      await this.recordAnalytic(client, category, 'sent', 0).catch(() => { });

      notificationDebugger.logCreation({
        userId: pgUserId, type: 'push', category: category || 'marketing',
        title: payload.notification?.title || payload.data?.title,
        body: payload.notification?.body || payload.data?.body,
        queueId, tokensFound: 0,
      }, queueId).then(debugId => notificationDebugger.updateStage(debugId, 'Queued', { queueId })).catch(() => { });

      // Instantly trigger processing
      this.processQueue().catch(err => console.error('[NotifQueue] Background process failed:', err));

      return queueId;
    } finally {
      if (client) client.release();
    }
  }

  public async registerToken(
    firebaseUserId: string,
    token: string,
    deviceInfo: {
      oldToken?: string;
      deviceId?: string;
      deviceName?: string;
      platform?: string;
      browser?: string;
      appVersion?: string;
      appName?: string;
      role?: string;
      franchiseId?: string;
      branchId?: string;
      terminalId?: string;
    }
  ): Promise<void> {
    let client: any = null;
    try {
      client = await pgPool.connect();
      let pgUserId = firebaseUserId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(firebaseUserId)) {
        const userRes = { rows: [{ id: firebaseUserId }] };
        if (userRes.rows.length > 0) pgUserId = userRes.rows[0].id;
        else { console.warn(`[NotifQueue] Cannot register token — user not found: ${firebaseUserId}`); return; }
      }

      if (deviceInfo.oldToken && deviceInfo.oldToken !== token) {
        await client.query('UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW() WHERE token = $1 AND user_id = $2', [deviceInfo.oldToken, pgUserId]);
        db.collection('users').doc(firebaseUserId).update({ fcmTokens: FieldValue.arrayRemove(deviceInfo.oldToken) }).catch(() => { });
      }

      // If deviceId is provided, deactivate previous token for this exact physical device
      if (deviceInfo.deviceId) {
        await client.query(
          `UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW() 
           WHERE user_id = $1 AND device_id = $2 AND token != $3`,
          [pgUserId, deviceInfo.deviceId, token]
        );
      } else if (deviceInfo.deviceName && deviceInfo.platform) {
        // Fallback: deviceName + platform match
        await client.query(
          `UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW() 
           WHERE user_id = $1 AND device_name = $2 AND platform = $3 AND token != $4`,
          [pgUserId, deviceInfo.deviceName, deviceInfo.platform, token]
        );
      }

      // Ensure 1 Device Token = 1 User (deactivate token for any previous user)
      await client.query('UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW() WHERE token = $1 AND user_id != $2', [token, pgUserId]);

      // Enforce authoritative owner role & appName
      const OWNER_ROLES = new Set(['owner', 'platform_owner']);
      const OWNER_EMAILS = new Set(['webhub2811@gmail.com', 'olivepizzarjn@gmail.com', 'olivepizzamaker@gmail.com']);
      let finalAppName = deviceInfo.appName || 'customer';
      let finalRole = deviceInfo.role || null;

      try {
        const uDoc = await db.collection('users').doc(firebaseUserId).get();
        if (uDoc.exists) {
          const uData = uDoc.data() || {};
          const uEmail = (uData.email || '').toLowerCase().trim();
          const uRole = (uData.role || '').toLowerCase().trim();
          if ((OWNER_ROLES.has(uRole) || OWNER_EMAILS.has(uEmail)) && (!deviceInfo.appName || deviceInfo.appName === 'owner')) {
            finalAppName = 'owner';
            finalRole = 'owner';
          }
        }
      } catch (err) {
        // Non-fatal
      }

      // Upsert token with complete application and RBAC metadata
      await client.query(
        `INSERT INTO fcm_tokens (user_id, token, device_id, device_name, platform, browser, app_version, is_active, last_used_at, app_name, role, branch_id, franchise_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW(),$8,$9,$10,$11,NOW())
         ON CONFLICT (user_id, token)
         DO UPDATE SET is_active = TRUE, last_used_at = NOW(), updated_at = NOW(),
           device_id = COALESCE(EXCLUDED.device_id, fcm_tokens.device_id),
           device_name = COALESCE(EXCLUDED.device_name, fcm_tokens.device_name),
           platform = COALESCE(EXCLUDED.platform, fcm_tokens.platform),
           browser = COALESCE(EXCLUDED.browser, fcm_tokens.browser),
           app_version = COALESCE(EXCLUDED.app_version, fcm_tokens.app_version),
           app_name = COALESCE(EXCLUDED.app_name, fcm_tokens.app_name),
           role = COALESCE(EXCLUDED.role, fcm_tokens.role),
           branch_id = COALESCE(EXCLUDED.branch_id, fcm_tokens.branch_id),
           franchise_id = COALESCE(EXCLUDED.franchise_id, fcm_tokens.franchise_id)`,
        [
          pgUserId,
          token,
          deviceInfo.deviceId || null,
          deviceInfo.deviceName || null,
          deviceInfo.platform || 'unknown',
          deviceInfo.browser || null,
          deviceInfo.appVersion || null,
          finalAppName,
          finalRole,
          deviceInfo.branchId || null,
          deviceInfo.franchiseId || null
        ]
      ).catch(async () => {
        // Fallback for older fcm_tokens schema
        await client.query(
          `INSERT INTO fcm_tokens (user_id, token, device_name, platform, browser, app_version, is_active, last_used_at, app_name)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW(),$7)
           ON CONFLICT (user_id, token)
           DO UPDATE SET is_active = TRUE, last_used_at = NOW(),
             device_name = EXCLUDED.device_name, platform = EXCLUDED.platform,
             browser = EXCLUDED.browser, app_version = EXCLUDED.app_version,
             app_name = COALESCE(EXCLUDED.app_name, fcm_tokens.app_name)`,
          [pgUserId, token, deviceInfo.deviceName, deviceInfo.platform, deviceInfo.browser, deviceInfo.appVersion, finalAppName]
        ).catch(async () => {
          await client.query(
            `INSERT INTO fcm_tokens (user_id, token, device_name, platform, browser, app_version, is_active, last_used_at)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
             ON CONFLICT (user_id, token)
             DO UPDATE SET is_active = TRUE, last_used_at = NOW(),
               device_name = EXCLUDED.device_name, platform = EXCLUDED.platform,
               browser = EXCLUDED.browser, app_version = EXCLUDED.app_version`,
            [pgUserId, token, deviceInfo.deviceName, deviceInfo.platform, deviceInfo.browser, deviceInfo.appVersion]
          );
        });
      });

      // Active Token Limit: Allow up to 10 active devices per user (phone, tablet, POS, desktop, etc.)
      const activeRes = await client.query(
        `SELECT token FROM fcm_tokens WHERE user_id = $1 AND is_active = TRUE ORDER BY last_used_at DESC, id DESC`,
        [pgUserId]
      );

      let activeTokensList = activeRes.rows.map((r: any) => r.token);
      if (activeTokensList.length > 10) {
        const keepTokens = activeTokensList.slice(0, 10);
        const deactivateTokens = activeTokensList.slice(10);
        await client.query(
          `UPDATE fcm_tokens SET is_active = FALSE, updated_at = NOW() WHERE user_id = $1 AND token = ANY($2)`,
          [pgUserId, deactivateTokens]
        );
        activeTokensList = keepTokens;
      }

      // Update Firestore user document with active tokens array
      db.collection('users').doc(firebaseUserId).set({
        fcmTokens: activeTokensList,
        notificationReady: true,
        lastTokenRefresh: FieldValue.serverTimestamp(),
      }, { merge: true }).catch(() => { });

      // Mirror device metadata into Firestore users/{userId}/devices/{tokenHash}
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
      db.collection('users').doc(firebaseUserId).collection('devices').doc(tokenHash).set({
        token,
        deviceId: deviceInfo.deviceId || null,
        deviceName: deviceInfo.deviceName || null,
        platform: deviceInfo.platform || 'unknown',
        appName: finalAppName,
        role: finalRole,
        branchId: deviceInfo.branchId || null,
        franchiseId: deviceInfo.franchiseId || null,
        lastSeenAt: FieldValue.serverTimestamp(),
        enabled: true,
      }, { merge: true }).catch(() => { });

      // Evict stale cache
      fcmTokenCache.evict(pgUserId);
    } finally {
      if (client) client.release();
    }
  }


  // ─── Queue Processor ─────────────────────────────────────────────────────────

  public async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    const client = await pgPool.connect();

    try {
      // Step 1: Lock pending IDs without a JOIN (pgbouncer-safe)
      const lockResult = await client.query(
        `UPDATE notification_queue
         SET status = 'sending', updated_at = NOW()
         WHERE id IN (
           SELECT id FROM notification_queue
           WHERE status = 'queued'
             AND (expires_at IS NULL OR expires_at > NOW())
             AND (scheduled_at IS NULL OR scheduled_at <= NOW())
           ORDER BY
             CASE priority WHEN 'high' THEN 1 ELSE 2 END,
             created_at ASC
           LIMIT 20
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`
      );

      if (lockResult.rows.length === 0) return;

      // Step 2: For each locked row, fetch firebase_uid separately
      for (const row of lockResult.rows) {
        try {
          // target_user_id IS the Firebase UID — pass it directly
          await this.processItem({ ...row, firebase_uid: row.target_user_id }, client);
        } catch (itemErr: any) {
          console.error(`[NotifQueue] Failed to process item id=${row.id}:`, itemErr.message);
          // Requeue instead of losing the item
          await client.query(
            `UPDATE notification_queue SET status = 'queued', updated_at = NOW() WHERE id = $1`,
            [row.id]
          ).catch(() => { });
        }
      }
    } catch (err: any) {
      console.error('[NotifQueue] processQueue error:', err.message);
    } finally {
      this.isProcessing = false;
      client.release();
    }
  }

  private async processItem(item: any, client: any): Promise<void> {
    const { id, target_user_id, payload, retry_count, priority, tag, order_id, version, category, firebase_uid } = item;
    const startTime = Date.now();

    try {
      await client.query(`UPDATE notification_queue SET status = 'sending', updated_at = NOW() WHERE id = $1`, [id]);

      const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const role = parsedPayload.data?.role || 'customer';
      const stage = parsedPayload.data?.stage || parsedPayload.data?.currentStatus || category || 'update';

      // ── STALE GUARD (re-check at send time) ──────────────────────────────
      if (order_id && version) {
        const isStale = await orderEventService.isStale(order_id, version, stage);
        if (isStale) {
          await client.query(`DELETE FROM notification_queue WHERE id = $1`, [id]);
          console.log(`[NotifQueue] STALE at send-time — dropped id=${id}`);
          return;
        }
      }

      // ── Fetch tokens + user info ──────────────────────────────────────────
      // Use FCMTokenCache (5-min TTL) to eliminate repeated DB reads per notification
      const [{ tokens: cachedTokens, source: tokenSource }, userResult] = await Promise.all([
        fcmTokenCache.get(target_user_id),
        db.collection('users').doc(target_user_id).get().then(doc => ({ rows: [doc.data() || {}] })),
      ]);

      const userEmail: string | null = userResult.rows[0]?.email || null;
      const userRole: string | null = userResult.rows[0]?.role || null;
      const customerName: string = userResult.rows[0]?.name || 'Customer';

      // ── AUTHORIZATION HARD GUARD: Drop operational restaurant alarms destined for Owner ──
      const OWNER_ROLES = new Set(['owner', 'platform_owner']);
      const OWNER_EMAILS = new Set(['webhub2811@gmail.com', 'olivepizzarjn@gmail.com', 'olivepizzamaker@gmail.com']);
      const cleanEmail = (userEmail || '').toLowerCase().trim();
      const cleanRole = (userRole || role || '').toLowerCase().trim();
      const isOwner = OWNER_ROLES.has(cleanRole) || OWNER_EMAILS.has(cleanEmail);

      const isOperationalAlarm = 
        stage === 'RESTAURANT_NEW_ORDER_ALARM' ||
        category === 'alarm_actionable' ||
        parsedPayload.data?.category === 'alarm_actionable' ||
        parsedPayload.data?.targetApp === 'restaurant' ||
        parsedPayload.data?.stage === 'RESTAURANT_NEW_ORDER_ALARM';

      if (isOperationalAlarm && isOwner) {
        console.warn(`[NotifQueue] 🚨 NOTIFICATION_DROPPED_AUTHORIZATION: Dropped operational restaurant notification id=${id} for Owner ${target_user_id} (${cleanEmail})`);
        await client.query(`DELETE FROM notification_queue WHERE id = $1`, [id]);
        return;
      }

      // Fallback to Firestore if cache+DB found no tokens
      let tokens: string[] = cachedTokens;
      if (tokens.length === 0 && firebase_uid) {
        const userDoc = await db.collection('users').doc(firebase_uid).get();
        tokens = userDoc.data()?.fcmTokens || [];
        // Sync Firestore tokens back to Postgres + cache
        for (const t of tokens) {
          await client.query(
            `INSERT INTO fcm_tokens (user_id, token, is_active) VALUES ($1,$2,TRUE) ON CONFLICT (user_id, token) DO UPDATE SET is_active=TRUE`,
            [target_user_id, t]
          ).catch(() => { });
        }
        if (tokens.length > 0) {
          await fcmTokenCache.refresh(target_user_id);
        }
      }

      console.log(`[NotifQueue] Tokens for ${target_user_id}: ${tokens.length} (source=${tokenSource})`,);


      // ── Always-send transactional emails ─────────────────────────────────
      // These fire regardless of push success/failure
      const alwaysEmail = EmailRulesEngine.isAlwaysEmail(role, stage);
      if (alwaysEmail && userEmail) {
        try {
          const subject = parsedPayload.data?.title || `Order Update — Olive Pizza`;
          const htmlBody = buildOrderStatusEmail({
            customerName, subject, stage, orderId: order_id,
            data: parsedPayload.data || {},
          });
          await queueEmail(userEmail, subject, htmlBody, 'transactional');
          console.log(`[NotifQueue] 📧 Always-send email → ${userEmail} stage=${stage}`);
        } catch (emailErr) {
          console.error('[NotifQueue] Always-send email failed:', emailErr);
        }
      }

      // ── No tokens path ────────────────────────────────────────────────────
      if (tokens.length === 0) {
        // Hard fallback: 0 tokens means instant final failure
        if (!alwaysEmail && EmailRulesEngine.shouldSend(role, stage, false, true) && userEmail) {
          try {
            const subject = parsedPayload.data?.title || `Order Update — Olive Pizza`;
            const htmlBody = buildOrderStatusEmail({
              customerName, subject, stage, orderId: order_id,
              data: parsedPayload.data || {},
            });
            await queueEmail(userEmail, subject, htmlBody, 'transactional');
            console.log(`[NotifQueue] 📧 Hard fallback email (0 tokens) → ${userEmail} stage=${stage}`);
          } catch (emailErr) {
            console.error('[NotifQueue] Fallback email failed:', emailErr);
          }
        } else if (!userEmail) {
          console.warn(`[NotifQueue] No tokens and no email for user ${target_user_id} — notification lost`);
        }
        await client.query(`UPDATE notification_queue SET status = 'sent', updated_at = NOW() WHERE id = $1`, [id]);
        return;
      }

      // ── Inject tracking fields ────────────────────────────────────────────
      parsedPayload.data = parsedPayload.data || {};
      parsedPayload.data.queueId = id;
      parsedPayload.data.version = String(version || 1);
      if (tag) parsedPayload.data.tag = tag;
      if (order_id) parsedPayload.data.orderId = order_id;

      if (priority === 'silent') delete parsedPayload.notification;

      // ── Send via FCM Multicast ────────────────────────────────────────────
      // Ensure Android wakes up custom service
      if (parsedPayload.android) {
        parsedPayload.android.priority = 'high';
      } else {
        parsedPayload.android = { priority: 'high' };
      }

      const sanitizedData: Record<string, string> = {};
      if (parsedPayload.data && typeof parsedPayload.data === 'object') {
        for (const [k, v] of Object.entries(parsedPayload.data)) {
          if (v !== undefined && v !== null) {
            sanitizedData[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
          }
        }
      }

      const sanitizedApns = sanitizeApnsConfig(parsedPayload.apns, category);

      const message: admin.messaging.MulticastMessage = {
        tokens,
        notification: parsedPayload.notification,
        data: sanitizedData,
        android: parsedPayload.android,
        apns: sanitizedApns,
        webpush: parsedPayload.webpush,
      };

      const response = await adminMessaging.sendEachForMulticast(message);
      const deliveryMs = Date.now() - startTime;

      // ── Handle invalid tokens and log to Production Logger ─────────
      const failedTokens: string[] = [];
      response.responses.forEach((r, idx) => {
        const fcmToken = tokens[idx];

        NotificationLogger.log({
          timestamp: new Date().toISOString(),
          orderId: order_id,
          userId: target_user_id,
          triggerSource: 'automatic',
          eventType: stage || category || 'queued_push',
          recipientRole: role,
          recipientCount: 1,
          activeTokenCount: tokens.length,
          inactiveTokenCount: failedTokens.length,
          fcmToken,
          payload: parsedPayload,
          firebaseResponse: r,
          status: r.success ? 'success' : 'failure',
          errorDetails: r.error?.message,
          elapsedTimeMs: deliveryMs,
          retryCount: retry_count || 0,
          retryReason: r.error ? r.error.code : undefined,
        });

        if (r.error) {
          const code = r.error.code;
          // ONLY deactivate tokens for permanent registration error codes per Fix 2
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            code === 'invalid-registration-token' ||
            code === 'registration-token-not-registered'
          ) {
            failedTokens.push(fcmToken);
          }
          // Do NOT retry invalid tokens
        }
      });

      if (failedTokens.length > 0) {
        // Invalidate in cache + DB atomically
        await fcmTokenCache.invalidate(target_user_id, failedTokens);
        // Also clean up Firestore token list
        if (firebase_uid) {
          db.collection('users').doc(firebase_uid).update({
            fcmTokens: FieldValue.arrayRemove(...failedTokens),
          }).catch(() => { });
        }
        console.log(`[NotifQueue] Deactivated ${failedTokens.length} invalid tokens for ${target_user_id}`);
      }

      const successCount = response.successCount;

      // ── FCM failed — throw to trigger retry ───────────────────────────
      if (successCount === 0 && tokens.length > 0) {
        throw new Error('All FCM tokens failed');
      }

      await client.query(`UPDATE notification_queue SET status = 'sent', updated_at = NOW() WHERE id = $1`, [id]);
      await this.recordAnalytic(client, category || 'general', 'sent', 1);
      await this.recordAnalytic(client, category || 'general', 'delivered', successCount);
      await this.recordDeliveryTime(client, category || 'general', deliveryMs);

      notificationDebugger.updateStage(id, 'Firebase Response', {
        tokensFound: tokens.length, status: successCount > 0 ? 'sent' : 'failed',
      }).catch(() => { });

      console.log(`[NotifQueue] ✅ Sent id=${id} tag=${tag || 'none'} to ${successCount}/${tokens.length} devices in ${deliveryMs}ms`);
    } catch (error: any) {
      const newRetryCount = (retry_count || 0) + 1;

      if (newRetryCount >= 3) {
        // ── Final failure: queue fallback email ─────────────────────────
        const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const role = parsedPayload.data?.role || 'customer';
        const stage = parsedPayload.data?.stage || parsedPayload.data?.currentStatus || category || 'update';
        const alwaysEmail = EmailRulesEngine.isAlwaysEmail(role, stage);
        const userResult = await db.collection('users').doc(target_user_id).get().then(doc => ({ rows: [doc.data() || {}] }));
        const userEmail = userResult.rows[0]?.email || null;
        const customerName = userResult.rows[0]?.name || 'Customer';

        if (!alwaysEmail && EmailRulesEngine.shouldSend(role, stage, false, true) && userEmail) {
          try {
            const subject = parsedPayload.data?.title || `Order Update — Olive Pizza`;
            const htmlBody = buildOrderStatusEmail({
              customerName, subject, stage, orderId: order_id,
              data: parsedPayload.data || {},
            });
            await queueEmail(userEmail, subject, htmlBody, 'transactional');
            console.log(`[NotifQueue] 📧 Hard fallback email (after 3 retries) → ${userEmail} stage=${stage}`);
          } catch (emailErr) {
            console.error('[NotifQueue] Fallback email failed:', emailErr);
          }
        }

        // Log to history and dead letter queue
        await client.query(
          `INSERT INTO notification_history (target_user_id, title, body, category, status)
           SELECT target_user_id, payload->'notification'->>'title', payload->'notification'->>'body', category, 'failed'
           FROM notification_queue WHERE id = $1 ON CONFLICT DO NOTHING`,
          [id]
        ).catch(() => { });

        await client.query(
          `INSERT INTO dead_letter_queue (original_queue_id, recipient, subject, payload, final_error)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, target_user_id, parsedPayload.data?.title || 'Push Failed', JSON.stringify(payload), error.message]
        ).catch(() => { });

        await client.query(`DELETE FROM notification_queue WHERE id = $1`, [id]);
        await this.recordAnalytic(client, category || 'general', 'failed', 1);
        notificationDebugger.updateStage(id, 'Failed', { error: error.message, status: 'failed' }).catch(() => { });
        console.error(`[NotifQueue] ❌ Permanently failed id=${id}: ${error.message}`);
      } else {
        const backoffMs = 1000 * Math.pow(2, newRetryCount);
        await client.query(
          `UPDATE notification_queue
           SET status = 'queued', retry_count = $1, updated_at = NOW(),
               scheduled_at = NOW() + ($2 || ' milliseconds')::INTERVAL
           WHERE id = $3`,
          [newRetryCount, backoffMs, id]
        );
        console.warn(`[NotifQueue] Retry #${newRetryCount} for id=${id} in ${backoffMs}ms`);
      }
    }
  }

  // ─── Inbox Writer ─────────────────────────────────────────────────────────────

  private async writeToInbox(
    client: any, userId: string, payload: any, tag: string | null, orderId: string | null,
    category: string, options: EnqueueOptions, expiresAt: Date | null
  ): Promise<void> {
    try {
      const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
      const title = p.notification?.title || p.data?.title || 'Notification';
      const body = p.notification?.body || p.data?.body || '';

      if (tag) {
        await client.query(
          `INSERT INTO notification_inbox (user_id, tag, order_id, title, body, category, url, data, version, expires_at, is_read, updated_at)
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,FALSE,NOW())
           ON CONFLICT (user_id, tag) WHERE tag IS NOT NULL
           DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, version=EXCLUDED.version,
             data=EXCLUDED.data, expires_at=EXCLUDED.expires_at, is_read=FALSE, updated_at=NOW()`,
          [userId, tag, title, body, category, p.data?.url || '/', JSON.stringify(p.data), options.version || 1, expiresAt]
        ).catch(() => {
          client.query(
            `INSERT INTO notification_inbox (user_id, tag, order_id, title, body, category, url, data, version, expires_at)
             VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [userId, tag, title, body, category, p.data?.url || '/', JSON.stringify(p.data), options.version || 1, expiresAt]
          ).catch(() => { });
        });
      } else {
        await client.query(
          `INSERT INTO notification_inbox (user_id, order_id, title, body, category, url, data, version, expires_at)
           VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8)`,
          [userId, title, body, category, p.data?.url || '/', JSON.stringify(p.data), options.version || 1, expiresAt]
        ).catch(() => { });
      }
    } catch (err) {
      console.error('[NotifQueue] Inbox write failed (non-blocking):', err);
    }
  }

  // ─── Analytics ─────────────────────────────────────────────────────────────

  private async recordAnalytic(client: any, category: string, field: 'sent' | 'delivered' | 'opened' | 'failed', count: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const col = `${field}_count`;
    await client.query(
      `INSERT INTO notification_analytics (period_date, category, ${col})
       VALUES ($1,$2,$3)
       ON CONFLICT (period_date, category, role)
       DO UPDATE SET ${col} = notification_analytics.${col} + EXCLUDED.${col}, updated_at = NOW()`,
      [today, category, count]
    ).catch(() => { });
  }

  private async recordDeliveryTime(client: any, category: string, ms: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO notification_analytics (period_date, category, total_delivery_time_ms, delivered_count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (period_date, category, role)
       DO UPDATE SET total_delivery_time_ms = notification_analytics.total_delivery_time_ms + $3, updated_at = NOW()`,
      [today, category, ms]
    ).catch(() => { });
  }

  // ─── DND Check ─────────────────────────────────────────────────────────────

  private async shouldSuppressByDND(userId: string, category: string, priority: string): Promise<boolean> {
    if (priority === 'high') return false;

    // DPDP Consent Check for Marketing / Promotional communications
    if (category === 'marketing' || category === 'announcement' || category === 'promotional') {
      try {
        const { PrivacyService } = await import('../privacy/PrivacyService.js');
        const consents = await PrivacyService.getUserConsents(userId);
        if (!consents.MARKETING_PROMOTIONS) {
          return true; // Suppressed by withdrawn/un-granted marketing consent
        }
      } catch {
        // Fallback to local DB check
      }
    }

    try {
      const client = await pgPool.connect();
      try {
        const result = await client.query(
          `SELECT mute_marketing, mute_low_priority FROM notification_preferences WHERE user_id = $1`,
          [userId]
        );
        if (result.rows.length === 0) return false;
        const p = result.rows[0];
        if (p.mute_marketing && (category === 'marketing' || category === 'announcement')) return true;
        if (p.mute_low_priority && priority === 'normal') return true;
        return false;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  public async runCleanup(): Promise<void> {
    const client = await pgPool.connect();
    try {
      await client.query('SELECT cleanup_notifications()');
      console.log('[NotifQueue] ✅ Auto-cleanup complete');
    } catch (err) {
      console.error('[NotifQueue] Cleanup error (non-fatal):', err);
    } finally {
      client.release();
    }
  }

  public destroy(): void {
    if (this.processingTimer) clearTimeout(this.processingTimer);
  }
}

export const notificationQueue = new NotificationQueueService();
