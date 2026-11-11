import '../config/env.js';
import { query } from '../config/postgres.js';

async function seedAppUsers() {
  const usersToSeed = [
    {
      id: 'usr_e2e_cust_01',
      firebase_uid: 'usr_e2e_cust_01',
      email: 'test.customer@olivepizza.in',
      name: 'Aarav Sharma',
      phone: '9826199887',
      role: 'customer',
      status: 'APPROVED',
      branch_id: 'main_branch',
      franchise_id: 'fra_rajnandgaon',
      allowed_apps: ['CUSTOMER']
    },
    {
      id: 'usr_mgr_rjn',
      firebase_uid: 'usr_mgr_rjn',
      email: 'manager.rjn@olivepizza.in',
      name: 'Rajnandgaon Branch Manager',
      phone: '9826111222',
      role: 'restaurant_manager',
      status: 'APPROVED',
      branch_id: 'main_branch',
      franchise_id: 'fra_rajnandgaon',
      allowed_apps: ['RESTAURANT_MANAGER', 'POS']
    },
    {
      id: 'usr_mgr_bsp',
      firebase_uid: 'usr_mgr_bsp',
      email: 'manager.bsp@olivepizza.in',
      name: 'Bilaspur Branch Manager',
      phone: '9826333444',
      role: 'restaurant_manager',
      status: 'APPROVED',
      branch_id: 'branch_bsp_main',
      franchise_id: 'fra_bilaspur',
      allowed_apps: ['RESTAURANT_MANAGER', 'POS']
    },
    {
      id: 'usr_fra_bsp',
      firebase_uid: 'usr_fra_bsp',
      email: 'owner.bsp@olivepizza.in',
      name: 'Bilaspur Franchise Owner',
      phone: '9826555666',
      role: 'franchise_owner',
      status: 'APPROVED',
      branch_id: 'branch_bsp_main',
      franchise_id: 'fra_bilaspur',
      allowed_apps: ['FRANCHISE_MANAGER']
    },
    {
      id: 'rider_01',
      firebase_uid: 'rider_01',
      email: 'rahul.rider@olivepizza.in',
      name: 'Rahul Sharma',
      phone: '+91 98271 22334',
      role: 'delivery_partner',
      status: 'APPROVED',
      branch_id: 'main_branch',
      franchise_id: 'fra_rajnandgaon',
      allowed_apps: ['DELIVERY']
    },
    {
      id: 'rider_02',
      firebase_uid: 'rider_02',
      email: 'amit.rider@olivepizza.in',
      name: 'Amit Verma',
      phone: '+91 98272 55667',
      role: 'delivery_partner',
      status: 'APPROVED',
      branch_id: 'main_branch',
      franchise_id: 'fra_rajnandgaon',
      allowed_apps: ['DELIVERY']
    },
    {
      id: 'rider_bsp_01',
      firebase_uid: 'rider_bsp_01',
      email: 'bsp.rider@olivepizza.in',
      name: 'Bilaspur Fast Rider',
      phone: '+91 98274 11223',
      role: 'delivery_partner',
      status: 'APPROVED',
      branch_id: 'branch_bsp_main',
      franchise_id: 'fra_bilaspur',
      allowed_apps: ['DELIVERY']
    }
  ];

  for (const u of usersToSeed) {
    await query(`
      INSERT INTO app_users (id, firebase_uid, email, name, phone, role, status, branch_id, franchise_id, allowed_apps, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, true, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        firebase_uid = EXCLUDED.firebase_uid,
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        branch_id = EXCLUDED.branch_id,
        franchise_id = EXCLUDED.franchise_id,
        allowed_apps = EXCLUDED.allowed_apps,
        is_active = true,
        updated_at = NOW();
    `, [u.id, u.firebase_uid, u.email, u.name, u.phone, u.role, u.status, u.branch_id, u.franchise_id, JSON.stringify(u.allowed_apps)]);
    console.log(`Upserted app_user: ${u.email} (${u.role})`);
  }

  process.exit(0);
}

seedAppUsers().catch(err => {
  console.error('Failed seeding app users:', err);
  process.exit(1);
});
