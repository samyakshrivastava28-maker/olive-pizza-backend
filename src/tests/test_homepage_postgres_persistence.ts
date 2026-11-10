import dotenv from 'dotenv';
dotenv.config();

import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';

async function testHomepagePersistence() {
  console.log('====================================================');
  console.log('🧪 Testing Homepage CMS PostgreSQL 18.6 & Redis Lifecycle');
  console.log('====================================================\n');

  const testFranchise = 'fra_test_cms';
  const testBranch = 'branch_test_alpha';
  const testChannel = 'web';
  const testLocale = 'en';
  const cacheKey = `olive:home:${testFranchise}:${testBranch}:${testChannel}:${testLocale}`;

  try {
    // Clean up any old test data
    await query('DELETE FROM homepage_configurations WHERE franchise_id = $1 AND branch_id = $2', [testFranchise, testBranch]);
    await redisService.del(cacheKey);

    // 1. Publish Version 1
    console.log('--- 1. Publishing Version 1 to PostgreSQL ---');
    const layoutV1 = {
      pageId: 'test_home_v1',
      title: 'Grand Woodfired Pizzas V1',
      sections: [{ id: 'hero', type: 'HERO', title: 'Welcome to Olive Pizza V1' }]
    };

    const insRes = await query(`
      INSERT INTO homepage_configurations (franchise_id, branch_id, version, status, layout_json, metadata, created_by, published_at)
      VALUES ($1, $2, 1, 'PUBLISHED', $3, $4, 'test_user', NOW())
      RETURNING id, version;
    `, [testFranchise, testBranch, JSON.stringify(layoutV1), JSON.stringify({ name: 'V1 Layout' })]);
    const v1 = insRes.rows[0].version;
    console.log('Version 1 committed to PostgreSQL:', v1);

    // Populate Redis
    await redisService.set(cacheKey, layoutV1, 3600);
    const cachedV1 = await redisService.get<any>(cacheKey);
    console.log('Cached in Redis:', cachedV1?.title);
    if (cachedV1?.title !== 'Grand Woodfired Pizzas V1') throw new Error('Redis cache verification failed for V1');

    // 2. Save a Draft (Version 2)
    console.log('\n--- 2. Saving Draft (Version 2) without publishing ---');
    const layoutV2 = {
      pageId: 'test_home_v2',
      title: 'Artisan Woodfired Pizzas V2 (DRAFT)',
      sections: [{ id: 'hero', type: 'HERO', title: 'Welcome to Olive Pizza V2' }]
    };

    await query(`
      INSERT INTO homepage_configurations (franchise_id, branch_id, version, status, layout_json, metadata, created_by)
      VALUES ($1, $2, 2, 'DRAFT', $3, $4, 'test_user')
    `, [testFranchise, testBranch, JSON.stringify(layoutV2), JSON.stringify({ name: 'V2 Draft' })]);
    console.log('Draft Version 2 saved to PostgreSQL');

    // Verify public query still returns Published V1 (Draft does not leak!)
    const publicQuery = await query(`
      SELECT version, layout_json 
      FROM homepage_configurations 
      WHERE franchise_id = $1 AND branch_id = $2 AND status = 'PUBLISHED'
      ORDER BY version DESC LIMIT 1
    `, [testFranchise, testBranch]);
    console.log('Public published version is still:', publicQuery.rows[0].version);
    if (publicQuery.rows[0].version !== 1) throw new Error('Draft leaked into published query!');

    // 3. Publish Version 2
    console.log('\n--- 3. Publishing Version 2 (Archiving Version 1) ---');
    await query(`
      UPDATE homepage_configurations 
      SET status = 'ARCHIVED', updated_at = NOW() 
      WHERE franchise_id = $1 AND branch_id = $2 AND status = 'PUBLISHED'
    `, [testFranchise, testBranch]);

    await query(`
      UPDATE homepage_configurations 
      SET status = 'PUBLISHED', published_at = NOW() 
      WHERE franchise_id = $1 AND branch_id = $2 AND version = 2
    `, [testFranchise, testBranch]);

    // Update Redis
    await redisService.set(cacheKey, layoutV2, 3600);
    const cachedV2 = await redisService.get<any>(cacheKey);
    console.log('Updated cache in Redis:', cachedV2?.title);
    if (cachedV2?.title !== 'Artisan Woodfired Pizzas V2 (DRAFT)') throw new Error('Redis cache verification failed for V2');

    // 4. Test Rollback to Version 1
    console.log('\n--- 4. Testing Atomic Rollback to Version 1 ---');
    await query(`
      UPDATE homepage_configurations 
      SET status = 'ARCHIVED', updated_at = NOW() 
      WHERE franchise_id = $1 AND branch_id = $2 AND status = 'PUBLISHED'
    `, [testFranchise, testBranch]);

    await query(`
      UPDATE homepage_configurations 
      SET status = 'PUBLISHED', published_at = NOW() 
      WHERE franchise_id = $1 AND branch_id = $2 AND version = 1
    `, [testFranchise, testBranch]);

    const rollbackQuery = await query(`
      SELECT version, layout_json 
      FROM homepage_configurations 
      WHERE franchise_id = $1 AND branch_id = $2 AND status = 'PUBLISHED'
      ORDER BY version DESC LIMIT 1
    `, [testFranchise, testBranch]);
    console.log('Current published version after rollback:', rollbackQuery.rows[0].version);
    if (rollbackQuery.rows[0].version !== 1) throw new Error('Rollback failed to restore Version 1');

    // Clean up
    console.log('\nCleaning up test data...');
    await query('DELETE FROM homepage_configurations WHERE franchise_id = $1 AND branch_id = $2', [testFranchise, testBranch]);
    await redisService.del(cacheKey);

    console.log('\n✅ ALL HOMEPAGE POSTGRESQL & REDIS PERSISTENCE TESTS PASSED!');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pgPool.end();
    process.exit(process.exitCode || 0);
  }
}

testHomepagePersistence();
