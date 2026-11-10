import { runMigrations } from '../migrations/runner.js';
import { pgPool, DATABASE_ENV, checkPostgresHealth, query } from '../config/postgres.js';

async function main() {
  console.log('====================================================');
  console.log('🍕 Running Migrations on Database Environment: ' + DATABASE_ENV);
  console.log('====================================================\n');

  try {
    const health = await checkPostgresHealth();
    console.log('Connection health:', health);

    if (!health.connected) {
      throw new Error(`Database connection failed: ${health.error}`);
    }

    const result = await runMigrations(pgPool);
    console.log('\nMigration execution completed:');
    console.log('  Applied:', result.applied.length > 0 ? result.applied : 'None (Up to date)');
    console.log('  Skipped:', result.skipped);

    const tables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\nVerified tables in database:');
    tables.rows.forEach((r: any) => console.log('  - ' + r.table_name));

  } catch (err: any) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pgPool.end();
  }
}

main();
