import '../src/config/validator.js';
import { query } from '../src/config/postgres.js';

async function main() {
  try {
    const users = await query(`
      SELECT id, email, role, allowed_apps, is_active, branch_id, franchise_id 
      FROM app_users 
      ORDER BY id
    `);
    console.log('\n=== APP USERS in PostgreSQL ===');
    console.table(users.rows);

    const fraPrices = await query(`
      SELECT * FROM franchise_prices LIMIT 10
    `);
    console.log('\n=== FRANCHISE PRICES in PostgreSQL ===');
    console.table(fraPrices.rows);
  } catch (err: any) {
    console.error('Inspect error:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
