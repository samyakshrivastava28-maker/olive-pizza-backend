import '../config/env.js';
import { pgPool } from '../config/postgres.js';

async function run() {
  const r = await pgPool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'canonical_orders' ORDER BY ordinal_position");
  console.table(r.rows);
  await pgPool.end();
}
run();
