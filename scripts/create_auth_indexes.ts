import { pgPool } from '../src/config/postgres.js';

async function createAuthIndexes() {
  try {
    console.log('Creating optimized auth indexes in PostgreSQL...');
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_users_lower_email ON app_users (LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_app_users_status_active ON app_users (status, is_active);
      CREATE INDEX IF NOT EXISTS idx_delivery_partners_lower_email ON delivery_partners (LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_delivery_partners_phone ON delivery_partners (phone);
    `);
    console.log('✅ Auth indexes created successfully!');

    const res = await pgPool.query(`
      SELECT tablename, indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename IN ('app_users', 'delivery_partners')
      ORDER BY tablename, indexname;
    `);
    res.rows.forEach(r => console.log('  ', r.tablename, '->', r.indexname, ':', r.indexdef));

  } catch (err: any) {
    console.error('Error creating indexes:', err.message);
  } finally {
    await pgPool.end();
    process.exit(0);
  }
}
createAuthIndexes();
