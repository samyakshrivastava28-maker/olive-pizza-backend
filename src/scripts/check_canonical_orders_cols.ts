import '../config/env.js';
import { query } from '../config/postgres.js';

async function check() {
  const cols = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'canonical_orders' ORDER BY column_name");
  console.log(cols.rows.map(r => `${r.column_name} (${r.data_type})`).join('\n'));
  process.exit(0);
}
check();
