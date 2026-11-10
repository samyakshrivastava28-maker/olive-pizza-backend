import pkg from 'pg';
const { Pool } = pkg;

import dotenv from 'dotenv';
dotenv.config();

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[Migration] DATABASE_URL is not set in environment.');
  process.exit(1);
}
const pgPool = new Pool({
  connectionString: dbUrl,
  connectionTimeoutMillis: 15000,
});

async function migrate() {
  const client = await pgPool.connect();
  try {
    console.log('[Migration] Checking current schema of order_locks...');
    const schemaBefore = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'order_locks' ORDER BY ordinal_position;"
    );
    console.log('[Migration] BEFORE:', JSON.stringify(schemaBefore.rows, null, 2));

    // We cannot use ALTER COLUMN TYPE directly with pgbouncer/pgpool in transaction mode,
    // so we do it step by step.
    console.log('[Migration] Altering order_id from uuid to VARCHAR(255)...');
    try {
      await client.query(`ALTER TABLE order_locks ALTER COLUMN order_id TYPE VARCHAR(255);`);
      console.log('[Migration] order_id -> VARCHAR(255): OK');
    } catch (e: any) {
      if (e.message.includes('already') || e.message.includes('varchar')) {
        console.log('[Migration] order_id already VARCHAR, skipping.');
      } else {
        console.error('[Migration] order_id migration error:', e.message);
      }
    }

    console.log('[Migration] Altering locked_by from uuid to VARCHAR(255)...');
    try {
      await client.query(`ALTER TABLE order_locks ALTER COLUMN locked_by TYPE VARCHAR(255);`);
      console.log('[Migration] locked_by -> VARCHAR(255): OK');
    } catch (e: any) {
      if (e.message.includes('already') || e.message.includes('varchar')) {
        console.log('[Migration] locked_by already VARCHAR, skipping.');
      } else {
        console.error('[Migration] locked_by migration error:', e.message);
      }
    }

    const schemaAfter = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'order_locks' ORDER BY ordinal_position;"
    );
    console.log('[Migration] AFTER:', JSON.stringify(schemaAfter.rows, null, 2));

    // Verify the fix works with a Firebase-style ID
    const testOrderId = 'abcXYZ123Test456';
    const testUid = 'firebase_uid_test_789';
    console.log('[Migration] Verifying insert with Firebase-style IDs...');
    await client.query(`DELETE FROM order_locks WHERE order_id = $1`, [testOrderId]);
    const insertResult = await client.query(
      `INSERT INTO order_locks (order_id, locked_by, action, locked_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (order_id) DO UPDATE 
       SET locked_by = EXCLUDED.locked_by, action = EXCLUDED.action, locked_at = EXCLUDED.locked_at
       RETURNING order_id`,
      [testOrderId, testUid, 'accept']
    );
    console.log('[Migration] ✅ Insert test PASSED. Inserted:', insertResult.rows[0].order_id);

    // Clean up test row
    await client.query(`DELETE FROM order_locks WHERE order_id = $1`, [testOrderId]);
    console.log('[Migration] ✅ Cleanup done. Migration complete!');

  } catch (err: any) {
    console.error('[Migration] Fatal error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();
