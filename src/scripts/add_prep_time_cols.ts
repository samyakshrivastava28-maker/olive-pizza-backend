import '../config/env.js';
import { query } from '../config/postgres.js';

async function migrate() {
  await query(`
    ALTER TABLE canonical_orders 
    ADD COLUMN IF NOT EXISTS estimated_preparation_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS expected_ready_at TIMESTAMPTZ;
  `);
  console.log('✅ Added estimated_preparation_minutes and expected_ready_at to canonical_orders');
  process.exit(0);
}
migrate().catch(e => {
  console.error(e);
  process.exit(1);
});
