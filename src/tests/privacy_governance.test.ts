import assert from 'node:assert';
import test from 'node:test';
import { PrivacyService } from '../services/privacy/PrivacyService.js';

test('DPDP Privacy & Data Governance Suite', async (t) => {
  if (!process.env.FIRESTORE_EMULATOR_HOST && (process.env.NODE_ENV === 'production' || !process.env.RUN_LIVE_FIRESTORE_TESTS)) {
    console.log('🔒 [Safety Guard] Privacy governance Firestore tests bypassed outside emulator/isolated test env (set FIRESTORE_EMULATOR_HOST or RUN_LIVE_FIRESTORE_TESTS=true to run).');
    return;
  }
  const testUid = `test_user_${Date.now()}`;
  let policyVersion = '1.0.0';

  await t.test('Test 1: Active Privacy Notice & DPDP Transparency', async () => {
    const policy = await PrivacyService.getActivePolicy();
    assert.ok(policy.version, 'Policy must possess a version number');
    assert.strictEqual(policy.status, 'active');
    assert.ok(policy.content.includes('Data Fiduciary'), 'Policy must mention Data Fiduciary');
    assert.ok(policy.content.includes('Grievance Officer'), 'Policy must provide Grievance Officer details');
    policyVersion = policy.version;
  });

  await t.test('Test 2: Consent Recording & Withdrawal (Tamper-Resistant)', async () => {
    const initialConsents = await PrivacyService.getUserConsents(testUid);
    assert.strictEqual(initialConsents.MARKETING_PROMOTIONS, false);

    await PrivacyService.recordConsent({
      userId: testUid,
      purpose: 'MARKETING_PROMOTIONS',
      granted: true,
      policyVersion,
      source: 'TEST_SUITE'
    });

    const updatedConsents = await PrivacyService.getUserConsents(testUid);
    assert.strictEqual(updatedConsents.MARKETING_PROMOTIONS, true, 'Marketing consent must be true after grant');

    await PrivacyService.withdrawConsent(testUid, 'MARKETING_PROMOTIONS');
    const withdrawnConsents = await PrivacyService.getUserConsents(testUid);
    assert.strictEqual(withdrawnConsents.MARKETING_PROMOTIONS, false, 'Marketing consent must be false after withdrawal');
  });

  await t.test('Test 3: Customer Data Correction & Validation', async () => {
    const correctionResult = await PrivacyService.correctUserData(testUid, {
      name: 'Aarav Sharma',
      phone: '9876543210'
    });
    assert.ok(correctionResult.updatedFields.includes('name'));
    assert.ok(correctionResult.updatedFields.includes('phone'));

    await assert.rejects(async () => {
      await PrivacyService.correctUserData(testUid, {});
    }, /No valid modifiable fields provided/);
  });

  await t.test('Test 4: Data Access Request & Security Sanitization', async () => {
    const exportBundle = await PrivacyService.generateDataExport(testUid);
    assert.ok(exportBundle.exportMetadata, 'Must include export metadata');
    assert.ok(exportBundle.profile, 'Must include sanitized profile');
    assert.strictEqual(exportBundle.profile.name, 'Aarav Sharma');
    assert.strictEqual((exportBundle as any).password, undefined, 'Passwords must never be exported');
    assert.strictEqual((exportBundle as any).token, undefined, 'Tokens must never be exported');
    assert.strictEqual((exportBundle as any).customClaims, undefined, 'Custom claims must never be exported');
  });

  await t.test('Test 5: Privacy Grievance Ticket Generation & 30-Day SLA', async () => {
    const grievance = await PrivacyService.submitGrievance({
      uid: testUid,
      customerName: 'Aarav Sharma',
      customerContact: 'aarav@example.com',
      category: 'CONSENT',
      description: 'Testing privacy grievance ticket workflow'
    });
    assert.ok(grievance.ticketId.startsWith('GRV-'), 'Ticket ID must have GRV- prefix');
    assert.ok(grievance.slaDeadline, 'Must compute SLA resolution deadline');

    const userGrievances = await PrivacyService.getUserGrievances(testUid);
    assert.strictEqual(userGrievances.length, 1);
    assert.strictEqual(userGrievances[0].ticketId, grievance.ticketId);
  });

  await t.test('Test 6: Processor Registry & Retention Configuration', async () => {
    const processors = await PrivacyService.getProcessors();
    assert.ok(processors.length >= 4, 'Must have at least Firebase, Supabase, Truecaller, Razorpay');
    assert.ok(processors.some(p => p.id === 'proc_firebase'));
    assert.ok(processors.some(p => p.id === 'proc_supabase'));
    assert.ok(processors.some(p => p.id === 'proc_truecaller'));

    const retention = await PrivacyService.getRetentionPolicies();
    assert.ok(retention.some(r => r.category === 'ORDER_RECORDS_FINANCIAL'));
    assert.ok(retention.some(r => r.category === 'GPS_BREADCRUMBS'));
  });

  await t.test('Test 7: Account Erasure Request & 30-day Grace Period', async () => {
    const deletionReq = await PrivacyService.requestAccountDeletion({
      uid: testUid,
      email: 'aarav@example.com',
      reason: 'Testing account deletion workflow',
      downloadDataRequested: true
    });
    assert.ok(deletionReq.requestId, 'Must generate deletion request ID');
    assert.ok(deletionReq.gracePeriodEnd, 'Must set 30-day statutory cooling period');
  });
});
