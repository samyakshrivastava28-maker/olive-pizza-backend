import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RiderWorkScheduleService, type RiderWorkSchedule } from '../services/delivery/RiderWorkScheduleService.js';

describe('RiderWorkScheduleService — Comprehensive Logic & Security Suite', () => {

  it('1. Normalizes valid 1-slot schedule with default timezone and sounds', () => {
    const raw = {
      enabled: true,
      timezone: 'Asia/Kolkata',
      slots: [
        { id: 'slot_1', daysOfWeek: [1, 2, 3, 4, 5], startTime: '12:00', endTime: '21:00' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered'
    };
    const norm = RiderWorkScheduleService.normalizeSchedule('rider_test_1', raw);
    assert.equal(norm.uid, 'rider_test_1');
    assert.equal(norm.enabled, true);
    assert.equal(norm.timezone, 'Asia/Kolkata');
    assert.equal(norm.slots.length, 1);
    assert.equal(norm.slots[0].startTime, '12:00');
    assert.equal(norm.slots[0].endTime, '21:00');
    assert.deepEqual(norm.slots[0].daysOfWeek, [1, 2, 3, 4, 5]);
    assert.equal(norm.startSound, 'new_order');
    assert.equal(norm.endSound, 'order_delivered');
  });

  it('2. Normalizes maximum 5 slots across different days and times', () => {
    const raw = {
      enabled: true,
      slots: [
        { id: 's1', daysOfWeek: [1], startTime: '09:00', endTime: '13:00' },
        { id: 's2', daysOfWeek: [1], startTime: '17:00', endTime: '22:00' },
        { id: 's3', daysOfWeek: [2, 3], startTime: '11:00', endTime: '19:00' },
        { id: 's4', daysOfWeek: [4, 5], startTime: '12:00', endTime: '20:00' },
        { id: 's5', daysOfWeek: [6, 0], startTime: '10:00', endTime: '23:00' }
      ]
    };
    const norm = RiderWorkScheduleService.normalizeSchedule('rider_test_5', raw);
    assert.equal(norm.slots.length, 5);
  });

  it('3. Rejects schedule with more than 5 slots', () => {
    const raw = {
      enabled: true,
      slots: [
        { daysOfWeek: [0], startTime: '08:00', endTime: '10:00' },
        { daysOfWeek: [1], startTime: '08:00', endTime: '10:00' },
        { daysOfWeek: [2], startTime: '08:00', endTime: '10:00' },
        { daysOfWeek: [3], startTime: '08:00', endTime: '10:00' },
        { daysOfWeek: [4], startTime: '08:00', endTime: '10:00' },
        { daysOfWeek: [5], startTime: '08:00', endTime: '10:00' }
      ]
    };
    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('rider_test_6', raw),
      /up to five/
    );
  });

  it('4. Rejects identical start and end times in a slot', () => {
    const raw = {
      enabled: true,
      slots: [
        { daysOfWeek: [1], startTime: '12:00', endTime: '12:00' }
      ]
    };
    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('rider_test_identical', raw),
      /identical/
    );
  });

  it('5. Rejects invalid time format or missing weekdays', () => {
    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('r1', {
        slots: [{ daysOfWeek: [1], startTime: '25:00', endTime: '12:00' }]
      }),
      /valid start and end/
    );

    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('r1', {
        slots: [{ daysOfWeek: [], startTime: '10:00', endTime: '12:00' }]
      }),
      /valid weekday/
    );
  });

  it('6. Rejects overlapping slots on the same weekday', () => {
    const raw = {
      enabled: true,
      slots: [
        { daysOfWeek: [1, 2], startTime: '10:00', endTime: '15:00' },
        { daysOfWeek: [2, 3], startTime: '14:00', endTime: '18:00' } // overlaps on Tuesday (day 2) between 14:00 and 15:00
      ]
    };
    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('rider_test_overlap', raw),
      /overlap/
    );
  });

  it('7. Rejects cross-midnight overnight overlap with next morning slot', () => {
    const raw = {
      enabled: true,
      slots: [
        // Monday 22:00 to Tuesday 04:00
        { daysOfWeek: [1], startTime: '22:00', endTime: '04:00' },
        // Tuesday 03:00 to 09:00 (overlaps Tuesday 03:00-04:00)
        { daysOfWeek: [2], startTime: '03:00', endTime: '09:00' }
      ]
    };
    assert.throws(
      () => RiderWorkScheduleService.normalizeSchedule('rider_test_overnight_overlap', raw),
      /overlap/
    );
  });

  it('8. Correctly allows overnight shift that does not overlap next day', () => {
    const raw = {
      enabled: true,
      slots: [
        // Wednesday 22:00 to Thursday 02:00
        { daysOfWeek: [3], startTime: '22:00', endTime: '02:00' },
        // Thursday 14:00 to 20:00 (well after Thursday 02:00)
        { daysOfWeek: [4], startTime: '14:00', endTime: '20:00' }
      ]
    };
    const norm = RiderWorkScheduleService.normalizeSchedule('rider_test_overnight_clean', raw);
    assert.equal(norm.slots.length, 2);
  });

  it('9. isCurrentlyScheduled correctly detects active daytime shift', () => {
    const schedule: RiderWorkSchedule = {
      uid: 'rider_test_schedule',
      enabled: true,
      timezone: 'UTC',
      slots: [
        // Monday (day 1) 10:00 to 18:00 UTC
        { id: 's1', daysOfWeek: [1], startTime: '10:00', endTime: '18:00' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered'
    };

    // 2026-10-19 is a Monday
    const insideTime = new Date('2026-10-19T14:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, insideTime), true);

    const beforeTime = new Date('2026-10-19T09:59:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, beforeTime), false);

    const afterTime = new Date('2026-10-19T18:01:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, afterTime), false);

    // Tuesday 14:30
    const wrongDay = new Date('2026-10-20T14:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, wrongDay), false);
  });

  it('10. isCurrentlyScheduled correctly evaluates cross-midnight overnight shift', () => {
    const schedule: RiderWorkSchedule = {
      uid: 'rider_test_overnight',
      enabled: true,
      timezone: 'UTC',
      slots: [
        // Friday (day 5) 21:00 to Saturday 03:00 UTC
        { id: 's_overnight', daysOfWeek: [5], startTime: '21:00', endTime: '03:00' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered'
    };

    // 2026-10-23 is a Friday
    // Friday 23:00 UTC -> inside
    const friLate = new Date('2026-10-23T23:00:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, friLate), true);

    // Saturday (2026-10-24) 01:30 UTC -> inside
    const satEarly = new Date('2026-10-24T01:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, satEarly), true);

    // Saturday 03:30 UTC -> outside
    const satLate = new Date('2026-10-24T03:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, satLate), false);

    // Friday 20:30 UTC -> outside
    const friEarly = new Date('2026-10-23T20:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, friEarly), false);
  });

  it('11. isCurrentlyScheduled honors continueUntil shift extension beyond shift end', () => {
    const schedule: RiderWorkSchedule = {
      uid: 'rider_test_extension',
      enabled: true,
      timezone: 'UTC',
      slots: [
        { id: 's1', daysOfWeek: [1], startTime: '10:00', endTime: '18:00' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered',
      // Shift extended until 19:30 UTC
      continueUntil: '2026-10-19T19:30:00Z'
    };

    // Monday 18:30 (outside regular slot, but within extension)
    const extendedTime = new Date('2026-10-19T18:30:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, extendedTime), true);

    // Monday 19:35 (after extension)
    const expiredExtension = new Date('2026-10-19T19:35:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, expiredExtension), false);
  });

  it('12. When schedule is disabled, isCurrentlyScheduled returns false unconditionally', () => {
    const schedule: RiderWorkSchedule = {
      uid: 'rider_disabled',
      enabled: false,
      timezone: 'UTC',
      slots: [
        { id: 's1', daysOfWeek: [1, 2, 3, 4, 5], startTime: '00:00', endTime: '23:59' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered'
    };
    const now = new Date('2026-10-19T12:00:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, now), false);
  });

  it('13. Timezone conversion: evaluates local clock in Asia/Kolkata correctly', () => {
    // 12:00 UTC is 17:30 IST (UTC+5:30)
    const schedule: RiderWorkSchedule = {
      uid: 'rider_ist',
      enabled: true,
      timezone: 'Asia/Kolkata',
      slots: [
        // 17:00 to 22:00 IST on Monday (day 1)
        { id: 'ist_slot', daysOfWeek: [1], startTime: '17:00', endTime: '22:00' }
      ],
      startSound: 'new_order',
      endSound: 'order_delivered'
    };

    // 2026-10-19T12:00:00Z is 17:30 IST on Monday -> inside
    const insideUtc = new Date('2026-10-19T12:00:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, insideUtc), true);

    // 2026-10-19T10:00:00Z is 15:30 IST on Monday -> outside (before 17:00)
    const outsideUtc = new Date('2026-10-19T10:00:00Z');
    assert.equal(RiderWorkScheduleService.isCurrentlyScheduled(schedule, outsideUtc), false);
  });
});
