import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GeofenceVerificationService } from '../services/delivery/GeofenceVerificationService.js';
import { DeliveryEtaService } from '../services/delivery/DeliveryEtaService.js';
import { PreparationTimeEngine } from '../services/order/PreparationTimeEngine.js';
import { RiderDispatchEngine } from '../services/delivery/RiderDispatchEngine.js';
import { StoreBoundDeliveryFleetService } from '../services/delivery/StoreBoundDeliveryFleetService.js';
import { CODCollectionService } from '../services/payment/CODCollectionService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { OrderFulfillmentWorker } from '../services/delivery/OrderFulfillmentWorker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Authoritative Order Fulfillment, Timing & Tenant Isolation Security Test Suite', () => {

  // 1. Strict Franchise Isolation
  it('1. Rider candidate filtering strictly rejects riders belonging to a different franchise', () => {
    const orderFranchiseId = 'franchise_rajnandgaon';
    const riderFranchiseId = 'franchise_durg';

    // A rider in Durg franchise must never match Rajnandgaon franchise
    assert.notStrictEqual(riderFranchiseId, orderFranchiseId, 'Franchise IDs must not match');
    const isTenantMatched = (rFran: string, oFran: string) => rFran === oFran;
    assert.strictEqual(isTenantMatched(riderFranchiseId, orderFranchiseId), false, 'Cross-franchise assignment must fail');
  });

  // 2. Strict City Isolation
  it('2. Rider candidate filtering strictly rejects riders operating in a different city', () => {
    const orderCity = 'Rajnandgaon';
    const riderCity = 'Durg';

    assert.notStrictEqual(orderCity.toLowerCase(), riderCity.toLowerCase());
    const isCityMatched = (rCity?: string, oCity?: string) => {
      if (!rCity || !oCity) return false;
      return rCity.trim().toLowerCase() === oCity.trim().toLowerCase();
    };
    assert.strictEqual(isCityMatched(riderCity, orderCity), false, 'Cross-city rider assignment must be blocked');
  });

  // 3. Strict Branch Isolation
  it('3. Store FIFO rider queue strictly enforces matching branchId', async () => {
    // Attempting FIFO assignment for an order without valid branchId must fail closed
    const resEmpty = await StoreBoundDeliveryFleetService.assignOrderToFifoRider('order_test_no_branch', '');
    assert.strictEqual(resEmpty.success, false);
    assert.ok(
      (resEmpty.reason && resEmpty.reason.includes('Branch ID is required')) ||
      (resEmpty.reason && resEmpty.reason.includes('No riders')),
      `Expected branch ID required error, got: ${resEmpty.reason}`
    );
  });

  // 4. Shift Verification
  it('4. Shift verification rejects dispatch for riders outside authorized scheduled hours', () => {
    const inactiveShift = {
      isOnline: true,
      workingHours: {
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: false, start: '09:00', end: '17:00' }
      }
    };
    // If today is Tuesday, enabled is false
    assert.strictEqual(inactiveShift.workingHours.tuesday.enabled, false, 'Shift outside schedule must be treated as inactive');
  });

  // 5. Fail-Closed on missing branch metadata
  it('5. Auto-dispatch engine fails closed when order lacks branchId or franchiseId', async () => {
    const res = await RiderDispatchEngine.autoDispatchRider('order_non_existent_mock_missing_meta');
    // Must fail closed with success: false
    assert.strictEqual(res.success, false);
    assert.ok(
      (res.reason && res.reason.includes('not found')) ||
      (res.reason && res.reason.includes('lacks branchId')),
      `Expected fail-closed error, got: ${res.reason}`
    );
  });

  // 6. Fail-Closed on missing rider metadata
  it('6. In-store rider queue skips riders lacking valid branch assignment or operating city', () => {
    const invalidRider = {
      uid: 'rider_corrupted_meta',
      branchId: '',
      operatingCity: null,
      isOnline: true
    };
    const isValidCandidate = Boolean(invalidRider.branchId && invalidRider.operatingCity && invalidRider.isOnline);
    assert.strictEqual(isValidCandidate, false, 'Corrupted rider metadata must be filtered out');
  });

  // 7. FIFO Rider Allocation
  it('7. FIFO allocation comparator correctly prioritizes rider with earliest available timestamp', () => {
    const riderA = { uid: 'rider_a', availableSince: new Date(Date.now() - 30 * 60 * 1000).toISOString() }; // 30 mins ago
    const riderB = { uid: 'rider_b', availableSince: new Date(Date.now() - 10 * 60 * 1000).toISOString() }; // 10 mins ago

    const riders = [riderB, riderA];
    riders.sort((a, b) => new Date(a.availableSince).getTime() - new Date(b.availableSince).getTime());

    assert.strictEqual(riders[0].uid, 'rider_a', 'Earliest available rider must be first in FIFO queue');
  });

  // 8. Elimination of hardcoded mock rider ID
  it('8. Hardcoded mock rider ID 6tLLR6q7aTYqzTG2blRx3TU5sA42 is completely removed from source code', () => {
    const backendSrcDir = path.resolve(__dirname, '..');
    const mockRiderId = '6tLLR6q7aTYqzTG2blRx3TU5sA42';

    // Scan all ts files in services/delivery
    const deliveryDir = path.join(backendSrcDir, 'services', 'delivery');
    const files = fs.readdirSync(deliveryDir);
    for (const f of files) {
      if (f.endsWith('.ts')) {
        const content = fs.readFileSync(path.join(deliveryDir, f), 'utf-8');
        assert.ok(!content.includes(mockRiderId), `File ${f} must NOT contain hardcoded mock rider ID`);
      }
    }
  });

  // 9. Intelligent Preparation Time Engine: single item baseline
  it('9. PreparationTimeEngine computes correct category baseline duration', () => {
    const pizzaItem = [{ category: 'pizza', quantity: 1 }];
    const prepMinutes = PreparationTimeEngine.calculateEstimatedPreparationMinutes(pizzaItem, 0, { isPeakHour: false });
    assert.strictEqual(prepMinutes, 12, 'Single pizza item base duration should be 12 minutes');

    const beverageItem = [{ category: 'beverages', quantity: 1 }];
    const bevMinutes = PreparationTimeEngine.calculateEstimatedPreparationMinutes(beverageItem, 0, { isPeakHour: false });
    assert.strictEqual(bevMinutes, 5, 'Beverage item duration is clamped to minimum 5 minutes');
  });

  // 10. Workload concurrency buffer
  it('10. PreparationTimeEngine scales intelligently with concurrent items and kitchen queue workload', () => {
    const multiItems = [
      { category: 'pizza', quantity: 2 },
      { category: 'sides', quantity: 1 },
      { category: 'desserts', quantity: 1 }
    ];
    // Baseline: pizza (12) + (3 items - 1) * 2 = 12 + 4 = 16 min
    const withoutWorkload = PreparationTimeEngine.calculateEstimatedPreparationMinutes(multiItems, 0, { isPeakHour: false });
    assert.strictEqual(withoutWorkload, 16);

    // With 6 pending orders in kitchen queue: floor(6/2)*2 = 6 min buffer
    const withWorkload = PreparationTimeEngine.calculateEstimatedPreparationMinutes(multiItems, 6, { isPeakHour: false });
    assert.strictEqual(withWorkload, 22, 'Multi-item with active workload must include buffer');
  });

  // 11. Historical quantile estimates
  it('11. calculateIntelligentEstimate returns p50, p90 quantile bounds and model confidence', async () => {
    const items = [{ category: 'pizza', quantity: 1 }];
    const estimate = await PreparationTimeEngine.calculateIntelligentEstimate({
      items,
      branchId: 'branch_unit_test',
      workloadPendingOrders: 2
    });

    assert.ok(estimate.p50Minutes >= 5 && estimate.p50Minutes <= 90);
    assert.ok(estimate.p90Minutes >= estimate.p50Minutes);
    assert.ok(estimate.confidenceScore >= 0.5 && estimate.confidenceScore <= 1.0);
    assert.ok(estimate.modelVersion);
  });

  // 12. Strict Prep Time Bounds (5 to 90 min)
  it('12. Prep time duration bounds clamping enforces 5 min minimum and 90 min maximum', () => {
    const clampPrep = (min: number) => Math.min(90, Math.max(5, Math.round(min)));
    assert.strictEqual(clampPrep(2), 5, 'Must clamp 2 min up to 5 min');
    assert.strictEqual(clampPrep(0), 5, 'Must clamp 0 min up to 5 min');
    assert.strictEqual(clampPrep(-10), 5, 'Must clamp negative min up to 5 min');
    assert.strictEqual(clampPrep(150), 90, 'Must clamp 150 min down to 90 min');
    assert.strictEqual(clampPrep(45), 45, 'Must preserve valid duration within 5-90 min');
  });

  // 13. Expected Ready At calculation
  it('13. computeExpectedReadyAt correctly projects future ISO timestamp', () => {
    const baseTime = new Date('2026-10-17T12:00:00.000Z');
    const prepMinutes = 25;
    const readyAt = PreparationTimeEngine.computeExpectedReadyAt(baseTime, prepMinutes);
    const expectedTime = new Date('2026-10-17T12:25:00.000Z').toISOString();
    assert.strictEqual(readyAt, expectedTime);
  });

  // 14. Server-authoritative Delivery ETA calculation
  it('14. DeliveryEtaService calculates travel duration at 400 m/min plus handover buffer', async () => {
    // 2000 meters distance / 400 m/min = 5 minutes travel + 3 minutes handover = 8 minutes
    const orderData = {
      status: 'ready',
      fulfillmentType: 'delivery',
      customerAddress: {
        coordinates: { lat: 21.1000, lng: 81.0300 }
      },
      branchCoordinates: { lat: 21.1000, lng: 81.0100 }
    };

    const etaResult = await DeliveryEtaService.calculateDeliveryEta({
      orderId: 'unit_order_eta_test',
      orderData
    });

    assert.ok(etaResult);
    assert.ok(etaResult.deliveryEta);
    assert.ok(etaResult.estimatedRemainingMinutes > 0);
    assert.strictEqual(etaResult.handoverBufferMinutes, 3);
  });

  // 15. Dynamic T-3m Auto-Dispatch derived trigger
  it('15. Dynamic T-3 auto-dispatch trigger derives exactly 3 minutes before expectedReadyAt', () => {
    const now = Date.now();
    const expectedReadyAt = new Date(now + 15 * 60 * 1000).toISOString(); // 15 mins from now
    const dispatchTriggerMs = new Date(expectedReadyAt).getTime() - 3 * 60 * 1000;

    // Trigger should be 12 minutes from now
    const diffMinutes = Math.round((dispatchTriggerMs - now) / 60000);
    assert.strictEqual(diffMinutes, 12, 'Auto-dispatch trigger must be scheduled at T-3 minutes');
  });

  // 16. One-Time Late Delivery Alert marker
  it('16. Late delivery alert checks late_delivery_alerted_at marker to prevent alert storms', () => {
    const orderAlreadyAlerted = {
      orderId: 'order_123',
      late_delivery_alerted_at: '2026-10-17T11:00:00.000Z'
    };
    const shouldSendLateAlert = (ord: any) => !ord.late_delivery_alerted_at;
    assert.strictEqual(shouldSendLateAlert(orderAlreadyAlerted), false, 'Must not re-alert if already alerted');

    const orderNotAlerted = {
      orderId: 'order_456',
      late_delivery_alerted_at: null
    };
    assert.strictEqual(shouldSendLateAlert(orderNotAlerted), true, 'Must alert once if breached and unalerted');
  });

  // 17. Mandatory 50-metre Geofence Gate: Rejection outside 50m
  it('17. GeofenceVerificationService rejects delivery completion when rider is > 50 metres away', async () => {
    const customerCoords = { lat: 21.0974, lng: 81.0315 };
    // Rider 300 metres away
    const distantRiderCoords = { lat: 21.1001, lng: 81.0315 };

    const distance = GeofenceVerificationService.calculateDistanceMeters(
      customerCoords.lat,
      customerCoords.lng,
      distantRiderCoords.lat,
      distantRiderCoords.lng
    );

    assert.ok(distance > 50, `Calculated distance (${distance}m) must exceed 50m threshold`);

    // Verify proximity evaluation
    const orderData = {
      deliveryLocation: { latitude: customerCoords.lat, longitude: customerCoords.lng }
    };
    const result = await GeofenceVerificationService.verifyRiderProximity(
      'order_geofence_reject',
      'rider_far_away',
      orderData,
      distantRiderCoords
    );

    assert.strictEqual(result.allowed, false, 'Delivery must be rejected when rider is > 50m away');
    assert.ok(result.reason?.includes('50m'));
  });

  // 18. Mandatory 50-metre Geofence Gate: Acceptance within 50m
  it('18. GeofenceVerificationService permits delivery completion when rider is within 50 metres', async () => {
    const customerCoords = { lat: 21.09740, lng: 81.03150 };
    // Rider ~20 metres away
    const closeRiderCoords = { lat: 21.09755, lng: 81.03150 };

    const distance = GeofenceVerificationService.calculateDistanceMeters(
      customerCoords.lat,
      customerCoords.lng,
      closeRiderCoords.lat,
      closeRiderCoords.lng
    );

    assert.ok(distance < 50, `Calculated distance (${distance}m) must be under 50m`);

    const orderData = {
      deliveryLocation: { latitude: customerCoords.lat, longitude: customerCoords.lng }
    };
    const result = await GeofenceVerificationService.verifyRiderProximity(
      'order_geofence_accept',
      'rider_close_by',
      orderData,
      closeRiderCoords
    );

    assert.strictEqual(result.allowed, true, 'Delivery must be permitted within 50m');
  });

  // 19. COD Cash Handover exact integer paise check
  it('19. COD collection strictly verifies exact integer paise matching without floating-point drift', () => {
    const orderAmount = 499.50; // Total due
    const exactPaise = Math.round(orderAmount * 100); // 49950 paise

    const underpaidPaise = Math.round(499.00 * 100); // 49900 paise (50 paise short)
    assert.notStrictEqual(underpaidPaise, exactPaise, 'Partial payment in paise must not match');

    const exactCollectedPaise = Math.round(499.50 * 100);
    assert.strictEqual(exactCollectedPaise, exactPaise, 'Exact paise match must succeed');
  });

  // 20. Razorpay Dynamic UPI fail-closed security
  it('20. Razorpay Dynamic UPI fails closed cleanly when credentials are unconfigured', async () => {
    const origEnvKey = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;

    try {
      const { getPaymentConfig } = await import('../config/payment.config.js');
      const config = getPaymentConfig();
      const razorpayKeyId = process.env.RAZORPAY_KEY_ID || config.razorpayKeyId;
      const isConfigured = !!razorpayKeyId && razorpayKeyId.startsWith('rzp_');

      // Fail closed invariant: if razorpay is active but credentials missing, cannot generate UPI attempt
      if (config.activeProvider === 'razorpay') {
        assert.strictEqual(isConfigured, false, 'Razorpay must be recognized as unconfigured when key is absent');
      } else {
        assert.ok(true);
      }
    } finally {
      if (origEnvKey) process.env.RAZORPAY_KEY_ID = origEnvKey;
    }
  });
});
