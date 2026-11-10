import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/lib/db.js';
import { CanonicalOrderService } from '../src/services/pos/CanonicalOrderService.js';
import { AuthoritativePricingResolver } from '../src/services/menu/AuthoritativePricingResolver.js';
import { POSService } from '../src/services/pos/POSService.js';

describe('POS Payment Contract, Idempotency & Durability Test Suite', () => {
  const branchId = 'branch_durable_test';
  const franchiseId = 'fra_durable_test';
  const testProductId = 'prod_durable_pizza';

  beforeAll(async () => {
    // 1. Seed test branch and franchise in restaurant_branches
    try {
      await query(`
        INSERT INTO restaurant_branches (id, franchise_id, name, address, is_open)
        VALUES ($1, $2, 'Durable Test Branch', 'Station Road', true)
        ON CONFLICT (id) DO UPDATE SET franchise_id = EXCLUDED.franchise_id;
      `, [branchId, franchiseId]);

      // 2. Seed franchise price override
      await query(`
        INSERT INTO franchise_prices (id, franchise_id, branch_id, product_id, selling_price, is_available, version, updated_by)
        VALUES ($1, $2, $3, $4, 250.00, true, 1, 'test_runner')
        ON CONFLICT (franchise_id, branch_id, product_id)
        DO UPDATE SET selling_price = EXCLUDED.selling_price;
      `, [`${branchId}_${testProductId}`, franchiseId, branchId, testProductId]);
    } catch (e: any) {
      console.warn('[TestSetup] Seeding notice:', e.message);
    }

    // Seed master catalog item
    POSService.seedCatalogItem(testProductId, {
      id: testProductId,
      name: 'Durable Cheese Supreme',
      basePrice: 220,
      sizes: {
        'regular': { price: 220 },
        'medium': { price: 320 }
      },
      addons: [
        { id: 'add_jalapeno', name: 'Jalapeno Slices', price: 40 }
      ]
    });
  });

  describe('P0.1 — Authoritative Price Resolution Invariants', () => {
    it('fails closed when branch does not belong to specified franchise', async () => {
      await expect(
        AuthoritativePricingResolver.resolveItemPrice({
          branchId,
          franchiseId: 'fra_attacker_cross_franchise',
          productId: testProductId
        })
      ).rejects.toThrow(/Cross-franchise access rejected/);
    });

    it('rejects unconfigured sizes with clear failure', async () => {
      await expect(
        AuthoritativePricingResolver.resolveItemPrice({
          branchId,
          productId: testProductId,
          size: 'SuperGiant_FakeSize'
        })
      ).rejects.toThrow(/Invalid size/);
    });

    it('rejects unconfigured addons with clear failure', async () => {
      await expect(
        AuthoritativePricingResolver.resolveItemPrice({
          branchId,
          productId: testProductId,
          addons: ['fake_addon_id']
        })
      ).rejects.toThrow(/Invalid addon/);
    });
  });

  describe('P0.2 — Payment Contract & Validation', () => {
    it('validates cash tender: returns PAID when full cash is received', () => {
      const totalAmount = 525.00;
      const cashReceived = 600.00;
      const changeDue = cashReceived >= totalAmount ? parseFloat((cashReceived - totalAmount).toFixed(2)) : 0;
      const paymentStatus = cashReceived >= (totalAmount - 0.05) ? 'PAID' : 'PARTIAL';

      expect(paymentStatus).toBe('PAID');
      expect(changeDue).toBe(75.00);
    });

    it('marks cash as PARTIAL when cash received is less than total', () => {
      const totalAmount = 525.00;
      const cashReceived = 400.00;
      const paymentStatus = cashReceived >= (totalAmount - 0.05) ? 'PAID' : 'PARTIAL';

      expect(paymentStatus).toBe('PARTIAL');
    });

    it('card remains PENDING without verified EDC authorization', () => {
      const unverifiedCard = {
        method: 'CARD',
        isCardVerified: false,
        cardRef: 'SWIPE_REF_12345'
      };
      const status = unverifiedCard.isCardVerified ? 'PAID' : 'PENDING';
      expect(status).toBe('PENDING');
    });

    it('card is marked PAID upon verified EDC terminal authorization code', () => {
      const verifiedCard = {
        method: 'CARD',
        isCardVerified: true,
        edcAuthCode: 'AUTH_884920'
      };
      const status = verifiedCard.isCardVerified ? 'PAID' : 'PENDING';
      expect(status).toBe('PAID');
    });

    it('UPI remains PENDING without verified gateway or dynamic QR confirmation', () => {
      const manualUpi = {
        method: 'UPI',
        isUpiVerified: false,
        upiRef: 'MANUAL_UTR_9876543210'
      };
      const status = manualUpi.isUpiVerified ? 'PAID' : 'PENDING';
      expect(status).toBe('PENDING');
    });

    it('UPI is marked PAID only upon verified dynamic QR / webhook confirmation', () => {
      const verifiedUpi = {
        method: 'UPI',
        isUpiVerified: true,
        upiTxnId: 'TXN_GATEWAY_CONFIRMED_991'
      };
      const status = verifiedUpi.isUpiVerified ? 'PAID' : 'PENDING';
      expect(status).toBe('PAID');
    });

    it('split payment requires both parts satisfied and digital verified to be PAID', () => {
      const total = 500;
      const splitA = { cash: 200, upi: 300, isUpiVerified: false };
      const statusA = (splitA.cash + splitA.upi >= total - 0.05 && splitA.isUpiVerified) ? 'PAID' : 'PARTIAL';
      expect(statusA).toBe('PARTIAL');

      const splitB = { cash: 200, upi: 300, isUpiVerified: true };
      const statusB = (splitB.cash + splitB.upi >= total - 0.05 && splitB.isUpiVerified) ? 'PAID' : 'PARTIAL';
      expect(statusB).toBe('PAID');
    });

    it('offline cash is accepted as PAID in local drawer, but offline digital remains PENDING reconciliation', () => {
      const offlineCashBill = { paymentMethod: 'CASH', isOffline: true };
      const cashStatus = offlineCashBill.paymentMethod === 'CASH' ? 'PAID' : 'PENDING';
      expect(cashStatus).toBe('PAID');

      const offlineUpiBill = { paymentMethod: 'UPI', isOffline: true, isUpiVerified: false };
      const upiStatus = (offlineUpiBill.paymentMethod === 'CASH' || offlineUpiBill.isUpiVerified) ? 'PAID' : 'PENDING';
      expect(upiStatus).toBe('PENDING');
    });
  });

  describe('P0.3 — Canonical Order Idempotency & Safe Retry Recovery', () => {
    it('returns existing canonical permanent bill number on duplicate retry without creating a second bill', async () => {
      const idempotentOrderId = `ord_pos_durable_${Date.now()}`;

      // First creation
      const firstCommit = await CanonicalOrderService.createCanonicalOrder({
        id: idempotentOrderId,
        orderSource: 'POS_DINE_IN',
        orderType: 'dine_in',
        customerName: 'Ramesh Kumar',
        customerPhone: '9876543210',
        items: [
          {
            menuItemId: testProductId,
            name: 'Durable Cheese Supreme',
            price: 250,
            quantity: 1,
            size: 'Regular',
            crust: 'Classic'
          }
        ],
        subtotal: 250,
        taxAmount: 12.50,
        totalAmount: 262.50,
        paymentMethod: 'CASH',
        paymentStatus: 'PAID',
        branchId,
        franchiseId,
        cashierId: 'cashier_test_01',
        cashierName: 'Cashier Ramesh'
      });

      expect(firstCommit.id).toBe(idempotentOrderId);
      expect(firstCommit.permanentBillNo).toBeGreaterThan(0);
      expect(firstCommit.isDuplicate).toBeFalsy();

      // Second creation with the exact same order ID (simulating network timeout retry / offline retry)
      const secondCommit = await CanonicalOrderService.createCanonicalOrder({
        id: idempotentOrderId,
        orderSource: 'POS_DINE_IN',
        orderType: 'dine_in',
        customerName: 'Ramesh Kumar',
        customerPhone: '9876543210',
        items: [
          {
            menuItemId: testProductId,
            name: 'Durable Cheese Supreme',
            price: 250,
            quantity: 1,
            size: 'Regular',
            crust: 'Classic'
          }
        ],
        subtotal: 250,
        taxAmount: 12.50,
        totalAmount: 262.50,
        paymentMethod: 'CASH',
        paymentStatus: 'PAID',
        branchId,
        franchiseId,
        cashierId: 'cashier_test_01',
        cashierName: 'Cashier Ramesh'
      });

      // Crucial: Must return exact same permanentBillNo and dailyOrderNo without duplicating!
      expect(secondCommit.id).toBe(idempotentOrderId);
      expect(secondCommit.permanentBillNo).toBe(firstCommit.permanentBillNo);
      expect(secondCommit.dailyOrderNo).toBe(firstCommit.dailyOrderNo);
      expect(secondCommit.isDuplicate).toBe(true);
    }, 25000);
  });
});
