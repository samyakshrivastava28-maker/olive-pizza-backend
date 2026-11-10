import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

async function run() {
  const { pgPool } = await import('./src/config/postgres.js'); 
  await pgPool.query('ALTER TABLE email_queue ADD COLUMN IF NOT EXISTS max_retries INTEGER DEFAULT 3;');
  console.log('Added max_retries column');
  process.exit(0);
}
run().catch(console.error);
