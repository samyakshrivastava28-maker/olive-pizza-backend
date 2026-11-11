import { query } from '../src/lib/db.js';

async function main() {
  try {
    const res = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('TABLES IN DB:');
    for (const r of res.rows) {
      console.log(' - ' + r.table_name);
    }
  } catch (err: any) {
    console.error('DB ERROR:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
