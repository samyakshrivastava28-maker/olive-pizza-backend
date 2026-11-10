import assert from 'node:assert';
import test from 'node:test';
import { InMemoryBillingRepository } from '../repositories/billing.repository.js';

test('Billing System: Atomic Concurrent Allocations (Zero Duplicates)', async (t) => {
  await t.test('allocates 100 concurrent bill numbers without duplicates or gaps', async () => {
    const repo = new InMemoryBillingRepository();
    const concurrentCount = 100;

    // Fire 100 allocation requests concurrently
    const promises = Array.from({ length: concurrentCount }, () => repo.allocateNextBillNumbers());
    const results = await Promise.all(promises);

    assert.strictEqual(results.length, concurrentCount);

    const permanentNumbers = results.map(r => r.permanentBillNo);
    const uniqueNumbers = new Set(permanentNumbers);

    // Verify zero duplicates
    assert.strictEqual(uniqueNumbers.size, concurrentCount, 'Every allocated bill number must be distinct');

    // Verify sequence is strictly 1 to 100
    const sorted = [...permanentNumbers].sort((a, b) => a - b);
    for (let i = 0; i < concurrentCount; i++) {
      assert.strictEqual(sorted[i], i + 1, `Expected sequence item ${i + 1} to match`);
    }

    // Verify telemetry
    const status = await repo.getCurrentSequenceStatus();
    assert.strictEqual(status.lastPermanentBillNo, 100);
    assert.strictEqual(status.todayDailyCount, 100);
  });

  await t.test('resets daily order counter when date advances while permanent bill counter increases continuously', async () => {
    const repo = new InMemoryBillingRepository();

    const day1 = new Date('2026-09-04T12:00:00+05:30');
    const day2 = new Date('2026-09-05T12:00:00+05:30');

    // Day 1 allocations
    const d1_1 = await repo.allocateNextBillNumbers(day1);
    const d1_2 = await repo.allocateNextBillNumbers(day1);

    assert.strictEqual(d1_1.permanentBillNo, 1);
    assert.strictEqual(d1_1.dailyOrderNo, 1);
    assert.strictEqual(d1_2.permanentBillNo, 2);
    assert.strictEqual(d1_2.dailyOrderNo, 2);

    // Day 2 allocations (Midnight rollover)
    const d2_1 = await repo.allocateNextBillNumbers(day2);
    const d2_2 = await repo.allocateNextBillNumbers(day2);

    // Permanent bill number continues forever: #3, #4
    assert.strictEqual(d2_1.permanentBillNo, 3);
    assert.strictEqual(d2_2.permanentBillNo, 4);

    // Daily order number resets to 1: #1, #2
    assert.strictEqual(d2_1.dailyOrderNo, 1, 'Daily order number must reset on new day');
    assert.strictEqual(d2_2.dailyOrderNo, 2);
  });

  await t.test('distinguishes source cleanly between ONLINE and POS billing records', async () => {
    const repo = new InMemoryBillingRepository();

    const onlineAlloc = await repo.allocateNextBillNumbers();
    await repo.saveBill({
      permanentBillNumber: onlineAlloc.permanentBillNo,
      billFormattedNumber: `#${onlineAlloc.permanentBillNo}`,
      orderId: 'ord_online_101',
      source: 'ONLINE',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'main_branch',
      totalAmount: 499,
      paymentMethod: 'UPI',
      paymentStatus: 'PAID',
      createdAt: new Date().toISOString()
    });

    const posAlloc = await repo.allocateNextBillNumbers();
    await repo.saveBill({
      permanentBillNumber: posAlloc.permanentBillNo,
      billFormattedNumber: `#${posAlloc.permanentBillNo}`,
      orderId: 'ord_pos_202',
      source: 'POS',
      franchiseId: 'fra_rajnandgaon',
      branchId: 'main_branch',
      terminalId: 'POS-TERM-01',
      totalAmount: 350,
      paymentMethod: 'CASH',
      paymentStatus: 'PAID',
      createdAt: new Date().toISOString()
    });

    const onlineBill = await repo.findByPermanentNumber(onlineAlloc.permanentBillNo);
    const posBill = await repo.findByPermanentNumber(posAlloc.permanentBillNo);

    assert(onlineBill);
    assert.strictEqual(onlineBill.source, 'ONLINE');
    assert.strictEqual(onlineBill.orderId, 'ord_online_101');

    assert(posBill);
    assert.strictEqual(posBill.source, 'POS');
    assert.strictEqual(posBill.terminalId, 'POS-TERM-01');
    assert.strictEqual(posBill.orderId, 'ord_pos_202');

    // Lookup by orderId
    const byOrder = await repo.findByOrderId('ord_online_101');
    assert.strictEqual(byOrder?.permanentBillNumber, onlineAlloc.permanentBillNo);
  });
});
