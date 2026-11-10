import cron from 'node-cron';
import { adminDb } from '../../config/firebase.js';
import { notificationEngine } from '../notification/NotificationEngine.js';

export interface RiderWorkSlot {
  id: string;
  daysOfWeek: number[]; // JS weekday: Sunday=0
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm; earlier than start means next day
}

export interface RiderWorkSchedule {
  uid: string;
  enabled: boolean;
  timezone: string;
  slots: RiderWorkSlot[];
  startSound: 'new_order' | 'order_alert';
  endSound: 'order_delivered' | 'order_confirmed';
  continueUntil?: string | null;
  lastAppliedOnline?: boolean | null;
  updatedAt?: string;
}

const SCHEDULES = 'rider_work_schedules';
const USERS = 'users';
const RIDERS = 'delivery_partners';
const WEEK_MINUTES = 7 * 24 * 60;
const SAFE_START_SOUNDS = new Set(['new_order', 'order_alert']);
const SAFE_END_SOUNDS = new Set(['order_delivered', 'order_confirmed']);
const IOS_SOUND_FILES: Record<string, string> = {
  new_order: 'new_order.wav',
  order_alert: 'order_alert.mp3',
  order_delivered: 'order_delivered.wav',
  order_confirmed: 'order_confirmed.mp3'
};

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizeTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80) return 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return 'Asia/Kolkata';
  }
}

function localClock(date: Date, timezone: string): { day: number; minute: number; dateKey: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const dayByName: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    day: dayByName[get('weekday')] ?? date.getUTCDay(),
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`
  };
}

function isSlotActive(slot: RiderWorkSlot, day: number, minute: number): boolean {
  const start = minuteOfDay(slot.startTime);
  const end = minuteOfDay(slot.endTime);
  if (end > start) {
    return slot.daysOfWeek.includes(day) && minute >= start && minute < end;
  }
  const previousDay = (day + 6) % 7;
  return (slot.daysOfWeek.includes(day) && minute >= start)
    || (slot.daysOfWeek.includes(previousDay) && minute < end);
}

export class RiderWorkScheduleService {
  private static quotaBackoffUntil = 0;
  private static initialized = false;

  static normalizeSchedule(uid: string, value: any): RiderWorkSchedule {
    if (!value || typeof value !== 'object') throw new Error('A schedule object is required.');
    const rawSlots = Array.isArray(value.slots) ? value.slots : [];
    if (rawSlots.length > 5) throw new Error('You can configure up to five work-time slots.');
    const slots: RiderWorkSlot[] = rawSlots.map((slot: any, index: number) => {
      if (!isValidTime(slot?.startTime) || !isValidTime(slot?.endTime)) {
        throw new Error(`Slot ${index + 1}: enter valid start and end times.`);
      }
      if (slot.startTime === slot.endTime) {
        throw new Error(`Slot ${index + 1}: start and end times cannot be identical.`);
      }
      const days: number[] = Array.isArray(slot.daysOfWeek)
        ? Array.from(new Set<number>((slot.daysOfWeek as unknown[]).map((day: unknown) => Number(day))))
        : [];
      if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error(`Slot ${index + 1}: choose at least one valid weekday.`);
      }
      const id = typeof slot.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(slot.id)
        ? slot.id
        : `slot_${index + 1}`;
      return { id, daysOfWeek: days.sort((a, b) => a - b), startTime: slot.startTime, endTime: slot.endTime };
    });

    // Prevent overlaps, including overnight slots. A schedule is expanded into a weekly minute map.
    const occupiedByDay = new Map<number, Set<number>>();
    for (const slot of slots) {
      const start = minuteOfDay(slot.startTime);
      const end = minuteOfDay(slot.endTime);
      const duration = end > start ? end - start : 1440 - start + end;
      if (duration <= 0 || duration > 24 * 60) throw new Error('Each work-time slot must be shorter than 24 hours.');
      for (const day of slot.daysOfWeek) {
        for (let offset = 0; offset < duration; offset++) {
          const absolute = (day * 1440 + start + offset) % WEEK_MINUTES;
          const targetDay = Math.floor(absolute / 1440);
          const minute = absolute % 1440;
          let daySet = occupiedByDay.get(targetDay);
          if (!daySet) { daySet = new Set<number>(); occupiedByDay.set(targetDay, daySet); }
          if (daySet.has(minute)) throw new Error('Work-time slots cannot overlap on the same weekday.');
          daySet.add(minute);
        }
      }
    }

    const startSound = SAFE_START_SOUNDS.has(value.startSound) ? value.startSound : 'new_order';
    const endSound = SAFE_END_SOUNDS.has(value.endSound) ? value.endSound : 'order_delivered';
    return {
      uid,
      enabled: Boolean(value.enabled) && slots.length > 0,
      timezone: normalizeTimezone(value.timezone),
      slots,
      startSound: startSound as RiderWorkSchedule['startSound'],
      endSound: endSound as RiderWorkSchedule['endSound'],
      continueUntil: null,
      updatedAt: new Date().toISOString()
    };
  }

  static isCurrentlyScheduled(schedule: RiderWorkSchedule, now: Date = new Date()): boolean {
    if (!schedule.enabled) return false;
    const clock = localClock(now, normalizeTimezone(schedule.timezone));
    const continued = Boolean(schedule.continueUntil && Date.parse(schedule.continueUntil) > now.getTime());
    const insideWindow = Array.isArray(schedule.slots) && schedule.slots.some((slot) =>
      isSlotActive(slot, clock.day, clock.minute)
    );
    return insideWindow || continued;
  }

  static async getSchedule(uid: string): Promise<RiderWorkSchedule> {
    const snap = await adminDb.collection(SCHEDULES).doc(uid).get();
    if (snap.exists) return { uid, ...snap.data() } as RiderWorkSchedule;
    const userSnap = await adminDb.collection(USERS).doc(uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    return {
      uid,
      enabled: false,
      timezone: normalizeTimezone(userData?.timezone || 'Asia/Kolkata'),
      slots: [],
      startSound: 'order_alert',
      endSound: 'order_delivered',
      continueUntil: null,
      lastAppliedOnline: null
    };
  }

  static async saveSchedule(uid: string, value: any): Promise<RiderWorkSchedule> {
    const currentSnap = await adminDb.collection(SCHEDULES).doc(uid).get();
    const normalized = this.normalizeSchedule(uid, value);
    const current = currentSnap.exists ? currentSnap.data() : {};
    const saved: RiderWorkSchedule = {
      ...normalized,
      continueUntil: current?.continueUntil || null,
      lastAppliedOnline: typeof current?.lastAppliedOnline === 'boolean' ? current.lastAppliedOnline : null,
      updatedAt: new Date().toISOString()
    };
    await adminDb.collection(SCHEDULES).doc(uid).set(saved, { merge: true });
    await adminDb.collection(USERS).doc(uid).set({
      workingSchedule: saved.slots,
      workScheduleEnabled: saved.enabled,
      workScheduleTimezone: saved.timezone,
      workScheduleUpdatedAt: saved.updatedAt
    }, { merge: true });
    await adminDb.collection(RIDERS).doc(uid).set({
      workingSchedule: saved.slots,
      workScheduleEnabled: saved.enabled,
      workScheduleTimezone: saved.timezone,
      workScheduleUpdatedAt: saved.updatedAt
    }, { merge: true }).catch(() => {});
    return saved;
  }

  static async extendWork(uid: string, minutes: number): Promise<{ until: string }> {
    const allowed = new Set([15, 30, 60, 90, 120, 180]);
    if (!allowed.has(minutes)) throw new Error('Choose a supported extension: 15, 30, 60, 90, 120 or 180 minutes.');
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const schedule = await this.getSchedule(uid);
    if (!schedule.enabled) throw new Error('Save and enable at least one work-time slot before extending work.');

    // Re-check account authorization at the point of mutation; a disabled rider must never be
    // brought online by an old notification action or a concurrent shift-end request.
    const [userSnap, riderSnap] = await Promise.all([
      adminDb.collection(USERS).doc(uid).get(),
      adminDb.collection(RIDERS).doc(uid).get().catch(() => null)
    ]);
    const user = userSnap.exists ? userSnap.data() : {};
    const rider = riderSnap?.exists ? riderSnap.data() : {};
    const role = String(user?.role || rider?.role || '').toLowerCase();
    const state = String(user?.accountStatus || user?.status || rider?.accountStatus || rider?.status || '').toLowerCase();
    const active = userSnap.exists && user?.isActive !== false && rider?.isActive !== false
      && ['delivery_partner', 'delivery', 'rider'].includes(role)
      && !['disabled', 'deactivated', 'rejected', 'revoked', 'deleted', 'suspended', 'blocked'].includes(state);
    if (!active) throw new Error('This delivery account is no longer authorized to continue work.');

    await adminDb.collection(SCHEDULES).doc(uid).set({
      continueUntil: until,
      suppressNextStartAlert: false,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    await this.applyOnlineState(uid, true, 'rider_extended_shift');
    await adminDb.collection(SCHEDULES).doc(uid).set({
      lastAppliedOnline: true,
      lastTransitionAt: new Date().toISOString()
    }, { merge: true });
    return { until };
  }

  static init(): void {
    if (this.initialized) return;
    this.initialized = true;
    cron.schedule('* * * * *', () => {
      void this.reconcileDueShifts();
    });
    void this.reconcileDueShifts();
    console.log('[RiderWorkScheduleService] Weekly rider schedule worker enabled (runs every minute).');
  }

  static async reconcileDueShifts(): Promise<void> {
    if (Date.now() < this.quotaBackoffUntil) {
      return;
    }
    let docs;
    try {
      const snap = await adminDb.collection(SCHEDULES).get();
      docs = snap.docs;
    } catch (error: any) {
      if (error?.message?.includes('RESOURCE_EXHAUSTED')) {
        this.quotaBackoffUntil = Date.now() + 15 * 60 * 1000;
        console.warn('[RiderWorkScheduleService] Firestore quota exceeded. Backing off for 15 minutes.');
        return;
      }
      console.error('[RiderWorkScheduleService] Could not load work schedules:', error?.message || error);
      return;
    }

    const now = new Date();
    for (const scheduleDoc of docs) {
      const uid = scheduleDoc.id;
      const schedule = { uid, ...scheduleDoc.data() } as RiderWorkSchedule & Record<string, any>;
      const [userSnap, riderSnap] = await Promise.all([
        adminDb.collection(USERS).doc(uid).get().catch(() => null),
        adminDb.collection(RIDERS).doc(uid).get().catch(() => null)
      ]);
      const user = userSnap?.exists ? userSnap.data() : {};
      const rider = riderSnap?.exists ? riderSnap.data() : {};
      const role = String(user?.role || rider?.role || '').toLowerCase();
      const accountStatus = String(user?.status || rider?.status || '').toLowerCase();
      const isAuthorizedRider = ['delivery_partner', 'delivery', 'rider'].includes(role)
        && user?.isActive !== false && rider?.isActive !== false
        && !['disabled', 'deactivated', 'rejected', 'revoked', 'deleted', 'suspended'].includes(accountStatus);
      const clock = localClock(now, normalizeTimezone(schedule.timezone));
      const continued = Boolean(schedule.continueUntil && Date.parse(schedule.continueUntil) > now.getTime());
      const insideWindow = Boolean(schedule.enabled && schedule.slots?.some((slot) =>
        isSlotActive(slot, clock.day, clock.minute)
      ));
      const shouldBeOnline = Boolean(isAuthorizedRider && schedule.enabled && (insideWindow || continued));
      const wasOnline = schedule.lastAppliedOnline;

      // Owner revocation/deactivation overrides a saved schedule immediately. Preserve the account role/status.
      if (!isAuthorizedRider) {
        await Promise.all([
          adminDb.collection(USERS).doc(uid).set({
            isOnline: false, onlineStatus: 'offline', availabilityStatus: 'offline',
            shiftState: 'OFF_SHIFT', shiftTransitionReason: 'account_not_authorized',
            shiftTransitionAt: now.toISOString()
          }, { merge: true }).catch(() => {}),
          adminDb.collection(RIDERS).doc(uid).set({
            isOnline: false, onlineStatus: 'offline', availabilityStatus: 'offline',
            shiftState: 'OFF_SHIFT', shiftTransitionReason: 'account_not_authorized',
            shiftTransitionAt: now.toISOString()
          }, { merge: true }).catch(() => {}),
          adminDb.collection(SCHEDULES).doc(uid).set({
            lastAppliedOnline: false, continueUntil: null
          }, { merge: true }).catch(() => {})
        ]);
        continue;
      }

      if (wasOnline === shouldBeOnline) continue;
      if (wasOnline == null && !shouldBeOnline) {
        // When a rider enables a recurring schedule while they were manually online,
        // apply the schedule immediately even on its first scheduler reconciliation.
        if (schedule.enabled && isAuthorizedRider) {
          await this.applyOnlineState(uid, false, 'outside_work_schedule');
        }
        await adminDb.collection(SCHEDULES).doc(uid).set({
          lastAppliedOnline: false,
          ...(schedule.enabled ? { lastTransitionAt: now.toISOString(), lastTransitionLocalDate: clock.dateKey } : {})
        }, { merge: true }).catch(() => {});
        continue;
      }

      const transitionAt = now.toISOString();
      const reason = continued && !insideWindow ? 'continued_shift' : insideWindow ? 'scheduled_shift' : 'scheduled_shift_ended';
      await this.applyOnlineState(uid, shouldBeOnline, reason);
      await adminDb.collection(SCHEDULES).doc(uid).set({
        lastAppliedOnline: shouldBeOnline,
        lastTransitionAt: transitionAt,
        lastTransitionLocalDate: clock.dateKey,
        continueUntil: continued ? schedule.continueUntil : null,
        updatedAt: transitionAt
      }, { merge: true });

      if (shouldBeOnline) {
        if (!schedule.suppressNextStartAlert) {
          await this.sendShiftNotification(uid, schedule, true, clock.dateKey, clock.minute).catch((e) =>
            console.warn('[RiderWorkScheduleService] Shift-start notification failed:', e?.message || e)
          );
        }
        await adminDb.collection(SCHEDULES).doc(uid).set({ suppressNextStartAlert: false }, { merge: true }).catch(() => {});
      } else {
        await this.sendShiftNotification(uid, schedule, false, clock.dateKey, clock.minute).catch((e) =>
          console.warn('[RiderWorkScheduleService] Shift-end notification failed:', e?.message || e)
        );
      }
    }
  }

  private static async applyOnlineState(uid: string, isOnline: boolean, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const payload = {
      isOnline,
      onlineStatus: isOnline ? 'online' : 'offline',
      availabilityStatus: isOnline ? 'available' : 'offline',
      shiftState: isOnline ? 'WORKING' : 'OFF_SHIFT',
      shiftTransitionReason: reason,
      shiftTransitionAt: now,
      updatedAt: now
    };
    await Promise.all([
      adminDb.collection(USERS).doc(uid).set(payload, { merge: true }),
      adminDb.collection(RIDERS).doc(uid).set(payload, { merge: true }).catch(() => {})
    ]);
  }

  private static async sendShiftNotification(uid: string, schedule: RiderWorkSchedule & Record<string, any>, started: boolean, localDate: string, localMinute: number): Promise<void> {
    const [userSnap, riderSnap] = await Promise.all([
      adminDb.collection(USERS).doc(uid).get(),
      adminDb.collection(RIDERS).doc(uid).get().catch(() => null)
    ]);
    const user = userSnap.exists ? userSnap.data() : {};
    const rider = riderSnap?.exists ? riderSnap.data() : {};
    const role = String(user?.role || rider?.role || '').toLowerCase();
    const accountState = String(user?.accountStatus || user?.status || rider?.accountStatus || rider?.status || '').toLowerCase();
    if (!userSnap.exists || !['delivery_partner', 'delivery', 'rider'].includes(role)
      || user?.isActive === false || rider?.isActive === false
      || ['disabled', 'deactivated', 'rejected', 'revoked', 'deleted', 'suspended', 'blocked'].includes(accountState)) {
      console.warn('[RiderWorkScheduleService] Skipping shift notification for inactive/non-rider UID:', uid);
      return;
    }
    const title = started ? 'Your work time has started' : 'Your work time ended for today';
    const body = started
      ? 'You are scheduled and now marked online. Make sure location access stays enabled while working.'
      : 'You are now offline. Tap Continue Work to extend your shift or Done to finish for today.';
    const type = started ? 'WORK_SHIFT_STARTED' : 'WORK_SHIFT_ENDED';
    const sound = started ? schedule.startSound : schedule.endSound;
    const channelId = started ? `olive_shift_started_${sound}` : `olive_shift_ended_${sound}`;
    const payload: any = {
      notification: { title, body },
      data: {
        title, body, type, stage: type, category: 'delivery',
        role: 'delivery', appName: 'delivery', sound, channelId,
        eventId: `${type}:${uid}:${localDate}:${String(Math.floor(localMinute / 60)).padStart(2, '0')}:${String(localMinute % 60).padStart(2, '0')}`,
        riderUid: uid,
        branchId: String(user?.branchId || rider?.branchId || ''),
        franchiseId: String(user?.franchiseId || rider?.franchiseId || ''),
        url: started ? '/settings' : '/settings?continueWork=1',
        alert: 'single'
      },
      android: {
        priority: 'high',
        notification: { channelId, sound, defaultVibrateTimings: true }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: {
          alert: { title, body },
          sound: IOS_SOUND_FILES[sound] || (started ? 'new_order.wav' : 'order_delivered.wav'),
          category: type,
          contentAvailable: true
        } }
      },
      webpush: { notification: { title, body, tag: `work-shift-${uid}-${localDate}`, renotify: true } }
    };
    await notificationEngine.send(uid, payload, {
      targetApp: 'delivery',
      category: 'alarm_actionable',
      priority: 'high',
      eventId: payload.data.eventId,
      expiresInSeconds: 180
    });
  }
}
