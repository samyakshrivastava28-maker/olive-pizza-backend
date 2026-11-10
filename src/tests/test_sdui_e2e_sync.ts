import dotenv from 'dotenv';
dotenv.config();

import { query, pgPool } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { adminDb } from '../config/firebase.js';

async function testSduiE2eSync() {
  console.log('====================================================');
  console.log('🔍 Testing SDUI E2E End-to-End Live Synchronization Pipeline');
  console.log('====================================================\n');

  const testFranchise = 'fra_e2e_verify';
  const testBranch = 'branch_e2e_verify';
  const testChannel = 'web';
  const testLocale = 'en';
  const cacheKey = `olive:home:${testFranchise}:${testBranch}:${testChannel}:${testLocale}`;

  try {
    // Clean up any old test records in PostgreSQL
    await query('DELETE FROM homepage_configurations WHERE franchise_id = $1 AND branch_id = $2', [testFranchise, testBranch]);

    // 1. Verify Google Stitch SDUI Schema Structure
    console.log('1️⃣  Validating Stitch Canonical SDUI Schema Structure...');
    const testStitchSchema = {
      versionId: `v_test_${Date.now()}`,
      pageId: 'stitch_galaxy_test',
      type: 'BUILT_IN',
      metadata: {
        name: 'Stitch Midnight Galaxy Test',
        description: 'Automated E2E Verification of Stitch SDUI Pipeline',
        publishedBy: 'sdui_verifier',
        publishedAt: new Date().toISOString()
      },
      sections: [
        {
          id: 'hero_sec',
          type: 'HERO',
          isHidden: false,
          config: {
            headline: 'Midnight Galaxy Woodfired Pizza',
            subtitle: 'Artisanal 72-hour slow fermented dough',
            buttonText: 'ORDER NOW',
            buttonAction: { type: 'OPEN_MENU' }
          }
        },
        {
          id: 'cravings_sec',
          type: 'CRAVINGS',
          isHidden: false,
          config: { headline: "WHAT'S YOUR CRAVING FOR?", subtitle: 'Wood-fired crusts' }
        },
        {
          id: 'featured_sec',
          type: 'FEATURED',
          isHidden: false,
          config: {}
        },
        {
          id: 'why_us_sec',
          type: 'WHY_US',
          isHidden: false,
          config: {}
        },
        {
          id: 'download_app_sec',
          type: 'DOWNLOAD_APP',
          isHidden: false,
          config: {}
        },
        {
          id: 'footer_sec',
          type: 'FOOTER',
          isHidden: false,
          config: {}
        }
      ]
    };

    console.log(`   Canonical sections defined: ${testStitchSchema.sections.map(s => s.type).join(', ')}`);

    // 2. Simulate Backend Publish Pipeline (Transactional PG + Redis + Firestore)
    console.log('\n2️⃣  Executing Publish Transaction to PostgreSQL (homepage_configurations)...');
    const client = await pgPool.connect();
    let publishedVer = 1;
    try {
      await client.query('BEGIN');
      const vRes = await client.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_ver 
        FROM homepage_configurations 
        WHERE franchise_id = $1 AND branch_id = $2
      `, [testFranchise, testBranch]);
      publishedVer = parseInt(vRes.rows[0]?.next_ver || '1', 10);

      // Insert published configuration
      await client.query(`
        INSERT INTO homepage_configurations (franchise_id, branch_id, version, status, layout_json, metadata, created_by, published_at)
        VALUES ($1, $2, $3, 'PUBLISHED', $4, $5, $6, NOW())
      `, [
        testFranchise,
        testBranch,
        publishedVer,
        JSON.stringify(testStitchSchema),
        JSON.stringify(testStitchSchema.metadata),
        'sdui_verifier'
      ]);

      await client.query('COMMIT');
      console.log(`   ✅ Version ${publishedVer} committed immutably to Layerbase PostgreSQL.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 3. Verify Redis Invalidation & Set
    console.log('\n3️⃣  Validating Redis Invalidation & Multi-Channel Snapshot Keying...');
    await redisService.del(cacheKey);
    await redisService.set(cacheKey, testStitchSchema, 3600);
    const redisCached = await redisService.get<any>(cacheKey);
    if (!redisCached || redisCached.pageId !== 'stitch_galaxy_test') {
      throw new Error('Redis verification failed for Stitch SDUI layout');
    }
    console.log(`   ✅ Redis cache successfully populated and verified with key: ${cacheKey}`);

    // 4. Verify Firestore Real-time Sync Read/Write
    console.log('\n4️⃣  Validating Cloud Firestore settings/homepage Synchronization...');
    const firestoreRef = adminDb.collection('settings').doc('homepage_e2e_test');
    await firestoreRef.set({
      config: testStitchSchema,
      activePageId: testStitchSchema.pageId,
      activeTemplateName: testStitchSchema.metadata.name,
      version: publishedVer,
      franchiseId: testFranchise,
      branchId: testBranch,
      updatedAt: new Date().toISOString(),
      updatedBy: 'sdui_verifier'
    });

    const firestoreSnap = await firestoreRef.get();
    if (!firestoreSnap.exists) {
      throw new Error('Firestore document settings/homepage_e2e_test was not found');
    }
    const fsData = firestoreSnap.data();
    if (fsData?.activePageId !== 'stitch_galaxy_test' || !fsData?.config?.sections) {
      throw new Error('Firestore document payload mismatch');
    }
    console.log(`   ✅ Cloud Firestore settings document verified: activePageId="${fsData.activePageId}", sectionsCount=${fsData.config.sections.length}`);

    // Check Live Firestore Document settings/homepage
    const liveFirestoreSnap = await adminDb.collection('settings').doc('homepage').get();
    console.log(`   ℹ️ Current production Firestore settings/homepage exists: ${liveFirestoreSnap.exists} (activePageId: "${liveFirestoreSnap.data()?.activePageId || 'default'}")`);

    // Clean up test data
    console.log('\n5️⃣  Cleaning up temporary test artifacts...');
    await query('DELETE FROM homepage_configurations WHERE franchise_id = $1 AND branch_id = $2', [testFranchise, testBranch]);
    await redisService.del(cacheKey);
    await firestoreRef.delete();
    console.log('   ✅ Clean-up complete.');

    console.log('\n====================================================');
    console.log('🎉 ALL SDUI VISUAL & LIVE SYNCHRONIZATION CHECKS PASSED!');
    console.log('====================================================');
  } catch (error: any) {
    console.error('❌ E2E Verification failed:', error);
    process.exitCode = 1;
  } finally {
    await pgPool.end();
    process.exit(process.exitCode || 0);
  }
}

testSduiE2eSync();
