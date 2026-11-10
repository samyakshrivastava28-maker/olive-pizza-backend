import { pgPool } from '../src/config/postgres.js';

async function seedAppUsers() {
  try {
    console.log('Seeding / syncing canonical app users in PostgreSQL...');

    // 1. Owner master accounts
    await pgPool.query(`
      INSERT INTO app_users (id, email, name, role, status, is_active, franchise_id, branch_id, allowed_apps)
      VALUES 
        ('admin_webhub', 'webhub2811@gmail.com', 'Platform Owner', 'owner', 'APPROVED', true, 'fra_primary', 'main_branch', '["OWNER", "RESTAURANT_MANAGER", "DELIVERY", "POS", "FRANCHISE_MANAGER", "CUSTOMER"]'::jsonb),
        ('admin_olive', 'olivepizzarjn@gmail.com', 'Restaurant Owner', 'owner', 'APPROVED', true, 'fra_primary', 'main_branch', '["OWNER", "RESTAURANT_MANAGER", "DELIVERY", "POS", "FRANCHISE_MANAGER", "CUSTOMER"]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        allowed_apps = EXCLUDED.allowed_apps;
    `);

    // 2. Manager account
    await pgPool.query(`
      INSERT INTO app_users (id, email, name, role, status, is_active, franchise_id, branch_id, allowed_apps)
      VALUES 
        ('staff_manager_01', 'manager@olivepizza.in', 'Branch Manager', 'restaurant_manager', 'APPROVED', true, 'fra_primary', 'main_branch', '["RESTAURANT_MANAGER"]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        allowed_apps = EXCLUDED.allowed_apps;
    `);

    // 3. Cashier account
    await pgPool.query(`
      INSERT INTO app_users (id, email, name, role, status, is_active, franchise_id, branch_id, allowed_apps)
      VALUES 
        ('staff_cashier_01', 'cashier@olivepizza.in', 'Counter Cashier', 'cashier', 'APPROVED', true, 'fra_primary', 'main_branch', '["POS"]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        allowed_apps = EXCLUDED.allowed_apps;
    `);

    // 4. Delivery rider account in app_users and delivery_partners
    await pgPool.query(`
      INSERT INTO app_users (id, email, phone, name, role, status, is_active, franchise_id, branch_id, allowed_apps)
      VALUES 
        ('staff_rider_01', 'rider@olivepizza.in', '+919827122334', 'Rahul Sharma (Rider)', 'delivery_partner', 'APPROVED', true, 'fra_primary', 'main_branch', '["DELIVERY"]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        allowed_apps = EXCLUDED.allowed_apps;

      INSERT INTO delivery_partners (id, name, phone, email, franchise_id, branch_id, vehicle_type, vehicle_number, is_online, status)
      VALUES 
        ('rider_01', 'Rahul Sharma', '+91 98271 22334', 'rider@olivepizza.in', 'fra_primary', 'main_branch', 'Motorcycle', 'CG 08 AB 1234', true, 'APPROVED')
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        status = EXCLUDED.status,
        is_online = EXCLUDED.is_online;
    `);

    // 5. Customer account
    await pgPool.query(`
      INSERT INTO app_users (id, email, phone, name, role, status, is_active, franchise_id, branch_id, allowed_apps)
      VALUES 
        ('cust_default_01', 'customer@gmail.com', '+919179944445', 'Gourmet Customer', 'customer', 'APPROVED', true, 'fra_primary', 'main_branch', '["CUSTOMER"]'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        role = EXCLUDED.role,
        status = EXCLUDED.status,
        is_active = EXCLUDED.is_active,
        allowed_apps = EXCLUDED.allowed_apps;
    `);

    console.log('✅ Canonical staff and client app users seeded and verified in PostgreSQL!');

    const res = await pgPool.query("SELECT id, email, role, status, is_active, allowed_apps FROM app_users WHERE role != 'customer' OR email = 'customer@gmail.com';");
    res.rows.forEach(r => console.log('  ', r));

  } catch (err: any) {
    console.error('Error seeding users:', err.message);
  } finally {
    await pgPool.end();
    process.exit(0);
  }
}
seedAppUsers();
