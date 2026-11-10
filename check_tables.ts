import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import { pgPool } from './src/config/postgres.js';

async function checkTables() {
  try {
    const res = await pgPool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('notification_queue', 'notification_history');
    `);
    console.log("Found tables:", res.rows.map(r => r.table_name));
  } catch(e) {
    console.error(e);
  } finally {
    pgPool.end();
  }
}

checkTables();
