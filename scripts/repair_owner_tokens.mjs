import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const OWNER_UIDS = ['ZzMmHLa6fBeDYY7clYNjP70fbiE2', '6tLLR6q7aTYqzTG2blRx3TU5sA42'];

async function main() {
  const client = await pool.connect();
  try {
    console.log('--- REPAIRING OWNER TOKENS IN fcm_tokens ---');

    // 1. Deactivate any token for owner UIDs where app_name != 'owner'
    const deactRes = await client.query(`
      UPDATE fcm_tokens
      SET is_active = FALSE, updated_at = NOW()
      WHERE user_id = ANY($1) 
        AND (app_name != 'owner' OR app_name IS NULL)
        AND is_active = TRUE
      RETURNING id, user_id, app_name, role, SUBSTRING(token, 1, 20) as token_prefix
    `, [OWNER_UIDS]);
    console.log(`Deactivated ${deactRes.rows.length} misclassified/stale owner tokens:`);
    console.table(deactRes.rows);

    // 2. Ensure all active tokens for owner UIDs are strictly app_name = 'owner' and role = 'owner'
    const activeRes = await client.query(`
      UPDATE fcm_tokens
      SET app_name = 'owner', role = 'owner', updated_at = NOW()
      WHERE user_id = ANY($1) AND is_active = TRUE
      RETURNING id, user_id, app_name, role, SUBSTRING(token, 1, 20) as token_prefix
    `, [OWNER_UIDS]);
    console.log(`Active owner tokens verified:`);
    console.table(activeRes.rows);

    // 3. Check for any remaining misclassified owner tokens across the table
    const remaining = await client.query(`
      SELECT user_id, app_name, role, count(*) 
      FROM fcm_tokens 
      WHERE user_id = ANY($1)
      GROUP BY user_id, app_name, role
    `, [OWNER_UIDS]);
    console.log('Current state of owner tokens:');
    console.table(remaining.rows);

  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
