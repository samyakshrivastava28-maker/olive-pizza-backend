import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await client.connect();
    console.log('Connected to DB');
    await client.query(`
      CREATE TABLE IF NOT EXISTS checkout_locks (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          device_id VARCHAR(255) NOT NULL,
          locked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);
    console.log('checkout_locks table created!');
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}
migrate();
