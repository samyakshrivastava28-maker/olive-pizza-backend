import { pgPool } from './src/config/postgres.js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

async function runMigration() {
  console.log('Starting Email System Migration...');

  try {
    const client = await pgPool.connect();
    
    // 1. email_campaigns
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          subject VARCHAR(255) NOT NULL,
          html_content TEXT NOT NULL,
          sent_count INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created email_campaigns table.');

    // 2. email_queue
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_queue (
          id SERIAL PRIMARY KEY,
          recipient VARCHAR(255) NOT NULL,
          subject VARCHAR(255) NOT NULL,
          html_content TEXT NOT NULL,
          type VARCHAR(50) DEFAULT 'transactional',
          campaign_id INTEGER REFERENCES email_campaigns(id),
          status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          retry_timestamp TIMESTAMP WITH TIME ZONE,
          idempotency_key VARCHAR(255) UNIQUE,
          last_error TEXT,
          smtp_response TEXT,
          sent_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created email_queue table.');

    // 3. dead_letter_queue
    await client.query(`
      CREATE TABLE IF NOT EXISTS dead_letter_queue (
          id SERIAL PRIMARY KEY,
          original_queue_id INTEGER,
          recipient VARCHAR(255) NOT NULL,
          subject VARCHAR(255) NOT NULL,
          payload TEXT,
          final_error TEXT,
          failed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Created dead_letter_queue table.');

    client.release();
    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
