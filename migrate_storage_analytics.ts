import { pgPool } from './src/config/postgres.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

async function runMigration() {
  console.log('Starting Storage Analytics Migration...');

  try {
    const client = await pgPool.connect();
    
    // 1. storage_analytics (High frequency, retained for 24h)
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_analytics (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(50) NOT NULL,
          used_bytes BIGINT NOT NULL,
          capacity_bytes BIGINT,
          health_status VARCHAR(20),
          latency_ms INTEGER,
          timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created storage_analytics table.');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_storage_analytics_provider_timestamp 
      ON storage_analytics(provider, timestamp);
    `);
    console.log('Created index on storage_analytics.');

    // 2. storage_analytics_daily (Aggregated long-term)
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_analytics_daily (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(50) NOT NULL,
          used_bytes_avg BIGINT NOT NULL,
          capacity_bytes_avg BIGINT,
          date DATE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(provider, date)
      );
    `);
    console.log('Created storage_analytics_daily table.');

    client.release();
    console.log('Migration completed successfully!');
  } catch (error) {
    console.error('Error running migration:', error);
  } finally {
    process.exit(0);
  }
}

runMigration();
