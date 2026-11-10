import { adminAuth, adminDb } from '../src/config/firebase.js';
import { FranchiseAccessService } from '../src/services/franchise/FranchiseAccessService.js';
import { pgPool } from '../src/config/postgres.js';

async function test() {
  const email = 'webhub2811@gmail.com';
  const user = await adminAuth.getUserByEmail(email).catch(e => {
    console.error('getUserByEmail failed:', e.message);
    return null;
  });
  if (!user) {
    console.error('User not found in Firebase Auth');
    process.exit(1);
  }
  console.log('Firebase user UID:', user.uid, 'email:', user.email, 'emailVerified:', user.emailVerified);

  // Check Firestore users doc
  const userDoc = await adminDb.collection('users').doc(user.uid).get();
  console.log('Firestore users doc exists:', userDoc.exists, 'data:', userDoc.data());

  // Check delivery_partners doc
  const partnerDoc = await adminDb.collection('delivery_partners').doc(user.uid).get();
  console.log('delivery_partners doc exists:', partnerDoc.exists, 'data:', partnerDoc.data());

  const result = await FranchiseAccessService.resolveAuthorization({
    uid: user.uid,
    email: user.email,
    targetApp: 'DELIVERY'
  });
  console.log('Delivery resolveAuthorization result:', JSON.stringify(result, null, 2));

  await pgPool.end().catch(() => {});
  process.exit(0);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
