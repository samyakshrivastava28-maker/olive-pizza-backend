import { MultiProviderGeocodeService } from '../src/services/location/MultiProviderGeocodeService';

async function testParallelGeocode() {
  console.log('--- Testing MultiProviderGeocodeService ---');
  const t0 = Date.now();
  const res = await MultiProviderGeocodeService.searchParallel({
    query: 'Station Road',
    city: 'Rajnandgaon',
    lat: 21.0963,
    lng: 81.0335,
    limit: 5,
  });

  const duration = Date.now() - t0;
  console.log(`Query finished in ${duration}ms`);
  console.log(`Success: ${res.success}`);
  console.log(`Providers queried: ${res.providersQueried.join(', ')}`);
  console.log(`Active providers: ${res.activeProviders.join(', ')}`);
  console.log(`Total results: ${res.total}`);

  for (let i = 0; i < Math.min(res.results.length, 3); i++) {
    const r = res.results[i];
    console.log(`Result #${i + 1}:`);
    console.log(`  Name: ${r.name}`);
    console.log(`  Address: ${r.formattedAddress}`);
    console.log(`  Coords: ${r.latitude}, ${r.longitude}`);
    console.log(`  Matched providers (${r.providerCount}): ${r.matchedProviders.join(', ')}`);
    console.log(`  Serviceable: ${r.isServiceable} (${r.serviceabilityMessage})`);
  }

  if (res.results.length > 0) {
    console.log('✅ MultiProviderGeocodeService verified successfully!');
  } else {
    console.log('⚠️ No results returned (might be offline or mocked)');
  }
}

testParallelGeocode().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
