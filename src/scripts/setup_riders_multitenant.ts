import '../config/env.js';
import { query, pgPool } from '../config/postgres.js';
import { adminAuth, adminDb } from '../config/firebase.js';

async function run() {
  console.log('--- Setting up Real Accounts for Multi-Franchise Delivery Verification ---');

  // 1. Rajnandgaon Rider: samyaks695@gmail.com
  // UID: Uln5UKsRyZaCzTePgBmfourQngu1
  await query(`
    INSERT INTO delivery_partners (
      id, name, phone, email, franchise_id, branch_id, vehicle_type, vehicle_number, is_online, status, current_lat, current_lng, last_location_time, active_order_id, user_id, updated_at
    ) VALUES (
      'dp_rjn_samyak_01', 'Samyak RJN Rider', '+919876543211', 'samyaks695@gmail.com',
      'fra_rajnandgaon', 'branch_rjn_main', 'motorcycle', 'CG-08-AB-1234',
      true, 'APPROVED', 21.0960, 81.0310, NOW(), NULL, 'Uln5UKsRyZaCzTePgBmfourQngu1', NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      is_online = true,
      status = 'APPROVED',
      active_order_id = NULL,
      current_lat = 21.0960,
      current_lng = 81.0310,
      last_location_time = NOW(),
      updated_at = NOW()
  `);

  await query(`
    INSERT INTO delivery_locations (
      delivery_partner_id, active_order_id, latitude, longitude, online_status, last_updated
    ) VALUES (
      'dp_rjn_samyak_01', NULL, 21.0960, 81.0310, true, NOW()
    )
    ON CONFLICT (delivery_partner_id) DO UPDATE SET
      active_order_id = NULL,
      latitude = 21.0960,
      longitude = 81.0310,
      online_status = true,
      last_updated = NOW()
  `);

  // 2. Bilaspur Rider: webhub2811@gmail.com
  // UID: 6tLLR6q7aTYqzTG2blRx3TU5sA42
  await query(`
    INSERT INTO delivery_partners (
      id, name, phone, email, franchise_id, branch_id, vehicle_type, vehicle_number, is_online, status, current_lat, current_lng, last_location_time, active_order_id, user_id, updated_at
    ) VALUES (
      'dp_bsp_webhub_01', 'Webhub Bilaspur Rider', '+919179944445', 'webhub2811@gmail.com',
      'fra_bilaspur', 'branch_bsp_main', 'motorcycle', 'CG-10-OP-1001',
      true, 'APPROVED', 22.0797, 82.1409, NOW(), NULL, '6tLLR6q7aTYqzTG2blRx3TU5sA42', NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      is_online = true,
      status = 'APPROVED',
      active_order_id = NULL,
      current_lat = 22.0797,
      current_lng = 82.1409,
      last_location_time = NOW(),
      updated_at = NOW()
  `);

  await query(`
    INSERT INTO delivery_locations (
      delivery_partner_id, active_order_id, latitude, longitude, online_status, last_updated
    ) VALUES (
      'dp_bsp_webhub_01', NULL, 22.0797, 82.1409, true, NOW()
    )
    ON CONFLICT (delivery_partner_id) DO UPDATE SET
      active_order_id = NULL,
      latitude = 22.0797,
      longitude = 82.1409,
      online_status = true,
      last_updated = NOW()
  `);

  // Verify in PostgreSQL
  const res = await query(`
    SELECT p.id, p.name, p.email, p.franchise_id, p.branch_id, p.is_online, p.status, p.active_order_id, l.latitude, l.longitude
    FROM delivery_partners p
    LEFT JOIN delivery_locations l ON l.delivery_partner_id = p.id
    WHERE p.id IN ('dp_rjn_samyak_01', 'dp_bsp_webhub_01')
  `);
  console.log('Verified active riders in PostgreSQL:');
  console.table(res.rows);

  await pgPool.end();
  console.log('Done!');
}

run().catch(console.error);
