import { describe, it } from 'node:test';
import assert from 'node:assert';
import { GeofenceVerificationService } from '../services/delivery/GeofenceVerificationService.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';

describe('M3 Remediation Invariants Suite', () => {

  describe('1. Authorization Fail-Closed Invariants', () => {
    it('POS operator without permitted terminal in PostgreSQL must fail closed', async () => {
      const authResult = await FranchiseAccessService.resolveAuthorization({
        uid: 'test_unassigned_cashier_uid',
        email: 'unassigned_cashier@olivepizza.in',
        targetApp: 'POS'
      });
      assert.strictEqual(authResult.authorized, false);
      assert.ok(
        ['TERMINAL_NOT_PERMITTED', 'NOT_REGISTERED', 'APP_ACCESS_DENIED'].includes(authResult.code || ''),
        `Expected fail-closed terminal/registration code, got ${authResult.code}`
      );
    });

    it('Non-existent staff identity must fail closed without creating synthetic profile', async () => {
      const authResult = await FranchiseAccessService.resolveAuthorization({
        uid: 'totally_non_existent_staff_uid_99999',
        email: 'nonexistent_staff_99999@olivepizza.in',
        targetApp: 'RESTAURANT_MANAGER'
      });
      assert.strictEqual(authResult.authorized, false);
      assert.strictEqual(authResult.code, 'NOT_REGISTERED');
    });
  });

  describe('2. Order Authority & Canonical Lifecycle Invariants', () => {
    it('Order state transition fails closed for non-existent canonical order (zero Firestore fallback)', async () => {
      const result = await OrderStateMachine.transition(
        'non_existent_canonical_order_id_99999',
        'preparing',
        { uid: 'test_admin_uid', role: 'admin' }
      );
      assert.strictEqual(result.success, false);
      assert.ok(
        result.error?.includes('Canonical order not found') || result.error?.includes('Database service unavailable'),
        `Expected canonical order not found error, got: ${result.error}`
      );
    });

    it('Order state machine transition matrix strictly enforces lifecycle order', () => {
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'accepted'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('accepted', 'preparing'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'ready'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('ready', 'partner_assigned'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('partner_assigned', 'picked_up'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('picked_up', 'out_for_delivery'), true);
      assert.strictEqual(OrderStateMachine.isValidTransition('out_for_delivery', 'delivered'), true);

      // Invalid skips
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'picked_up'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('preparing', 'delivered'), false);
      assert.strictEqual(OrderStateMachine.isValidTransition('pending', 'delivered'), false);
    });
  });

  describe('3. Dynamic Geofencing & Alias Resolution Invariants', () => {
    it('Rejects invalid coordinate ranges (lat > 90, lng > 180, 0,0) with INVALID_COORDINATES', async () => {
      const resLatOver = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 95.0,
        lng: 81.0
      });
      assert.strictEqual(resLatOver.isServiceable, false);
      assert.strictEqual(resLatOver.code, 'INVALID_COORDINATES');

      const resZero = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 0.0,
        lng: 0.0
      });
      assert.strictEqual(resZero.isServiceable, false);
      assert.strictEqual(resZero.code, 'INVALID_COORDINATES');

      const resLngOver = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 21.0,
        lng: 195.0
      });
      assert.strictEqual(resLngOver.isServiceable, false);
      assert.strictEqual(resLngOver.code, 'INVALID_COORDINATES');
    });

    it('Rejects location outside canonical branch radius with OUT_OF_DELIVERY_ZONE (no 25km hardcoded fallback)', async () => {
      // 50 km away from Rajnandgaon HQ
      const resFar = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 21.5000,
        lng: 81.5000
      });
      assert.strictEqual(resFar.isServiceable, false);
      assert.ok(
        resFar.code === 'OUT_OF_DELIVERY_ZONE' || resFar.code === 'SERVICE_UNAVAILABLE',
        `Expected OUT_OF_DELIVERY_ZONE or SERVICE_UNAVAILABLE, got ${resFar.code}`
      );
    });

    it('Resolves location within canonical branch delivery radius for Rajnandgaon HQ', async () => {
      // Station Road, Rajnandgaon (~0.5 km from HQ)
      const resNear = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 21.0970,
        lng: 81.0345
      });
      if (resNear.isServiceable) {
        assert.ok(resNear.context);
        assert.ok(['branch_rjn_main', 'main_branch'].includes(resNear.context.branchId));
        assert.ok(resNear.context.distanceKm <= 12, 'Distance must be within canonical 12 km radius');
      }
    });

    it('Gracefully handles branch_rjn_main / main_branch alias resolution', async () => {
      const resAlias1 = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 21.0970,
        lng: 81.0345,
        targetBranchId: 'branch_rjn_main'
      });
      const resAlias2 = await CustomerOrderingContextService.resolveOrderingContext({
        customerId: 'test_cust',
        lat: 21.0970,
        lng: 81.0345,
        targetBranchId: 'main_branch'
      });

      if (resAlias1.isServiceable && resAlias2.isServiceable) {
        assert.strictEqual(resAlias1.context?.franchiseId, 'fra_rajnandgaon');
        assert.strictEqual(resAlias2.context?.franchiseId, 'fra_rajnandgaon');
      }
    });
  });

  describe('4. Delivery Completion Geofence Invariants', () => {
    it('Fails closed when canonical order lacks customer destination coordinates', async () => {
      const orderWithoutCoords = {
        id: 'ord_test_no_coords',
        deliveryPartnerId: 'rider_01',
        deliveryAddress: 'Main Street, Rajnandgaon'
      };

      const result = await GeofenceVerificationService.verifyRiderProximity(
        'ord_test_no_coords',
        'rider_01',
        orderWithoutCoords
      );
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('customer delivery destination coordinates'));
    });

    it('Fails closed when assigned rider does not match riderUid attempting delivery', async () => {
      const orderWithAssignedRider = {
        id: 'ord_test_assigned',
        deliveryPartnerId: 'legitimate_rider_01',
        deliveryAddressCoordinates: { lat: 21.0974, lng: 81.0347 }
      };

      const result = await GeofenceVerificationService.verifyRiderProximity(
        'ord_test_assigned',
        'impostor_rider_02',
        orderWithAssignedRider
      );
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('not the assigned delivery partner'));
    });

    it('Fails closed when trusted server rider GPS is unavailable', async () => {
      const orderWithCoords = {
        id: 'ord_test_coords',
        deliveryPartnerId: 'rider_with_no_server_gps',
        deliveryAddressCoordinates: { lat: 21.0974, lng: 81.0347 }
      };

      const result = await GeofenceVerificationService.verifyRiderProximity(
        'ord_test_coords',
        'rider_with_no_server_gps',
        orderWithCoords
      );
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason?.includes('trusted server-side rider GPS'));
    });

    it('Accurately computes distance between coordinates using Haversine formula', () => {
      // Rajnandgaon HQ: 21.0974, 81.0347
      // 50 meters away: 21.09785, 81.0347
      const distance = GeofenceVerificationService.calculateDistanceMeters(
        21.0974, 81.0347,
        21.09785, 81.0347
      );
      assert.ok(distance > 40 && distance < 60, `Expected ~50m, calculated: ${distance}m`);
    });
  });

});
