import { pgPool } from '../src/config/postgres.js';

async function fixLifecycles() {
  try {
    const res = await pgPool.query(`
      UPDATE canonical_orders 
      SET live_lifecycle = 'TERMINAL', 
          delivered_at = COALESCE(delivered_at, updated_at, NOW())
      WHERE UPPER(order_status) IN ('DELIVERED', 'CANCELLED') 
        AND live_lifecycle = 'ACTIVE'
      RETURNING id, order_status, live_lifecycle;
    `);
    console.log(`Updated ${res.rowCount} orders to TERMINAL:`);
    res.rows.slice(0, 10).forEach(r => console.log('  ', r.id, r.order_status, r.live_lifecycle));

    const check = await pgPool.query("SELECT COUNT(*) FROM canonical_orders WHERE live_lifecycle = 'ACTIVE';");
    console.log('Remaining ACTIVE orders:', check.rows[0].count);

  } catch (err: any) {
    console.error('Error:', err.message);
  } finally {
    await pgPool.end();
    process.exit(0);
  }
}
fixLifecycles();
