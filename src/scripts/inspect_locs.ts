import '../config/env.js';
import { query, pgPool } from '../config/postgres.js';

async function run() {
  const cols = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'delivery_locations'");
  console.log('DELIVERY_LOCATIONS COLS:', cols.rows);
  const locs = await query("SELECT * FROM delivery_locations");
  console.log('DELIVERY_LOCATIONS ROWS:', locs.rows);
  await pgPool.end();
}

run().catch(console.error);
