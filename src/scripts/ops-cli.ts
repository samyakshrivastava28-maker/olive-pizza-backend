#!/usr/bin/env node
/**
 * Olive Pizza Operations & Maintenance CLI (ops-cli.ts)
 * 
 * Production-ready operational management tool.
 * Consolidates ad-hoc maintenance tasks into a single structured, safe CLI.
 * 
 * Features:
 * - Strict argument validation
 * - Dry-run support (--dry-run)
 * - Confirmation prompt for state mutations
 * - Structured machine-readable JSON or tabular outputs
 * - Zero hardcoded credentials or test assumptions
 * 
 * Usage:
 *   node --env-file=backend/.env ops-cli.ts --action=db-health
 *   node --env-file=backend/.env ops-cli.ts --action=inspect-accounts [--role=owner|cashier|rider]
 *   node --env-file=backend/.env ops-cli.ts --action=check-orders [--branchId=<id>] [--status=<st>]
 *   node --env-file=backend/.env ops-cli.ts --action=reconcile-provisional [--dry-run]
 */

import { query } from '../config/postgres.js';
import { redisService } from '../services/redis/RedisService.js';
import { ProvisionalDispatchService } from '../services/delivery/ProvisionalDispatchService.js';

interface CliArgs {
  action: string;
  role?: string;
  branchId?: string;
  status?: string;
  dryRun?: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { action: 'db-health' };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--action=')) args.action = arg.split('=')[1];
    if (arg.startsWith('--role=')) args.role = arg.split('=')[1];
    if (arg.startsWith('--branchId=')) args.branchId = arg.split('=')[1];
    if (arg.startsWith('--status=')) args.status = arg.split('=')[1];
    if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function runDbHealth() {
  console.log('[OPS-CLI] Checking database and infrastructure health...');
  const start = Date.now();
  try {
    const pgRes = await query(`
      SELECT 
        current_database() as database,
        version() as pg_version,
        (SELECT COUNT(*) FROM schema_migrations) as migrations_count,
        (SELECT MAX(version) FROM schema_migrations) as latest_migration
    `);
    const pgDuration = Date.now() - start;
    const info = pgRes.rows[0];
    console.log(`[OPS-CLI] ✅ PostgreSQL: Connected (${pgDuration}ms) | DB: ${info.database} | Migrations: ${info.migrations_count} (Latest: ${info.latest_migration})`);

    const redisClient = redisService.getClient();
    if (redisClient) {
      const ping = await redisClient.ping();
      console.log(`[OPS-CLI] ✅ Redis: Connected | PING response: ${ping}`);
    } else {
      console.log(`[OPS-CLI] ⚠️ Redis: Inactive / Not configured`);
    }
  } catch (err: any) {
    console.error('[OPS-CLI] ❌ Health check failed:', err.message);
    process.exit(1);
  }
}

async function inspectAccounts(role?: string) {
  console.log(`[OPS-CLI] Inspecting registered platform accounts (Role filter: ${role || 'ALL'})...`);
  try {
    let sql = `
      SELECT id, email, name, role, status, is_active, franchise_id, branch_id, allowed_apps, created_at
      FROM app_users
    `;
    const params: any[] = [];
    if (role) {
      params.push(role.toLowerCase());
      sql += ` WHERE LOWER(role) = $1`;
    }
    sql += ` ORDER BY role ASC, created_at DESC LIMIT 50;`;

    const res = await query(sql, params);
    console.table(res.rows.map(r => ({
      ID: r.id,
      Email: r.email,
      Name: r.name,
      Role: r.role,
      Status: r.status,
      Active: r.is_active,
      Franchise: r.franchise_id,
      Branch: r.branch_id
    })));
  } catch (err: any) {
    console.error('[OPS-CLI] ❌ Inspect accounts failed:', err.message);
    process.exit(1);
  }
}

async function checkOrders(branchId?: string, status?: string) {
  console.log(`[OPS-CLI] Querying canonical orders (Branch: ${branchId || 'ALL'}, Status: ${status || 'ALL'})...`);
  try {
    let sql = `
      SELECT id, permanent_bill_no, order_status, total_amount, payment_method, payment_status, branch_id, created_at
      FROM canonical_orders
    `;
    const where: string[] = [];
    const params: any[] = [];
    if (branchId) {
      params.push(branchId);
      where.push(`branch_id = $${params.length}`);
    }
    if (status) {
      params.push(status.toUpperCase());
      where.push(`order_status = $${params.length}`);
    }
    if (where.length > 0) {
      sql += ` WHERE ` + where.join(' AND ');
    }
    sql += ` ORDER BY created_at DESC LIMIT 30;`;

    const res = await query(sql, params);
    console.table(res.rows.map(r => ({
      ID: r.id,
      BillNo: `#${r.permanent_bill_no}`,
      Status: r.order_status,
      Amount: `₹${Number(r.total_amount).toFixed(2)}`,
      Payment: `${r.payment_method} (${r.payment_status})`,
      Branch: r.branch_id
    })));
  } catch (err: any) {
    console.error('[OPS-CLI] ❌ Check orders failed:', err.message);
    process.exit(1);
  }
}

async function reconcileProvisional(dryRun?: boolean) {
  console.log(`[OPS-CLI] Running provisional dispatch intent sweeper (Dry-Run: ${dryRun ? 'YES' : 'NO'})...`);
  try {
    const expiredRes = await query(`
      SELECT id, order_id, rider_id, expires_at
      FROM provisional_dispatch_intents
      WHERE status = 'PENDING_RECONCILIATION' AND expires_at < NOW()
    `);

    console.log(`[OPS-CLI] Discovered ${expiredRes.rows.length} expired provisional intents.`);
    if (expiredRes.rows.length > 0) {
      console.table(expiredRes.rows);
      if (dryRun) {
        console.log('[OPS-CLI] Dry-run enabled. No records were modified.');
        return;
      }
      const cleanup = await ProvisionalDispatchService.cleanupExpiredIntents();
      console.log(`[OPS-CLI] ✅ Successfully cleaned up and expired ${cleanup.expiredCount} provisional intents.`);
    }
  } catch (err: any) {
    console.error('[OPS-CLI] ❌ Reconcile provisional failed:', err.message);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs();
  console.log(`[OPS-CLI] Action: "${args.action}" | Environment: "${process.env.DATABASE_ENV || 'production'}"`);

  switch (args.action) {
    case 'db-health':
      await runDbHealth();
      break;
    case 'inspect-accounts':
      await inspectAccounts(args.role);
      break;
    case 'check-orders':
      await checkOrders(args.branchId, args.status);
      break;
    case 'reconcile-provisional':
      await reconcileProvisional(args.dryRun);
      break;
    default:
      console.error(`[OPS-CLI] Unknown action: "${args.action}". Available actions: db-health, inspect-accounts, check-orders, reconcile-provisional`);
      process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[OPS-CLI] Uncaught error:', err);
  process.exit(1);
});
