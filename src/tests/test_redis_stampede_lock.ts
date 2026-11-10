import dotenv from 'dotenv';
dotenv.config();

import { redisService } from '../services/redis/RedisService.js';
import crypto from 'crypto';

async function testStampedeLocks() {
  console.log('====================================================');
  console.log('🧪 Testing Redlock Token Ownership & Stampede Protection');
  console.log('====================================================\n');

  try {
    const isPing = await redisService.ping();
    console.log('Redis ping:', isPing);

    const testLockKey = 'test_stampede_lock_' + Date.now();
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const tokenC = crypto.randomUUID();

    // 1. Worker A acquires lock
    console.log('--- 1. Worker A acquires lock ---');
    const acquiredA = await redisService.acquireLockWithToken(testLockKey, tokenA, 5);
    console.log('Worker A acquired:', acquiredA);
    if (!acquiredA) throw new Error('Worker A should have acquired lock');

    // 2. Worker B tries to acquire same lock
    console.log('\n--- 2. Worker B tries to acquire same lock ---');
    const acquiredB = await redisService.acquireLockWithToken(testLockKey, tokenB, 5);
    console.log('Worker B acquired (should be false):', acquiredB);
    if (acquiredB) throw new Error('Worker B acquired lock while Worker A still held it!');

    // 3. Unauthorized release attempt with wrong token C
    console.log('\n--- 3. Unauthorized release attempt with Token C ---');
    const releasedWrong = await redisService.releaseLockWithToken(testLockKey, tokenC);
    console.log('Release with Token C (should be false):', releasedWrong);
    if (releasedWrong) throw new Error('Lock released with wrong token!');

    // Verify lock is still held
    const acquiredAgain = await redisService.acquireLockWithToken(testLockKey, tokenB, 5);
    console.log('Worker B tries again before A releases (should be false):', acquiredAgain);
    if (acquiredAgain) throw new Error('Lock was prematurely released!');

    // 4. Worker A safely releases lock
    console.log('\n--- 4. Worker A releases lock with Token A ---');
    const releasedA = await redisService.releaseLockWithToken(testLockKey, tokenA);
    console.log('Worker A released (should be true):', releasedA);
    if (!releasedA) throw new Error('Worker A failed to release lock with valid token');

    // 5. Worker B can now acquire lock
    console.log('\n--- 5. Worker B acquires released lock ---');
    const acquiredBAfter = await redisService.acquireLockWithToken(testLockKey, tokenB, 5);
    console.log('Worker B acquired after A released:', acquiredBAfter);
    if (!acquiredBAfter) throw new Error('Worker B could not acquire released lock');
    await redisService.releaseLockWithToken(testLockKey, tokenB);

    // 6. Test fetchWithStampedeProtection with concurrent requests
    console.log('\n--- 6. Testing fetchWithStampedeProtection concurrency ---');
    const cacheKey = 'test_stampede_cache_' + Date.now();
    let loaderExecutions = 0;

    const loader = async () => {
      loaderExecutions++;
      await new Promise(r => setTimeout(r, 200)); // Simulate 200ms DB query
      return { menuVersion: 42, items: ['Pizza Margherita', 'Pizza Formaggi'] };
    };

    // Fire 5 concurrent requests simultaneously
    const results = await Promise.all([
      redisService.fetchWithStampedeProtection(cacheKey, loader, { ttlSeconds: 60 }),
      redisService.fetchWithStampedeProtection(cacheKey, loader, { ttlSeconds: 60 }),
      redisService.fetchWithStampedeProtection(cacheKey, loader, { ttlSeconds: 60 }),
      redisService.fetchWithStampedeProtection(cacheKey, loader, { ttlSeconds: 60 }),
      redisService.fetchWithStampedeProtection(cacheKey, loader, { ttlSeconds: 60 })
    ]);

    console.log('Total concurrent requests: 5');
    console.log('Loader executions count (should be 1):', loaderExecutions);
    console.log('Sample result:', results[0]?.items);

    if (loaderExecutions !== 1) {
      throw new Error(`Stampede protection failed: loader executed ${loaderExecutions} times instead of 1`);
    }

    // Clean up
    await redisService.del(cacheKey);

    console.log('\n✅ ALL STAMPEDE LOCK & TOKEN OWNERSHIP TESTS PASSED!');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

testStampedeLocks();
