import pool from '../lib/db.js';

async function clean() {
  try {
    const res = await pool.query('DELETE FROM users WHERE role != $1 RETURNING email', ['owner']);
    console.log("Deleted old test users:", res.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}
clean();
