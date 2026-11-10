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

async function setupTables() {
  try {
    const client = await pgPool.connect();
    
    console.log("Connected to database, setting up tables...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_queue (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          payload JSONB NOT NULL,
          status VARCHAR(50) DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'opened', 'action_performed', 'failed')),
          priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('normal', 'high', 'silent')),
          retry_count INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Created notification_queue table");

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_history (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(255),
          body TEXT,
          category VARCHAR(50),
          status VARCHAR(50) DEFAULT 'delivered',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Created notification_history table");

    client.release();
  } catch(e) {
    console.error("Error setting up tables:", e);
  } finally {
    pgPool.end();
  }
}

setupTables();
