import dotenv from 'dotenv';
dotenv.config();
import { adminDb as db, adminAuth as auth } from '../config/firebase.js';

const ONLY_AUTHORIZED_OWNER = 'olivepizzarjn@gmail.com';

const ACCOUNTS_TO_REVOKE = [
  'samyakshrivastava28@gmail.com',
  'ssamyak265@gmail.com',
  's.callhub2811@gmail.com',
  'samyaks695@gmail.com',
  'shrivastavadhirendra587@gmail.com',
  'shrishikhar184@gmail.com',
  'homkumarsahu@gmail.com',
  'testowner1783509780310@example.com',
  'olivepizzamaker@gmail.com'
];

async function revokeUnauthorizedOwners() {
  console.log('🔒 Revoking Owner privileges from all unauthorized accounts...');
  console.log(`Master Owner: ${ONLY_AUTHORIZED_OWNER}\n`);

  for (const email of ACCOUNTS_TO_REVOKE) {
    const cleanEmail = email.toLowerCase().trim();
    console.log(`Checking ${cleanEmail}...`);

    // 1. Firebase Auth custom claims revocation
    try {
      const user = await auth.getUserByEmail(cleanEmail);
      if (user) {
        await auth.setCustomUserClaims(user.uid, {
          role: 'customer',
          admin: false,
          isGlobalOwner: false,
          isOwnerMode: false,
          permissions: []
        });
        await auth.revokeRefreshTokens(user.uid);
        console.log(`  ✅ Cleared Firebase Auth custom claims for ${cleanEmail} (UID: ${user.uid})`);

        // Update user doc in Firestore by UID
        await db.collection('users').doc(user.uid).set({
          role: 'customer',
          isGlobalOwner: false,
          admin: false,
          permissions: [],
          updatedAt: new Date().toISOString()
        }, { merge: true });
        console.log(`  ✅ Reset Firestore users/${user.uid} to role: 'customer'`);
      }
    } catch (err: any) {
      console.log(`  ℹ️ Auth record check: ${err.message}`);
    }

    // 2. Clear legacy Firestore docs if any (e.g. email_...)
    const emailKeyDoc = `email_${cleanEmail.replace(/[^a-z0-9]/g, '_')}`;
    const docSnap = await db.collection('users').doc(emailKeyDoc).get();
    if (docSnap.exists) {
      await db.collection('users').doc(emailKeyDoc).delete();
      console.log(`  🗑️ Deleted legacy Firestore doc: users/${emailKeyDoc}`);
    }

    // Check query by email in users collection
    const querySnap = await db.collection('users').where('email', '==', cleanEmail).get();
    for (const d of querySnap.docs) {
      if (d.data()?.role === 'owner' || d.data()?.isGlobalOwner) {
        await d.ref.set({
          role: 'customer',
          isGlobalOwner: false,
          admin: false,
          permissions: [],
          updatedAt: new Date().toISOString()
        }, { merge: true });
        console.log(`  ✅ Reset Firestore users/${d.id} to role: 'customer'`);
      }
    }
  }

  // 3. Ensure Master Owner olivepizzarjn@gmail.com is set properly
  try {
    const masterUser = await auth.getUserByEmail(ONLY_AUTHORIZED_OWNER);
    if (masterUser) {
      await auth.setCustomUserClaims(masterUser.uid, {
        role: 'owner',
        admin: true,
        isGlobalOwner: true,
        isOwnerMode: true,
        permissions: ['*']
      });
      await db.collection('users').doc(masterUser.uid).set({
        email: ONLY_AUTHORIZED_OWNER,
        role: 'owner',
        isGlobalOwner: true,
        admin: true,
        permissions: ['*'],
        updatedAt: new Date().toISOString()
      }, { merge: true });
      console.log(`\n👑 Master Owner ${ONLY_AUTHORIZED_OWNER} verified and reinforced.`);
    }
  } catch (err: any) {
    console.error('Master owner check error:', err.message);
  }

  console.log('\n✅ Cleanup complete. Only olivepizzarjn@gmail.com has owner access.');
}

revokeUnauthorizedOwners().then(() => process.exit(0)).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
