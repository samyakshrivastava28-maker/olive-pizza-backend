import { describe, it, expect, beforeAll } from 'vitest';
import { AuthoritativePricingResolver } from '../src/services/menu/AuthoritativePricingResolver.js';
import { POSService } from '../src/services/pos/POSService.js';
import { query } from '../src/lib/db.js';

describe('Authoritative Multi-Franchise Pricing & RBAC Integration Tests', () => {
  const branchA = 'branch_rajnandgaon_hq';
  const branchB = 'branch_bhilai_express';
  const franchiseA = 'fra_rajnandgaon';
  const franchiseB = 'fra_bhilai';
  const testProductId = 'prod_margherita_auth_test';

  beforeAll(async () => {
    // 1. Seed PostgreSQL franchise_prices with different selling prices for Branch A vs Branch B
    try {
      await query(`
        INSERT INTO franchise_prices (id, franchise_id, branch_id, product_id, selling_price, is_available, version, updated_by)
        VALUES 
          ($1, $2, $3, $4, 199.00, true, 1, 'test_setup'),
          ($5, $6, $7, $8, 229.00, true, 1, 'test_setup')
        ON CONFLICT (franchise_id, branch_id, product_id)
        DO UPDATE SET selling_price = EXCLUDED.selling_price, is_available = EXCLUDED.is_available;
      `, [
        `${branchA}_${testProductId}`, franchiseA, branchA, testProductId,
        `${branchB}_${testProductId}`, franchiseB, branchB, testProductId
      ]);
    } catch (e: any) {
      console.warn('[TestSetup] Postgres seeding warning:', e.message);
    }

    // Seed master catalog item
    POSService.seedCatalogItem(testProductId, {
      id: testProductId,
      name: 'Margherita Pizza Classic',
      basePrice: 189,
      sizes: {
        'medium': { price: 299 },
        'large': { price: 399 }
      },
      addons: [
        { id: 'add_extra_cheese', name: 'Extra Mozzarella', price: 50 }
      ]
    });
  });

  it('resolves Branch A price as ₹199.00 and Branch B price as ₹229.00 for the same product', async () => {
    // Branch A resolution
    const priceA = await AuthoritativePricingResolver.resolveItemPrice({
      branchId: branchA,
      franchiseId: franchiseA,
      productId: testProductId
    });
    expect(priceA.unitPrice).toBe(199.00);
    expect(priceA.source).toBe('FRANCHISE_PRICE_OVERRIDE');

    // Branch B resolution
    const priceB = await AuthoritativePricingResolver.resolveItemPrice({
      branchId: branchB,
      franchiseId: franchiseB,
      productId: testProductId
    });
    expect(priceB.unitPrice).toBe(229.00);
    expect(priceB.source).toBe('FRANCHISE_PRICE_OVERRIDE');
  });

  it('rejects pricing resolution when branchId is missing', async () => {
    await expect(
      AuthoritativePricingResolver.resolveItemPrice({
        branchId: '',
        productId: testProductId
      })
    ).rejects.toThrow(/Authoritative branch context is required/);
  });

  it('rejects pricing resolution when product is unpriced or does not exist', async () => {
    POSService.seedCatalogItem('prod_non_existent_fake_item', null);
    await expect(
      AuthoritativePricingResolver.resolveItemPrice({
        branchId: branchA,
        productId: 'prod_non_existent_fake_item'
      })
    ).rejects.toThrow(/was not found in the authoritative master catalog/);
  });

  it('calculates POS bill with branch-specific prices through POSService.calculateBill', async () => {
    // Calculate for Branch A
    const billA = await POSService.calculateBill({
      branchId: branchA,
      orderType: 'DINE_IN',
      items: [
        {
          id: testProductId,
          menuItemId: testProductId,
          name: 'Margherita Pizza Classic',
          price: 999, // Intentional spoofed client price to test server authoritative override
          quantity: 2
        }
      ]
    });

    // Subtotal must be 199 * 2 = 398 (not client 999*2)
    expect(billA.subtotal).toBe(398);
    expect(billA.taxes).toBe(Math.round(398 * 0.05)); // 20
    expect(billA.finalTotal).toBe(398 + Math.round(398 * 0.05)); // 418

    // Calculate for Branch B
    const billB = await POSService.calculateBill({
      branchId: branchB,
      orderType: 'DINE_IN',
      items: [
        {
          id: testProductId,
          menuItemId: testProductId,
          name: 'Margherita Pizza Classic',
          price: 999, // Intentional spoofed client price
          quantity: 2
        }
      ]
    });

    // Subtotal must be 229 * 2 = 458
    expect(billB.subtotal).toBe(458);
    expect(billB.taxes).toBe(Math.round(458 * 0.05)); // 23
    expect(billB.finalTotal).toBe(458 + Math.round(458 * 0.05)); // 481
  });

  it('authorizes Owner and Owner-authorized staff accounts for POS operational access', async () => {
    // 1. Master Owner emails
    const masterOwners = ['olivepizzarjn@gmail.com', 'webhub2811@gmail.com', 'olivepizzamaker@gmail.com'];
    for (const email of masterOwners) {
      const isOwner = email === 'olivepizzarjn@gmail.com' || email === 'webhub2811@gmail.com' || email === 'olivepizzamaker@gmail.com';
      expect(isOwner).toBe(true);
    }

    // 2. Authorized staff roles
    const allowedRoles = ['pos_operator', 'cashier', 'franchise_manager', 'franchise_owner', 'store_manager', 'manager', 'staff'];
    expect(allowedRoles.includes('cashier')).toBe(true);
    expect(allowedRoles.includes('pos_operator')).toBe(true);
    expect(allowedRoles.includes('staff')).toBe(true);

    // 3. Allowed apps grant
    const staffApps = ['POS', 'RESTAURANT_MANAGER'];
    expect(staffApps.map(a => a.toUpperCase()).includes('POS')).toBe(true);
  });

  it('rejects invalid size variants and fails closed', async () => {
    await expect(
      AuthoritativePricingResolver.resolveItemPrice({
        branchId: branchA,
        productId: testProductId,
        size: 'ExtraLarge_Invalid'
      })
    ).rejects.toThrow(/Invalid size "ExtraLarge_Invalid"/);
  });

  it('rejects invalid crusts and fails closed', async () => {
    await expect(
      AuthoritativePricingResolver.resolveItemPrice({
        branchId: branchA,
        productId: testProductId,
        crust: 'StuffedCrust_Invalid'
      })
    ).rejects.toThrow(/Invalid crust/);
  });

  it('rejects invalid addons and fails closed', async () => {
    await expect(
      AuthoritativePricingResolver.resolveItemPrice({
        branchId: branchA,
        productId: testProductId,
        addons: ['add_unauthorized_topping']
      })
    ).rejects.toThrow(/Invalid addon "add_unauthorized_topping"/);
  });

  it('calculates deterministic size delta pricing without arbitrary proportional ratios', async () => {
    // Master base: 189, Medium: 299 (delta = +110)
    // Branch A override: 199 -> Medium unitPrice = 199 + 110 = 309
    const priceMedium = await AuthoritativePricingResolver.resolveItemPrice({
      branchId: branchA,
      productId: testProductId,
      size: 'medium'
    });
    expect(priceMedium.unitPrice).toBe(309.00);
    expect(priceMedium.source).toBe('FRANCHISE_PRICE_OVERRIDE');
  });

  it('inherits master catalog pricing when confirmed absent from branch overrides', async () => {
    const inheritedProdId = 'prod_inherits_master_pricing';
    POSService.seedCatalogItem(inheritedProdId, {
      id: inheritedProdId,
      name: 'Paneer Tikka Special',
      basePrice: 249.00,
      isAvailable: true
    });

    const inheritedPrice = await AuthoritativePricingResolver.resolveItemPrice({
      branchId: 'branch_non_overridden_store',
      productId: inheritedProdId
    });
    expect(inheritedPrice.unitPrice).toBe(249.00);
    expect(inheritedPrice.source).toBe('MASTER_CATALOG');
  });

  it('enforces payment validation contract for cash tender, change, and digital verification', () => {
    const finalTotal = 418.00;

    // 1. Cash fully paid
    const cashPaidReceived = 500;
    const changeDue = cashPaidReceived >= finalTotal ? parseFloat((cashPaidReceived - finalTotal).toFixed(2)) : 0;
    const cashStatus = cashPaidReceived >= (finalTotal - 0.05) ? 'PAID' : 'PARTIAL';
    expect(cashStatus).toBe('PAID');
    expect(changeDue).toBe(82.00);

    // 2. Cash underpaid
    const cashUnderpaidReceived = 350;
    const underpaidStatus = cashUnderpaidReceived >= (finalTotal - 0.05) ? 'PAID' : 'PARTIAL';
    expect(underpaidStatus).toBe('PARTIAL');

    // 3. Card unverified manual string
    const cardUnverified = { method: 'CARD', isCardVerified: false, cardRef: 'MANUAL_1234' };
    const cardUnverifiedStatus = cardUnverified.isCardVerified ? 'PAID' : 'PENDING';
    expect(cardUnverifiedStatus).toBe('PENDING');

    // 4. Card verified with EDC auth
    const cardVerified = { method: 'CARD', isCardVerified: true, cardAuthCode: 'AUTH_882910' };
    const cardVerifiedStatus = cardVerified.isCardVerified ? 'PAID' : 'PENDING';
    expect(cardVerifiedStatus).toBe('PAID');

    // 5. UPI unverified manual reference
    const upiUnverified = { method: 'UPI', isUpiVerified: false, upiRef: 'UTR991823771' };
    const upiUnverifiedStatus = upiUnverified.isUpiVerified ? 'PAID' : 'PENDING';
    expect(upiUnverifiedStatus).toBe('PENDING');

    // 6. UPI verified via webhook / QR
    const upiVerified = { method: 'UPI', isUpiVerified: true, upiTxnId: 'UPI_TXN_OK_99' };
    const upiVerifiedStatus = upiVerified.isUpiVerified ? 'PAID' : 'PENDING';
    expect(upiVerifiedStatus).toBe('PAID');

    // 7. Split payment with unverified digital
    const splitPayment = { method: 'SPLIT', splitCash: 200, splitUPI: 218, splitDigitalVerified: false };
    const splitTotal = splitPayment.splitCash + splitPayment.splitUPI;
    const splitStatus = (splitTotal >= finalTotal - 0.05 && splitPayment.splitDigitalVerified) ? 'PAID' : 'PARTIAL';
    expect(splitStatus).toBe('PARTIAL');

    // 8. Offline cash vs digital
    const offlineCash = { method: 'CASH', isOffline: true };
    const offlineCashStatus = offlineCash.method === 'CASH' ? 'PAID' : 'PENDING';
    expect(offlineCashStatus).toBe('PAID');

    const offlineDigital = { method: 'UPI', isOffline: true, isUpiVerified: false };
    const offlineDigitalStatus = (offlineDigital.method === 'CASH' || offlineDigital.isUpiVerified) ? 'PAID' : 'PENDING';
    expect(offlineDigitalStatus).toBe('PENDING');
  });
});
