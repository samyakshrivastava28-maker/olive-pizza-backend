/**
 * security_test_suite.ts — Automated Security & Location Regression Test Suite
 * Tests IDOR defense, privilege escalation, cross-app boundary enforcement,
 * parameter tampering, data minimization, and parallel location search.
 */

import fs from 'fs';
import path from 'path';
import { MultiProviderGeocodeService } from '../src/services/location/MultiProviderGeocodeService.js';
import { CustomerOrderingContextService } from '../src/services/order/CustomerOrderingContextService.js';
import {
  ResourceAccessService,
  ResponseSanitizationService,
  ApiSecurityMiddleware,
  isUserAuthorizedForApp,
  AuthenticatedSecurityUser
} from '../src/security/index.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export async function runSecurityTestSuite(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  const runTest = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  [PASS] ${name}`);
    } catch (err: any) {
      results.push({ name, passed: false, error: err?.message || String(err) });
      console.error(`  [FAIL] ${name}: ${err?.message || err}`);
    }
  };

  console.log('\n========================================================================');
  console.log('       RUNNING OLIVE PIZZA AUTOMATED SECURITY REGRESSION TEST SUITE     ');
  console.log('========================================================================\n');

  // Test 1: Location Engine — Zero Public Nominatim Autocomplete
  await runTest('Location: Nominatim Autocomplete Removed From Forward Search', async () => {
    const searchRes = await MultiProviderGeocodeService.searchParallel({
      query: 'Station Road Rajnandgaon',
      city: 'Rajnandgaon',
      limit: 5
    });

    if (searchRes.providersQueried.includes('nominatim')) {
      throw new Error('Nominatim was queried in forward search! Must be Photon, Mapbox, Geoapify, Mappls only.');
    }
    if (searchRes.results.some((r) => r.provider === 'nominatim')) {
      throw new Error('Result provider returned nominatim during forward autocomplete search!');
    }
  });

  // Test 2: Location Engine — In-Memory Serviceability Batch Check
  await runTest('Location: In-Memory Active Branches Serviceability Check', async () => {
    const branches = await CustomerOrderingContextService.getActiveBranchesSnapshot();
    if (!Array.isArray(branches)) {
      throw new Error('Active branches snapshot is not an array.');
    }

    const testCandidates = [
      { latitude: 21.0963, longitude: 81.0335 }, // Rajnandgaon coordinates
      { latitude: 28.6139, longitude: 77.2090 }  // New Delhi (out of delivery zone)
    ];

    const checks = await CustomerOrderingContextService.checkBatchServiceability(testCandidates);
    if (checks.length !== 2) {
      throw new Error(`Expected 2 check results, got ${checks.length}`);
    }
    // New Delhi candidate should be unserviceable
    if (checks[1].isServiceable === true) {
      throw new Error('New Delhi candidate incorrectly resolved as serviceable!');
    }
  });

  // Test 3: IDOR Protection — Customer Cross-Account Access Blocked
  await runTest('IDOR Defense: Customer A Cannot Access Customer B Profile', () => {
    const customerA: AuthenticatedSecurityUser = {
      uid: 'cust_A_123',
      role: 'customer',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      branchId: 'main_branch',
      branchIds: ['main_branch'],
      permissions: [],
      isActive: true,
      isGlobalOwner: false,
      isFranchiseOwner: false,
      isBranchScoped: false
    };

    let blocked = false;
    try {
      ResourceAccessService.authorizeUserAccess(customerA, 'cust_B_456');
    } catch (err: any) {
      if (err.status === 403 || err.code === 'FORBIDDEN_IDOR') {
        blocked = true;
      }
    }

    if (!blocked) {
      throw new Error('IDOR vulnerability: Customer A was allowed to access Customer B profile!');
    }
  });

  // Test 4: IDOR Protection — Customer Cross-Order Access Blocked
  await runTest('IDOR Defense: Customer A Cannot Access Customer B Order', () => {
    const customerA: AuthenticatedSecurityUser = {
      uid: 'cust_A_123',
      role: 'customer',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      branchId: 'main_branch',
      branchIds: ['main_branch'],
      permissions: [],
      isActive: true,
      isGlobalOwner: false,
      isFranchiseOwner: false,
      isBranchScoped: false
    };

    const orderB = {
      id: 'ord_B_789',
      customerId: 'cust_B_456',
      totalAmount: 499
    };

    let blocked = false;
    try {
      ResourceAccessService.authorizeOrderAccess(customerA, orderB, 'ord_B_789');
    } catch (err: any) {
      if (err.status === 403) {
        blocked = true;
      }
    }

    if (!blocked) {
      throw new Error('IDOR vulnerability: Customer A accessed order belonging to Customer B!');
    }
  });

  // Test 5: Privilege Escalation — Stripping Injected Role in Request Body
  await runTest('Security: Injected Role in Request Body Is Stripped', () => {
    const fakeReq: any = {
      user: {
        uid: 'cust_111',
        role: 'customer',
        scope: { isGlobalOwner: false }
      },
      body: {
        name: 'Attacker',
        role: 'owner',
        isAdmin: true,
        permissions: ['*']
      },
      query: {},
      params: {}
    };

    const fakeRes: any = {
      status: (code: number) => ({ json: (data: any) => ({ code, data }) })
    };

    let nextCalled = false;
    const middleware = ApiSecurityMiddleware.rejectParameterTampering();
    middleware(fakeReq, fakeRes, () => {
      nextCalled = true;
    });

    if (!nextCalled) throw new Error('Middleware did not call next()');
    if (fakeReq.body.role !== undefined) throw new Error('Injected role was not stripped!');
    if (fakeReq.body.isAdmin !== undefined) throw new Error('Injected isAdmin was not stripped!');
    if (fakeReq.body.permissions !== undefined) throw new Error('Injected permissions were not stripped!');
  });

  // Test 6: Cross-App Boundary — Customer Token Denied from Owner and POS Apps
  await runTest('App Boundary: Customer Token Denied from Owner and POS Interfaces', () => {
    const customerUser: AuthenticatedSecurityUser = {
      uid: 'cust_111',
      role: 'customer',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      branchId: 'main_branch',
      branchIds: ['main_branch'],
      permissions: [],
      isActive: true,
      isGlobalOwner: false,
      isFranchiseOwner: false,
      isBranchScoped: false
    };

    if (isUserAuthorizedForApp(customerUser, 'OWNER_APP')) {
      throw new Error('Security violation: Customer authorized for OWNER_APP!');
    }
    if (isUserAuthorizedForApp(customerUser, 'POS_APP')) {
      throw new Error('Security violation: Customer authorized for POS_APP!');
    }
    if (isUserAuthorizedForApp(customerUser, 'RESTAURANT_MANAGER_APP')) {
      throw new Error('Security violation: Customer authorized for RESTAURANT_MANAGER_APP!');
    }
    if (!isUserAuthorizedForApp(customerUser, 'CUSTOMER_APP')) {
      throw new Error('Customer should be authorized for CUSTOMER_APP!');
    }
  });

  // Test 7: Cross-Branch Scope — Manager A Denied from Branch B Operations
  await runTest('Branch Scope: Branch A Manager Denied from Accessing Branch B', () => {
    const managerA: AuthenticatedSecurityUser = {
      uid: 'mgr_A_001',
      role: 'restaurant_manager',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_primary',
      branchId: 'branch_A',
      branchIds: ['branch_A'],
      permissions: ['orders.manage'],
      isActive: true,
      isGlobalOwner: false,
      isFranchiseOwner: false,
      isBranchScoped: true
    };

    let blocked = false;
    try {
      ResourceAccessService.authorizeBranchAccess(managerA, 'branch_B');
    } catch (err: any) {
      if (err.status === 403 || err.code === 'FORBIDDEN_CROSS_BRANCH') {
        blocked = true;
      }
    }

    if (!blocked) {
      throw new Error('Cross-Branch isolation failed: Manager of Branch A accessed Branch B!');
    }
  });

  // Test 8: Data Minimization — Delivery Order DTO Strips Customer Email and Profit Margins
  await runTest('Data Minimization: Delivery Order DTO Omits Customer Email and Margins', () => {
    const rawOrder = {
      id: 'ord_123',
      orderNumber: 'OP-1234',
      status: 'out_for_delivery',
      branchId: 'main_branch',
      customerName: 'Samyak',
      customerEmail: 'customer_private@gmail.com',
      customerPhone: '9876543210',
      deliveryAddress: 'Main Road Rajnandgaon',
      profitMarginPercent: 42.5,
      foodCost: 150,
      paymentMethod: 'CASH',
      total: 450,
      internalStaffNotes: 'Sensitive notes here'
    };

    const deliveryDTO = ResponseSanitizationService.toDeliveryOrderDTO(rawOrder);

    if ((deliveryDTO as any).customerEmail !== undefined) {
      throw new Error('Data exposure: customerEmail present in DeliveryOrderDTO!');
    }
    if ((deliveryDTO as any).profitMarginPercent !== undefined) {
      throw new Error('Data exposure: profitMarginPercent present in DeliveryOrderDTO!');
    }
    if ((deliveryDTO as any).foodCost !== undefined) {
      throw new Error('Data exposure: foodCost present in DeliveryOrderDTO!');
    }
    if ((deliveryDTO as any).internalStaffNotes !== undefined) {
      throw new Error('Data exposure: internalStaffNotes present in DeliveryOrderDTO!');
    }
    if (deliveryDTO.deliveryPhone !== '9876543210') {
      throw new Error('Delivery phone must be present for rider navigation!');
    }
  });

  // Test 9: Deleted Franchise Access — Immediately Denied Across Operations
  await runTest('Franchise Security: Operations on Soft-Deleted Franchise Are Blocked', () => {
    const staffUser: AuthenticatedSecurityUser = {
      uid: 'staff_101',
      role: 'cashier',
      organizationId: 'org_olive_pizza',
      franchiseId: 'fra_deleted_01',
      branchId: 'branch_deleted_01',
      branchIds: ['branch_deleted_01'],
      permissions: [],
      isActive: true,
      isGlobalOwner: false,
      isFranchiseOwner: false,
      isBranchScoped: true
    };

    const deletedFranchiseData = {
      id: 'fra_deleted_01',
      status: 'deleted',
      isActive: false
    };

    let blocked = false;
    try {
      ResourceAccessService.authorizeFranchiseAccess(staffUser, 'fra_deleted_01', deletedFranchiseData);
    } catch (err: any) {
      if (err.status === 403 && err.code === 'FRANCHISE_INACTIVE') {
        blocked = true;
      }
    }

    if (!blocked) {
      throw new Error('Deleted franchise was not blocked!');
    }
  });

  // Test 10: Zero Direct Client Nominatim Calls in Any Frontend Repo
  await runTest('Static Integrity: Zero Direct Nominatim Calls in Any Client Project', () => {
    const frontendDirs = [
      'c:\\Users\\RYZEN\\Downloads\\olive-pizza\\frontend\\src',
      'c:\\Users\\RYZEN\\Downloads\\olive-pizza-owner\\frontend\\src',
      'c:\\Users\\RYZEN\\Downloads\\Olive Pizza restaurant manager\\src',
      'c:\\Users\\RYZEN\\Downloads\\olive-pizza-delivery\\src',
      'c:\\Users\\RYZEN\\Downloads\\olive-pizza-pos\\src',
      'c:\\Users\\RYZEN\\Downloads\\olive-pizza-franchise\\src'
    ];

    const violations: string[] = [];

    const scan = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'node_modules') scan(full);
        else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx') || e.name.endsWith('.js') || e.name.endsWith('.jsx'))) {
          const content = fs.readFileSync(full, 'utf-8');
          if (content.includes('nominatim.openstreetmap.org')) {
            violations.push(full);
          }
        }
      }
    };

    frontendDirs.forEach(scan);

    if (violations.length > 0) {
      throw new Error(`Direct Nominatim calls detected in frontend files:\n${violations.join('\n')}`);
    }
  });

  // Test 11: Parameter Tampering — Customer Injected userId Forced to Auth UID
  await runTest('Parameter Tampering: Injected Foreign userId in Body/Query Overwritten with Auth UID', () => {
    const fakeCustomerReq: any = {
      user: {
        uid: 'cust_real_123',
        role: 'customer',
        scope: { isGlobalOwner: false }
      },
      body: {
        userId: 'cust_victim_456',
        customerId: 'cust_victim_456',
        item: 'Pizza'
      },
      query: {
        userId: 'cust_victim_456'
      },
      params: {}
    };

    const fakeRes: any = {
      status: (code: number) => ({ json: (d: any) => ({ code, d }) })
    };

    const ok = ApiSecurityMiddleware.validateAndSanitize(fakeCustomerReq, fakeRes);
    if (!ok) throw new Error('Expected validateAndSanitize to pass for customer');
    if (fakeCustomerReq.body.userId !== 'cust_real_123') {
      throw new Error(`Expected body.userId to be overridden to cust_real_123, got ${fakeCustomerReq.body.userId}`);
    }
    if (fakeCustomerReq.body.customerId !== 'cust_real_123') {
      throw new Error(`Expected body.customerId to be overridden to cust_real_123, got ${fakeCustomerReq.body.customerId}`);
    }
    if (fakeCustomerReq.query.userId !== 'cust_real_123') {
      throw new Error(`Expected query.userId to be overridden to cust_real_123, got ${fakeCustomerReq.query.userId}`);
    }
  });

  // Test 12: Route Parameter Scope Tampering — Foreign :branchId Returns 403
  await runTest('Scope Tampering: Staff Route Parameter :branchId Mismatch Returns 403', () => {
    const fakeStaffReq: any = {
      user: {
        uid: 'staff_888',
        role: 'restaurant_manager',
        branchId: 'branch_allowed',
        branchIds: ['branch_allowed'],
        scope: { isBranchScoped: true, isGlobalOwner: false }
      },
      body: {},
      query: {},
      params: {
        branchId: 'branch_forbidden'
      }
    };

    let statusCode = 0;
    let responseData: any = null;
    const fakeRes: any = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (d: any) => { responseData = d; }
        };
      }
    };

    const ok = ApiSecurityMiddleware.validateAndSanitize(fakeStaffReq, fakeRes);
    if (ok) throw new Error('Expected validateAndSanitize to return false on branch mismatch');
    if (statusCode !== 403 || responseData?.code !== 'FORBIDDEN_BRANCH_TAMPERING') {
      throw new Error(`Expected 403 FORBIDDEN_BRANCH_TAMPERING, got status ${statusCode}`);
    }
  });

  // Test 13: Scope Tampering: Foreign :franchiseId Mismatch Returns 403
  await runTest('Scope Tampering: Staff Route Parameter :franchiseId Mismatch Returns 403', () => {
    const fakeStaffReq: any = {
      user: {
        uid: 'staff_999',
        role: 'franchise_manager',
        franchiseId: 'fra_allowed',
        scope: { isGlobalOwner: false }
      },
      body: {},
      query: {},
      params: {
        franchiseId: 'fra_forbidden'
      }
    };

    let statusCode = 0;
    let responseData: any = null;
    const fakeRes: any = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (d: any) => { responseData = d; }
        };
      }
    };

    const ok = ApiSecurityMiddleware.validateAndSanitize(fakeStaffReq, fakeRes);
    if (ok) throw new Error('Expected validateAndSanitize to return false on franchise mismatch');
    if (statusCode !== 403 || responseData?.code !== 'FORBIDDEN_FRANCHISE_TAMPERING') {
      throw new Error(`Expected 403 FORBIDDEN_FRANCHISE_TAMPERING, got status ${statusCode}`);
    }
  });

  console.log('\n========================================================================');
  const allPassed = results.every((r) => r.passed);
  console.log(`TEST SUMMARY: ${results.filter((r) => r.passed).length}/${results.length} PASSED`);
  if (!allPassed) {
    console.error('FAILED TESTS:');
    results.filter((r) => !r.passed).forEach((r) => console.error(`  - ${r.name}: ${r.error}`));
  }
  console.log('========================================================================\n');

  return results;
}

if (process.argv[1]?.endsWith('security_test_suite.ts')) {
  runSecurityTestSuite().then((res) => {
    const passed = res.every((r) => r.passed);
    process.exit(passed ? 0 : 1);
  });
}
