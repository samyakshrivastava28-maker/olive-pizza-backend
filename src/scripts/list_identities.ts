import '../config/env.js';
import { query } from '../config/postgres.js';

async function list() {
  const cols = await query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'app_users'
  `);
  console.log('--- APP_USERS COLUMNS ---');
  console.log(cols.rows.map(r => r.column_name).join(', '));

  const users = await query(`
    SELECT id, email, role, branch_id, franchise_id, name 
    FROM app_users 
    WHERE role IN ('restaurant_manager', 'franchise_owner', 'delivery_partner', 'owner', 'admin')
    ORDER BY role, email
  `);
  console.log('--- APP_USERS ---');
  console.table(users.rows);

  const partners = await query(`
    SELECT id, name, email, phone, status, is_online, branch_id, franchise_id 
    FROM delivery_partners
    ORDER BY branch_id, id
  `);
  console.log('--- DELIVERY_PARTNERS ---');
  console.table(partners.rows);

  const branches = await query(`
    SELECT id, name, franchise_id, is_active, latitude, longitude 
    FROM restaurant_branches
    ORDER BY id
  `);
  console.log('--- BRANCHES ---');
  console.table(branches.rows);

  process.exit(0);
}

list().catch(err => {
  console.error(err);
  process.exit(1);
});
