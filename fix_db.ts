import { pgPool } from './src/config/postgres.js';

async function main() {
  const client = await pgPool.connect();
  try {
    await client.query('ALTER TABLE notification_queue ALTER COLUMN order_id TYPE VARCHAR(100);');
    await client.query('ALTER TABLE notification_history ALTER COLUMN order_id TYPE VARCHAR(100);');
    await client.query('ALTER TABLE notification_inbox ALTER COLUMN order_id TYPE VARCHAR(100);');
    
    // First we might need to drop any foreign keys if order_locks has them
    await client.query('ALTER TABLE order_locks DROP CONSTRAINT IF EXISTS order_locks_pkey CASCADE;');
    await client.query('ALTER TABLE order_locks ALTER COLUMN order_id TYPE VARCHAR(100);');
    await client.query('ALTER TABLE order_locks ADD PRIMARY KEY (order_id);');

    console.log('Successfully altered tables');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    client.release();
    process.exit(0);
  }
}
main();
