import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import bootstrapRoutes from '../routes/bootstrap.routes.ts';

describe('Smart API Page Bootstrap Aggregation Endpoints', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/api/v1', bootstrapRoutes);

    await new Promise<void>((resolve) => {
      server = testApp.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('1. GET /api/v1/home/bootstrap returns unified home screen payload with Cache-Control', async () => {
    const res = await fetch(`${baseUrl}/api/v1/home/bootstrap`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert(Array.isArray(body.categories), 'categories must be an array');
    assert(Array.isArray(body.featuredProducts), 'featuredProducts must be an array');
    assert(Array.isArray(body.offers), 'offers must be an array');
    assert.equal(typeof body.storeStatus, 'object');
    const cacheHeader = res.headers.get('cache-control');
    assert(cacheHeader && cacheHeader.includes('max-age'), 'Cache-Control header must be set');
  });

  it('2. GET /api/v1/menu/bootstrap returns catalog, categories, offers & availability in one shot', async () => {
    const res = await fetch(`${baseUrl}/api/v1/menu/bootstrap`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert(Array.isArray(body.categories), 'categories must be an array');
    assert(Array.isArray(body.products), 'products must be an array');
    assert(typeof body.availability === 'object', 'availability map must be an object');
  });

  it('3. GET /api/v1/cart/bootstrap returns coupons, packaging charge, taxes, delivery tiers', async () => {
    const res = await fetch(`${baseUrl}/api/v1/cart/bootstrap`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;

    assert.equal(body.success, true);
    assert(Array.isArray(body.coupons), 'coupons must be an array');
    assert(typeof body.packagingCharge === 'number', 'packagingCharge must be a number');
    assert(typeof body.taxRates === 'object', 'taxRates must be an object');
    assert(typeof body.deliveryFeeConfig === 'object', 'deliveryFeeConfig must be an object');
  });

  it('4. Protected endpoints reject unauthenticated requests gracefully', async () => {
    // Owner dashboard requires authentication & staff/owner role
    const ownerRes = await fetch(`${baseUrl}/api/v1/owner/dashboard/bootstrap`);
    assert([401, 403].includes(ownerRes.status), 'Unauthenticated owner request must be rejected');

    // Restaurant live requires restaurant manager role
    const restRes = await fetch(`${baseUrl}/api/v1/restaurant/live/bootstrap`);
    assert([401, 403].includes(restRes.status), 'Unauthenticated restaurant request must be rejected');

    // Delivery live requires delivery rider role
    const delRes = await fetch(`${baseUrl}/api/v1/delivery/live/bootstrap`);
    assert([401, 403].includes(delRes.status), 'Unauthenticated delivery request must be rejected');

    // POS bootstrap requires staff role
    const posRes = await fetch(`${baseUrl}/api/v1/pos/bootstrap`);
    assert([401, 403].includes(posRes.status), 'Unauthenticated POS request must be rejected');
  });
});
