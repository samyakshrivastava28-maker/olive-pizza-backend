import { Router, Response } from 'express';
import { query } from '../config/postgres.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

router.use(verifyToken);
router.use(requireRole(['owner', 'admin', 'developer']));

/**
 * GET /api/dashboard/summary
 * Direct authoritative dashboard analytics computed directly from Render PostgreSQL.
 * Sourced 100% from canonical_orders, canonical_bills, and app_users with zero Firestore reads.
 */
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = (req.query.branchId as string) || req.user?.branchId || null;

    // 1. Metric Aggregates from canonical_orders & canonical_bills
    // - Today's Revenue & Order Count (using Asia/Kolkata timezone)
    // - Current Month's Revenue & Order Count
    // - Active Order Status Counts
    const statsQuery = `
      WITH tz_orders AS (
        SELECT 
          id,
          order_status,
          total_amount,
          created_at,
          (created_at AT TIME ZONE 'Asia/Kolkata') as local_created_at
        FROM canonical_orders
        WHERE ($1::text IS NULL OR branch_id = $1::text)
      )
      SELECT
        -- Today stats
        COALESCE(COUNT(id) FILTER (
          WHERE DATE(local_created_at) = DATE(NOW() AT TIME ZONE 'Asia/Kolkata')
        ), 0)::int AS today_orders_count,
        
        COALESCE(SUM(total_amount) FILTER (
          WHERE DATE(local_created_at) = DATE(NOW() AT TIME ZONE 'Asia/Kolkata')
            AND UPPER(order_status) NOT IN ('CANCELLED', 'REJECTED')
        ), 0)::float AS today_revenue,

        -- Month stats
        COALESCE(COUNT(id) FILTER (
          WHERE date_trunc('month', local_created_at) = date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')
        ), 0)::int AS month_orders_count,
        
        COALESCE(SUM(total_amount) FILTER (
          WHERE date_trunc('month', local_created_at) = date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')
            AND UPPER(order_status) NOT IN ('CANCELLED', 'REJECTED')
        ), 0)::float AS month_revenue,

        -- Lifetime stats
        COALESCE(COUNT(id), 0)::int AS lifetime_orders_count,
        COALESCE(SUM(total_amount) FILTER (WHERE UPPER(order_status) NOT IN ('CANCELLED', 'REJECTED')), 0)::float AS lifetime_revenue,

        -- Active Pipeline counts
        COALESCE(COUNT(id) FILTER (WHERE UPPER(order_status) IN ('PENDING', 'PLACED', 'CREATED', 'NEW_ORDER', 'NEW', 'PAYMENT_PENDING', 'PENDING_ACCEPTANCE')), 0)::int AS pending_count,
        COALESCE(COUNT(id) FILTER (WHERE UPPER(order_status) IN ('CONFIRMED', 'PREPARING', 'KITCHEN', 'READY', 'ACCEPTED', 'BAKING', 'READY_FOR_PICKUP')), 0)::int AS preparing_count,
        COALESCE(COUNT(id) FILTER (WHERE UPPER(order_status) IN ('OUT_FOR_DELIVERY', 'PICKED_UP', 'PARTNER_ASSIGNED')), 0)::int AS out_for_delivery_count,
        COALESCE(COUNT(id) FILTER (WHERE UPPER(order_status) IN ('DELIVERED', 'COMPLETED')), 0)::int AS delivered_count,
        COALESCE(COUNT(id) FILTER (WHERE UPPER(order_status) IN ('CANCELLED', 'REJECTED', 'FAILED')), 0)::int AS cancelled_count
      FROM tz_orders;
    `;

    const statsRes = await query(statsQuery, [branchId]);
    const metrics = statsRes.rows[0] || {
      today_orders_count: 0,
      today_revenue: 0,
      month_orders_count: 0,
      month_revenue: 0,
      lifetime_orders_count: 0,
      lifetime_revenue: 0,
      pending_count: 0,
      preparing_count: 0,
      out_for_delivery_count: 0,
      delivered_count: 0,
      cancelled_count: 0
    };

    // 2. Fetch Latest 150 Orders for the live orders table in Dashboard
    const ordersQuery = `
      SELECT 
        o.id,
        COALESCE(o.daily_order_no::text, o.permanent_bill_no::text, o.id) as "orderNumber",
        UPPER(o.order_status) as "status",
        COALESCE(o.customer_name, 'Guest Customer') as "customerName",
        COALESCE(o.customer_phone, '') as "customerPhone",
        o.total_amount as "totalAmount",
        o.subtotal,
        o.payment_method as "paymentMethod",
        UPPER(COALESCE(b.payment_status, o.payment_status, 'PENDING')) as "paymentStatus",
        o.order_type as "deliveryType",
        o.branch_id as "branchId",
        o.franchise_id as "franchiseId",
        o.delivery_partner_id as "deliveryPartnerId",
        dp.name as "deliveryPartnerName",
        o.delivery_address as "deliveryAddress",
        o.created_at as "createdAt",
        o.updated_at as "updatedAt",
        b.permanent_bill_no as "billingNumber",
        COALESCE(
          (SELECT json_agg(json_build_object(
            'id', oi.id,
            'name', oi.item_name,
            'quantity', oi.quantity,
            'price', oi.unit_price,
            'total', oi.line_total
          )) FROM canonical_order_items oi WHERE oi.order_id = o.id),
          '[]'::json
        ) as items
      FROM canonical_orders o
      LEFT JOIN canonical_bills b ON b.order_id = o.id
      LEFT JOIN delivery_partners dp ON dp.id = o.delivery_partner_id
      WHERE ($1::text IS NULL OR o.branch_id = $1::text)
      ORDER BY o.created_at DESC
      LIMIT 150;
    `;

    const ordersRes = await query(ordersQuery, [branchId]);

    res.json({
      success: true,
      source: 'postgresql',
      metrics: {
        todayRevenue: metrics.today_revenue,
        todayOrdersCount: metrics.today_orders_count,
        monthRevenue: metrics.month_revenue,
        monthOrdersCount: metrics.month_orders_count,
        lifetimeRevenue: metrics.lifetime_revenue,
        lifetimeOrdersCount: metrics.lifetime_orders_count,
        activePipeline: {
          pending: metrics.pending_count,
          preparing: metrics.preparing_count,
          outForDelivery: metrics.out_for_delivery_count,
          delivered: metrics.delivered_count,
          cancelled: metrics.cancelled_count
        }
      },
      orders: ordersRes.rows
    });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error computing summary from PostgreSQL:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to compute dashboard metrics' });
  }
});

/**
 * GET /api/dashboard/customers
 * Authoritative customer list directly from PostgreSQL app_users table.
 */
router.get('/customers', async (req: AuthRequest, res: Response) => {
  try {
    const searchQuery = (req.query.q as string || '').toLowerCase().trim();
    
    let sql = `
      SELECT 
        id,
        name,
        email,
        phone,
        role,
        status,
        is_active as "isActive",
        total_orders as "totalOrders",
        total_spent as "totalSpent",
        default_address as "defaultAddress",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM app_users
      WHERE role = 'customer'
    `;
    const params: any[] = [];

    if (searchQuery) {
      params.push(`%${searchQuery}%`);
      sql += ` AND (LOWER(name) LIKE $1 OR LOWER(email) LIKE $1 OR phone LIKE $1)`;
    }

    sql += ` ORDER BY total_spent DESC, created_at DESC LIMIT 300;`;

    const result = await query(sql, params);

    res.json({
      success: true,
      source: 'postgresql',
      count: result.rowCount,
      customers: result.rows
    });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error fetching customers from PostgreSQL:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch customer directory' });
  }
});

/**
 * GET /api/dashboard/delivery-partners
 * Authoritative delivery partners list directly from PostgreSQL delivery_partners table.
 */
router.get('/delivery-partners', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = (req.query.branchId as string) || req.user?.branchId || null;

    let sql = `
      SELECT 
        uid as id,
        uid,
        name,
        phone,
        email,
        franchise_id as "franchiseId",
        branch_id as "branchId",
        vehicle_type as "vehicleType",
        vehicle_number as "vehicleNumber",
        is_online as "isOnline",
        status,
        current_lat as lat,
        current_lng as lng,
        active_order_id as "activeOrderId",
        total_deliveries as "totalDeliveries",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM delivery_partners
      WHERE ($1::text IS NULL OR branch_id = $1::text)
      ORDER BY is_online DESC, name ASC;
    `;

    const result = await query(sql, [branchId]);

    res.json({
      success: true,
      source: 'postgresql',
      count: result.rowCount,
      partners: result.rows
    });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error fetching delivery partners from PostgreSQL:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch delivery partners' });
  }
});

/**
 * POST /api/dashboard/delivery-partners
 * Create or update a delivery partner in PostgreSQL (dual writes to Firestore if available).
 */
router.post('/delivery-partners', async (req: AuthRequest, res: Response) => {
  try {
    const { id, name, phone, email, vehicleType, vehicleNumber, isOnline, branchId, franchiseId } = req.body;
    const partnerId = id || `del_${Date.now()}`;
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanBranch = branchId || 'main_branch';
    const cleanFranchise = franchiseId || 'fra_rajnandgaon';

    const upsertSql = `
      INSERT INTO delivery_partners (
        uid, name, phone, email, franchise_id, branch_id, vehicle_type, vehicle_number, is_online, status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'APPROVED', NOW())
      ON CONFLICT (uid) DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        vehicle_type = EXCLUDED.vehicle_type,
        vehicle_number = EXCLUDED.vehicle_number,
        is_online = EXCLUDED.is_online,
        updated_at = NOW()
      RETURNING *;
    `;

    const result = await query(upsertSql, [
      partnerId,
      name || 'Delivery Partner',
      phone || null,
      cleanEmail || null,
      cleanFranchise,
      cleanBranch,
      vehicleType || 'Motorcycle',
      vehicleNumber || null,
      isOnline !== undefined ? Boolean(isOnline) : true
    ]);

    // Authoritative operational sync to Firestore delivery_partners
    try {
      const { adminDb } = await import('../config/firebase.js');
      await adminDb.collection('delivery_partners').doc(partnerId).set({
        name,
        phone,
        email: cleanEmail,
        vehicleType,
        vehicleNumber,
        isOnline: Boolean(isOnline),
        branchId: cleanBranch,
        franchiseId: cleanFranchise,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch (fsErr: any) {
      console.warn('[Firestore Sync Notice on partner save]:', fsErr.message);
    }

    res.json({
      success: true,
      partner: result.rows[0]
    });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error saving delivery partner:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to save delivery partner' });
  }
});

/**
 * DELETE /api/dashboard/delivery-partners/:id
 * Remove delivery partner from PostgreSQL and Firestore.
 */
router.delete('/delivery-partners/:id', async (req: AuthRequest, res: Response) => {
  try {
    const partnerId = req.params.id;
    await query('DELETE FROM delivery_partners WHERE uid = $1;', [partnerId]);
    await query("UPDATE app_users SET is_active = false, status = 'DISABLED', updated_at = NOW() WHERE firebase_uid = $1;", [partnerId]);

    try {
      const { adminDb } = await import('../config/firebase.js');
      await adminDb.collection('delivery_partners').doc(partnerId).delete();
    } catch (fsErr: any) {
      console.warn('[Firestore Partner Delete Notice]:', fsErr.message);
    }

    res.json({ success: true, message: 'Delivery partner removed from registry' });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error deleting delivery partner:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete delivery partner' });
  }
});

/**
 * PATCH /api/dashboard/delivery-partners/:id/toggle-online
 * Toggle delivery partner online status.
 */
router.patch('/delivery-partners/:id/toggle-online', async (req: AuthRequest, res: Response) => {
  try {
    const partnerId = req.params.id;
    const { isOnline } = req.body;

    const result = await query(
      'UPDATE delivery_partners SET is_online = $1, updated_at = NOW() WHERE uid = $2 RETURNING *;',
      [Boolean(isOnline), partnerId]
    );

    try {
      const { adminDb } = await import('../config/firebase.js');
      await adminDb.collection('delivery_partners').doc(partnerId).set({
        isOnline: Boolean(isOnline),
        updatedAt: new Date().toISOString()
      }, { merge: true });
    } catch {}

    res.json({ success: true, partner: result.rows[0] });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error toggling delivery partner online status:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update partner status' });
  }
});

/**
 * GET /api/dashboard/restaurant-branch
 * Branch settings directly from PostgreSQL restaurant_branches.
 */
router.get('/restaurant-branch', async (req: AuthRequest, res: Response) => {
  try {
    const branchId = (req.query.branchId as string) || req.user?.branchId || 'main_branch';
    const result = await query('SELECT * FROM restaurant_branches WHERE branch_id = $1 LIMIT 1;', [branchId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Branch not found in PostgreSQL registry' });
    }

    res.json({
      success: true,
      source: 'postgresql',
      branch: result.rows[0]
    });
  } catch (error: any) {
    console.error('[DashboardRoutes] Error fetching restaurant branch from PostgreSQL:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch branch settings' });
  }
});

export default router;
