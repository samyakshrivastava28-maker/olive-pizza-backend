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

async function runPostgresCleanup() {
  console.log('=== STARTING MILESTONE 1 POSTGRESQL CLEANUP ===');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Disassociate test riders from canonical orders
    const updateOrdersRes = await client.query(`
      UPDATE canonical_orders 
      SET delivery_partner_id = 'dp_rjn_samyak_01', 
          delivery_partner_name = 'Samyak RJN Delivery Raider'
      WHERE delivery_partner_id IN ('rider_01', 'rider_02', 'rider_bsp_01', 'dp_durg_ssamyak_01', 'dp_bsp_webhub_01')
      RETURNING id, delivery_partner_id;
    `);
    console.log(`[1] Reassigned canonical_orders away from test riders: ${updateOrdersRes.rowCount} rows`);

    // Also update any orders with non-rajnandgaon franchise/branch
    const updateOrderBranchRes = await client.query(`
      UPDATE canonical_orders 
      SET branch_id = 'branch_rjn_main', franchise_id = 'fra_rajnandgaon' 
      WHERE franchise_id != 'fra_rajnandgaon' OR branch_id NOT IN ('branch_rjn_main', 'main_branch')
      RETURNING id;
    `);
    console.log(`[1b] Reassigned canonical_orders branch to branch_rjn_main: ${updateOrderBranchRes.rowCount} rows`);

    // 2. Clear orphaned test dispatch queues
    const delDispatchRes = await client.query(`
      DELETE FROM pending_dispatch_queue 
      WHERE franchise_id != 'fra_rajnandgaon' 
         OR branch_id NOT IN ('branch_rjn_main', 'main_branch')
      RETURNING id;
    `);
    console.log(`[2] Cleared orphaned pending_dispatch_queue: ${delDispatchRes.rowCount} rows`);

    // 3. Clear orphaned test locations in delivery_locations
    const delLocRes = await client.query(`
      DELETE FROM delivery_locations 
      WHERE delivery_partner_id != 'dp_rjn_samyak_01'
      RETURNING id, delivery_partner_id;
    `);
    console.log(`[3] Cleared orphaned delivery_locations: ${delLocRes.rowCount} rows`);

    // 4. Purge test franchise prices
    const delPriceRes = await client.query(`
      DELETE FROM franchise_prices 
      WHERE franchise_id != 'fra_rajnandgaon' 
         OR branch_id NOT IN ('branch_rjn_main', 'main_branch')
      RETURNING id;
    `);
    console.log(`[4] Purged test franchise_prices: ${delPriceRes.rowCount} rows`);

    // 5. Purge test delivery partners (keep exclusively dp_rjn_samyak_01)
    const delDpRes = await client.query(`
      DELETE FROM delivery_partners 
      WHERE id != 'dp_rjn_samyak_01'
      RETURNING id, name;
    `);
    console.log(`[5] Purged test delivery_partners: ${delDpRes.rowCount} rows`);

    // 6. Purge test branches (keep exclusively branch_rjn_main and main_branch)
    const delBranchRes = await client.query(`
      DELETE FROM restaurant_branches 
      WHERE franchise_id != 'fra_rajnandgaon' 
         OR id NOT IN ('branch_rjn_main', 'main_branch')
      RETURNING id, name;
    `);
    console.log(`[6] Purged test restaurant_branches: ${delBranchRes.rowCount} rows`);

    // 7. Purge test franchises (keep exclusively fra_rajnandgaon)
    const delFranchiseRes = await client.query(`
      DELETE FROM franchises 
      WHERE id != 'fra_rajnandgaon'
      RETURNING id, name;
    `);
    console.log(`[7] Purged test franchises: ${delFranchiseRes.rowCount} rows`);

    // 8. Purge dummy staff app_users
    const delUsersRes = await client.query(`
      DELETE FROM app_users 
      WHERE email IN (
        'ssamyak265@gmail.com',
        'samyakssaamm@gmail.com',
        'rahul.rider@olivepizza.in',
        'amit.rider@olivepizza.in',
        'bsp.rider@olivepizza.in',
        'rider@olivepizza.in',
        'rider2@olivepizza.in',
        'manager.bsp@olivepizza.in',
        'owner.bsp@olivepizza.in',
        'cashier@olivepizza.in'
      )
      RETURNING id, email, role;
    `);
    console.log(`[8] Purged dummy staff app_users: ${delUsersRes.rowCount} rows`);

    // 9. Correct Customer account in app_users
    const updateCustomerRes = await client.query(`
      UPDATE app_users 
      SET franchise_id = 'fra_rajnandgaon',
          branch_id = 'branch_rjn_main',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{location}',
            '{"lat": 21.0974, "lng": 81.0347}'::jsonb
          ),
          default_address = 'Station Road, Rajnandgaon, Chhattisgarh 491441'
      WHERE email = 's.callhub2811@gmail.com'
      RETURNING id, email, franchise_id, branch_id;
    `);
    console.log(`[9] Updated Customer s.callhub2811@gmail.com in app_users: ${updateCustomerRes.rowCount} rows`);

    // 10. Align Master Owner account
    const updateOwnerRes = await client.query(`
      UPDATE app_users 
      SET franchise_id = 'fra_rajnandgaon',
          branch_id = 'all',
          role = 'owner',
          allowed_apps = '["OWNER", "FRANCHISE_MANAGER", "RESTAURANT_MANAGER", "POS", "DELIVERY", "CUSTOMER"]'::jsonb
      WHERE email = 'olivepizzarjn@gmail.com'
      RETURNING id, email, franchise_id, branch_id;
    `);
    console.log(`[10] Updated Master Owner olivepizzarjn@gmail.com in app_users: ${updateOwnerRes.rowCount} rows`);

    // 11. Align webhub2811@gmail.com account
    const updateWebhubRes = await client.query(`
      UPDATE app_users 
      SET franchise_id = 'fra_rajnandgaon',
          branch_id = 'all',
          role = 'platform_owner',
          allowed_apps = '["OWNER", "FRANCHISE_MANAGER", "RESTAURANT_MANAGER", "POS", "DELIVERY", "CUSTOMER"]'::jsonb
      WHERE email = 'webhub2811@gmail.com'
      RETURNING id, email, franchise_id, branch_id;
    `);
    console.log(`[11] Updated webhub2811@gmail.com in app_users: ${updateWebhubRes.rowCount} rows`);

    await client.query('COMMIT');
    console.log('✅ TRANSACTION COMMITTED SUCCESSFULLY');

    // Run verification queries
    console.log('\n--- VERIFICATION AUDIT ---');
    const fRes = await client.query('SELECT id, name, status FROM franchises');
    console.log('Active Franchises in PG:', fRes.rows);

    const bRes = await client.query('SELECT id, franchise_id, name, latitude, longitude, delivery_settings, is_open FROM restaurant_branches');
    console.log('Active Branches in PG:', bRes.rows);

    const dpRes = await client.query('SELECT id, franchise_id, branch_id, name, email, status FROM delivery_partners');
    console.log('Active Delivery Partners in PG:', dpRes.rows);

    const uRes = await client.query('SELECT id, email, role, franchise_id, branch_id FROM app_users ORDER BY role');
    console.log('Active App Users in PG:', uRes.rows);

    const testLocCount = await client.query('SELECT count(*) FROM delivery_locations WHERE delivery_partner_id != \'dp_rjn_samyak_01\'');
    const testQueueCount = await client.query('SELECT count(*) FROM pending_dispatch_queue WHERE franchise_id != \'fra_rajnandgaon\'');
    const testPricesCount = await client.query('SELECT count(*) FROM franchise_prices WHERE franchise_id != \'fra_rajnandgaon\'');

    console.log('Remaining Test Artifacts Audit:');
    console.log({
      testDeliveryLocations: testLocCount.rows[0].count,
      testPendingDispatchQueue: testQueueCount.rows[0].count,
      testFranchisePrices: testPricesCount.rows[0].count
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ TRANSACTION ROLLED BACK DUE TO ERROR:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runPostgresCleanup().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
