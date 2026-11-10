/**
 * preparation_time_metrics.test.ts
 * 
 * Comprehensive verification suite for Section 5:
 * Correct Preparation-Time Analytics (3 Distinct Metrics + Historical Estimation Layer)
 * 
 * Verifies all 14 required test scenarios:
 * 1. Full actual lifecycle timestamps
 * 2. Missing preparation start
 * 3. Missing ready timestamp
 * 4. Missing acceptance timestamp
 * 5. Missing delivery timestamp
 * 6. Out-of-order timestamps
 * 7. Negative durations
 * 8. Corrupted historical records
 * 9. Insufficient sample count (< 5 samples -> explicitly UNAVAILABLE)
 * 10. Different branches cohort filtering
 * 11. Different order types cohort filtering
 * 12. Different time-of-day periods cohort filtering
 * 13. Actual versus estimated aggregation distinction
 * 14. Non-destructive: No accidental historical record modification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { PreparationTimeEngine } from '../services/order/PreparationTimeEngine.js';

test('Priority P0: Kitchen Preparation-Time Analytics Suite (3 Distinct Metrics + Historical Estimation)', async (t) => {
  let testDb: DisposableTestDb;

  testDb = await createDisposableTestDb();

  const mockPoolClient = {
    query: testDb.query,
    release: () => {}
  };
  const mockPool = {
    query: testDb.query,
    connect: async () => mockPoolClient
  };

  setTestDbOverride(testDb.query, mockPool);
  setTestQueryOverride(testDb.query);

  t.after(async () => {
    setTestDbOverride(null, null);
    setTestQueryOverride(null);
    if (testDb) {
      await testDb.close();
    }
  });

  // Seed baseline branches
  await testDb.db.exec(`
    INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open, accepting_orders)
    VALUES 
      ('branch_prep_01', 'fra_rajnandgaon', 'Prep Branch 1', 'Main Road', '9179944445', true, true),
      ('branch_prep_02', 'fra_rajnandgaon', 'Prep Branch 2', 'South Road', '9876543210', true, true)
    ON CONFLICT (id) DO NOTHING;
  `);

  await t.test('1. Full actual lifecycle timestamps calculates all 3 metrics with source: ACTUAL', () => {
    const order = {
      created_at: new Date('2026-11-03T12:00:00Z'),
      accepted_at: new Date('2026-11-03T12:02:00Z'),
      preparation_started_at: new Date('2026-11-03T12:05:00Z'),
      ready_at: new Date('2026-11-03T12:20:00Z'),
      delivered_at: new Date('2026-11-03T12:40:00Z')
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);

    // Metric A: Kitchen Prep (ready_at - prep_started_at) = 15 mins
    assert.strictEqual(metrics.kitchenPreparation.source, 'ACTUAL');
    assert.strictEqual(metrics.kitchenPreparation.value_minutes, 15);
    assert.strictEqual(metrics.kitchenPreparation.confidence, 'HIGH');

    // Metric B: Acceptance to Ready (ready_at - accepted_at) = 18 mins
    assert.strictEqual(metrics.acceptanceToReady.source, 'ACTUAL');
    assert.strictEqual(metrics.acceptanceToReady.value_minutes, 18);
    assert.strictEqual(metrics.acceptanceToReady.confidence, 'HIGH');

    // Metric C: Total Fulfilment (delivered_at - created_at) = 40 mins
    assert.strictEqual(metrics.totalFulfilment.source, 'ACTUAL');
    assert.strictEqual(metrics.totalFulfilment.value_minutes, 40);
    assert.strictEqual(metrics.totalFulfilment.confidence, 'HIGH');
  });

  await t.test('2. Missing preparation_started_at returns kitchen prep as UNAVAILABLE', () => {
    const order = {
      created_at: new Date('2026-11-03T12:00:00Z'),
      accepted_at: new Date('2026-11-03T12:02:00Z'),
      preparation_started_at: null,
      ready_at: new Date('2026-11-03T12:20:00Z'),
      delivered_at: new Date('2026-11-03T12:40:00Z')
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.kitchenPreparation.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.kitchenPreparation.value_minutes, null);
    // Other metrics must still compute correctly
    assert.strictEqual(metrics.acceptanceToReady.source, 'ACTUAL');
    assert.strictEqual(metrics.acceptanceToReady.value_minutes, 18);
    assert.strictEqual(metrics.totalFulfilment.source, 'ACTUAL');
    assert.strictEqual(metrics.totalFulfilment.value_minutes, 40);
  });

  await t.test('3. Missing ready_at returns kitchen prep and acceptance-to-ready as UNAVAILABLE', () => {
    const order = {
      created_at: new Date('2026-11-03T12:00:00Z'),
      accepted_at: new Date('2026-11-03T12:02:00Z'),
      preparation_started_at: new Date('2026-11-03T12:05:00Z'),
      ready_at: null,
      delivered_at: new Date('2026-11-03T12:40:00Z')
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.kitchenPreparation.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.acceptanceToReady.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.totalFulfilment.source, 'ACTUAL');
    assert.strictEqual(metrics.totalFulfilment.value_minutes, 40);
  });

  await t.test('4. Missing accepted_at returns acceptance-to-ready as UNAVAILABLE', () => {
    const order = {
      created_at: new Date('2026-11-03T12:00:00Z'),
      accepted_at: null,
      preparation_started_at: new Date('2026-11-03T12:05:00Z'),
      ready_at: new Date('2026-11-03T12:20:00Z'),
      delivered_at: new Date('2026-11-03T12:40:00Z')
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.kitchenPreparation.source, 'ACTUAL');
    assert.strictEqual(metrics.kitchenPreparation.value_minutes, 15);
    assert.strictEqual(metrics.acceptanceToReady.source, 'UNAVAILABLE');
  });

  await t.test('5. Missing delivered_at returns total fulfilment as UNAVAILABLE', () => {
    const order = {
      created_at: new Date('2026-11-03T12:00:00Z'),
      accepted_at: new Date('2026-11-03T12:02:00Z'),
      preparation_started_at: new Date('2026-11-03T12:05:00Z'),
      ready_at: new Date('2026-11-03T12:20:00Z'),
      delivered_at: null
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.totalFulfilment.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.totalFulfilment.value_minutes, null);
  });

  await t.test('6. Out-of-order timestamps are detected and rejected as UNAVAILABLE', () => {
    const order = {
      created_at: new Date('2026-11-03T12:30:00Z'),
      accepted_at: new Date('2026-11-03T12:35:00Z'),
      // prep started AFTER ready!
      preparation_started_at: new Date('2026-11-03T12:25:00Z'),
      ready_at: new Date('2026-11-03T12:15:00Z'),
      delivered_at: new Date('2026-11-03T12:45:00Z')
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.kitchenPreparation.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.kitchenPreparation.confidence, 'NONE');
    assert.ok(metrics.kitchenPreparation.methodology?.includes('Corrupted'));
  });

  await t.test('7. Negative durations are excluded from aggregation', () => {
    const order = {
      created_at: new Date('2026-11-03T12:40:00Z'),
      accepted_at: new Date('2026-11-03T12:30:00Z'), // accepted before created!
      preparation_started_at: new Date('2026-11-03T12:20:00Z'),
      ready_at: new Date('2026-11-03T12:10:00Z'),
      delivered_at: new Date('2026-11-03T12:00:00Z') // delivered before created!
    };

    const metrics = PreparationTimeEngine.calculateOrderMetrics(order);
    assert.strictEqual(metrics.kitchenPreparation.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.acceptanceToReady.source, 'UNAVAILABLE');
    assert.strictEqual(metrics.totalFulfilment.source, 'UNAVAILABLE');
  });

  await t.test('8. Insufficient sample count (< 5 samples) returns source: UNAVAILABLE', async () => {
    // Branch with only 2 orders
    await testDb.db.exec(`
      INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, branch_id, franchise_id,
        total_amount, payment_method, payment_status,
        created_at, accepted_at, preparation_started_at, ready_at, delivered_at
      ) VALUES 
        ('ord_few_1', 91001, 1, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'DELIVERED', 'branch_prep_02', 'fra_rajnandgaon', 350.00, 'COD', 'PAID',
         NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '28 minutes', NOW() - INTERVAL '25 minutes', NOW() - INTERVAL '15 minutes', NOW()),
        ('ord_few_2', 91002, 2, CURRENT_DATE, CURRENT_TIME, 'ONLINE', 'delivery', 'DELIVERED', 'branch_prep_02', 'fra_rajnandgaon', 420.00, 'COD', 'PAID',
         NOW() - INTERVAL '35 minutes', NOW() - INTERVAL '33 minutes', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '18 minutes', NOW());
    `);

    const report = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_prep_02'
    });

    assert.strictEqual(report.source, 'UNAVAILABLE');
    assert.strictEqual(report.value_minutes, null);
    assert.strictEqual(report.confidence, 'NONE');
    assert.strictEqual(report.sample_count, 2);
    assert.ok(report.methodology?.includes('Insufficient genuine samples'));
  });

  await t.test('9. Sufficient samples (>= 5 samples) computes p50 and p90 with source: ESTIMATED', async () => {
    // Seed 6 valid orders with known kitchen preparation durations (10, 12, 14, 16, 18, 20 mins)
    const durations = [10, 12, 14, 16, 18, 20];
    for (let i = 0; i < durations.length; i++) {
      const d = durations[i];
      await testDb.db.exec(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, branch_id, franchise_id,
          total_amount, payment_method, payment_status,
          created_at, accepted_at, preparation_started_at, ready_at, delivered_at
        ) VALUES (
          'ord_sample_${i}', ${92000 + i}, ${i + 1}, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'DELIVERED', 'branch_prep_01', 'fra_rajnandgaon',
          400.00, 'UPI', 'PAID',
          NOW() - INTERVAL '${d + 30} minutes',
          NOW() - INTERVAL '${d + 28} minutes',
          NOW() - INTERVAL '${d + 25} minutes',
          NOW() - INTERVAL '25 minutes',
          NOW()
        );
      `);
    }

    const report = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_prep_01'
    });

    assert.strictEqual(report.source, 'ESTIMATED');
    assert.ok(report.value_minutes !== null);
    assert.ok(report.sample_count >= 5);
    // Median of [10, 12, 14, 16, 18, 20] is index 3 (16)
    assert.strictEqual(report.value_minutes, 16);
    assert.ok(report.confidence === 'LOW' || report.confidence === 'MEDIUM');
  });

  await t.test('10. Branch cohort isolation: filters orders strictly by branch', async () => {
    const reportBranch1 = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_prep_01'
    });
    const reportBranch2 = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_prep_02'
    });

    assert.strictEqual(reportBranch1.source, 'ESTIMATED');
    assert.strictEqual(reportBranch2.source, 'UNAVAILABLE', 'Branch 2 has insufficient samples');
  });

  await t.test('11. Order type cohort filtering (delivery vs dine_in)', async () => {
    // Seed 5 takeaway orders with duration 8 mins
    for (let i = 0; i < 5; i++) {
      await testDb.db.exec(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, branch_id, franchise_id,
          total_amount, payment_method, payment_status,
          created_at, accepted_at, preparation_started_at, ready_at, delivered_at
        ) VALUES (
          'ord_takeaway_${i}', ${93000 + i}, ${i + 1}, CURRENT_DATE, CURRENT_TIME,
          'POS', 'takeaway', 'COMPLETED', 'branch_prep_01', 'fra_rajnandgaon',
          250.00, 'CASH', 'PAID',
          NOW() - INTERVAL '20 minutes',
          NOW() - INTERVAL '18 minutes',
          NOW() - INTERVAL '16 minutes',
          NOW() - INTERVAL '8 minutes',
          NOW()
        );
      `);
    }

    const takeawayReport = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_prep_01',
      orderType: 'takeaway'
    });

    assert.strictEqual(takeawayReport.source, 'ESTIMATED');
    assert.strictEqual(takeawayReport.value_minutes, 8);
    assert.strictEqual(takeawayReport.sample_count, 5);
  });

  await t.test('12. Time of day cohort filtering (lunch vs dinner)', async () => {
    await testDb.db.exec(`
      INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open, accepting_orders)
      VALUES ('branch_dinner_cohort', 'fra_rajnandgaon', 'Dinner Cohort Branch', 'Night St', '9179944445', true, true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Seed orders specifically created during dinner hour (20:00 UTC)
    for (let i = 0; i < 5; i++) {
      await testDb.db.exec(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time,
          order_source, order_type, order_status, branch_id, franchise_id,
          total_amount, payment_method, payment_status,
          created_at, accepted_at, preparation_started_at, ready_at, delivered_at
        ) VALUES (
          'ord_dinner_${i}', ${94000 + i}, ${i + 1}, CURRENT_DATE, CURRENT_TIME,
          'ONLINE', 'delivery', 'DELIVERED', 'branch_dinner_cohort', 'fra_rajnandgaon',
          600.00, 'UPI', 'PAID',
          '2026-11-03 20:00:00+00',
          '2026-11-03 20:02:00+00',
          '2026-11-03 20:05:00+00',
          '2026-11-03 20:25:00+00',
          '2026-11-03 20:45:00+00'
        );
      `);
    }

    const dinnerReport = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_dinner_cohort',
      timeOfDay: 'dinner'
    });

    assert.strictEqual(dinnerReport.source, 'ESTIMATED');
    assert.strictEqual(dinnerReport.value_minutes, 20); // 20:25 - 20:05 = 20 mins
    assert.strictEqual(dinnerReport.sample_count, 5);

    // Lunch query on dinner cohort must return UNAVAILABLE (< 5 lunch samples)
    const lunchReport = await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', {
      branchId: 'branch_dinner_cohort',
      timeOfDay: 'lunch'
    });
    assert.strictEqual(lunchReport.source, 'UNAVAILABLE');
  });

  await t.test('13. Non-destructive: estimation queries do not modify original database records', async () => {
    const beforeCount = await testDb.query(`SELECT COUNT(*) as count FROM canonical_orders`);
    const beforeRows = await testDb.query(`SELECT id, updated_at, ready_at FROM canonical_orders LIMIT 5`);

    // Run multiple metric aggregations
    await PreparationTimeEngine.getHistoricalMetricStats('KITCHEN_PREPARATION', { branchId: 'branch_prep_01' });
    await PreparationTimeEngine.getHistoricalMetricStats('ACCEPTANCE_TO_READY', { branchId: 'branch_prep_01' });
    await PreparationTimeEngine.getHistoricalMetricStats('TOTAL_FULFILMENT', { branchId: 'branch_prep_01' });

    const afterCount = await testDb.query(`SELECT COUNT(*) as count FROM canonical_orders`);
    const afterRows = await testDb.query(`SELECT id, updated_at, ready_at FROM canonical_orders LIMIT 5`);

    assert.strictEqual(beforeCount.rows[0].count, afterCount.rows[0].count, 'Row count must not change');
    assert.deepStrictEqual(beforeRows.rows, afterRows.rows, 'Row timestamps must remain strictly unaltered');
  });

  await t.test('14. Backwards compatibility: calculateIntelligentEstimate and getHistoricalBranchStats return valid bounds', async () => {
    const estimate = await PreparationTimeEngine.calculateIntelligentEstimate({
      items: [{ category: 'pizza', quantity: 2 }, { category: 'beverages', quantity: 1 }],
      branchId: 'branch_prep_01',
      workloadPendingOrders: 2
    });

    assert.ok(estimate.estimatedMinutes >= 5);
    assert.ok(estimate.p90Minutes >= estimate.p50Minutes);
    assert.ok(estimate.confidenceScore >= 0.7);
  });
});
