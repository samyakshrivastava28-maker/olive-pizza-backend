import '../src/config/validator.js';
import { query } from '../src/config/postgres.js';

async function main() {
  try {
    const tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('--- ALL PUBLIC TABLES ---');
    console.log(tables.rows.map(r => r.table_name));

    // Look specifically for pos, price, product, catalog, inventory, shift, bill tables
    for (const t of ['app_users', 'products', 'franchises', 'branches', 'franchise_products', 'franchise_prices', 'orders', 'order_items', 'bills', 'shifts', 'inventory_items', 'recipes', 'cash_drawers']) {
      try {
        const cols = await query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_name = $1
          ORDER BY ordinal_position;
        `, [t]);
        if (cols.rows.length > 0) {
          console.log(`\n=== Table: ${t} ===`);
          console.log(cols.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));
        }
      } catch (e: any) {
        console.log(`Table ${t} check failed: ${e.message}`);
      }
    }
  } catch (err: any) {
    console.error('Database discovery error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
