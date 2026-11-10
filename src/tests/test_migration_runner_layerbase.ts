import dotenv from 'dotenv';
dotenv.config();

import { runMigrations } from '../migrations/runner.js';

async function test() {
  console.log('Running runMigrations() against Layerbase...');
  const result = await runMigrations();
  console.log('Migration Result:', result);
  process.exit(0);
}

test().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
