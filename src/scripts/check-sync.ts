import pool from '../lib/db.js';

async function check() {
  try {
    const userId = 'fake_firebase_uid_123';
    const email = 'testuser123@example.com';
    const name = 'Test User';
    
    const sql = `
      INSERT INTO users (firebase_uid, email, name, role)
      VALUES ($1, $2, $3, 'customer')
      ON CONFLICT (firebase_uid) DO UPDATE 
      SET name = COALESCE(EXCLUDED.name, users.name),
          last_login = NOW()
      RETURNING *;
    `;
    const result = await pool.query(sql, [userId, email, name || '']);
    console.log("Insert result:", result.rows);
  } catch (err) {
    console.error("SQL Error in /sync:", err);
  } finally {
    await pool.end();
  }
}
check();
