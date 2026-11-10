import dotenv from 'dotenv';
dotenv.config();

import { RedisGpsService } from '../services/gps/RedisGpsService.js';
import { redisService } from '../services/redis/RedisService.js';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 Testing RedisGpsService & Atomic Lua Cleanup');
  console.log('====================================================\n');

  try {
    const isReady = await redisService.ping();
    console.log('Redis connected and ping:', isReady);

    const testFranchise = 'fra_test_gps';
    const rider1 = 'rider_test_alpha';
    const rider2 = 'rider_test_beta';
    const order1 = 'order_test_101';

    // 1. Ingest Rider 1 Location
    console.log('\n--- 1. Testing updateLocation ---');
    const updateRes = await RedisGpsService.updateLocation({
      deliveryPartnerId: rider1,
      franchiseId: testFranchise,
      branchId: 'main_branch',
      latitude: 21.0967,
      longitude: 81.0315,
      accuracy: 4.5,
      speed: 25.0,
      heading: 180.0,
      onlineStatus: true
    });
    console.log('Rider 1 update result:', updateRes);
    if (!updateRes.success) throw new Error('Rider 1 update failed');

    // 2. Fetch Latest Location
    console.log('\n--- 2. Testing getLatestLocation ---');
    const loc1 = await RedisGpsService.getLatestLocation(rider1);
    console.log('Fetched Rider 1 location:', loc1);
    if (!loc1 || loc1.latitude !== 21.0967 || loc1.longitude !== 81.0315) {
      throw new Error('Fetched location mismatch');
    }

    // 3. Ingest Rider 2 with Active Order
    console.log('\n--- 3. Testing updateLocation with activeOrderId ---');
    await RedisGpsService.updateLocation({
      deliveryPartnerId: rider2,
      franchiseId: testFranchise,
      branchId: 'main_branch',
      activeOrderId: order1,
      latitude: 21.1000,
      longitude: 81.0400,
      accuracy: 5.0,
      speed: 30.0,
      heading: 90.0,
      onlineStatus: true
    });

    const orderLoc = await RedisGpsService.getLatestLocationByOrder(order1);
    console.log('Fetched order location by order ID:', orderLoc);
    if (!orderLoc || orderLoc.deliveryPartnerId !== rider2) {
      throw new Error('Order location mapping failed');
    }

    // 4. Test Active Locations for Franchise
    console.log('\n--- 4. Testing getActiveLocations for franchise ---');
    const activeLocs = await RedisGpsService.getActiveLocations(testFranchise);
    console.log(`Active locations in ${testFranchise}:`, activeLocs.length);
    if (activeLocs.length !== 2) throw new Error('Expected 2 active riders in test franchise');

    // 5. Test Atomic Lua Stale Cleanup
    console.log('\n--- 5. Testing Atomic Lua Stale Cleanup ---');
    // Set Rider 1's last_seen score artificially to 120 seconds ago
    const client = redisService.getClient();
    if (!client) throw new Error('Client null');
    
    const staleTime = Date.now() - 120000;
    await client.zadd(`olive:riders:last_seen:${testFranchise}`, staleTime, rider1);

    // Run atomic prune with 60s threshold
    const removed = await RedisGpsService.pruneStaleRiders(testFranchise, 60);
    console.log('Riders pruned by Lua script:', removed);
    if (!removed.includes(rider1)) throw new Error('Expected stale rider1 to be pruned');

    // Verify Rider 1 is gone from GEO and presence
    const locAfterPrune = await RedisGpsService.getLatestLocation(rider1);
    console.log('Rider 1 location after prune (should be null):', locAfterPrune);
    if (locAfterPrune !== null) throw new Error('Rider 1 was not completely pruned');

    // Verify Rider 2 is still active
    const loc2AfterPrune = await RedisGpsService.getLatestLocation(rider2);
    console.log('Rider 2 location after prune (should be active):', loc2AfterPrune?.deliveryPartnerId);
    if (!loc2AfterPrune) throw new Error('Rider 2 should not have been pruned');

    // 6. Test Order Reassignment
    console.log('\n--- 6. Testing Order Reassignment ---');
    const rider3 = 'rider_test_gamma';
    await RedisGpsService.updateLocation({
      deliveryPartnerId: rider3,
      franchiseId: testFranchise,
      latitude: 21.0950,
      longitude: 81.0350
    });

    await RedisGpsService.reassignOrder(order1, rider2, rider3, testFranchise);
    const orderLocReassigned = await RedisGpsService.getLatestLocationByOrder(order1);
    console.log('Order location after reassignment:', orderLocReassigned?.deliveryPartnerId);
    if (orderLocReassigned?.deliveryPartnerId !== rider3) {
      throw new Error('Order reassignment failed');
    }

    // 7. Test Order Completion
    console.log('\n--- 7. Testing completeOrderTracking ---');
    await RedisGpsService.completeOrderTracking(order1, rider3);
    const orderLocCompleted = await RedisGpsService.getLatestLocationByOrder(order1);
    console.log('Order location after completion (should be null):', orderLocCompleted);
    if (orderLocCompleted !== null) throw new Error('Completed order pointer was not deleted');

    // Clean up test keys
    console.log('\nCleaning up test keys...');
    await RedisGpsService.removeRider(testFranchise, rider2);
    await RedisGpsService.removeRider(testFranchise, rider3);

    console.log('\n✅ ALL REDIS GPS & LUA CLEANUP TESTS PASSED SUCCESSFULLY!');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

runTests();
