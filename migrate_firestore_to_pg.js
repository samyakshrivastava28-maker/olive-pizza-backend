import pg from 'pg';
import dotenv from 'dotenv';
import { adminDb } from './src/config/firebase.js';

dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.RENDER_POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrateData() {
  console.log('--- STARTING RELATIONAL BACKFILL FROM FIRESTORE TO RENDER POSTGRESQL ---');

  // 1. Migrate Users & Customers
  try {
    console.log('[1/3] Migrating users and customers...');
    const usersSnap = await adminDb.collection('users').get();
    console.log(`Found ${usersSnap.size} user docs in Firestore.`);
    let userCount = 0;

    for (const doc of usersSnap.docs) {
      const u = doc.data();
      const uid = doc.id;
      const email = (u.email || '').toLowerCase().trim();
      const phone = u.phone || u.phoneNumber || '';
      const name = u.name || u.displayName || 'Customer';
      const role = u.role || 'customer';
      const status = u.status || 'APPROVED';
      const isActive = u.isActive !== false;
      const franchiseId = u.franchiseId || null;
      const branchId = u.branchId || null;
      const allowedApps = JSON.stringify(u.allowedApps || []);
      const totalOrders = Number(u.totalOrders) || 0;
      const totalSpent = Number(u.totalSpent) || 0;
      const defaultAddress = typeof u.address === 'string' ? u.address : (u.address?.fullAddress || u.defaultAddress || null);
      const metadata = JSON.stringify(u);

      await pool.query(`
        INSERT INTO app_users (
          id, email, phone, name, role, status, is_active,
          franchise_id, branch_id, allowed_apps, total_orders, total_spent,
          default_address, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10::jsonb, $11, $12,
          $13, $14::jsonb, COALESCE($15::timestamptz, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
        )
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          is_active = EXCLUDED.is_active,
          franchise_id = EXCLUDED.franchise_id,
          branch_id = EXCLUDED.branch_id,
          allowed_apps = EXCLUDED.allowed_apps,
          default_address = EXCLUDED.default_address,
          metadata = EXCLUDED.metadata,
          updated_at = CURRENT_TIMESTAMP;
      `, [
        uid, email, phone, name, role, status, isActive,
        franchiseId, branchId, allowedApps, totalOrders, totalSpent,
        defaultAddress, metadata, u.createdAt || null
      ]);
      userCount++;
    }
    console.log(`✅ Upserted ${userCount} users into app_users table.`);
  } catch (err) {
    console.warn('Users migration warning:', err.message);
  }

  // 2. Migrate Restaurant Branches & Settings
  try {
    console.log('[2/3] Migrating restaurant branches & settings...');
    // Seed default HQ / Rajnandgaon branch if empty
    const settingsSnap = await adminDb.collection('restaurant_settings').get().catch(() => ({ docs: [] }));
    const branches = new Map();

    branches.set('main_branch', {
      id: 'main_branch',
      franchise_id: 'fra_primary',
      name: 'Olive Pizza — Rajnandgaon (HQ)',
      address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
      phone: '+91 91799 44445',
      is_open: true,
      accepting_orders: true,
      current_prep_time: 25,
      close_reason: ''
    });

    for (const doc of settingsSnap.docs) {
      const s = doc.data();
      const bId = doc.id;
      branches.set(bId, {
        id: bId,
        franchise_id: s.franchiseId || 'fra_primary',
        name: s.restaurantName || s.name || `Olive Pizza ${bId}`,
        address: s.address || 'Rajnandgaon, Chhattisgarh',
        phone: s.phone || '+91 91799 44445',
        is_open: s.isOpen !== false,
        accepting_orders: s.acceptingOrders !== false,
        current_prep_time: Number(s.currentPrepTime) || 25,
        close_reason: s.closeReason || '',
        operating_hours: JSON.stringify(s.operatingHours || {}),
        delivery_settings: JSON.stringify(s.deliverySettings || {}),
        tax_settings: JSON.stringify(s.taxAndCharges || {}),
        payment_settings: JSON.stringify(s.paymentSettings || {})
      });
    }

    // Also check franchises / branches collection
    const franSnap = await adminDb.collection('franchises').get().catch(() => ({ docs: [] }));
    for (const doc of franSnap.docs) {
      const f = doc.data();
      const bId = doc.id;
      if (!branches.has(bId)) {
        branches.set(bId, {
          id: bId,
          franchise_id: f.franchiseId || bId,
          name: f.name || f.restaurantName || `Olive Pizza ${bId}`,
          address: f.address || '',
          phone: f.phone || '',
          is_open: f.isOpen !== false,
          accepting_orders: f.acceptingOrders !== false,
          current_prep_time: Number(f.currentPrepTime) || 25,
          close_reason: f.closeReason || ''
        });
      }
    }

    for (const [bId, b] of branches.entries()) {
      await pool.query(`
        INSERT INTO restaurant_branches (
          id, franchise_id, name, address, phone, is_open, accepting_orders,
          current_prep_time, close_reason, operating_hours, delivery_settings,
          tax_settings, payment_settings, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, COALESCE($10::jsonb, '{}'::jsonb), COALESCE($11::jsonb, '{}'::jsonb),
          COALESCE($12::jsonb, '{}'::jsonb), COALESCE($13::jsonb, '{}'::jsonb), CURRENT_TIMESTAMP
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          address = EXCLUDED.address,
          phone = EXCLUDED.phone,
          is_open = EXCLUDED.is_open,
          accepting_orders = EXCLUDED.accepting_orders,
          current_prep_time = EXCLUDED.current_prep_time,
          close_reason = EXCLUDED.close_reason,
          updated_at = CURRENT_TIMESTAMP;
      `, [
        bId, b.franchise_id, b.name, b.address, b.phone, b.is_open, b.accepting_orders,
        b.current_prep_time, b.close_reason, b.operating_hours || null, b.delivery_settings || null,
        b.tax_settings || null, b.payment_settings || null
      ]);
    }
    console.log(`✅ Upserted ${branches.size} restaurant branches into restaurant_branches table.`);
  } catch (err) {
    console.warn('Restaurant branches migration warning:', err.message);
  }

  // 3. Migrate Delivery Partners / Riders
  try {
    console.log('[3/3] Migrating delivery partners / riders...');
    const delSnap = await adminDb.collection('delivery_partners').get().catch(() => ({ docs: [] }));
    let riderCount = 0;

    for (const doc of delSnap.docs) {
      const d = doc.data();
      const uid = doc.id;
      const name = d.name || 'Delivery Partner';
      const phone = d.phone || d.phoneNumber || '';
      const email = d.email || '';
      const franchiseId = d.franchiseId || 'fra_primary';
      const branchId = d.branchId || 'main_branch';
      const vehicleType = d.vehicleType || 'Motorcycle';
      const vehicleNumber = d.vehicleNumber || d.vehiclePlate || '';
      const isOnline = d.isOnline === true;
      const status = d.status || 'APPROVED';
      const lat = d.currentLat || d.latitude || (d.location?.latitude) || null;
      const lng = d.currentLng || d.longitude || (d.location?.longitude) || null;
      const activeOrderId = d.activeOrderId || null;
      const totalDeliveries = Number(d.totalDeliveries) || 0;
      const metadata = JSON.stringify(d);

      await pool.query(`
        INSERT INTO delivery_partners (
          id, name, phone, email, franchise_id, branch_id,
          vehicle_type, vehicle_number, is_online, status,
          current_lat, current_lng, active_order_id, total_deliveries, metadata, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14, $15::jsonb, CURRENT_TIMESTAMP
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          email = EXCLUDED.email,
          franchise_id = EXCLUDED.franchise_id,
          branch_id = EXCLUDED.branch_id,
          vehicle_type = EXCLUDED.vehicle_type,
          vehicle_number = EXCLUDED.vehicle_number,
          is_online = EXCLUDED.is_online,
          status = EXCLUDED.status,
          current_lat = COALESCE(EXCLUDED.current_lat, delivery_partners.current_lat),
          current_lng = COALESCE(EXCLUDED.current_lng, delivery_partners.current_lng),
          active_order_id = EXCLUDED.active_order_id,
          metadata = EXCLUDED.metadata,
          updated_at = CURRENT_TIMESTAMP;
      `, [
        uid, name, phone, email, franchiseId, branchId,
        vehicleType, vehicleNumber, isOnline, status,
        lat, lng, activeOrderId, totalDeliveries, metadata
      ]);
      riderCount++;
    }
    console.log(`✅ Upserted ${riderCount} delivery partners into delivery_partners table.`);
  } catch (err) {
    console.warn('Delivery partners migration warning:', err.message);
  }

  // 4. Update customer lifetime statistics in app_users from canonical_orders
  try {
    console.log('[4/4] Calculating customer lifetime order stats from canonical_orders...');
    await pool.query(`
      WITH stats AS (
        SELECT 
          customer_phone,
          COUNT(*) as order_count,
          SUM(total_amount) as spent
        FROM canonical_orders
        WHERE customer_phone IS NOT NULL AND customer_phone != 'N/A' AND customer_phone != ''
        GROUP BY customer_phone
      )
      UPDATE app_users u
      SET 
        total_orders = stats.order_count,
        total_spent = stats.spent,
        updated_at = CURRENT_TIMESTAMP
      FROM stats
      WHERE u.phone = stats.customer_phone;
    `);
    console.log('✅ Synchronized lifetime stats for customers.');
  } catch (err) {
    console.warn('Customer stats sync notice:', err.message);
  }

  // Verification Counts
  const [usersRes, branchRes, riderRes] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM app_users'),
    pool.query('SELECT COUNT(*) FROM restaurant_branches'),
    pool.query('SELECT COUNT(*) FROM delivery_partners')
  ]);
  console.log('\n--- VERIFICATION IN RENDER POSTGRESQL ---');
  console.log(`  app_users           : ${usersRes.rows[0].count} records`);
  console.log(`  restaurant_branches : ${branchRes.rows[0].count} records`);
  console.log(`  delivery_partners   : ${riderRes.rows[0].count} records`);

  await pool.end();
  process.exit(0);
}

migrateData();
