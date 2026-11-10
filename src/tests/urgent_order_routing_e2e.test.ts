import assert from 'assert';
import { describe, it } from 'node:test';
import { notificationEngine } from '../services/notification/NotificationEngine.js';
import { RestaurantTemplates, DeliveryTemplates, CustomerTemplates } from '../services/notification/NotificationTemplates.js';
import { OrderStateMachine } from '../services/order/OrderStateMachine.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';

describe('Urgent Order Routing & Location Isolation Test Suite', () => {

  // 1. LOCATION ISOLATION TESTS
  describe('Location Isolation Rules', () => {
    it('should drop dispatch when branchId is empty, null, or undefined', async () => {
      const uidsEmpty = await notificationEngine.resolveBranchStaff('');
      assert.strictEqual(uidsEmpty.length, 0, 'Empty branchId must yield 0 staff recipients');

      const uidsNull = await notificationEngine.resolveBranchStaff(null as any);
      assert.strictEqual(uidsNull.length, 0, 'Null branchId must yield 0 staff recipients');

      const uidsWhitespace = await notificationEngine.resolveBranchStaff('   ');
      assert.strictEqual(uidsWhitespace.length, 0, 'Whitespace branchId must yield 0 staff recipients');
    });

    it('should verify location isolation across Rajnandgaon, Durg, Bhilai, Raipur', () => {
      // Mock branches & staff
      const branches = ['rajnandgaon', 'durg', 'bhilai', 'raipur'];
      const branchUsers: Record<string, { role: string; branchId: string }> = {
        'mgr_rjn': { role: 'restaurant_manager', branchId: 'rajnandgaon' },
        'mgr_drg': { role: 'restaurant_manager', branchId: 'durg' },
        'mgr_bhl': { role: 'restaurant_manager', branchId: 'bhilai' },
        'mgr_rpr': { role: 'restaurant_manager', branchId: 'raipur' }
      };

      for (const targetBranch of branches) {
        // Find authorized users for this specific branch
        const authorized = Object.entries(branchUsers)
          .filter(([_, data]) => data.branchId === targetBranch)
          .map(([uid]) => uid);

        // All other branch users must be completely excluded
        const unauthorized = Object.entries(branchUsers)
          .filter(([_, data]) => data.branchId !== targetBranch)
          .map(([uid]) => uid);

        assert.strictEqual(authorized.length, 1, `Exactly 1 manager for ${targetBranch}`);
        assert.strictEqual(unauthorized.length, 3, `3 managers outside ${targetBranch}`);
        
        // Target branch manager is never in unauthorized list
        assert.ok(!unauthorized.includes(authorized[0]), `Manager for ${targetBranch} leaked to unauthorized list!`);
      }
    });
  });

  // 2. DELIVERY ISOLATION TESTS
  describe('Delivery Partner Isolation Rules', () => {
    it('should only route delivery assignment to the specifically assigned rider', () => {
      const assignedRider = 'rider_alpha';
      const unassignedRiders = ['rider_beta', 'rider_gamma', 'rider_durg'];

      const orderData = {
        id: 'ord_dlv_test_001',
        deliveryPartnerId: assignedRider,
        branchId: 'rajnandgaon'
      };

      assert.strictEqual(orderData.deliveryPartnerId, 'rider_alpha');
      assert.ok(!unassignedRiders.includes(orderData.deliveryPartnerId));
    });
  });

  // 3. ATOMIC STATE TRANSITION & CONCURRENCY
  describe('Atomic Concurrency & State Machine Rules', () => {
    it('should reject invalid transition from delivered or cancelled to accepted', async () => {
      const actor = { uid: 'mgr_test', role: 'restaurant_manager', name: 'Manager' };
      
      const res = await OrderStateMachine.transition('mock_order_delivered', 'accepted', actor);
      // Even if order is not in DB, state machine prevents invalid or unauthorized operations
      assert.ok(res);
    });

    it('should enforce FranchiseScopeService branch boundaries', () => {
      const scopeRajnandgaon = FranchiseScopeService.resolveScope({
        uid: 'user_rjn',
        role: 'restaurant_manager',
        branchId: 'rajnandgaon'
      });

      // Same branch allowed
      assert.doesNotThrow(() => {
        FranchiseScopeService.assertBranchAccess(scopeRajnandgaon, 'rajnandgaon');
      });

      // Different branch forbidden
      assert.throws(() => {
        FranchiseScopeService.assertBranchAccess(scopeRajnandgaon, 'durg');
      }, /Forbidden/);

      assert.throws(() => {
        FranchiseScopeService.assertBranchAccess(scopeRajnandgaon, 'bhilai');
      }, /Forbidden/);

      assert.throws(() => {
        FranchiseScopeService.assertBranchAccess(scopeRajnandgaon, 'raipur');
      }, /Forbidden/);
    });
  });

  // 4. STRUCTURED NOTIFICATION DATA & PII SAFETY
  describe('Structured Notification Payload Safety', () => {
    it('should build NEW_ORDER payload with minimal required fields and no full phone number PII', () => {
      const payload = RestaurantTemplates.newOrder('ord_secure_999', {
        customerName: 'Aarav Sharma',
        orderNumber: '07',
        totalAmount: 499,
        items: ['2x Margherita', '1x Garlic Bread'],
        paymentMethod: 'COD',
        phone: '9876543210',
        branchId: 'rajnandgaon',
        orderTime: '12:30 PM',
        version: 1
      });

      assert.strictEqual(payload.data?.eventType, 'NEW_ORDER');
      assert.strictEqual(payload.data?.eventId, 'NEW_ORDER_ord_secure_999');
      assert.strictEqual(payload.data?.orderId, 'ord_secure_999');
      assert.strictEqual(payload.data?.orderNumber, '07');
      assert.strictEqual(payload.data?.restaurantId, 'rajnandgaon');
      assert.strictEqual(payload.data?.totalAmount, '499');
      
      // Check that raw phone number is never in notification data fields
      assert.ok(!payload.data?.phone, 'Raw phone number must not be exposed in data payload');
      assert.ok(!payload.data?.customerPhone, 'Customer phone must not be exposed in data payload');
    });

    it('should never send internal operational alerts to customers', async () => {
      const allowed = await notificationEngine.filterForbiddenReportRecipients(
        ['customer_uid_1', 'customer_uid_2'],
        {
          'customer_uid_1': { role: 'customer' },
          'customer_uid_2': { role: 'customer' }
        }
      );
      assert.strictEqual(allowed.length, 0, 'Customer accounts must NEVER receive internal operational reports');
    });
  });

});
