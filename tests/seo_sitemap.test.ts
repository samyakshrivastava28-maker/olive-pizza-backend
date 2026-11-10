import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('SEO & Sitemap Engine Tests', () => {
  it('serves dynamic /sitemap.xml with valid XML structure and public URLs', async () => {
    const res = await request(app).get('/sitemap.xml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    
    const body = res.text;
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<urlset');
    expect(body).toContain('<loc>');
    expect(body).toContain('/menu');
    expect(body).toContain('/offers');
    expect(body).toContain('/about');
    expect(body).toContain('/contact');
    expect(body).toContain('/privacy-policy');
    expect(body).toContain('/terms');

    // Strict exclusion verification: Must NOT contain private, dashboard or POS routes
    expect(body).not.toContain('/admin');
    expect(body).not.toContain('/owner');
    expect(body).not.toContain('/franchise');
    expect(body).not.toContain('/manager');
    expect(body).not.toContain('/pos');
    expect(body).not.toContain('/checkout');
    expect(body).not.toContain('/account');
    expect(body).not.toContain('/api/');
  });

  it('serves valid /robots.txt with allowed public routes and disallowed admin/POS routes', async () => {
    const res = await request(app).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.text;
    expect(body).toContain('User-agent: *');
    expect(body).toContain('Allow: /');
    expect(body).toContain('Allow: /menu');
    expect(body).toContain('Allow: /product/');
    expect(body).toContain('Allow: /offers');
    
    // Disallowed private paths
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Disallow: /checkout');
    expect(body).toContain('Disallow: /account');
    expect(body).toContain('Disallow: /pos');
    expect(body).toContain('Disallow: /owner');
    expect(body).toContain('Disallow: /franchise');
    expect(body).toContain('Disallow: /manager');
    expect(body).toContain('Disallow: /delivery');

    // References sitemap
    expect(body).toContain('Sitemap:');
    expect(body).toContain('/sitemap.xml');
  });

  it('serves /api/sitemap.xml and /api/robots.txt identically for API routing compatibility', async () => {
    const resSitemap = await request(app).get('/api/sitemap.xml');
    expect(resSitemap.status).toBe(200);
    expect(resSitemap.headers['content-type']).toContain('xml');

    const resRobots = await request(app).get('/api/robots.txt');
    expect(resRobots.status).toBe(200);
    expect(resRobots.text).toContain('User-agent: *');
  });
});
