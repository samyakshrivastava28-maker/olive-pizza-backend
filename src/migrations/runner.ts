import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(customPool?: any): Promise<{ applied: string[]; skipped: string[] }> {
  let dbUrl = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    const databaseEnv = process.env.DATABASE_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
    dbUrl = databaseEnv === 'render-test' 
      ? (process.env.RENDER_POSTGRES_URL || process.env.DATABASE_URL)
      : (process.env.DATABASE_URL || process.env.RENDER_POSTGRES_URL);
  }

  if (dbUrl && dbUrl.includes('.supabase.co')) {
    dbUrl = dbUrl.replace('db.tdjrkqmhdynbaciguyvr.supabase.co:5432', 'aws-1-ap-south-1.pooler.supabase.com:6543');
    if (!dbUrl.includes('pgbouncer=true')) {
      dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'pgbouncer=true';
    }
  }

  const isLocal = Boolean(
    dbUrl?.includes('localhost') || 
    dbUrl?.includes('127.0.0.1') || 
    process.env.PG_SSL === 'false' ||
    process.env.NODE_ENV === 'test'
  );

  const pool = customPool || new Pool({
    connectionString: dbUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // 1. Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64)
      );
    `);

    // 2. Discover and strictly validate all .sql files in migrations directory
    const rawFiles = fs.readdirSync(__dirname)
      .filter(f => f.endsWith('.sql'));

    // Strict naming convention validation (e.g., 001_initial_schema.sql)
    const filenamePattern = /^(\d{3})_[a-z0-9_]+\.sql$/;
    for (const file of rawFiles) {
      if (!filenamePattern.test(file)) {
        throw new Error(`[Migrations] Invalid migration filename format: "${file}". Must follow strict pattern: 000_description.sql`);
      }
    }

    // Deterministic numeric ordering
    const files = rawFiles.sort((a, b) => parseInt(a.split('_')[0], 10) - parseInt(b.split('_')[0], 10));

    // Strict duplicate version check (fail-closed)
    const versionMap = new Map<string, string>();
    for (const file of files) {
      const version = file.split('_')[0];
      if (versionMap.has(version)) {
        throw new Error(`[Migrations] Duplicate migration version detected: Version "${version}" is claimed by both "${versionMap.get(version)}" and "${file}". Aborting fail-closed.`);
      }
      versionMap.set(version, file);
    }

    for (const file of files) {
      const version = file.split('_')[0];
      const checkRes = await client.query('SELECT version, checksum FROM schema_migrations WHERE version = $1', [version]);

      if (checkRes.rows.length > 0) {
        const sqlContent = fs.readFileSync(path.join(__dirname, file), 'utf8');
        const normalizedContent = sqlContent.replace(/\r\n/g, '\n');
        const currentChecksum = crypto.createHash('sha256').update(normalizedContent, 'utf8').digest('hex');
        const rawChecksum = crypto.createHash('sha256').update(sqlContent, 'utf8').digest('hex');
        const recordedChecksum = checkRes.rows[0].checksum;

        if (recordedChecksum && recordedChecksum !== currentChecksum && recordedChecksum !== rawChecksum) {
          throw new Error(`[Migrations] Checksum mismatch for already-applied migration "${file}". Expected ${recordedChecksum}, but file on disk has ${currentChecksum}. Migration history has been altered! Aborting fail-closed.`);
        }
        if (!recordedChecksum) {
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [currentChecksum, version]);
        }
        skipped.push(file);
        continue;
      }

      console.log(`[Migrations] Applying ${file}...`);
      const sqlContent = fs.readFileSync(path.join(__dirname, file), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sqlContent);
        const checksum = crypto.createHash('sha256').update(sqlContent, 'utf8').digest('hex');
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [version, file, checksum]
        );
        await client.query('COMMIT');
        applied.push(file);
        console.log(`[Migrations] ✅ Successfully applied ${file}`);
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`[Migrations] ❌ Failed to apply ${file}:`, err.message);
        throw err;
      }
    }
  } finally {
    client.release();
    if (!customPool) {
      await pool.end();
    }
  }

  return { applied, skipped };
}

if (process.argv[1] && (process.argv[1].endsWith('runner.ts') || process.argv[1].endsWith('runner.js'))) {
  runMigrations()
    .then((res) => {
      console.log(`[Migrations CLI] Completed. Applied: ${res.applied.length}, Skipped: ${res.skipped.length}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migrations CLI] Migration failed:', err);
      process.exit(1);
    });
}
