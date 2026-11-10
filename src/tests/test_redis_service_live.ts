import dotenv from 'dotenv';
dotenv.config();

import { redisService } from '../services/redis/RedisService.js';

async function testService() {
  console.log('Testing RedisService...');
  // Wait up to 5 seconds for ready
  for (let i = 0; i < 10; i++) {
    const status = redisService.getStatus();
    console.log(`Check ${i}: isConnected = ${status.isConnected}, configured = ${status.configured}`);
    if (status.isConnected) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const ok = await redisService.ping();
  console.log('redisService.ping() =', ok);

  if (ok) {
    await redisService.set('olive:test:redis_service', 'working', 60);
    const val = await redisService.get('olive:test:redis_service');
    console.log('redisService.get() =', val);
  }

  process.exit(0);
}

testService();
