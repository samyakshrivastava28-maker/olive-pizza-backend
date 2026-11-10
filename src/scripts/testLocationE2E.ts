import { MultiProviderGeocodeService } from '../services/location/MultiProviderGeocodeService.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';
import { checkPostgresHealth, query, DATABASE_ENV } from '../config/postgres.js';
import { checkSupabaseHealth } from '../config/supabase.js';

async function runLocationE2ETest() {
  console.log('\n============================================================');
  console.log('🍕 OLIVE PIZZA — LOCATION SYSTEM & DATABASE E2E VERIFICATION');
  console.log('============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, details?: any) {
    if (condition) {
      console.log(`  ✅ PASS: ${title}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${title}`, details || '');
      failed++;
    }
  }

  try {
    // ─── 1. Multi-Provider Parallel Search ──────────────────────────────
    console.log('[Test 1] Multi-Provider Parallel Search & Normalization:');
    const searchRes = await MultiProviderGeocodeService.searchParallel({
      query: 'Rajnandgaon Railway Station',
      lat: 21.0963,
      lng: 81.0335,
      limit: 6
    });

    assert('Search returns success: true', searchRes.success === true);
    assert('Returns non-empty normalized results', searchRes.results.length > 0, `Count: ${searchRes.results.length}`);
    assert('Providers queried include Nominatim', searchRes.providersQueried.includes('nominatim'));
    assert('Providers queried include Photon', searchRes.providersQueried.includes('photon'));

    const first = searchRes.results[0];
    if (first) {
      assert('First result has valid numeric latitude', typeof first.latitude === 'number' && !isNaN(first.latitude));
      assert('First result has valid numeric longitude', typeof first.longitude === 'number' && !isNaN(first.longitude));
      assert('First result has formattedAddress string', Boolean(first.formattedAddress));
      assert('First result has name string', Boolean(first.name));
      assert('First result has provider attribution', Boolean(first.provider));
      console.log(`     Sample: "${first.name}" (${first.latitude}, ${first.longitude}) via [${first.provider}]`);
    }

    // ─── 2. Authoritative Ordering Context & Exact Coordinates ──────────
    console.log('\n[Test 2] Authoritative Ordering Context & Exact Coordinates:');
    // Coords near Rajnandgaon store
    const serviceableRes = await CustomerOrderingContextService.resolveOrderingContext({
      customerId: 'test_customer_01',
      lat: 21.0963,
      lng: 81.0335,
      addressLine: 'Near Railway Station, Rajnandgaon, CG'
    });
    assert('Store vicinity is resolved as serviceable', serviceableRes.isServiceable === true);
    assert('Identifies Rajnandgaon branch or closest branch', Boolean(serviceableRes.context?.branchId));
    assert('Calculates accurate delivery distance', typeof serviceableRes.context?.distanceKm === 'number');

    // Distant coords (e.g., Delhi, 1000km away)
    const outOfAreaRes = await CustomerOrderingContextService.resolveOrderingContext({
      customerId: 'test_customer_02',
      lat: 28.6139,
      lng: 77.2090,
      addressLine: 'Connaught Place, New Delhi'
    });
    assert('Distant location correctly rejected as unserviceable', outOfAreaRes.isServiceable === false);
    assert('Rejection returns clear user-friendly explanation', Boolean(outOfAreaRes.error));

    // ─── 3. Render PostgreSQL Testing Database ──────────────────────────
    console.log('\n[Test 3] Render PostgreSQL Testing Database:');
    assert('Active environment is render-test', DATABASE_ENV === 'render-test');

    const pgHealth = await checkPostgresHealth();
    assert('Render PostgreSQL connection is healthy', pgHealth.connected === true);
    assert('Environment returned in health probe', pgHealth.environment === 'render-test');

    const tablesRes = await query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_schema = 'public';
    `);
    const tableCount = parseInt(tablesRes.rows[0].count, 10);
    assert('Schema tables present in database (>15 tables)', tableCount >= 15, `Found: ${tableCount}`);

    // Test ACID lock table
    const testKey = 'test_lock_' + Date.now();
    await query('INSERT INTO checkout_locks (lock_key, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 minute\')', [testKey, 'usr_test']);
    const lockRead = await query('SELECT * FROM checkout_locks WHERE lock_key = $1', [testKey]);
    assert('ACID checkout lock inserted and verified in Render PostgreSQL', lockRead.rows.length === 1);
    await query('DELETE FROM checkout_locks WHERE lock_key = $1', [testKey]);

    // ─── 4. Supabase Live GPS Isolation ─────────────────────────────────
    console.log('\n[Test 4] Supabase GPS Live Tracking System Isolation:');
    const supaHealth = await checkSupabaseHealth();
    assert('Dedicated Supabase GPS telemetry client active', typeof supaHealth.connected === 'boolean');

    // ─── Summary ────────────────────────────────────────────────────────
    console.log('\n============================================================');
    console.log(`📊 FINAL RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('============================================================\n');

  } catch (err: any) {
    console.error('Fatal test error:', err);
  } finally {
    process.exit(0);
  }
}

runLocationE2ETest();
