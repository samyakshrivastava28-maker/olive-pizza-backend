import { pgPool } from '../config/postgres.js';

async function main() {
  try {
    const branchClause = " AND o.branch_id = ANY($1::text[])";
    const pgParams = [['fra_op_durg_01_main_branch']];
    const pgRes = await pgPool.query(
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
       WHERE o.order_status NOT IN ('DELIVERED', 'CANCELLED', 'REJECTED', 'VOIDED') ${branchClause}
       GROUP BY o.id, rb.name
       ORDER BY o.created_at DESC LIMIT 10`,
      pgParams
    );
    console.log('Result count:', pgRes.rows.length);
    console.log(pgRes.rows.map((r: any) => ({
      id: r.id,
      order_status: r.order_status,
      branch_id: r.branch_id,
      franchise_id: r.franchise_id,
      total_amount: r.total_amount
    })));
  } finally {
    await pgPool.end();
  }
}

main();
