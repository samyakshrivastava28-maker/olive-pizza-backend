import { pgPool } from '../config/postgres.js';

async function main() {
  try {
    const res = await pgPool.query(
      `SELECT id, branch_id, franchise_id, order_status, total_amount, delivery_partner_id, delivery_partner_name, created_at 
       FROM canonical_orders 
       ORDER BY created_at DESC LIMIT 3`
    );
    console.table(res.rows);
  } finally {
    await pgPool.end();
  }
}

main();
