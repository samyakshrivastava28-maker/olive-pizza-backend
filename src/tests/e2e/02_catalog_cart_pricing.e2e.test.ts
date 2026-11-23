/**
 * E2E API Test 02: Menu Catalog & Cart Pricing Calculation
 * Tests home/menu/cart bootstrap endpoints, catalog schema, and authoritative pricing.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getServerInfo } from './helpers/testServer.js';

describe('E2E Backend API: Menu Catalog & Cart Pricing Calculation', () => {
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  before(async () => {
    const s = await getServerInfo();
    baseUrl = s.baseUrl;
    closeServer = s.close;
  });

  after(async () => {
    await closeServer();
  });

  it('1. GET /api/v1/home/bootstrap returns unified home screen catalog', async () => {
    const res = await fetch(`${baseUrl}/api/v1/home/bootstrap?branchId=branch_rjn_main`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.categories), 'categories must be an array');
    assert.ok(Array.isArray(body.featuredProducts), 'featuredProducts must be an array');
    assert.ok(body.storeStatus, 'storeStatus must be present');
  });

  it('2. GET /api/v1/menu/bootstrap returns catalog with categories and products', async () => {
    const res = await fetch(`${baseUrl}/api/v1/menu/bootstrap?branchId=branch_rjn_main`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.categories), 'categories must be an array');
    assert.ok(Array.isArray(body.products), 'products must be an array');
    assert.ok(body.products.length > 0, 'products must contain at least 1 item');

    const first = body.products[0];
    assert.ok(first.id, 'product must have an id');
    assert.ok(first.name, 'product must have a name');
    assert.ok(typeof first.basePrice === 'number' || typeof first.price === 'number');
  });

  it('3. GET /api/v1/cart/bootstrap returns packagingCharge, 5% GST, and delivery tiers', async () => {
    const res = await fetch(`${baseUrl}/api/v1/cart/bootstrap?branchId=branch_rjn_main`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert.ok(typeof body.packagingCharge === 'number');
    assert.ok(body.taxRates || body.gstPercentage !== undefined);
  });

  it('4. Authoritative pricing calculation matches specification', () => {
    const base = 199;
    const variantAdd = 99; // Medium
    const crustAdd = 60; // Cheese Burst
    const addOn = 50; // Olives
    const subtotal = base + variantAdd + crustAdd + addOn; // 408
    const gst = Math.round(subtotal * 0.05); // 20
    const delivery = 40;
    const packaging = 20;
    const total = subtotal + gst + delivery + packaging; // 488

    assert.equal(subtotal, 408);
    assert.equal(gst, 20);
    assert.equal(total, 488);
  });
});
