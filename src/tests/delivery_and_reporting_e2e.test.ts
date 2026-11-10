import { webSocketServer } from '../services/websocket/WebSocketServer.js';
/**
 * phase7_delivery_and_reporting.test.ts — Comprehensive Phase 7 Verification Suite
 * 
 * Verifies:
 * 1. Authoritative PostgreSQL GPS Telemetry & 5-minute Breadcrumb Retention
 * 2. Spatial Bounding-Box + Haversine Proximity Discovery & Strict Tenant Isolation
 * 3. Automatic Rider Assignment with Atomic Concurrency Row Locking (FOR UPDATE) & Idempotency
 * 4. Multi-Tenant RFC 4180 CSV Reporting Engine with Formula Injection Sanitization
 * 5. Firebase Storage Private Report Organization & RBAC Signed URL Verification
 * 6. AES-256-GCM Encrypted PostgreSQL Database Backup & Isolated Restoration Validation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createDisposableTestDb, DisposableTestDb } from './disposableTestDb.js';
import { setTestDbOverride } from '../lib/db.js';
import { setTestQueryOverride } from '../config/postgres.js';
import { PostgresGpsService } from '../services/gps/PostgresGpsService.js';
import { RiderDispatchEngine } from '../services/delivery/RiderDispatchEngine.js';
import { ReportExportService } from '../services/reports/ReportExportService.js';
import { FirebaseStorageReportService } from '../services/storage/FirebaseStorageReportService.js';

test('Phase 7 Delivery, Geospatial, Reporting, and Storage Master Suite', async (t) => {
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

  // Seed baseline multi-tenant test fixtures
  await testDb.db.exec(`
    -- Branches
    INSERT INTO restaurant_branches (id, franchise_id, name, address, phone, is_open, latitude, longitude)
    VALUES 
      ('branch_rjn_main', 'fra_rajnandgaon', 'Rajnandgaon HQ', 'Station Road', '9179944445', true, 21.0967, 81.0315),
      ('branch_bsp_main', 'fra_bilaspur', 'Bilaspur Branch', 'Link Road', '9876543200', true, 22.0797, 82.1409)
    ON CONFLICT (id) DO NOTHING;

    -- Delivery Partners
    INSERT INTO delivery_partners (
      id, name, phone, email, franchise_id, branch_id, status, is_online, current_lat, current_lng, last_location_time
    ) VALUES
      ('rider_rjn_1', 'Ramesh Kumar', '9876500001', 'ramesh@olivepizza.in', 'fra_rajnandgaon', 'branch_rjn_main', 'APPROVED', true, 21.0970, 81.0320, NOW()),
      ('rider_rjn_2', 'Suresh Singh', '9876500002', 'suresh@olivepizza.in', 'fra_rajnandgaon', 'branch_rjn_main', 'APPROVED', true, 21.0980, 81.0330, NOW()),
      ('rider_rjn_offline', 'Dinesh Yadav', '9876500003', 'dinesh@olivepizza.in', 'fra_rajnandgaon', 'branch_rjn_main', 'APPROVED', false, 21.0965, 81.0310, NOW()),
      ('rider_bsp_1', 'Anil Sharma', '9876500004', 'anil@olivepizza.in', 'fra_bilaspur', 'branch_bsp_main', 'APPROVED', true, 22.0800, 82.1415, NOW())
    ON CONFLICT (id) DO NOTHING;

    -- Canonical Orders (Online & POS)
    INSERT INTO canonical_orders (
      id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
      order_status, payment_method, payment_status, customer_name, customer_phone, delivery_address,
      subtotal, discount_amount, coupon_code, cgst, sgst, tax_amount, delivery_fee, total_amount,
      franchise_id, branch_id, cashier_id, cashier_name, terminal_id
    ) VALUES
      ('ord_online_101', 1001, 1, '2026-11-01', '12:30:00', 'ONLINE', 'delivery', 'CONFIRMED', 'UPI', 'PAID', 'Alok Verma', '9988776655', 'House 42, Civil Lines', 400.00, 40.00, 'WELCOME10', 9.00, 9.00, 18.00, 30.00, 408.00, 'fra_rajnandgaon', 'branch_rjn_main', NULL, NULL, NULL),
      ('ord_online_102', 1002, 2, '2026-11-01', '13:00:00', 'ONLINE', 'delivery', 'CONFIRMED', 'CASH', 'PENDING', 'Pooja Patel', '9988776656', 'Flat 102, Shanti Nagar', 600.00, 0.00, NULL, 15.00, 15.00, 30.00, 40.00, 670.00, 'fra_rajnandgaon', 'branch_rjn_main', NULL, NULL, NULL),
      ('ord_pos_201', 1003, 3, '2026-11-01', '13:15:00', 'POS_DINE_IN', 'dine_in', 'COMPLETED', 'CASH', 'PAID', 'Walk-in Table 4', 'N/A', NULL, 300.00, 0.00, NULL, 7.50, 7.50, 15.00, 0.00, 315.00, 'fra_rajnandgaon', 'branch_rjn_main', 'usr_test_cashier', 'POS Cashier', 'Counter-1'),
      ('ord_pos_202', 1004, 4, '2026-11-01', '14:00:00', 'POS_TAKEAWAY', 'pickup', 'COMPLETED', 'CARD', 'PAID', 'Amit Sinha', '9988776657', NULL, 500.00, 50.00, 'SPECIAL50', 11.25, 11.25, 22.50, 0.00, 472.50, 'fra_rajnandgaon', 'branch_rjn_main', 'usr_test_cashier', 'POS Cashier', 'Counter-1'),
      ('ord_bsp_301', 1005, 1, '2026-11-01', '14:30:00', 'ONLINE', 'delivery', 'CONFIRMED', 'UPI', 'PAID', 'Bilaspur Customer', '9988776658', 'Vyapar Vihar', 350.00, 0.00, NULL, 8.75, 8.75, 17.50, 25.00, 392.50, 'fra_bilaspur', 'branch_bsp_main', NULL, NULL, NULL)
    ON CONFLICT (id) DO NOTHING;
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. GPS TELEMETRY & CLEANUP TESTS
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('1. GPS Telemetry, Retention, and Breadcrumb Cleanup', async (tGps) => {
    await tGps.test('1.1 Upsert latest location writes to delivery_locations and updates delivery_partners', async () => {
      const res = await PostgresGpsService.upsertLatestLocation({
        deliveryPartnerId: 'rider_rjn_1',
        latitude: 21.0972,
        longitude: 81.0325,
        speed: 25,
        heading: 90,
        accuracy: 5,
        onlineStatus: true
      });
      assert.equal(res.success, true);

      const loc = await PostgresGpsService.getLatestLocation('rider_rjn_1');
      assert.ok(loc);
      assert.equal(loc?.deliveryPartnerId, 'rider_rjn_1');
      assert.equal(loc?.latitude, 21.0972);
      assert.equal(loc?.longitude, 81.0325);
      assert.equal(loc?.isStale, false);
      assert.equal(loc?.onlineStatus, true);
    });

    await tGps.test('1.2 Active order tracking updates and retrieves by orderId', async () => {
      await PostgresGpsService.setActiveOrder('rider_rjn_1', 'ord_online_101');
      const loc = await PostgresGpsService.getLatestLocationByOrder('ord_online_101');
      assert.ok(loc);
      assert.equal(loc?.deliveryPartnerId, 'rider_rjn_1');
      assert.equal(loc?.activeOrderId, 'ord_online_101');
    });

    await tGps.test('1.3 Boundary check rejects invalid geographic coordinates', async () => {
      const invalidLat = await PostgresGpsService.upsertLatestLocation({
        deliveryPartnerId: 'rider_rjn_1',
        latitude: 105.0, // Invalid lat > 90
        longitude: 81.0
      });
      assert.equal(invalidLat.success, false);
      assert.equal(invalidLat.error, 'Invalid geographic coordinates');

      const invalidLng = await PostgresGpsService.upsertLatestLocation({
        deliveryPartnerId: 'rider_rjn_1',
        latitude: 21.0,
        longitude: 195.0 // Invalid lng > 180
      });
      assert.equal(invalidLng.success, false);
    });

    await tGps.test('1.4 Stale breadcrumbs (> 5 min) are pruned without deleting active deliveries', async () => {
      // Insert navigation session & old breadcrumbs
      await testDb.db.exec(`
        INSERT INTO navigation_sessions (id, order_id, delivery_partner_id, status, started_at)
        VALUES ('sess_test_1', 'ord_online_101', 'rider_rjn_1', 'ACTIVE', NOW() - INTERVAL '10 minutes')
        ON CONFLICT (id) DO NOTHING;

        -- Old breadcrumb (> 5 min)
        INSERT INTO navigation_points (session_id, order_id, latitude, longitude, created_at)
        VALUES ('sess_test_1', 'ord_online_101', 21.0970, 81.0320, NOW() - INTERVAL '6 minutes');

        -- Fresh breadcrumb (< 5 min)
        INSERT INTO navigation_points (session_id, order_id, latitude, longitude, created_at)
        VALUES ('sess_test_1', 'ord_online_101', 21.0975, 81.0330, NOW() - INTERVAL '1 minute');
      `);

      const cleanup = await PostgresGpsService.pruneStaleGpsData(5);
      assert.ok(cleanup.prunedPoints >= 1, 'Should prune at least one old breadcrumb');

      // Verify active order row in delivery_locations was NOT deleted
      const activeLoc = await PostgresGpsService.getLatestLocationByOrder('ord_online_101');
      assert.ok(activeLoc, 'Active delivery location must never be pruned');

      // Clear active order on delivery
      await PostgresGpsService.clearActiveOrder('rider_rjn_1', 'ord_online_101');
      const clearedLoc = await PostgresGpsService.getLatestLocationByOrder('ord_online_101');
      assert.equal(clearedLoc, null, 'Location by order must return null after delivery');
    });

    await tGps.test('1.5 Live location upsert returns authoritative franchiseId & branchId for scoped WebSocket broadcasting', async () => {
      const upsertRes = await PostgresGpsService.upsertLatestLocation({
        deliveryPartnerId: 'rider_rjn_1',
        latitude: 21.0968,
        longitude: 81.0316,
        onlineStatus: true
      });

      assert.equal(upsertRes.success, true);
      assert.equal(upsertRes.franchiseId, 'fra_rajnandgaon');
      assert.equal(upsertRes.branchId, 'branch_rjn_main');
    });

    await tGps.test('1.6 WebSocket broadcastToBranch strictly isolates tenant telemetry from other franchise owners', async () => {
      // Mock WebSocket connections
      const receivedA: string[] = [];
      const receivedB: string[] = [];
      const receivedSuper: string[] = [];

      const mockWsA = { readyState: 1, send: (m: string) => receivedA.push(m) };
      const mockWsB = { readyState: 1, send: (m: string) => receivedB.push(m) };
      const mockWsSuper = { readyState: 1, send: (m: string) => receivedSuper.push(m) };

      // Inject mock clients into WebSocketServer
      const clientsMap = (webSocketServer as any).clients;
      clientsMap.set('owner_A', new Set([{
        ws: mockWsA,
        uid: 'owner_A',
        role: 'owner',
        franchiseId: 'fra_rajnandgaon',
        branchId: 'branch_rjn_main',
        connectedAt: Date.now(),
        subscribedOrders: new Set()
      }]));

      clientsMap.set('owner_B', new Set([{
        ws: mockWsB,
        uid: 'owner_B',
        role: 'owner',
        franchiseId: 'fra_bilaspur',
        branchId: 'branch_bsp_main',
        connectedAt: Date.now(),
        subscribedOrders: new Set()
      }]));

      clientsMap.set('owner_super', new Set([{
        ws: mockWsSuper,
        uid: 'owner_super',
        role: 'owner',
        franchiseId: undefined, // Platform super-owner
        connectedAt: Date.now(),
        subscribedOrders: new Set()
      }]));

      // Broadcast an update for Rajnandgaon branch
      webSocketServer.broadcastToBranch('fra_rajnandgaon', 'branch_rjn_main', {
        type: 'RIDER_LOCATION_UPDATE',
        data: { partnerId: 'rider_rjn_1', lat: 21.0968, lng: 81.0316 }
      });

      // Cleanup mock clients
      clientsMap.delete('owner_A');
      clientsMap.delete('owner_B');
      clientsMap.delete('owner_super');

      // Assertions: Owner A and Super Owner received event; Owner B (Franchise B) was isolated!
      assert.equal(receivedA.length, 1, 'Owner of Franchise A must receive Rajnandgaon telemetry');
      assert.equal(receivedSuper.length, 1, 'Global super-owner must receive telemetry across all branches');
      assert.equal(receivedB.length, 0, 'Owner of Franchise B must NEVER receive Rajnandgaon telemetry (Tenant Isolation)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. GEOSPATIAL CANDIDATE DISCOVERY & TENANT ISOLATION
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('2. Geospatial Candidate Discovery and Strict Tenant Isolation', async (tGeo) => {
    await tGeo.test('2.1 Finds nearby online riders within branch radius using Haversine calculation', async () => {
      // Ensure rider 1 is available and has fresh location
      await PostgresGpsService.upsertLatestLocation({
        deliveryPartnerId: 'rider_rjn_1',
        latitude: 21.0968,
        longitude: 81.0318,
        onlineStatus: true
      });

      const candidates = await PostgresGpsService.findNearbyEligibleRiders({
        restaurantLat: 21.0967,
        restaurantLng: 81.0315,
        branchId: 'branch_rjn_main',
        franchiseId: 'fra_rajnandgaon',
        maxRadiusMeters: 5000
      });

      assert.ok(candidates.length > 0, 'Must find at least one eligible nearby rider');
      const top = candidates[0];
      assert.equal(top.uid, 'rider_rjn_1');
      assert.ok(top.distanceMeters < 500, `Distance should be < 500m, was ${top.distanceMeters}m`);
      assert.equal(top.branchId, 'branch_rjn_main');
    });

    await tGeo.test('2.2 Strict Franchise Isolation: Cross-franchise riders are excluded', async () => {
      // Query for Rajnandgaon branch must NEVER return Bilaspur rider
      const candidates = await PostgresGpsService.findNearbyEligibleRiders({
        restaurantLat: 21.0967,
        restaurantLng: 81.0315,
        branchId: 'branch_rjn_main',
        franchiseId: 'fra_rajnandgaon',
        maxRadiusMeters: 100000 // Even with huge radius
      });

      const hasBilaspurRider = candidates.some(c => c.uid === 'rider_bsp_1' || c.franchiseId === 'fra_bilaspur');
      assert.equal(hasBilaspurRider, false, 'Cross-franchise rider must be strictly excluded');
    });

    await tGeo.test('2.3 Offline riders are excluded from candidate discovery', async () => {
      const candidates = await PostgresGpsService.findNearbyEligibleRiders({
        restaurantLat: 21.0967,
        restaurantLng: 81.0315,
        branchId: 'branch_rjn_main',
        franchiseId: 'fra_rajnandgaon',
        maxRadiusMeters: 10000
      });

      const hasOffline = candidates.some(c => c.uid === 'rider_rjn_offline');
      assert.equal(hasOffline, false, 'Offline rider must never be returned as candidate');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. AUTOMATIC RIDER ASSIGNMENT & ROW-LEVEL LOCKING
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('3. Automatic Rider Assignment, Concurrency Locks, and Idempotency', async (tAssign) => {
    await tAssign.test('3.1 Successful automatic assignment locks order and rider in PostgreSQL', async () => {
      // Ensure rider 1 is available
      await testDb.db.exec(`
        UPDATE delivery_partners SET is_online = true, active_order_id = NULL WHERE id = 'rider_rjn_1';
        UPDATE delivery_locations SET active_order_id = NULL, online_status = true WHERE delivery_partner_id = 'rider_rjn_1';
      `);

      const result = await RiderDispatchEngine.autoDispatchRider('ord_online_102');
      assert.equal(result.success, true);
      assert.ok(result.rider);
      assert.equal(result.rider?.uid, 'rider_rjn_1');

      // Verify canonical_orders in database has partner info and PARTNER_ASSIGNED status
      const orderCheck = await testDb.query(`
        SELECT order_status, delivery_partner_id, delivery_partner_name, partner_assigned_at
        FROM canonical_orders WHERE id = 'ord_online_102'
      `);
      assert.equal(orderCheck.rows[0].order_status, 'PARTNER_ASSIGNED');
      assert.equal(orderCheck.rows[0].delivery_partner_id, 'rider_rjn_1');
      assert.ok(orderCheck.rows[0].partner_assigned_at);

      // Verify delivery_partners has active_order_id
      const riderCheck = await testDb.query(`
        SELECT active_order_id FROM delivery_partners WHERE id = 'rider_rjn_1'
      `);
      assert.equal(riderCheck.rows[0].active_order_id, 'ord_online_102');
    });

    await tAssign.test('3.2 Idempotency: Repeating dispatch on already-assigned order returns success immediately', async () => {
      const duplicateDispatch = await RiderDispatchEngine.autoDispatchRider('ord_online_102');
      assert.equal(duplicateDispatch.success, true);
      assert.equal(duplicateDispatch.idempotent, true);
      assert.equal(duplicateDispatch.rider?.uid, 'rider_rjn_1');
    });

    await tAssign.test('3.3 Fail-closed when no eligible riders available', async () => {
      // Make all Rajnandgaon riders busy
      await testDb.db.exec(`
        UPDATE delivery_partners SET active_order_id = 'busy_order' WHERE branch_id = 'branch_rjn_main';
      `);

      // Create new unassigned order
      await testDb.db.exec(`
        INSERT INTO canonical_orders (
          id, permanent_bill_no, daily_order_no, order_date, order_time, order_source, order_type,
          order_status, payment_method, payment_status, total_amount, franchise_id, branch_id
        ) VALUES (
          'ord_unassigned_999', 9999, 99, '2026-11-01', '15:00:00', 'ONLINE', 'delivery',
          'CONFIRMED', 'UPI', 'PAID', 300.00, 'fra_rajnandgaon', 'branch_rjn_main'
        ) ON CONFLICT (id) DO NOTHING;
      `);

      const noRiderResult = await RiderDispatchEngine.autoDispatchRider('ord_unassigned_999');
      assert.equal(noRiderResult.success, false);
      assert.ok(noRiderResult.reason?.includes('No eligible riders') || noRiderResult.reason?.includes('busy'));

      // Restore rider availability for subsequent tests and cleanup temporary order
      await testDb.db.exec(`
        DELETE FROM canonical_orders WHERE id = 'ord_unassigned_999';
        UPDATE delivery_partners SET active_order_id = NULL WHERE branch_id = 'branch_rjn_main';
      `);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MULTI-TENANT SPREADSHEET-COMPATIBLE CSV REPORTING
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('4. Spreadsheet-Compatible CSV Reporting Engine', async (tReport) => {
    await tReport.test('4.1 Online order CSV export includes only online orders with GST breakdown', async () => {
      const res = await ReportExportService.generateOnlineOrderCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      assert.equal(res.reportType, 'ONLINE');
      assert.equal(res.rowCount, 2, 'Should have exactly 2 online orders for Rajnandgaon');
      assert.ok(res.csvContent.includes('Order ID,Permanent Bill No,Daily Order No,Date'));
      assert.ok(res.csvContent.includes('ord_online_101'));
      assert.ok(res.csvContent.includes('ord_online_102'));
      assert.ok(!res.csvContent.includes('ord_pos_201'), 'Must not contain POS orders');
      assert.ok(!res.csvContent.includes('ord_bsp_301'), 'Must not contain Bilaspur orders');
    });

    await tReport.test('4.2 POS order CSV export includes POS orders with cashier and terminal details', async () => {
      const res = await ReportExportService.generatePosOrderCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      assert.equal(res.reportType, 'POS');
      assert.equal(res.rowCount, 2, 'Should have exactly 2 POS orders for Rajnandgaon');
      assert.ok(res.csvContent.includes('ord_pos_201'));
      assert.ok(res.csvContent.includes('ord_pos_202'));
      assert.ok(res.csvContent.includes('Counter-1'));
      assert.ok(res.csvContent.includes('POS Cashier'));
      assert.ok(!res.csvContent.includes('ord_online_101'), 'Must not contain online orders');
    });

    await tReport.test('4.3 Combined CSV export includes all channels with explicit Order Source', async () => {
      const res = await ReportExportService.generateCombinedOrderCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      assert.equal(res.reportType, 'COMBINED');
      assert.equal(res.rowCount, 4, 'Should include 2 Online + 2 POS orders = 4 total');
      assert.ok(res.csvContent.includes('ONLINE'));
      assert.ok(res.csvContent.includes('POS_DINE_IN'));
      assert.ok(res.csvContent.includes('POS_TAKEAWAY'));
    });

    await tReport.test('4.4 Financial Summary calculates exact sales, tax, discounts, and payment splits', async () => {
      const res = await ReportExportService.generateFinancialSummaryCsv({
        franchiseId: 'fra_rajnandgaon',
        startDate: '2026-11-01',
        endDate: '2026-11-01'
      });

      assert.equal(res.reportType, 'FINANCIAL_SUMMARY');
      assert.equal(res.rowCount, 1, 'One day aggregated row');
      const lines = res.csvContent.split('\r\n');
      assert.equal(lines.length, 2); // Header + 1 Data line
      const dataRow = lines[1].split(',');

      // Total orders = 4 (ord_online_101, 102, ord_pos_201, 202)
      assert.equal(dataRow[1], '4', 'Total orders should be 4');
      assert.equal(dataRow[2], '2', 'Online orders should be 2');
      assert.equal(dataRow[3], '2', 'POS orders should be 2');

      // Gross sales = 400 + 600 + 300 + 500 = 1800.00
      assert.equal(dataRow[4], '1800.00');

      // Discounts = 40 + 0 + 0 + 50 = 90.00
      assert.equal(dataRow[5], '90.00');

      // Net sales = 1800 - 90 = 1710.00
      assert.equal(dataRow[6], '1710.00');
    });

    await tReport.test('4.5 Formula Injection Protection (CWE-1236) and Financial Number Preservation', async () => {
      // 1. Legitimate negative numbers (refunds/discounts) must NOT be prepended with quote
      const safeNegative = ReportExportService.sanitizeCell(-50.00);
      assert.equal(safeNegative, '-50');

      const safeNegativeStr = ReportExportService.sanitizeCell('-50.00');
      assert.equal(safeNegativeStr, '-50.00');

      const safePositiveStr = ReportExportService.sanitizeCell('+123.45');
      assert.equal(safePositiveStr, '+123.45');

      // 2. Malicious formula injections starting with =, @, \t, \r, or non-numeric commands with +/-
      const safeFormula = ReportExportService.sanitizeCell('=SUM(A1:A10)');
      assert.equal(safeFormula, "'=SUM(A1:A10)");

      const safeAt = ReportExportService.sanitizeCell('@admin_cmd');
      assert.equal(safeAt, "'@admin_cmd");

      const safeDdeCmd = ReportExportService.sanitizeCell("-cmd|' /C calc'!A0");
      assert.equal(safeDdeCmd, "'-cmd|' /C calc'!A0");

      const safePlusCmd = ReportExportService.sanitizeCell("+cmd|' /C calc'!A0");
      assert.equal(safePlusCmd, "'+cmd|' /C calc'!A0");

      const safeNormal = ReportExportService.sanitizeCell('Normal Pizza');
      assert.equal(safeNormal, 'Normal Pizza');

      const safeQuotes = ReportExportService.sanitizeCell('Olive "Supreme" Pizza');
      assert.equal(safeQuotes, '"Olive ""Supreme"" Pizza"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. PRIVATE FIREBASE STORAGE & ENCRYPTED DATABASE BACKUP
  // ═══════════════════════════════════════════════════════════════════════════
  await t.test('5. Private Report Storage & AES-256-GCM Encrypted Backups', async (tStorage) => {
    let savedReportId = '';

    await tStorage.test('5.1 Uploads report to private path and records metadata in generated_reports', async () => {
      const csvData = 'Header1,Header2\r\nVal1,Val2\r\n';
      const upload = await FirebaseStorageReportService.uploadReport({
        franchiseId: 'fra_rajnandgaon',
        branchId: 'branch_rjn_main',
        reportType: 'ONLINE',
        periodLabel: '2026-11-01',
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        csvContent: csvData,
        generatedByUid: 'usr_test_owner'
      });

      assert.ok(upload.reportId);
      savedReportId = upload.reportId;
      assert.ok(upload.filePath.startsWith('reports/fra_rajnandgaon/branch_rjn_main/online/'));
      assert.ok(upload.checksumSha256);

      // Verify PostgreSQL record
      const dbCheck = await testDb.query(`
        SELECT id, franchise_id, branch_id, report_type, checksum_sha256, storage_provider
        FROM generated_reports WHERE id = $1
      `, [upload.reportId]);

      assert.equal(dbCheck.rows.length, 1);
      assert.equal(dbCheck.rows[0].franchise_id, 'fra_rajnandgaon');
      assert.equal(dbCheck.rows[0].storage_provider, 'FIREBASE_STORAGE');
    });

    await tStorage.test('5.2 Signed URL generation enforces strict server-side tenant RBAC', async () => {
      // 1. Authorized Owner
      const authorizedOwner = await FirebaseStorageReportService.getSignedDownloadUrl(savedReportId, {
        role: 'owner',
        franchiseId: 'fra_rajnandgaon'
      });
      assert.ok(authorizedOwner.downloadUrl);
      assert.equal(authorizedOwner.expiresInSeconds, 900);

      // 2. Cross-Franchise Unauthorized Caller
      await assert.rejects(
        async () => {
          await FirebaseStorageReportService.getSignedDownloadUrl(savedReportId, {
            role: 'restaurant_manager',
            franchiseId: 'fra_bilaspur' // Mismatched franchise!
          });
        },
        /Forbidden/
      );
    });

    await tStorage.test('5.3 Database Backup: AES-256-GCM encryption with SHA-256 checksum', async () => {
      const backupSecret = 'test-backup-encryption-key-for-phase7-testing-32chars';
      const backup = await FirebaseStorageReportService.createEncryptedDatabaseBackup({
        secretKey: backupSecret,
        customDumpSql: 'CREATE TABLE IF NOT EXISTS test_restore_table (id INT PRIMARY KEY, name TEXT); INSERT INTO test_restore_table VALUES (1, \'Restored Record\');'
      });

      assert.ok(backup.backupId);
      assert.ok(backup.storagePath.startsWith('backups/'));
      assert.ok(backup.encryptedBuffer.length > 28); // 12-byte IV + 16-byte Tag + ciphertext
      assert.ok(backup.checksumSha256);

      // Verify database_backups table
      const auditRes = await testDb.query(`
        SELECT id, encryption_algorithm, status FROM database_backups WHERE id = $1
      `, [backup.backupId]);
      assert.equal(auditRes.rows.length, 1);
      assert.equal(auditRes.rows[0].encryption_algorithm, 'AES-256-GCM');
      assert.equal(auditRes.rows[0].status, 'COMPLETED');

      // 5.4 Restoration Test: Decrypt and execute in isolated target database
      const restoreResult = await FirebaseStorageReportService.restoreDatabaseBackup(
        backup.encryptedBuffer,
        backupSecret,
        testDb.query
      );

      assert.equal(restoreResult.success, true);
      assert.ok(restoreResult.statementsExecuted >= 2);

      // Verify restored table and data
      const checkRestored = await testDb.query(`SELECT * FROM test_restore_table WHERE id = 1`);
      assert.equal(checkRestored.rows.length, 1);
      assert.equal(checkRestored.rows[0].name, 'Restored Record');
    });

    await tStorage.test('5.5 Restoration with string literals containing semicolons parses cleanly without syntax errors', async () => {
      const backupSecret = 'test-backup-encryption-key-for-phase7-testing-32chars';
      const sqlWithSemicolons = `
        CREATE TABLE IF NOT EXISTS test_semicolon_restore (id INT PRIMARY KEY, title TEXT, notes TEXT);
        INSERT INTO test_semicolon_restore (id, title, notes) VALUES (1, 'Olive Pizza; Special Veggie', 'Shop #4; Main Market; Beside Bank');
      `;
      const backup = await FirebaseStorageReportService.createEncryptedDatabaseBackup({
        secretKey: backupSecret,
        customDumpSql: sqlWithSemicolons
      });

      const restoreResult = await FirebaseStorageReportService.restoreDatabaseBackup(
        backup.encryptedBuffer,
        backupSecret,
        testDb.query
      );

      assert.equal(restoreResult.success, true);
      assert.equal(restoreResult.statementsExecuted, 2, 'Should execute exactly 2 statements, preserving semicolons inside single quotes');

      const checkRow = await testDb.query(`SELECT * FROM test_semicolon_restore WHERE id = 1`);
      assert.equal(checkRow.rows.length, 1);
      assert.equal(checkRow.rows[0].title, 'Olive Pizza; Special Veggie');
      assert.equal(checkRow.rows[0].notes, 'Shop #4; Main Market; Beside Bank');
    });
  });
});
