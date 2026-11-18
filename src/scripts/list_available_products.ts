import { pgPool } from '../config/postgres.js';

async function listProducts() {
  const res = await pgPool.query('SELECT id, name, is_active FROM menu_products LIMIT 10');
  console.log('Available menu_products in Postgres:');
  console.table(res.rows);
  process.exit(0);
}

listProducts().catch(console.error);
