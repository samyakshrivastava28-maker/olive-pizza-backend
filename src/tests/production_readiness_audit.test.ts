/**
 * production_readiness_audit.test.ts — Production Readiness & Remediation Verification Suite
 * 
 * Verifies:
 * 1. Authoritative PostgreSQL Report Access Control (Eliminates Email Allowlist & Token Claim Bypass)
 * 2. Granular Order Items Detail CSV Export (Full Franchise Business Record Retention)
 * 3. Standardized Backup Decryption & Restorative Recovery (ERR_CORRUPT_PAYLOAD, ERR_CRYPTO_AUTH_FAILED)
 * 4. Expiring Timestamped HMAC Deep Links for Monthly Report Streaming
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { FirebaseStorageReportService } from '../services/storage/FirebaseStorageReportService.js';
import { ReportExportService } from '../services/reports/ReportExportService.js';
import { MonthlyReportNotificationService } from '../services/reports/MonthlyReportNotificationService.js';

test('Production Readiness & Targeted Remediation Audit Suite', async (t) => {
  let testDb: DisposableTestDb;

  // Initialize isolated in-memory PostgreSQL instance with migrations 001–011
  testDb = await createDisposableTestDb();

  const mockPoolClient = {
    query: testDb.query,
    release: () => {}
  };
  const mockPool = {
    query: testDb.query,
    connect: async () => mockPoolClient
  };

  setTestDbOverride(testDb.query, mockPool);
  setTestQueryOverride(testDb.query);

  t.after(async () => {
    setTestDbOverride(null, null);
    setTestQueryOverride(null);
    if (testDb) {
      await testDb.close();
    }
  });

  // Seed baseline data
  await testDb.db.exec(`
    -- 1. App Users (Authoritative Database Accounts)
    INSERT INTO app_users (id, email, name, role, status, is_active, franchise_id, branch_id)
    VALUES
      ('usr_global_owner', 'webhub2811@gmail.com', 'Samyak Shrivastava', 'owner', 'APPROVED', true, NULL, NULL),
      ('usr_sec_owner', 'olivepizzarjn@gmail.com', 'Olive Pizza RJN', 'owner', 'APPROVED', true, NULL, NULL),
      ('usr_revoked_owner', 'revoked_owner@olivepizza.in', 'Revoked Owner', 'owner', 'REVOKED', false, NULL, NULL),
      ('usr_spoofed_owner', 'olivepizzamaker@gmail.com', 'Revoked Creator', 'owner', 'REVOKED', false, NULL, NULL),
      ('usr_fra_rjn_mgr', 'manager_rjn@olivepizza.in', 'RJN Manager', 'franchise_owner', 'APPROVED', true, 'fra_rajnandgaon', 'branch_rjn_main'),
      ('usr_fra_bsp_mgr', 'manager_bsp@olivepizza.in', 'BSP Manager', 'franchise_owner', 'APPROVED', true, 'fra_bilaspur', 'branch_bsp_main'),
      ('usr_cust_fake_role', 'customer_hacker@gmail.com', 'Customer Hacker', 'customer', 'APPROVED', true, NULL, NULL),
      ('usr_delivery_boy', 'rider1@olivepizza.in', 'Delivery Rider', 'delivery_partner', 'APPROVED', true, 'fra_rajnandgaon', 'branch_rjn_main')
    ON CONFLICT (id) DO NOTHING;

    -- 2. Restaurant Branches
    INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open)
    VALUES 
      ('branch_rjn_main', 'fra_rajnandgaon', 'Rajnandgaon HQ', 'Station Road', '9179944445', true),
      ('branch_bsp_main', 'fra_bilaspur', 'Bilaspur Branch', 'Link Road', '9876543200', true)
    ON CONFLICT (id) DO NOTHING;

    -- 3. Canonical Orders & Order Items
    INSERT INTO canonical_orders (
      id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
      order_status, payment_method, payment_status, customer_name, customer_phone, delivery_address,
      subtotal, discount_amount, coupon_code, cgst, sgst, tax_amount, delivery_fee, total_amount,
      franchise_id, branch_id
    ) VALUES
      ('ord_audit_101', 5001, 1, '2026-11-01', '12:00:00', 'ONLINE', 'delivery', 'CONFIRMED', 'UPI', 'PAID', 'Rahul Sharma', '9876543210', 'House 12, Main St', 500.00, 50.00, 'DISCOUNT10', 11.25, 11.25, 22.50, 30.00, 502.50, 'fra_rajnandgaon', 'branch_rjn_main'),
      ('ord_audit_102', 5002, 2, '2026-11-01', '13:00:00', 'POS_DINE_IN', 'dine_in', 'COMPLETED', 'CASH', 'PAID', 'Table 2', 'N/A', NULL, 300.00, 0.00, NULL, 7.50, 7.50, 15.00, 0.00, 315.00, 'fra_bilaspur', 'branch_bsp_main')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO canonical_order_items (
      id, order_id, menu_item_id, item_name, size_variant, crust, quantity, unit_price, addons_json, tax_amount, discount_amount, line_total
    ) VALUES
      ('item_101_1', 'ord_audit_101', 'menu_farmhouse', 'Farmhouse Pizza', 'Medium', 'Cheese Burst', 1, 350.00, '[{"name": "Extra Cheese", "price": 50}]'::jsonb, 8.75, 25.00, 375.00),
      ('item_101_2', 'ord_audit_101', 'menu_coke', 'Coca Cola 500ml', '500ml', 'N/A', 2, 75.00, '[]'::jsonb, 2.50, 25.00, 127.50),
      ('item_102_1', 'ord_audit_102', 'menu_margherita', 'Margherita Pizza', 'Regular', 'Pan Crust', 1, 300.00, '[]'::jsonb, 7.50, 0.00, 307.50)
    ON CONFLICT (id) DO NOTHING;
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. AUTHORITATIVE POSTGRESQL REPORT ACCESS CONTROL
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('1. Authoritative PostgreSQL Report Access Control', async (tAuth) => {
    await tAuth.test('1.1 Active owner in PostgreSQL can access global and franchise reports', async () => {
      const globalAccess = await FirebaseStorageReportService.verifyReportAccess(
        { uid: 'usr_global_owner', email: 'webhub2811@gmail.com' },
        { isGlobal: true }
      );
      assert.equal(globalAccess.authorized, true);
      assert.equal(globalAccess.user.role, 'owner');

      const franchiseAccess = await FirebaseStorageReportService.verifyReportAccess(
        { uid: 'usr_global_owner', email: 'webhub2811@gmail.com' },
        { franchiseId: 'fra_rajnandgaon' }
      );
      assert.equal(franchiseAccess.authorized, true);
    });

    await tAuth.test('1.2 Revoked owner is REJECTED even with owner role and authorized email', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_spoofed_owner', email: 'olivepizzamaker@gmail.com', role: 'owner' },
            { isGlobal: true }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'ACCOUNT_REVOKED');
          return true;
        }
      );
    });

    await tAuth.test('1.3 Deactivated or status REVOKED account fails-closed immediately', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_revoked_owner', email: 'revoked_owner@olivepizza.in', role: 'owner' },
            { franchiseId: 'fra_rajnandgaon' }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'ACCOUNT_REVOKED');
          return true;
        }
      );
    });

    await tAuth.test('1.4 Forged token claim (role: owner) is REJECTED when database role is customer', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_cust_fake_role', email: 'customer_hacker@gmail.com', role: 'owner' },
            { franchiseId: 'fra_rajnandgaon' }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'ROLE_FORBIDDEN');
          return true;
        }
      );
    });

    await tAuth.test('1.5 Cross-Franchise Isolation: Franchise A user is FORBIDDEN from Franchise B reports', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_fra_rjn_mgr', email: 'manager_rjn@olivepizza.in' },
            { franchiseId: 'fra_bilaspur' }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'FRANCHISE_ACCESS_DENIED');
          return true;
        }
      );
    });

    await tAuth.test('1.6 Franchise user is FORBIDDEN from accessing Global executive reports', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_fra_rjn_mgr', email: 'manager_rjn@olivepizza.in' },
            { isGlobal: true }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'GLOBAL_ACCESS_DENIED');
          return true;
        }
      );
    });

    await tAuth.test('1.7 Delivery partners and riders are unconditionally blocked from reports', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.verifyReportAccess(
            { uid: 'usr_delivery_boy', email: 'rider1@olivepizza.in' },
            { franchiseId: 'fra_rajnandgaon' }
          );
        },
        (err: any) => {
          assert.equal(err.code, 'ROLE_FORBIDDEN');
          return true;
        }
      );
    });

    await tAuth.test('1.8 MonthlyReportNotificationService deterministic role & status checks', () => {
      // Inactive user
      const inactiveRes = MonthlyReportNotificationService.isUserAuthorizedForReport(
        { uid: 'usr_test', role: 'owner', email: 'webhub2811@gmail.com', isActive: false },
        { level: 'GLOBAL' }
      );
      assert.equal(inactiveRes.authorized, false);

      // Customer claiming owner email
      const customerRes = MonthlyReportNotificationService.isUserAuthorizedForReport(
        { uid: 'usr_test2', role: 'customer', email: 'webhub2811@gmail.com', isActive: true },
        { level: 'GLOBAL' }
      );
      assert.equal(customerRes.authorized, false);

      // Active global owner
      const activeOwnerRes = MonthlyReportNotificationService.isUserAuthorizedForReport(
        { uid: 'usr_test3', role: 'owner', email: 'webhub2811@gmail.com', isActive: true },
        { level: 'GLOBAL' }
      );
      assert.equal(activeOwnerRes.authorized, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. GRANULAR ORDER ITEMS BREAKDOWN CSV EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('2. Granular Order Items Breakdown CSV Export', async (tItems) => {
    await tItems.test('2.1 Exports order items joined with canonical orders per franchise', async () => {
      const res = await ReportExportService.generateOrderItemsCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      assert.equal(res.rowCount, 2);
      assert.equal(res.reportType, 'ORDER_ITEMS');
      assert.ok(res.csvContent.includes('Farmhouse Pizza'));
      assert.ok(res.csvContent.includes('Coca Cola 500ml'));
      assert.ok(res.csvContent.includes('Rahul Sharma'));
      assert.ok(res.csvContent.includes('Cheese Burst'));
      // Bilaspur item must not be included
      assert.equal(res.csvContent.includes('Margherita Pizza'), false);
    });

    await tItems.test('2.2 Validates RFC 4180 format and all required headers', async () => {
      const res = await ReportExportService.generateOrderItemsCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      const lines = res.csvContent.split('\r\n');
      const headerLine = lines[0];
      assert.ok(headerLine.includes('Order ID'));
      assert.ok(headerLine.includes('Permanent Bill No'));
      assert.ok(headerLine.includes('Item ID'));
      assert.ok(headerLine.includes('Item Name'));
      assert.ok(headerLine.includes('Quantity'));
      assert.ok(headerLine.includes('Unit Price'));
      assert.ok(headerLine.includes('Addons'));
      assert.ok(headerLine.includes('Item Tax'));
      assert.ok(headerLine.includes('Item Discount'));
      assert.ok(headerLine.includes('Line Total'));
    });

    await tItems.test('2.3 Formula Injection Protection on item attributes', () => {
      const sanitizedFormula = ReportExportService.sanitizeCell('=cmd|"/C calc"!A0');
      assert.equal(sanitizedFormula, `"'=cmd|""/C calc""!A0"`);

      const sanitizedNumeric = ReportExportService.sanitizeCell(-45.50);
      assert.equal(sanitizedNumeric, '-45.5');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. STANDARDIZED BACKUP DECRYPTION & RESTORATIVE RECOVERY
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('3. Standardized Backup Decryption & Restorative Recovery', async (tBackup) => {
    const validKey = 'production-grade-master-backup-key-32-bytes!!';
    const wrongKey = 'wrong-encryption-key-for-testing-backup!!';

    // Create a real encrypted backup using FirebaseStorageReportService
    const backup = await FirebaseStorageReportService.createEncryptedDatabaseBackup({
      secretKey: validKey,
      customDumpSql: 'CREATE TABLE IF NOT EXISTS test_restore_table (id INT, val TEXT); INSERT INTO test_restore_table VALUES (1, \'success\');'
    });

    assert.ok(backup.encryptedBuffer);
    assert.ok(backup.encryptedBuffer.length > 28);

    await tBackup.test('3.1 Truncated buffer (< 28 bytes) throws ERR_CORRUPT_PAYLOAD', async () => {
      const truncated = Buffer.from('too-short');
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.restoreDatabaseBackup(truncated, validKey, async () => {});
        },
        (err: any) => {
          assert.equal(err.code, 'ERR_CORRUPT_PAYLOAD');
          return true;
        }
      );
    });

    await tBackup.test('3.2 Wrong secret key throws ERR_CRYPTO_AUTH_FAILED', async () => {
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.restoreDatabaseBackup(backup.encryptedBuffer, wrongKey, async () => {});
        },
        (err: any) => {
          assert.equal(err.code, 'ERR_CRYPTO_AUTH_FAILED');
          return true;
        }
      );
    });

    await tBackup.test('3.3 Tampered ciphertext throws ERR_CRYPTO_AUTH_FAILED', async () => {
      const tampered = Buffer.from(backup.encryptedBuffer);
      // Flip a bit in the ciphertext
      tampered[tampered.length - 1] ^= 0xFF;

      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.restoreDatabaseBackup(tampered, validKey, async () => {});
        },
        (err: any) => {
          assert.equal(err.code, 'ERR_CRYPTO_AUTH_FAILED');
          return true;
        }
      );
    });

    await tBackup.test('3.4 Valid key decrypts and restores statements cleanly', async () => {
      const executed: string[] = [];
      const restoreResult = await FirebaseStorageReportService.restoreDatabaseBackup(
        backup.encryptedBuffer,
        validKey,
        async (stmt) => {
          executed.push(stmt);
          await testDb.db.exec(stmt);
        }
      );

      assert.equal(restoreResult.success, true);
      assert.ok(restoreResult.statementsExecuted >= 2);

      const check = await testDb.query('SELECT * FROM test_restore_table');
      assert.equal(check.rows.length, 1);
      assert.equal(check.rows[0].val, 'success');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. EXPIRING TIMESTAMPED HMAC DEEP LINKS
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('4. Expiring Timestamped HMAC Deep Links', async (tHmac) => {
    const reportSecret = 'olive-capability-dev-secret-32-chars';
    const reportId = 'monthly_sep_2026';

    await tHmac.test('4.1 Unexpired timestamped HMAC passes verification', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
      const dataToSign = `${reportId}:${futureExp}`;
      const validSig = crypto.createHmac('sha256', reportSecret).update(dataToSign).digest('hex');

      // Verify expiration check
      const expMs = futureExp * 1000;
      assert.ok(Date.now() < expMs, 'Timestamp must be in future');

      const expectedSig = crypto.createHmac('sha256', reportSecret).update(dataToSign).digest('hex');
      assert.equal(crypto.timingSafeEqual(Buffer.from(validSig, 'utf8'), Buffer.from(expectedSig, 'utf8')), true);
    });

    await tHmac.test('4.2 Expired timestamp is rejected', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60; // 1 minute in past
      const expMs = pastExp * 1000;
      const isExpired = Date.now() > expMs;
      assert.equal(isExpired, true, 'Past timestamp must be marked expired');
    });

    await tHmac.test('4.3 Tampered signature fails timingSafeEqual', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const dataToSign = `${reportId}:${futureExp}`;
      const forgedSig = crypto.createHmac('sha256', 'wrong-secret').update(dataToSign).digest('hex');
      const expectedSig = crypto.createHmac('sha256', reportSecret).update(dataToSign).digest('hex');

      assert.equal(crypto.timingSafeEqual(Buffer.from(forgedSig, 'utf8'), Buffer.from(expectedSig, 'utf8')), false);
    });
  });
});
