import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import pkg from 'pg';
import fs from 'fs/promises';

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

async function runSchema() {
  try {
    const client = await pgPool.connect();
    console.log("Connected to database, executing schema.sql...");

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = await fs.readFile(schemaPath, 'utf8');

    await client.query(sql);
    console.log("Successfully executed schema.sql");

    client.release();
  } catch(e) {
    console.error("Error executing schema:", e);
  } finally {
    pgPool.end();
  }
}

runSchema();
