import { pgPool } from '../config/postgres.js';
import { RiderDispatchEngine } from '../services/delivery/RiderDispatchEngine.js';

async function main() {
  console.log('--- Updating Durg Rider online and timestamp ---');
  await pgPool.query(`
    UPDATE delivery_partners
    SET is_online = true,
        status = 'APPROVED',
        active_order_id = NULL,
        updated_at = NOW(),
        last_location_time = NOW(),
        current_lat = 21.1904,
        current_lng = 81.2849
    WHERE id = 'dp_durg_ssamyak_01'
  `);
  console.log('✅ Rider dp_durg_ssamyak_01 updated.');

  console.log('--- Finding eligible riders for order 88239891 ---');
  const riders = await RiderDispatchEngine.findEligibleRiders('88239891-14cd-4910-af3d-a7e74abe52f0');
  console.log('Eligible riders:', riders);

  console.log('--- Dispatching Rider ---');
  const result = await RiderDispatchEngine.autoDispatchRider('88239891-14cd-4910-af3d-a7e74abe52f0');
  console.log('Dispatch result:', result);

  const orderCheck = await pgPool.query(`SELECT id, order_status, delivery_partner_id, delivery_partner_name, partner_assigned_at FROM canonical_orders WHERE id = '88239891-14cd-4910-af3d-a7e74abe52f0'`);
  console.log('Canonical order state:', orderCheck.rows[0]);

  process.exit(0);
}

main().catch(err => {
  console.error('Dispatch error:', err);
  process.exit(1);
});
