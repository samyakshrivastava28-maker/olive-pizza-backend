import '../config/env.js';
import { query } from '../config/postgres.js';

async function check() {
  const cols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'menu_products'");
  console.log('menu_products columns:', cols.rows.map(r => r.column_name).join(', '));
  const res = await query("SELECT * FROM menu_products WHERE id IN ('prod_margherita', 'prod_farmhouse')");
  console.log(JSON.stringify(res.rows, null, 2));
  process.exit(0);
}
check();
