import './env.js';
import pkg from 'pg';
const { Pool } = pkg;
import type { PoolClient, QueryResult } from 'pg';
import dotenv from 'dotenv';
import { runMigrations } from '../migrations/runner.js';

dotenv.config();

export type DatabaseEnvironment = 'development' | 'testing' | 'render-test' | 'staging' | 'production' | 'vps' | 'layerbase';

export const DATABASE_ENV: DatabaseEnvironment = 
  (process.env.DATABASE_ENV as DatabaseEnvironment) || 
  (process.env.NODE_ENV === 'production' ? 'production' : 'development');

export type DatabaseProvider = 'layerbase' | 'self_hosted' | 'local' | 'render-test' | 'vps';

let dbUrl: string | undefined = (process.env.DATABASE_PROVIDER === 'layerbase' || process.env.DATABASE_ENV === 'layerbase')
  ? (process.env.LAYERBASE_DATABASE_URL || process.env.DATABASE_URL)
  : process.env.DATABASE_URL;

if (!dbUrl) {
  if (process.env.DATABASE_PROVIDER === 'layerbase' || process.env.DATABASE_ENV === 'layerbase') {
    dbUrl = process.env.LAYERBASE_DATABASE_URL || process.env.DATABASE_URL;
  } else if (process.env.DATABASE_PROVIDER === 'self_hosted' || process.env.DATABASE_PROVIDER === 'vps' || process.env.DATABASE_ENV === 'production' || process.env.DATABASE_ENV === 'vps') {
    dbUrl = process.env.VPS_POSTGRES_URL || process.env.DATABASE_URL;
  } else if (process.env.DATABASE_PROVIDER === 'render-test' || process.env.DATABASE_ENV === 'render-test') {
    dbUrl = process.env.RENDER_POSTGRES_URL || process.env.DATABASE_URL;
  } else {
    dbUrl = process.env.DATABASE_URL;
  }
}

// Auto-fix Render IPv6 issue for Supabase (Forces IPv4 Connection Pooler)
if (dbUrl && dbUrl.includes('.supabase.co')) {
  dbUrl = dbUrl.replace('db.tdjrkqmhdynbaciguyvr.supabase.co:5432', 'aws-1-ap-south-1.pooler.supabase.com:6543');
  if (!dbUrl.includes('pgbouncer=true')) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'pgbouncer=true';
  }
}

const isExplicitLocalHost = Boolean(
  dbUrl?.includes('localhost') || 
  dbUrl?.includes('127.0.0.1') || 
  dbUrl?.includes('::1')
);

export const DATABASE_PROVIDER: DatabaseProvider = 
  (process.env.DATABASE_PROVIDER as DatabaseProvider) || 
  (isExplicitLocalHost ? 'local' :
   dbUrl?.includes('layerbase.dev') ? 'layerbase' :
   dbUrl?.includes('render.com') || dbUrl?.includes('dpg-') ? 'render-test' : 'layerbase');

const isLocalPostgres = Boolean(
  isExplicitLocalHost ||
  DATABASE_PROVIDER === 'local' ||
  (process.env.NODE_ENV === 'test' && !dbUrl?.includes('layerbase.dev') && !dbUrl?.includes('supabase.co'))
);

const isLayerbase = Boolean(!isLocalPostgres && (dbUrl?.includes('layerbase.dev') || DATABASE_PROVIDER === 'layerbase' || DATABASE_ENV === 'layerbase'));
const isRenderPostgres = Boolean(!isLocalPostgres && (dbUrl?.includes('render.com') || dbUrl?.includes('dpg-') || DATABASE_PROVIDER === 'render-test'));
const isCloudPostgres = Boolean(!isLocalPostgres && (isLayerbase || isRenderPostgres || dbUrl?.includes('supabase.co') || dbUrl?.includes('pooler.supabase.com')));

const maxConnections = parseInt(process.env.POSTGRES_POOL_MAX || (isLayerbase ? '15' : '20'), 10);
const idleTimeoutMillis = parseInt(process.env.POSTGRES_POOL_IDLE_TIMEOUT_MS || '30000', 10);
const connectionTimeoutMillis = parseInt(process.env.POSTGRES_POOL_CONN_TIMEOUT_MS || '15000', 10);

export const pgPool = new Pool({
  connectionString: dbUrl,
  max: maxConnections,
  idleTimeoutMillis: idleTimeoutMillis,
  connectionTimeoutMillis: connectionTimeoutMillis,
  query_timeout: 15000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
  ssl: isLocalPostgres
    ? false
    : process.env.PG_SSL_REJECT_UNAUTHORIZED === 'true'
      ? { rejectUnauthorized: true, ca: process.env.PG_SSL_CA }
      : process.env.PG_SSL_REJECT_UNAUTHORIZED === 'false' || isCloudPostgres
        ? { rejectUnauthorized: false }
        : false,
// statement_timeout omitted from pool startup params for serverless pooler compatibility
});

console.log(`[PostgreSQL] Provider: "${DATABASE_PROVIDER}" | Environment: "${DATABASE_ENV}" | Target: ${isLayerbase ? 'Layerbase Serverless PostgreSQL (Authoritative)' : isRenderPostgres ? 'Render PostgreSQL' : 'PostgreSQL'}`);

pgPool.on('error', (err) => {
  console.warn('[PostgreSQL Pool] Idle client connection warning (safe to ignore):', err.message);
});

/**
 * Execute parameterized query with automatic timing and error logging
 */
/**
 * Asserts that the database connection target is safe for the active environment.
 * If running under test mode, prevents connecting to cloud PostgreSQL hosts before any socket opens.
 */
export function assertSafeDatabaseTarget(overrideUrl?: string): void {
  if (process.env.NODE_ENV === 'test' || process.env.TEST_SAFETY_FAILSAFE === 'strict') {
    const target = overrideUrl || process.env.DATABASE_URL || dbUrl;
    const isTargetCloud = overrideUrl
      ? Boolean(target && (target.includes('layerbase.dev') || target.includes('render.com') || target.includes('dpg-') || target.includes('supabase.co')) && !target.includes('localhost') && !target.includes('127.0.0.1') && !target.includes('::1'))
      : isCloudPostgres;

    if (isTargetCloud && process.env.ALLOW_CLOUD_TEST_CONNECTION !== 'true') {
      throw new Error(
        `[DATABASE TARGET BLOCKED] Test execution cannot target cloud PostgreSQL host. ` +
        `Use disposable in-memory PGlite instance or local PostgreSQL container.`
      );
    }
  }
}

/**
 * Fail-safe guard: Refuses to run mutating queries against cloud databases during test execution.
 * Covers direct queries, transaction clients, writable CTEs (WITH ... INSERT/UPDATE/DELETE), MERGE, and DDL.
 */
export function assertSafeDatabaseForMutation(sqlText: string, overrideIsCloud?: boolean): void {
  if (process.env.NODE_ENV === 'test' || process.env.TEST_SAFETY_FAILSAFE === 'strict') {
    const isCloud = overrideIsCloud !== undefined ? overrideIsCloud : isCloudPostgres;
    if (isCloud && process.env.ALLOW_CLOUD_TEST_CONNECTION !== 'true') {
      const normalized = sqlText.trim().replace(/\/\*[\s\S]*?\*\/|--.*$/gm, '').trim();
      const isDirectMutation = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE)\b/i.test(normalized);
      const isWritableCTE = /^\s*WITH\b[\s\S]*?\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(normalized);

      if (isDirectMutation || isWritableCTE) {
        throw new Error(
          `[DATABASE SAFETY BLOCKER] Mutation query blocked against cloud PostgreSQL during test execution. ` +
          `Direct write attempted: "${sqlText.substring(0, 60)}...". All mutation tests must use the disposable in-memory PGlite test provider.`
        );
      }
    }
  }
}

let testQueryOverride: ((text: string, params?: any[]) => Promise<any>) | null = null;

export function setTestQueryOverride(fn: ((text: string, params?: any[]) => Promise<any>) | null): void {
  testQueryOverride = fn;
}

let testTransactionOverride: (<T>(callback: (client: any) => Promise<T>) => Promise<T>) | null = null;

export function setTestTransactionOverride(fn: (<T>(callback: (client: any) => Promise<T>) => Promise<T>) | null): void {
  testTransactionOverride = fn;
}

let testClientOverride: (() => Promise<PoolClient>) | null = null;

export function setTestClientOverride(fn: (() => Promise<PoolClient>) | null): void {
  testClientOverride = fn;
}

export async function query<T = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
  if (testQueryOverride) {
    return testQueryOverride(text, params);
  }
  assertSafeDatabaseForMutation(text);
  const start = Date.now();
  try {
    const res = await pgPool.query<T>(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[PostgreSQL Slow Query] ${duration}ms: ${text.substring(0, 120)}`);
    }
    return res;
  } catch (err: any) {
    if (err.message?.includes('client_idle_timeout') || err.message?.includes('Connection terminated') || err.message?.includes('timeout') || err.code === '08P01' || err.code === '57P01') {
      console.warn(`[PostgreSQL Pooler] Idle client connection expired (${err.message}). Retrying query with fresh socket...`);
      return await pgPool.query<T>(text, params);
    }
    console.error(`[PostgreSQL Query Error] ${err.message} | Query: ${text.substring(0, 120)}`);
    throw err;
  }
}

/**
 * Execute an atomic transaction block with automatic BEGIN, COMMIT, and ROLLBACK.
 * Every client query executed within the transaction is guarded against cloud mutation during tests.
 */
export async function getClient(): Promise<PoolClient> {
  if (testClientOverride) {
    return await testClientOverride();
  }
  return await pgPool.connect();
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  if (testTransactionOverride) {
    return testTransactionOverride(callback as any);
  }
  const client = await getClient();
  const originalClientQuery = client.query.bind(client);

  (client as any).query = (queryTextOrConfig: any, values?: any) => {
    const text = typeof queryTextOrConfig === 'string' ? queryTextOrConfig : queryTextOrConfig?.text;
    if (text) {
      assertSafeDatabaseForMutation(text);
    }
    return (originalClientQuery as any)(queryTextOrConfig, values);
  };

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr: any) {
      console.error('[PostgreSQL Transaction] Rollback error:', rbErr.message);
    }
    throw err;
  } finally {
    (client as any).query = originalClientQuery;
    client.release(true);
  }
}

/**
 * Health check helper returning connectivity latency and pool metrics without exposing secrets
 */
export async function checkPostgresHealth(): Promise<{
  connected: boolean;
  latencyMs: number;
  environment: DatabaseEnvironment;
  poolStatus: { total: number; idle: number; waiting: number };
  error?: string;
}> {
  const start = Date.now();
  try {
    const res = await pgPool.query('SELECT 1 as ping');
    const latencyMs = Date.now() - start;
    return {
      connected: res.rows[0]?.ping === 1,
      latencyMs,
      environment: DATABASE_ENV,
      poolStatus: {
        total: pgPool.totalCount,
        idle: pgPool.idleCount,
        waiting: pgPool.waitingCount,
      }
    };
  } catch (err: any) {
    return {
      connected: false,
      latencyMs: Date.now() - start,
      environment: DATABASE_ENV,
      poolStatus: {
        total: pgPool.totalCount,
        idle: pgPool.idleCount,
        waiting: pgPool.waitingCount,
      },
      error: err.message || 'PostgreSQL ping failed',
    };
  }
}

/**
 * Graceful pool drain on process shutdown
 */
export async function closePostgresPool(): Promise<void> {
  try {
    await pgPool.end();
    console.log('[PostgreSQL] Connection pool gracefully closed.');
  } catch (err: any) {
    console.error('[PostgreSQL] Error closing pool:', err.message);
  }
}

process.on('SIGTERM', closePostgresPool);
process.on('SIGINT', closePostgresPool);

/**
 * Initialize PostgreSQL tables, migrations, and triggers
 */
export const initPostgres = async () => {
  try {
    // 1. Run repeatable version-controlled migrations
    await runMigrations();

    const client = await pgPool.connect();

    // 2. Add delivery_locations to supabase_realtime publication safely if present
    try {
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'delivery_locations') THEN
            IF NOT EXISTS (
              SELECT 1 FROM pg_publication_tables 
              WHERE pubname = 'supabase_realtime' AND tablename = 'delivery_locations'
            ) THEN
              ALTER PUBLICATION supabase_realtime ADD TABLE delivery_locations;
            END IF;
          END IF;
        END $$;
      `);
    } catch (e: any) {
      // Safe to ignore if not running on Supabase
    }

    // 3. PostgreSQL LISTEN / NOTIFY for instant notification queue wakeup
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION notify_notification_queue_insert()
        RETURNS trigger AS $$
        BEGIN
          PERFORM pg_notify('notification_queue_channel', NEW.id::text);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'trg_notify_notification_queue'
          ) THEN
            CREATE TRIGGER trg_notify_notification_queue
              AFTER INSERT ON notification_queue
              FOR EACH ROW EXECUTE FUNCTION notify_notification_queue_insert();
          END IF;
        END $$;
      `);
    } catch (e: any) {
      // Non-fatal if notification_queue is managed separately
    }

    client.release();
    console.log('[PostgreSQL] Standard PostgreSQL initialized successfully with connection pool.');
  } catch (error: any) {
    console.error('[PostgreSQL] Initialization error:', error.message);
  }
};