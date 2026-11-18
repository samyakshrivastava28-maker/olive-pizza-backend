import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: 'C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runRemediation() {
  console.log('=== STARTING MILESTONE 1 ITERATION 2 DATABASE REMEDIATION ===');
  const client = await pool.connect();

  try {
    // 1. Audit before
    const preOrphans = await client.query(`
      SELECT count(*)::int as orphaned_rider_orders, array_agg(DISTINCT o.delivery_partner_id) as orphaned_riders
      FROM canonical_orders o
      LEFT JOIN delivery_partners dp ON o.delivery_partner_id = dp.id
      WHERE o.delivery_partner_id IS NOT NULL AND dp.id IS NULL;
    `);
    console.log('[PRE-AUDIT] Orphaned rider orders in canonical_orders:', preOrphans.rows[0]);

    const preBranches = await client.query(`
      SELECT id, name, delivery_settings FROM restaurant_branches;
    `);
    console.log('[PRE-AUDIT] Branches delivery settings:', preBranches.rows);

    await client.query('BEGIN');

    // 2. Fix orphaned orders in canonical_orders
    const updateOrdersRes = await client.query(`
      UPDATE canonical_orders 
      SET delivery_partner_id = 'dp_rjn_samyak_01', 
          delivery_partner_name = 'Samyak RJN Delivery Raider'
      WHERE delivery_partner_id IS NOT NULL 
        AND delivery_partner_id != 'dp_rjn_samyak_01'
      RETURNING id, delivery_partner_id, delivery_partner_name;
    `);
    console.log(`[UPDATE] Updated ${updateOrdersRes.rowCount} orders in canonical_orders to dp_rjn_samyak_01.`);

    // 3. Align main_branch delivery radius to 12 km
    const updateBranchRes = await client.query(`
      UPDATE restaurant_branches
      SET delivery_settings = jsonb_set(COALESCE(delivery_settings, '{}'::jsonb), '{radiusKm}', '12'::jsonb)
      WHERE id = 'main_branch'
      RETURNING id, name, delivery_settings;
    `);
    console.log(`[UPDATE] Updated main_branch delivery_settings:`, updateBranchRes.rows[0]);

    await client.query('COMMIT');

    // 4. Verification queries
    const postOrphans = await client.query(`
      SELECT count(*)::int as orphaned_rider_orders
      FROM canonical_orders o
      LEFT JOIN delivery_partners dp ON o.delivery_partner_id = dp.id
      WHERE o.delivery_partner_id IS NOT NULL AND dp.id IS NULL;
    `);
    console.log('[VERIFICATION] Orphaned rider orders count (must be 0):', postOrphans.rows[0].orphaned_rider_orders);

    const postBranches = await client.query(`
      SELECT id, franchise_id, name, delivery_settings, delivery_settings->>'radiusKm' as radius_km
      FROM restaurant_branches;
    `);
    console.log('[VERIFICATION] Restaurant branches delivery settings:');
    console.table(postBranches.rows);

    if (postOrphans.rows[0].orphaned_rider_orders !== 0) {
      throw new Error(`Integrity check failed: ${postOrphans.rows[0].orphaned_rider_orders} orphaned rider orders remaining!`);
    }

    console.log('=== DATABASE REMEDIATION COMPLETED SUCCESSFULLY ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ERROR] Remediation failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runRemediation();
