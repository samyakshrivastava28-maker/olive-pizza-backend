import { pgPool } from '../config/postgres.js';

async function migrate() {
  const client = await pgPool.connect();
  try {
    console.log('Adding JSONB columns to menu_items...');
    await client.query(`
      ALTER TABLE menu_items 
      ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS crusts JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS addons JSONB DEFAULT '[]'::jsonb;
    `);
    console.log('Migration successful!');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    client.release();
    process.exit(0);
  }
}

migrate();
