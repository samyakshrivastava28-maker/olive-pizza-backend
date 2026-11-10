import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDb() {
  console.log('Initializing PostgreSQL database...');
  try {
    const schemaPath = path.join(__dirname, '../../schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    await pool.query(schemaSql);
    console.log('✅ Database initialized successfully with schema.sql');
    
  } catch (err) {
    console.error('🔥 Error initializing database:', err);
  } finally {
    await pool.end();
  }
}

initDb();
