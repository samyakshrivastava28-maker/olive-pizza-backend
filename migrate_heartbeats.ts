import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import pkg from 'pg';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

let dbUrl = process.env.DATABASE_URL;

if (dbUrl && dbUrl.includes('.supabase.co')) {
  dbUrl = dbUrl.replace('db.tdjrkqmhdynbaciguyvr.supabase.co:5432', 'aws-1-ap-south-1.pooler.supabase.com:6543');
  if (!dbUrl.includes('pgbouncer=true')) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'pgbouncer=true';
  }
}

const pgPool = new Pool({
  connectionString: dbUrl,
  connectionTimeoutMillis: 10000,
});

async function migrate() {
  try {
    const client = await pgPool.connect();
    console.log("Connected, adding columns...");

    await client.query(`
      ALTER TABLE device_heartbeats 
      ADD COLUMN IF NOT EXISTS battery_level DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS connection_quality VARCHAR(50);
    `);
    console.log("Columns added successfully");

    client.release();
  } catch(e) {
    console.error("Migration error:", e);
  } finally {
    pgPool.end();
  }
}

migrate();
