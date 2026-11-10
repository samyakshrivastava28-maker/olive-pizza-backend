import '../src/config/validator.js';
import { query } from '../src/config/postgres.js';

async function main() {
  try {
    console.log('[Migration] Creating necessary performance indexes on fcm_tokens...');
    await query(`CREATE INDEX IF NOT EXISTS idx_fcm_tokens_branch_app ON fcm_tokens (branch_id, app_name, is_active);`);
    console.log('Created idx_fcm_tokens_branch_app');

    await query(`CREATE INDEX IF NOT EXISTS idx_fcm_tokens_role ON fcm_tokens (role, is_active);`);
    console.log('Created idx_fcm_tokens_role');

    await query(`CREATE INDEX IF NOT EXISTS idx_fcm_tokens_franchise_app ON fcm_tokens (franchise_id, app_name, is_active);`);
    console.log('Created idx_fcm_tokens_franchise_app');

    const res = await query("SELECT indexname FROM pg_indexes WHERE tablename = 'fcm_tokens'");
    console.log('Current indexes on fcm_tokens:', res.rows.map(r => r.indexname));
  } catch (err) {
    console.error('ERROR creating indexes:', err);
  } finally {
    process.exit(0);
  }
}

main();
