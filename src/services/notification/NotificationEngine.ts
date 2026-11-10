/**
 * NotificationEngine — Single Notification Pipeline
 *
 * This is the ONE and ONLY notification sender in the entire codebase.
 * Every notification of every kind (order alarms, status updates, delivery
 * assignments, manual broadcasts, marketing) passes through this module.
 *
 * Architecture:
 *   Trigger (route handler / UI action)
 *         ↓
 *   NotificationEngine.send()
 *         ↓
 *   Recipient Resolver (Postgres fcm_tokens → Firestore fallback)
 *         ↓
 *   Payload Builder (hybrid notification/data for ordinary pushes; data-only
 *   Android messages for authenticated actionable staff alarms)
 *         ↓
 *   Firebase Admin sendEachForMulticast()
 *         ↓
 *   NotificationLogger + token deactivation + Postgres inbox
 *
 * Background delivery policy:
 *   Ordinary notifications use the OS tray block for reliable display when the
 *   app is closed. Actionable restaurant/delivery alarms are sent data-only on
 *   Android so their native messaging service can validate the recipient UID,
 *   play the bundled sound once, and construct the correct native order UI.
 *   APNs retains its native alert/sound payload because iOS does not support
 *   custom app overlays over other applications.
 */

import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { adminMessaging, adminDb as db } from '../../config/firebase.js';
import { pgPool } from '../../config/postgres.js';
import { NotificationLogger } from './NotificationLogger.js';
import type { NotificationPayload, NotificationCategory as TemplateCategory } from './NotificationTemplates.js';

export type NotificationCategory = TemplateCategory | 'simple_informational';


export interface NotificationEngineOptions {
  tag?: string;
  orderId?: string;
  category?: NotificationCategory | string;
  priority?: 'normal' | 'high' | 'critical';
  version?: number;
  expiresInSeconds?: number;
  /** For pinned_live: collapse notifications with same tag on device */
  collapseKey?: string;
  /** Target client application to prevent cross-app notification leaks */
  targetApp?: 'customer' | 'owner' | 'franchise' | 'restaurant' | 'delivery' | 'pos';
  /** Deterministic event ID for deduplication/idempotency */
  eventId?: string;
}

export interface SendResult {
  successCount: number;
  failureCount: number;
  tokensFound: number;
  errors: string[];
}

export class NotificationEngine {
  private static recentEventIds = new Map<string, number>();
  private static schemaInitialized = false;

  constructor() {
    this.ensureSchema().catch((err) => {
      console.warn('[NotificationEngine] Schema self-healing notice:', err.message);
    });

    // Cleanup in-memory cache every 5 minutes
    const interval = setInterval(() => {
      const cutoff = Date.now() - 600000;
      for (const [id, ts] of NotificationEngine.recentEventIds.entries()) {
        if (ts < cutoff) NotificationEngine.recentEventIds.delete(id);
      }
    }, 300000);
    if (interval.unref) interval.unref();
  }

  private async ensureSchema(): Promise<void> {
    if (NotificationEngine.schemaInitialized) return;
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS notification_events (
          event_id VARCHAR(255) PRIMARY KEY,
          order_id VARCHAR(255),
          recipient_count INT,
          processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notification_events_processed_at ON notification_events(processed_at);

        CREATE TABLE IF NOT EXISTS order_activity_tokens (
          id SERIAL PRIMARY KEY,
          order_id VARCHAR(255) NOT NULL,
          user_id VARCHAR(255) NOT NULL,
          token TEXT NOT NULL,
          device_id VARCHAR(255),
          platform VARCHAR(32) DEFAULT 'ios',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CONSTRAINT uq_order_activity_token UNIQUE (order_id, token)
        );
        CREATE INDEX IF NOT EXISTS idx_order_activity_tokens_order_id ON order_activity_tokens(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_activity_tokens_user_id ON order_activity_tokens(user_id);

        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS role VARCHAR(64);
        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS branch_id VARCHAR(128);
        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS franchise_id VARCHAR(128);
        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS app_name VARCHAR(64);
        ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();
      `);
      NotificationEngine.schemaInitialized = true;
    } catch (e: any) {
      console.warn('[NotificationEngine] Table verification warning:', e.message);
    }
  }

  /**
   * Send a notification to a single user.
   * Resolves their active FCM tokens from Postgres (with Firestore fallback).
   * Always sends hybrid messages (notification + data blocks).
   */
  public async send(
    firebaseUserId: string,
    payload: NotificationPayload,
    options: NotificationEngineOptions = {}
  ): Promise<SendResult> {
    return this.sendBulk([firebaseUserId], payload, options);
  }

  /**
   * Send a notification to multiple users simultaneously.
   * Resolves all active FCM tokens for the given UIDs, deduplicates,
   * chunks into FCM-safe batches of 500, and sends concurrently.
   */
  public async sendBulk(
    firebaseUserIds: string[],
    payload: NotificationPayload,
    options: NotificationEngineOptions = {}
  ): Promise<SendResult> {
    if (!firebaseUserIds || firebaseUserIds.length === 0) {
      return { successCount: 0, failureCount: 0, tokensFound: 0, errors: [] };
    }

    const isTargetedOperationalAlert = (options.category === 'alarm_actionable' || payload.data?.category === 'alarm_actionable')
      && ['restaurant', 'delivery'].includes(String(options.targetApp || '').toLowerCase());

    // Native operational alerts carry the UID they were sent to. Use one recipient per
    // Firebase message so the device can discard stale alerts after logout/account switching.
    if (isTargetedOperationalAlert) {
      const recipientUids = [...new Set(firebaseUserIds.filter((uid) => typeof uid === 'string' && uid.trim()))];
      if (recipientUids.length > 1) {
        const baseEventId = options.eventId || payload.data?.eventId;
        const results = await Promise.all(recipientUids.map((uid) => {
          const recipientEventId = baseEventId ? `${baseEventId}:${uid}` : undefined;
          const recipientPayload: NotificationPayload = {
            ...payload,
            data: { ...(payload.data || {}), recipientUid: uid, ...(recipientEventId ? { eventId: recipientEventId } : {}) }
          };
          return this.sendBulk([uid], recipientPayload, {
            ...options,
            ...(recipientEventId ? { eventId: recipientEventId } : {})
          });
        }));
        return results.reduce<SendResult>((total, result) => ({
          successCount: total.successCount + result.successCount,
          failureCount: total.failureCount + result.failureCount,
          tokensFound: total.tokensFound + result.tokensFound,
          errors: [...total.errors, ...result.errors]
        }), { successCount: 0, failureCount: 0, tokensFound: 0, errors: [] });
      }
      if (recipientUids.length === 1) {
        payload = {
          ...payload,
          data: { ...(payload.data || {}), recipientUid: recipientUids[0] }
        };
      }
    }

    // ── 0a. Server-Side Idempotency Guard ────────────────────────────────────
    const eventId = options.eventId || payload.data?.eventId;
    if (eventId) {
      const now = Date.now();
      const existingTime = NotificationEngine.recentEventIds.get(eventId);
      if (existingTime && (now - existingTime) < 600000) {
        console.log(`[NotificationEngine][Deduplication] In-memory drop for duplicate eventId: ${eventId}`);
        return { successCount: 0, failureCount: 0, tokensFound: 0, errors: ['duplicate_event_suppressed'] };
      }

      try {
        const dbCheck = await pgPool.query(
          `INSERT INTO notification_events (event_id, order_id, recipient_count, processed_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [eventId, options.orderId || payload.data?.orderId || null, firebaseUserIds.length]
        );
        if (dbCheck.rowCount === 0) {
          console.log(`[NotificationEngine][Deduplication] DB drop for duplicate eventId: ${eventId}`);
          NotificationEngine.recentEventIds.set(eventId, now);
          return { successCount: 0, failureCount: 0, tokensFound: 0, errors: ['duplicate_event_suppressed'] };
        }
        NotificationEngine.recentEventIds.set(eventId, now);
      } catch (dbErr: any) {
        NotificationEngine.recentEventIds.set(eventId, now);
      }
    }

    // ── 0. Server-Side Security Guard: Monthly / Financial Reports Safety ──
    const isReportCategory = options.category === 'monthly_report' ||
      options.category === 'report' ||
      payload.data?.category === 'monthly_report' ||
      payload.data?.category === 'report' ||
      (options.tag && options.tag.startsWith('monthly_report_'));

    let targetUids = firebaseUserIds;
    if (isReportCategory) {
      targetUids = await this.filterForbiddenReportRecipients(firebaseUserIds);
      if (targetUids.length === 0) {
        console.warn(`[NotificationEngine][Security Guard] All target UIDs were blocked from receiving internal reports (Customer/Delivery guard enforced).`);
        return { successCount: 0, failureCount: 0, tokensFound: 0, errors: ['forbidden_audience'] };
      }
    }

    // ── 1. Resolve FCM tokens ─────────────────────────────────────────────────
    const tokens = await this.resolveTokens(targetUids, options.targetApp);

    const startTime = Date.now();
    const notificationId = options.orderId ? `notif_${options.orderId}_${Date.now()}` : `notif_${Date.now()}`;
    const eventType = payload.data?.stage || payload.data?.category || options.category || 'push';
    const triggerSource = options.category === 'simple_informational' || payload.data?.source === 'owner_broadcast'
      ? 'manual' : 'automatic';

    if (tokens.length === 0) {
      console.warn(`[NotificationEngine] No active FCM tokens found for UIDs: ${firebaseUserIds.join(', ')}`);
      NotificationLogger.log({
        notificationId,
        timestamp: new Date().toISOString(),
        orderId: options.orderId,
        userId: firebaseUserIds[0] || 'unknown',
        triggerSource,
        eventType,
        recipientRole: payload.data?.role || options.category,
        recipients: firebaseUserIds.join(', '),
        resolvedUids: firebaseUserIds,
        resolvedTokens: 0,
        invalidTokens: 0,
        fcmSuccess: 0,
        fcmFailure: 0,
        skippedTokens: firebaseUserIds.length,
        retryCount: 0,
        providerUsed: 'Firebase FCM',
        latencyMs: 0,
        elapsedTimeMs: 0,
        status: 'skipped',
        errorDetails: 'No active FCM tokens found for target user(s)',
      });
      return { successCount: 0, failureCount: 0, tokensFound: 0, errors: ['no_tokens'] };
    }

    // ── 2. Normalize Android priority ────────────────────────────────────────
    let androidPriority: 'normal' | 'high' = 'high';
    if (options.priority === 'normal') androidPriority = 'normal';

    // Preserve or set channel from payload
    const channelId = payload.android?.notification?.channelId
      || payload.data?.channelId
      || 'olive_order_new_v2';
    const soundName = payload.android?.notification?.sound
      || payload.data?.sound
      || (channelId === 'olive_order_completed_v2' ? 'order_delivered' : 'new_order');
    const clickAction = payload.android?.notification?.clickAction
      || (payload.data?.alert === 'continuous' ? 'olive_alarm' : undefined);

    // Ensure android block is always fully populated
    if (!payload.android) payload.android = {} as any;
    payload.android!.priority = androidPriority;
    if (!payload.android!.notification) payload.android!.notification = {} as any;
    payload.android!.notification!.channelId = channelId;
    payload.android!.notification!.sound = soundName;
    (payload.android!.notification as any).visibility = 'public';
    payload.android!.notification!.notificationPriority =
      androidPriority === 'high' ? 'PRIORITY_MAX' : 'PRIORITY_DEFAULT';
    payload.android!.notification!.defaultVibrateTimings =
      payload.android!.notification!.defaultVibrateTimings ?? true;
    if (clickAction) {
      payload.android!.notification!.clickAction = clickAction;
    }

    // ── 3. Sanitize data block & APNs headers (MUST be string values) ──────
    const sanitizedData: Record<string, string> = {};

    if (payload.data && typeof payload.data === 'object') {
      for (const [k, v] of Object.entries(payload.data)) {
        if (v !== undefined && v !== null) {
          sanitizedData[k] = typeof v === 'string' ? v
            : typeof v === 'object' ? JSON.stringify(v)
            : String(v);
        }
      }
    }

    // Ensure title and body are populated in data block for native handling
    if (!sanitizedData.title && payload.notification?.title) {
      sanitizedData.title = payload.notification.title;
    }
    if (!sanitizedData.body && payload.notification?.body) {
      sanitizedData.body = payload.notification.body;
    }
    if (!sanitizedData.title && payload.android?.notification?.title) {
      sanitizedData.title = payload.android.notification.title;
    }
    if (!sanitizedData.body && payload.android?.notification?.body) {
      sanitizedData.body = payload.android.notification.body;
    }
    if (!sanitizedData.title) sanitizedData.title = 'Olive Pizza';
    if (!sanitizedData.body) sanitizedData.body = 'New update received';

    // Strict APNs header sanitization & validation (Firebase requires EVERY APNs header to be a string)
    const sanitizedApns = sanitizeApnsConfig(payload.apns, options.category || 'push');

    // Category Payload Rule (§2.1):
    // For Restaurant Management and all operational alerts that require OS system tray display
    // and custom audio alerts when closed/killed, NEVER delete the notification blocks.
    const isDataOnlyCategory = options.category === 'alarm_actionable' || options.category === 'pinned_live';

    // ── 4. Chunk and send ────────────────────────────────────────────────────
    const chunkSize = 500;
    const chunks: string[][] = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
      chunks.push(tokens.slice(i, i + chunkSize));
    }

    console.log(
      `[NotificationEngine] Sending category=${options.category || 'order'} | ` +
      `dataOnly=${isDataOnlyCategory} | targets=${firebaseUserIds.length} | tokens=${tokens.length} | chunks=${chunks.length}`
    );

    let totalSuccess = 0;
    let totalFailure = 0;
    const errors: string[] = [];
    const failedTokens: string[] = [];

    await Promise.all(chunks.map(async (chunk) => {
      try {
        const androidConfig = payload.android ? { ...payload.android } : undefined;
        const isUrgentStaffApp = options.targetApp === 'restaurant'
          || options.targetApp === 'delivery'
          || payload.data?.role === 'restaurant_manager'
          || payload.data?.role === 'delivery'
          || sanitizedData.type === 'NEW_ORDER'
          || sanitizedData.type === 'ORDER_DELIVERED'
          || sanitizedData.type === 'DELIVERY_ASSIGNED'
          || sanitizedData.stage === 'delivery_assigned';

        const isShiftTransition = sanitizedData.type === 'WORK_SHIFT_STARTED' || sanitizedData.type === 'WORK_SHIFT_ENDED';
        // Actionable staff alarms are handled by the native Android messaging service, which
        // builds the one-shot custom-sound notification and order action buttons itself. If we
        // also attach an FCM notification block, Android may display it without invoking that
        // native handler while the app is backgrounded or killed.
        const isNativeManagedStaffAlarm = isUrgentStaffApp && (options.category === 'alarm_actionable' || payload.data?.category === 'alarm_actionable');

        if (isDataOnlyCategory && androidConfig && (!isUrgentStaffApp || isNativeManagedStaffAlarm)) {
          delete androidConfig.notification;
        }
        // Shift transitions are always native-managed on Android, including their action buttons.
        if ((isShiftTransition || isNativeManagedStaffAlarm) && androidConfig) delete androidConfig.notification;

        const message: admin.messaging.MulticastMessage = {
          tokens: chunk,
          data: sanitizedData,
          android: androidConfig,
          apns: sanitizedApns,
          webpush: payload.webpush,
        };

        // Keep the visible APNs alert while Android receives data-only pushes for native operational UI.
        if (!isShiftTransition && !isNativeManagedStaffAlarm && (!isDataOnlyCategory || isUrgentStaffApp) && (payload.notification || sanitizedData.title)) {
          message.notification = payload.notification || {
            title: sanitizedData.title || 'Olive Pizza Alert',
            body: sanitizedData.body || 'Immediate action required'
          };
        }

        const response = await adminMessaging.sendEachForMulticast(message);
        const elapsedMs = Date.now() - startTime;
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;

        response.responses.forEach((r, idx) => {
          const fcmToken = chunk[idx];

          if (r.error) {
            const code = r.error.code;
            if (
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/registration-token-not-registered' ||
              code === 'invalid-registration-token' ||
              code === 'registration-token-not-registered'
            ) {
              failedTokens.push(fcmToken);
            } else {
              errors.push(`${code}: ${r.error.message}`);
            }
          }

          NotificationLogger.log({
            notificationId,
            timestamp: new Date().toISOString(),
            orderId: options.orderId,
            userId: firebaseUserIds.length === 1 ? firebaseUserIds[0] : 'bulk_target',
            category: options.category || payload.data?.category || 'push',
            triggerSource,
            eventType,
            recipientRole: payload.data?.role || options.category,
            recipients: firebaseUserIds.join(', '),
            resolvedUids: firebaseUserIds,
            resolvedTokens: tokens.length,
            invalidTokens: failedTokens.length,
            fcmSuccess: response.successCount,
            fcmFailure: response.failureCount,
            skippedTokens: 0,
            retryCount: 0,
            providerUsed: 'Firebase FCM',
            latencyMs: elapsedMs,
            elapsedTimeMs: elapsedMs,
            fcmToken,
            payload,
            apnsHeaders: sanitizedApns?.headers || null,
            androidConfig: payload.android || null,
            firebaseResponse: r,
            status: r.success ? 'success' : 'failure',
            errorDetails: r.error?.message,
            retryReason: r.error?.code,
          });
        });
      } catch (err: any) {
        console.error('[NotificationEngine] Chunk send failed:', err.message);
        errors.push(err.message);
        totalFailure += chunk.length;
      }
    }));

    // ── 5. Deactivate permanently invalid tokens in Postgres & Firestore ────────
    if (failedTokens.length > 0) {
      pgPool.query(
        `UPDATE fcm_tokens SET is_active = FALSE WHERE token = ANY($1)`,
        [failedTokens]
      ).catch(err => console.error('[NotificationEngine] Token deactivation failed:', err.message));

      // Remove from Firestore user docs as well
      for (const uid of firebaseUserIds) {
        db.collection('users').doc(uid).update({
          fcmTokens: FieldValue.arrayRemove(...failedTokens)
        }).catch(() => {});
      }

      console.log(`[NotificationEngine] Deactivated ${failedTokens.length} invalid FCM tokens`);
    }

    console.log(
      `[NotificationEngine] Result: ${totalSuccess} sent, ${totalFailure} failed, ` +
      `${tokens.length} tokens, ${Date.now() - startTime}ms`
    );

    return {
      successCount: totalSuccess,
      failureCount: totalFailure,
      tokensFound: tokens.length,
      errors,
    };
  }

  /**
   * Send notification directly to a list of raw tokens (e.g. ActivityKit APNs tokens or FCM tokens).
   */
  public async sendToTokens(
    tokens: string[],
    payload: NotificationPayload,
    options: NotificationEngineOptions = {}
  ): Promise<SendResult> {
    if (!tokens || tokens.length === 0) {
      return { successCount: 0, failureCount: 0, tokensFound: 0, errors: [] };
    }

    const startTime = Date.now();
    const sanitizedData: Record<string, string> = {};
    if (payload.data && typeof payload.data === 'object') {
      for (const [k, v] of Object.entries(payload.data)) {
        if (v !== undefined && v !== null) {
          sanitizedData[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
      }
    }

    const sanitizedApns = sanitizeApnsConfig(payload.apns, options.category || 'push');
    const chunkSize = 500;
    const chunks: string[][] = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
      chunks.push(tokens.slice(i, i + chunkSize));
    }

    let totalSuccess = 0;
    let totalFailure = 0;
    const errors: string[] = [];

    await Promise.all(chunks.map(async (chunk) => {
      try {
        const message: admin.messaging.MulticastMessage = {
          tokens: chunk,
          data: sanitizedData,
          android: payload.android,
          apns: sanitizedApns,
          webpush: payload.webpush,
        };
        if (payload.notification) {
          message.notification = payload.notification;
        }

        const response = await adminMessaging.sendEachForMulticast(message);
        totalSuccess += response.successCount;
        totalFailure += response.failureCount;

        response.responses.forEach((r) => {
          if (r.error) {
            errors.push(`${r.error.code}: ${r.error.message}`);
          }
        });
      } catch (err: any) {
        console.error('[NotificationEngine] sendToTokens chunk failed:', err.message);
        errors.push(err.message);
        totalFailure += chunk.length;
      }
    }));

    return {
      successCount: totalSuccess,
      failureCount: totalFailure,
      tokensFound: tokens.length,
      errors,
    };
  }

  /**
   * Hard Server-Side Security Guard:
   * Re-evaluates backend identity and drops any customer or delivery personnel
   * from receiving internal business / monthly reports.
   */
  public async filterForbiddenReportRecipients(
    uids: string[],
    mockProfiles?: Record<string, { role: string; email?: string }>
  ): Promise<string[]> {
    const allowedStaffRoles = new Set([
      'owner', 'admin', 'developer', 'platform_owner',
      'franchise_owner', 'franchise_manager',
      'restaurant_manager', 'manager', 'cashier', 'staff', 'kitchen_staff'
    ]);
    const forbiddenRoles = new Set(['customer', 'delivery', 'delivery_partner', 'rider']);

    const allowedUids: string[] = [];
    for (const uid of uids) {
      try {
        let role = '';
        let email = '';

        if (mockProfiles && mockProfiles[uid]) {
          role = (mockProfiles[uid].role || '').toLowerCase().trim();
          email = (mockProfiles[uid].email || '').toLowerCase().trim();
        } else {
          const userDoc = await db.collection('users').doc(uid).get();
          if (userDoc.exists) {
            const data = userDoc.data() || {};
            role = (data.role || '').toLowerCase().trim();
            email = (data.email || '').toLowerCase().trim();
          } else {
            const res = await pgPool.query(`SELECT role, email FROM users WHERE firebase_uid = $1`, [uid]).catch(() => ({ rows: [] }));
            if (res.rows.length > 0) {
              role = (res.rows[0].role || '').toLowerCase().trim();
              email = (res.rows[0].email || '').toLowerCase().trim();
            }
          }
        }

        const isOwnerEmail = ['olivepizzarjn@gmail.com', 'webhub2811@gmail.com', 'olivepizzamaker@gmail.com'].includes(email);

        // 1. Forbidden roles are unconditionally dropped
        if (forbiddenRoles.has(role)) {
          console.warn(`[NotificationEngine][Security Guard] Blocked internal report notification to user ${uid} with forbidden role '${role}'.`);
          continue;
        }

        // 2. Only allow if verified staff role or verified owner email
        if (isOwnerEmail || allowedStaffRoles.has(role)) {
          allowedUids.push(uid);
        } else {
          console.warn(`[NotificationEngine][Security Guard] Blocked internal report notification to user ${uid} without staff authorization (role='${role}').`);
        }
      } catch (e: any) {
        console.warn(`[NotificationEngine][Security Guard] Exception checking report recipient ${uid}:`, e.message);
      }
    }
    return allowedUids;
  }

  /**
   * Resolve active FCM tokens for a list of Firebase UIDs.
   * Primary: Postgres fcm_tokens (is_active=TRUE, optionally matching targetApp)
   * Fallback: Firestore users.fcmTokens[] (auto-synced back to Postgres)
   */
  private async resolveTokens(firebaseUserIds: string[], targetApp?: string): Promise<string[]> {
    const client = await pgPool.connect();
    try {
      let queryStr = `SELECT user_id as firebase_uid, token, app_name, role
                      FROM fcm_tokens
                      WHERE user_id = ANY($1) AND is_active = TRUE`;
      const params: any[] = [firebaseUserIds];

      const result = await client.query(queryStr, params).catch(async () => {
        // Graceful fallback if role or app_name column is not yet present
        return await client.query(
          `SELECT user_id as firebase_uid, token, app_name
           FROM fcm_tokens
           WHERE user_id = ANY($1) AND is_active = TRUE`,
          [firebaseUserIds]
        ).catch(async () => {
          return await client.query(
            `SELECT user_id as firebase_uid, token
             FROM fcm_tokens
             WHERE user_id = ANY($1) AND is_active = TRUE`,
            [firebaseUserIds]
          ).catch(() => ({ rows: [] as any[] }));
        });
      });

      const ALLOWED_STAFF_ROLES = new Set(['restaurant_manager', 'kitchen_staff', 'manager', 'cashier', 'chef', 'owner', 'platform_owner', 'admin']);

      let filteredRows = result.rows;
      if (targetApp) {
        // STRICT APP ISOLATION with App Synonyms:
        filteredRows = result.rows.filter((r: any) => {
          const app = (r.app_name || '').toLowerCase().trim();
          const target = (targetApp || '').toLowerCase().trim();
          const tokenRole = (r.role || '').toLowerCase().trim();

          // CRITICAL APP TARGET ISOLATION:
          // For restaurant operational targetApp, only tokens registered from restaurant app are allowed.
          if (target === 'restaurant' || target === 'restaurant_manager') {
            if (app === 'owner' || app === 'customer' || app === 'delivery') {
              return false;
            }
          }

          if (!target || target === 'all') return true;

          // Match restaurant / restaurant_manager synonyms
          if ((target === 'restaurant' || target === 'restaurant_manager') &&
              (app === 'restaurant' || app === 'restaurant_manager')) {
            return true;
          }
          // Match delivery / delivery_partner synonyms
          if ((target === 'delivery' || target === 'delivery_partner') &&
              (app === 'delivery' || app === 'delivery_partner')) {
            return true;
          }
          // Match franchise / franchise_manager synonyms
          if ((target === 'franchise' || target === 'franchise_manager') &&
              (app === 'franchise' || app === 'franchise_manager')) {
            return true;
          }
          // Match owner
          if (target === 'owner' && app === 'owner') return true;
          // Match pos
          if (target === 'pos' && app === 'pos') return true;
          // Match customer
          if (target === 'customer' && (app === 'customer' || !app)) return true;

          // Reject if explicitly tagged for a different app
          if (app && app !== target) return false;

          // For staff / delivery / owner apps, reject untagged legacy tokens to prevent cross-app leakage
          return target === 'customer';
        });
      }

      // SECOND PASS: Authoritative Identity Verification for Restaurant Target
      if (targetApp && (targetApp.toLowerCase().trim() === 'restaurant' || targetApp.toLowerCase().trim() === 'restaurant_manager')) {
        const verifiedRows: any[] = [];
        for (const row of filteredRows) {
          try {
            const uid = row.firebase_uid;
            let isVerifiedStaff = false;

            // 1. Authoritative PostgreSQL app_users check
            const pgUser = await pgPool.query(
              `SELECT id, email, role, allowed_apps, is_active FROM app_users 
               WHERE id = $1 LIMIT 1`,
              [uid]
            ).catch(() => ({ rows: [] }));

            if (pgUser.rows.length > 0) {
              const u = pgUser.rows[0];
              const allowedApps = Array.isArray(u.allowed_apps) ? u.allowed_apps.map((a: string) => String(a).toUpperCase().trim()) : [];
              const uRole = (u.role || '').toLowerCase().trim();
              if (u.is_active !== false && (
                uRole === 'owner' || 
                uRole === 'platform_owner' ||
                allowedApps.includes('RESTAURANT_MANAGER') || 
                allowedApps.includes('RESTAURANT') ||
                ALLOWED_STAFF_ROLES.has(uRole)
              )) {
                isVerifiedStaff = true;
              }
            }

            // 2. Fallback to Firestore users collection
            if (!isVerifiedStaff) {
              const uDoc = await db.collection('users').doc(uid).get().catch(() => null);
              if (uDoc && uDoc.exists) {
                const ud = uDoc.data() || {};
                const role = (ud.role || '').toLowerCase().trim();
                if ((ALLOWED_STAFF_ROLES.has(role) || role === 'owner') && ud.isActive !== false) {
                  isVerifiedStaff = true;
                }
              }
            }

            // 3. Fallback to restaurant_managers collection
            if (!isVerifiedStaff) {
              const rmDoc = await db.collection('restaurant_managers').doc(uid).get().catch(() => null);
              if (rmDoc && rmDoc.exists) {
                const rmd = rmDoc.data() || {};
                const st = (rmd.status || '').toUpperCase();
                if ((st === 'APPROVED' || st === 'ACTIVE' || !rmd.status) && rmd.isActive !== false) {
                  isVerifiedStaff = true;
                }
              }
            }

            // Allow positively verified restaurant staff tokens
            if (isVerifiedStaff) {
              verifiedRows.push(row);
            } else {
              console.warn(`[NotificationEngine] Token for UID ${uid} rejected — not verified as active restaurant staff`);
            }
          } catch (vErr: any) {
            console.warn(`[NotificationEngine] Error verifying token for UID ${row.firebase_uid} — failing closed:`, vErr.message);
          }
        }
        filteredRows = verifiedRows;
      }

      const foundUids = new Set(filteredRows.map((r: any) => r.firebase_uid));
      let tokens: string[] = filteredRows.map((r: any) => r.token);

      // Firestore fallback for UIDs with no Postgres tokens
      const missingUids = firebaseUserIds.filter(uid => !foundUids.has(uid));
      if (missingUids.length > 0) {
        for (const uid of missingUids) {
          try {
            const userDoc = await db.collection('users').doc(uid).get();
            const userData = userDoc.data() || {};
            const userEmail = (userData.email || '').toLowerCase().trim();
            const userRole = (userData.role || '').toLowerCase().trim();
            const isOwner = userRole === 'owner' || userRole === 'platform_owner';

            // Safety Guard: Owner tokens must NEVER fallback for customer notifications
            if (isOwner && targetApp === 'customer') {
              continue;
            }
            // Delivery tokens fallback guard: only delivery roles
            if (targetApp === 'delivery' && !['delivery', 'delivery_partner', 'rider'].includes(userRole)) {
              continue;
            }
            // Restaurant tokens fallback guard: only restaurant staff roles
            if (targetApp === 'restaurant' && !['restaurant_manager', 'kitchen_staff', 'manager', 'cashier', 'chef'].includes(userRole)) {
              continue;
            }

            const firestoreTokens: string[] = userData.fcmTokens || [];
            for (const t of firestoreTokens) {
              if (t && typeof t === 'string') {
                tokens.push(t);
                // Auto-sync to Postgres so future sends don't need the fallback
                client.query(
                  `INSERT INTO fcm_tokens (user_id, token, is_active, last_used_at, app_name)
                   VALUES ($1, $2, TRUE, NOW(), $3)
                   ON CONFLICT (user_id, token)
                   DO UPDATE SET is_active = TRUE, last_used_at = NOW()`,
                  [uid, t, targetApp || 'customer']
                ).catch(() => {});
              }
            }
          } catch (e: any) {
            console.warn(`[NotificationEngine] Firestore token fallback failed for ${uid}:`, e.message);
          }
        }
      }

      return Array.from(new Set(tokens)); // deduplicate
    } finally {
      client.release();
    }
  }

  /**
   * Resolve all active FCM tokens for users with a given role.
   * Resolves UIDs from Firestore users collection.
   */
  public async resolveByRole(role: 'owner' | 'delivery_partner' | 'customer' | 'restaurant_manager' | 'restaurant' | 'franchise' | string): Promise<string[]> {
    let targetRoles: string[] = [role];
    if (role === 'delivery_partner' || role === 'delivery') {
      targetRoles = ['delivery_partner', 'delivery'];
    } else if (role === 'restaurant' || role === 'restaurant_manager') {
      targetRoles = ['restaurant_manager', 'kitchen_staff', 'manager'];
    } else if (role === 'franchise' || role === 'franchise_manager') {
      targetRoles = ['franchise_owner', 'franchise_manager'];
    } else if (role === 'owner' || role === 'admin') {
      targetRoles = ['owner', 'admin'];
    } else if (role === 'customer') {
      targetRoles = ['customer'];
    }

    const uidsSet = new Set<string>();

    // 1. Resolve user UIDs from Firestore users collection
    try {
      for (const r of targetRoles) {
        const snap = await db.collection('users').where('role', '==', r).get();
        snap.docs.forEach(doc => uidsSet.add(doc.id));
      }
    } catch (e: any) {
      console.warn(`[NotificationEngine] Firestore role lookup failed for ${role}:`, e.message);
    }

    // 2. Also check PostgreSQL users table if available (graceful fallback)
    try {
      const res = await pgPool.query(
        `SELECT firebase_uid FROM users WHERE role = ANY($1)`,
        [targetRoles]
      );
      res.rows.forEach((row: any) => {
        if (row.firebase_uid) uidsSet.add(row.firebase_uid);
      });
    } catch (e: any) {
      // Ignore error if Postgres users table doesn't have role column
    }

    return Array.from(uidsSet);
  }

  /**
   * Resolves active user UIDs for restaurant managers/staff for a specific branch and franchise.
   * Strictly scopes new-order and operational alerts to the target branch & franchise.
   * Excludes franchise_manager from operational kitchen alarms.
   */
  public async resolveBranchStaff(
    branchId: string,
    franchiseId?: string,
    roles: string[] = ['restaurant_manager', 'kitchen_staff', 'manager', 'cashier', 'chef']
  ): Promise<string[]> {
    if (!branchId || typeof branchId !== 'string' || branchId.trim() === '') {
      console.warn('[NotificationEngine] Cannot resolve branch staff: invalid or empty branchId');
      return [];
    }

    const cleanBranchId = branchId.trim();
    const cleanFranchiseId = franchiseId ? franchiseId.trim() : undefined;
    const uidsSet = new Set<string>();

    const normF = (id?: string) => (id || '').trim().toLowerCase().replace(/^fra_/, '');
    const cleanTargetF = normF(cleanFranchiseId);

    try {
      // 1. Query Firestore users by branchId + role
      for (const r of roles) {
        const snap = await db.collection('users')
          .where('branchId', '==', cleanBranchId)
          .where('role', '==', r)
          .get();

        snap.docs.forEach((doc: any) => {
          const d = doc.data();
          if (d?.isActive !== false) {
            const userF = normF(d?.franchiseId);
            if (!cleanTargetF || !userF || userF === cleanTargetF || d?.franchiseId === 'all') {
              uidsSet.add(doc.id);
            }
          }
        });
      }

      // 2. Query restaurant_managers collection for approved managers (strictly 1:1 branch & franchise)
      try {
        const rmSnap = await db.collection('restaurant_managers')
          .where('branchId', '==', cleanBranchId)
          .get();

        rmSnap.docs.forEach((doc: any) => {
          const d = doc.data();
          const st = (d?.status || '').toUpperCase();
          if (d?.isActive !== false && (st === 'APPROVED' || st === 'ACTIVE' || !d?.status)) {
            const userF = normF(d?.franchiseId);
            if (!cleanTargetF || !userF || userF === cleanTargetF || d?.franchiseId === 'all') {
              uidsSet.add(doc.id);
            }
          }
        });
      } catch (rmErr) {
        // Non-fatal
      }

      // 4. Also check PostgreSQL fcm_tokens table for tokens registered directly under this branch (+ franchise)
      try {
        let pgSql = `SELECT DISTINCT user_id 
                     FROM fcm_tokens 
                     WHERE is_active = TRUE 
                       AND branch_id = $1 
                       AND role = ANY($2)`;
        const pgParams: any[] = [cleanBranchId, roles];
        if (cleanFranchiseId) {
          pgSql += ` AND (franchise_id = $3 OR franchise_id = $4 OR franchise_id IS NULL OR franchise_id = '')`;
          pgParams.push(cleanFranchiseId, cleanTargetF);
        }
        const pgRes = await pgPool.query(pgSql, pgParams);
        pgRes.rows.forEach((r: any) => {
          if (r.user_id) uidsSet.add(r.user_id);
        });
      } catch (pgErr: any) {
        // Postgres query non-fatal fallback
      }
    } catch (e: any) {
      console.warn(`[NotificationEngine] Branch staff lookup failed for branch ${cleanBranchId} (franchise: ${cleanFranchiseId}):`, e.message);
    }

    const ALLOWED_STAFF_ROLES = new Set(['restaurant_manager', 'kitchen_staff', 'manager', 'cashier', 'chef']);
    const FORBIDDEN_EMAILS = new Set(['webhub2811@gmail.com', 'olivepizzarjn@gmail.com', 'olivepizzamaker@gmail.com']);
    const FORBIDDEN_ROLES = new Set(['owner', 'platform_owner', 'customer', 'delivery', 'delivery_partner', 'rider']);

    const validUids: string[] = [];
    for (const uid of uidsSet) {
      try {
        let isAuthorized = false;

        // 1. Check users collection
        const uDoc = await db.collection('users').doc(uid).get().catch(() => null);
        if (uDoc && uDoc.exists) {
          const ud = uDoc.data() || {};
          const email = (ud.email || '').toLowerCase().trim();
          const role = (ud.role || '').toLowerCase().trim();

          if (FORBIDDEN_EMAILS.has(email) || FORBIDDEN_ROLES.has(role)) {
            console.log(`[NotificationEngine] 🚨 SECURITY: Excluded non-restaurant user ${uid} (${email}, role=${role}) from branch staff`);
            continue;
          }

          if (ALLOWED_STAFF_ROLES.has(role) && ud.isActive !== false) {
            const userF = normF(ud.franchiseId);
            const userB = (ud.branchId || '').trim();
            const branchMatches = !cleanBranchId || userB === cleanBranchId || userB === 'all';
            const franchiseMatches = !cleanTargetF || !userF || userF === cleanTargetF || ud.franchiseId === 'all';
            if (branchMatches && franchiseMatches) {
              isAuthorized = true;
            }
          }
        }

        // 2. If not confirmed in users, check restaurant_managers collection
        if (!isAuthorized) {
          const rmDoc = await db.collection('restaurant_managers').doc(uid).get().catch(() => null);
          if (rmDoc && rmDoc.exists) {
            const rmd = rmDoc.data() || {};
            const email = (rmd.email || '').toLowerCase().trim();
            const st = (rmd.status || '').toUpperCase();
            if (!FORBIDDEN_EMAILS.has(email) && (st === 'APPROVED' || st === 'ACTIVE' || !rmd.status) && rmd.isActive !== false) {
              const userF = normF(rmd.franchiseId);
              const userB = (rmd.branchId || '').trim();
              const branchMatches = !cleanBranchId || userB === cleanBranchId || userB === 'all';
              const franchiseMatches = !cleanTargetF || !userF || userF === cleanTargetF || rmd.franchiseId === 'all';
              if (branchMatches && franchiseMatches) {
                isAuthorized = true;
              }
            }
          }
        }

        // FAIL CLOSED (§5): Only include positively verified restaurant staff!
        if (isAuthorized) {
          validUids.push(uid);
        } else {
          console.warn(`[NotificationEngine] Recipient ${uid} failed positive restaurant staff verification — excluded.`);
        }
      } catch (verErr: any) {
        // FAIL CLOSED on error — do NOT include
        console.warn(`[NotificationEngine] Error verifying user ${uid} — failing closed:`, verErr.message);
      }
    }

    return validUids;
  }

  /**
   * Automatic Token Cleanup Job:
   * 1. Deactivates tokens inactive > 30 days.
   * 2. Deletes duplicate inactive tokens older than 60 days.
   */
  public async cleanupStaleTokens(): Promise<{ deactivatedCount: number; deletedCount: number }> {
    const client = await pgPool.connect();
    try {
      const deactRes = await client.query(
        `UPDATE fcm_tokens SET is_active = FALSE 
         WHERE is_active = TRUE AND (last_used_at < NOW() - INTERVAL '30 days' OR (last_used_at IS NULL AND created_at < NOW() - INTERVAL '30 days'))
         RETURNING id`
      );

      const delRes = await client.query(
        `DELETE FROM fcm_tokens 
         WHERE is_active = FALSE AND (updated_at < NOW() - INTERVAL '60 days' OR created_at < NOW() - INTERVAL '60 days')
         RETURNING id`
      );

      const deactivatedCount = deactRes.rows.length;
      const deletedCount = delRes.rows.length;
      if (deactivatedCount > 0 || deletedCount > 0) {
        console.log(`[NotificationEngine] Token Cleanup: Deactivated ${deactivatedCount} stale tokens, deleted ${deletedCount} expired tokens.`);
      }

      return { deactivatedCount, deletedCount };
    } catch (err: any) {
      console.error('[NotificationEngine] Token cleanup failed:', err.message);
      return { deactivatedCount: 0, deletedCount: 0 };
    } finally {
      client.release();
    }
  }
}

/**
 * Strict APNs Payload Sanitizer & Validator:
 * Guarantees EVERY value in `apns.headers` is explicitly a string.
 * Removes null, undefined, boolean, and numeric values or converts them to String(v).
 */
export function sanitizeApnsConfig(apns?: any, category?: string): admin.messaging.ApnsConfig | undefined {
  if (!apns || typeof apns !== 'object') return undefined;

  const cleanApns: admin.messaging.ApnsConfig = {};

  if (apns.headers && typeof apns.headers === 'object') {
    const cleanHeaders: Record<string, string> = {};
    for (const [key, rawVal] of Object.entries(apns.headers)) {
      if (rawVal === null || rawVal === undefined || rawVal === '') continue;

      const stringVal = String(rawVal);
      if (typeof rawVal !== 'string') {
        console.warn(`[NotificationEngine][APNs Validation] Category="${category || 'push'}" Header "${key}" converted from ${typeof rawVal} (${rawVal}) to string "${stringVal}"`);
      }
      cleanHeaders[key] = stringVal;
    }
    if (Object.keys(cleanHeaders).length > 0) {
      cleanApns.headers = cleanHeaders;
    }
  }

  if (apns.payload && typeof apns.payload === 'object') {
    cleanApns.payload = apns.payload;
  }
  if (apns.fcmOptions && typeof apns.fcmOptions === 'object') {
    cleanApns.fcmOptions = apns.fcmOptions;
  }

  return Object.keys(cleanApns).length > 0 ? cleanApns : undefined;
}

// Singleton export
export const notificationEngine = new NotificationEngine();
