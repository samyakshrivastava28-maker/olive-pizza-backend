import { pgPool } from '../config/postgres.js';
import { adminAuth } from '../config/firebase.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';

async function debugQuery() {
  const userRecord = await adminAuth.getUserByEmail('samyakssaamm@gmail.com');
  const user = {
    uid: userRecord.uid,
    role: userRecord.customClaims?.role,
    franchiseId: userRecord.customClaims?.franchiseId,
    branchId: userRecord.customClaims?.branchId,
    email: userRecord.email,
  };
  const scope = FranchiseScopeService.resolveScope(user as any);
  const effectiveBranchId = FranchiseScopeService.getEffectiveBranchId(scope, scope.branchId || '');
  console.log('Effective branch:', effectiveBranchId);

  const branchAliases = (b: string): string[] =>
    (b === 'main_branch' || b === 'branch_rjn_main') ? ['main_branch', 'branch_rjn_main'] : [b];

  const pgParams: any[] = [];
  const clauses: string[] = [];

  if (effectiveBranchId !== 'all') {
    pgParams.push(branchAliases(effectiveBranchId));
    clauses.push(`o.branch_id = ANY($${pgParams.length}::text[])`);
  }
  if (scope.isFranchiseOwner && scope.franchiseId) {
    pgParams.push(scope.franchiseId);
    clauses.push(`o.franchise_id = $${pgParams.length}`);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  pgParams.push(100);

  const sql = `SELECT o.*, rb.name AS branch_name
    FROM canonical_orders o
    LEFT JOIN restaurant_branches rb ON rb.id = o.branch_id
    ${whereSql}
    ORDER BY o.created_at DESC
    LIMIT $${pgParams.length}`;

  console.log('SQL:', sql);
  console.log('Params:', pgParams);

  const pgRes = await pgPool.query(sql, pgParams);
  console.log('pgRes count:', pgRes.rows.length);
  if (pgRes.rows.length > 0) {
    console.log('Sample row branch_id:', pgRes.rows[0].branch_id);
    const proj = OrderProjectionService.projectByRole(pgRes.rows[0], user);
    console.log('Projected order:', proj);
  } else {
    const all = await pgPool.query('SELECT id, branch_id, franchise_id, order_status FROM canonical_orders LIMIT 5');
    console.log('All canonical_orders sample:', all.rows);
  }

  process.exit(0);
}

debugQuery().catch(console.error);
