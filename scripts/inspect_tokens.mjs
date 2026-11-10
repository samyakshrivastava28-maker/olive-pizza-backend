import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('.env') });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT * FROM orders WHERE id = 'ca7d5141-f537-4ce4-bd1f-23fd2fde0b11'
    `);
    console.log('Postgres order record:');
    console.log(res.rows[0]);

    const notifs = await client.query(`
      SELECT * FROM notification_inbox WHERE order_id = 'ca7d5141-f537-4ce4-bd1f-23fd2fde0b11'
    `);
    console.log('Notification inbox for this order:', notifs.rows);

    const q = await client.query(`
      SELECT * FROM notification_queue WHERE order_id = 'ca7d5141-f537-4ce4-bd1f-23fd2fde0b11'
    `);
    console.log('Notification queue for this order:', q.rows);

  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
