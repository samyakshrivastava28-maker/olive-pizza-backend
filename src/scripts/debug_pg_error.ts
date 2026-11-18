import { pgPool } from '../config/postgres.js';

async function testExactQuery() {
  const branchAliases = (b: string) => [b];
  const effectiveBranchId = 'fra_op_durg_01_main_branch';
  const pgParams = [branchAliases(effectiveBranchId), 100];
  const whereSql = 'WHERE o.branch_id = ANY($1::text[])';

  try {
    const res = await pgPool.query(
      `SELECT o.*, rb.name AS branch_name,
         COALESCE(
           json_agg(
             json_build_object(
               'id', i.id,
               'menuItemId', i.menu_item_id,
               'name', i.item_name,
               'size', i.size_variant,
               'crust', i.crust,
               'quantity', i.quantity,
               'unitPrice', i.unit_price,
               'price', i.unit_price,
               'lineTotal', i.line_total,
               'addons', i.addons_json
             )
           ) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM canonical_orders o
       LEFT JOIN restaurant_branches rb ON rb.id = o.branch_id
       LEFT JOIN canonical_order_items i ON o.id = i.order_id
       ${whereSql}
       GROUP BY o.id, rb.name
       ORDER BY o.created_at DESC
       LIMIT $2`,
      pgParams
    );
    console.log('✅ Query succeeded, rows:', res.rows.length);
  } catch (err: any) {
    console.error('❌ Query failed:', err.message);
  }
  process.exit(0);
}

testExactQuery();
