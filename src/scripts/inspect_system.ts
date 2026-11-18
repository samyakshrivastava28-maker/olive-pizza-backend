import '../config/env.js';
import { pgPool } from '../config/postgres.js';

async function run() {
  const users = await pgPool.query('SELECT id, email, role, phone, name FROM app_users');
  console.log('APP USERS:', users.rows);
  const branches = await pgPool.query('SELECT id, name, franchise_id, latitude, longitude FROM restaurant_branches');
  console.log('BRANCHES:', branches.rows);
  const partners = await pgPool.query('SELECT id, name, email, franchise_id, branch_id, is_online, status, user_id FROM delivery_partners');
  console.log('PARTNERS:', partners.rows);
  await pgPool.end();
}

run().catch(console.error);
