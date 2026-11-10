import pool from '../lib/db.js';

async function migrate() {
  try {
    console.log("Migrating active_deliveries schema for Firestore IDs...");
    
    // Drop old table completely if it exists (since we don't care about old tracking data)
    await pool.query('DROP TABLE IF EXISTS deliveries CASCADE');
    await pool.query('DROP TABLE IF EXISTS active_deliveries CASCADE');

    const sql = `
      CREATE TABLE active_deliveries (
          order_id VARCHAR(255) PRIMARY KEY,
          delivery_partner_id VARCHAR(255),
          current_lat DECIMAL(10, 8) NOT NULL,
          current_lng DECIMAL(11, 8) NOT NULL,
          status VARCHAR(50) DEFAULT 'active',
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(sql);
    console.log("✅ Successfully created new active_deliveries table optimized for Hybrid Architecture");
  } catch (e) {
    console.error("Migration failed:", e);
  } finally {
    await pool.end();
  }
}

migrate();
