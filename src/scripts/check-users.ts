import pool from '../lib/db.js';

async function check() {
  try {
    const res = await pool.query('SELECT firebase_uid, email, name, phone FROM users');
    console.log("Users in DB:", res.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}
check();
