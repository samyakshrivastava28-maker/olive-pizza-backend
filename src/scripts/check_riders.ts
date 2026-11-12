import '../config/env.js';
import { pgPool } from '../config/postgres.js';

async function run() {
  const riders = await pgPool.query('SELECT * FROM delivery_partners');
  console.table(riders.rows);
  await pgPool.end();
}
run();
