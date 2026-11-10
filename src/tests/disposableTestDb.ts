/**
 * Disposable In-Memory PostgreSQL Test Database Provider
 * 
 * Powered by @electric-sql/pglite (WASM PostgreSQL 18.6).
 * Provides a 100% isolated, ephemeral database environment for integration tests.
 * Zero Docker dependencies, zero cloud credentials, and zero production side effects.
 */

import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_ENV = 'test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DisposableTestDb {
  db: PGlite;
  query: <T = any>(text: string, params?: any[]) => Promise<{ rows: T[]; rowCount: number }>;
  withTransaction: <T>(callback: (client: { query: (text: string, params?: any[]) => Promise<any> }) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

/**
 * Creates and initializes a fresh in-memory PostgreSQL instance with all canonical migrations applied.
 */
export async function createDisposableTestDb(): Promise<DisposableTestDb> {
  const db = new PGlite();

  // Load and apply all SQL migrations from src/migrations in alphabetical order
  const migrationsDir = path.resolve(__dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await db.exec(sql);
    } catch (err: any) {
      console.warn(`[DisposableTestDb] Warning executing migration ${file}:`, err.message);
    }
  }

  // Pre-seed baseline test entities
  await db.exec(`
    INSERT INTO restaurant_branches (
      id, franchise_id, name, address, phone, is_open
    ) VALUES (
      'main_branch', 'fra_rajnandgaon', 'Rajnandgaon Main Branch', 'Station Road, Rajnandgaon', '9876543210', true
    ) ON CONFLICT (id) DO NOTHING;

    INSERT INTO app_users (
      id, email, phone, name, role, status, franchise_id, branch_id, allowed_apps, is_active
    ) VALUES 
      ('usr_test_owner', 'owner@olivepizza.in', '9179944445', 'Platform Owner', 'owner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["OWNER", "CUSTOMER"]'::jsonb, true),
      ('usr_test_cashier', 'cashier@olivepizza.in', '9876543211', 'POS Cashier', 'cashier', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["POS"]'::jsonb, true),
      ('usr_test_rider', 'rider@olivepizza.in', '9876543212', 'Delivery Rider', 'delivery_partner', 'APPROVED', 'fra_rajnandgaon', 'main_branch', '["DELIVERY"]'::jsonb, true)
    ON CONFLICT (id) DO NOTHING;
  `);

  const query = async <T = any>(text: string, params: any[] = []): Promise<{ rows: T[]; rowCount: number }> => {
    const res = await db.query<T>(text, params);
    const affected = (res as any).affectedRows;
    return {
      rows: res.rows,
      rowCount: affected !== undefined ? affected : res.rows.length
    };
  };

  const withTransaction = async <T>(callback: (client: { query: (text: string, params?: any[]) => Promise<any> }) => Promise<T>): Promise<T> => {
    await db.exec('BEGIN');
    try {
      const client = {
        query: (sql: string, params: any[] = []) => db.query(sql, params)
      };
      const result = await callback(client);
      await db.exec('COMMIT');
      return result;
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  };

  const close = async (): Promise<void> => {
    await db.close();
  };

  return {
    db,
    query,
    withTransaction,
    close
  };
}
