import '../src/config/validator.js';
import { query } from '../src/config/postgres.js';

async function main() {
  try {
    for (const t of ['canonical_bills', 'canonical_order_items', 'canonical_orders', 'pos_shifts', 'restaurant_branches']) {
      const cols = await query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = $1
        ORDER BY ordinal_position;
      `, [t]);
      console.log(`\n=== Table: ${t} ===`);
      console.log(cols.rows.map(c => `${c.column_name} (${c.data_type})`).join(', '));
    }
  } catch (err: any) {
    console.error('Schema check error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
