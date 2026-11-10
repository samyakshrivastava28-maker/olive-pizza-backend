import { adminAuth, adminDb } from '../config/firebase.js';

const PROTECTED_EMAILS = new Set([
  'webhub2811@gmail.com',
  'olivepizzarjn@gmail.com',
  'samyakshrivastava28@gmail.com',
  'samyaks695@gmail.com',
  'samyakssaamm@gmail.com',
  'ssamyak265@gmail.com',
  'homkumarsahu@gmail.com',
  'shrivastavadhirendra587@gmail.com',
  'shrishikhar184@gmail.com',
  's.callhub2811@gmail.com',
]);

const CONFIRMED_TEST_PATTERNS = [
  /^matrix_/i,
  /^pos_reject_/i,
  /^pos_counter1_/i,
  /^cust_isolation_/i,
  /^cust_test_/i,
  /^test_pos_/i,
  /^test_fo_/i,
  /^test_appr_/i,
  /^test_deact_/i,
  /^test_fra_/i,
  /^test_inact_/i,
  /^test_owner_/i,
  /^test_pending_/i,
  /^test_rej_/i,
  /^test_rest_/i,
  /^test_rider_/i,
  /^test_unver_/i,
  /^test@example\.com$/i,
  /^test@user\.com$/i,
  /^testowner\d+@example\.com$/i,
];

async function runCleanup() {
  console.log('--- Starting Safe Targeted Cleanup of Automated Test Accounts ---');

  const listResult = await adminAuth.listUsers(500);
  const uidsToDelete: string[] = [];
  const detailsToDelete: Array<{ uid: string; email?: string }> = [];

  for (const user of listResult.users) {
    const email = (user.email || '').toLowerCase().trim();
    const uid = user.uid;

    // Hard protection check
    if (PROTECTED_EMAILS.has(email)) {
      console.log(`[PROTECTED] Preserving authentic account: ${email} (${uid})`);
      continue;
    }

    // Check if user matches confirmed automated test patterns
    const isTestEmail = CONFIRMED_TEST_PATTERNS.some((pattern) => pattern.test(email));
    const isTestUid = CONFIRMED_TEST_PATTERNS.some((pattern) => pattern.test(uid));

    if (isTestEmail || isTestUid) {
      console.log(`[TARGET IDENTIFIED] Queuing test account for removal: ${email || 'NO_EMAIL'} (${uid})`);
      uidsToDelete.push(uid);
      detailsToDelete.push({ uid, email });
    } else {
      console.log(`[SKIPPED] Non-test / unidentified user preserved: ${email || 'PHONE_USER'} (${uid})`);
    }
  }

  console.log(`\nIdentified ${uidsToDelete.length} confirmed automated test accounts to delete.`);

  if (uidsToDelete.length === 0) {
    console.log('No automated test accounts found to delete.');
    return;
  }

  // Delete in batches of 100 via deleteUsers
  const BATCH_SIZE = 100;
  for (let i = 0; i < uidsToDelete.length; i += BATCH_SIZE) {
    const chunk = uidsToDelete.slice(i, i + BATCH_SIZE);
    const deleteResult = await adminAuth.deleteUsers(chunk);
    console.log(`Deleted batch of ${chunk.length}: success=${deleteResult.successCount}, failures=${deleteResult.failureCount}`);
  }

  // Also clean up from Firestore users and franchise_users collections
  for (const { uid } of detailsToDelete) {
    await adminDb.collection('users').doc(uid).delete().catch(() => {});
    await adminDb.collection('franchise_users').doc(uid).delete().catch(() => {});
  }

  console.log('Targeted cleanup finished successfully.');
}

runCleanup().then(() => {
  console.log('Script completed.');
  process.exit(0);
}).catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
