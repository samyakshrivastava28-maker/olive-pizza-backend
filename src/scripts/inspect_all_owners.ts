import dotenv from 'dotenv';
dotenv.config();
import { adminDb as db, adminAuth as auth } from '../config/firebase.js';

async function inspectAllOwners() {
  console.log('🔍 Inspecting all Admin and Owner accounts in Firebase Auth & Firestore...\n');

  const usersSnap = await db.collection('users').get();
  console.log(`Found ${usersSnap.size} user documents in Firestore:`);

  const ownerUids: string[] = [];

  for (const doc of usersSnap.docs) {
    const d = doc.data();
    if (
      d.role === 'owner' ||
      d.role === 'admin' ||
      d.role === 'developer' ||
      d.role === 'platform_owner' ||
      (d.email && ['olivepizzarjn@gmail.com', 'webhub2811@gmail.com'].includes(d.email.toLowerCase()))
    ) {
      console.log(`- Firestore Doc ID: ${doc.id}`);
      console.log(`  Email: ${d.email}`);
      console.log(`  Role: ${d.role}`);
      console.log(`  UID: ${d.uid}`);
      console.log(`  Permissions: ${JSON.stringify(d.permissions?.slice(0, 5))}...`);
      if (d.uid) ownerUids.push(d.uid);
      if (doc.id) ownerUids.push(doc.id);
    }
  }

  // Also list users from Firebase Auth
  const listUsersResult = await auth.listUsers(100);
  console.log(`\nFound ${listUsersResult.users.length} users in Firebase Auth:`);
  for (const u of listUsersResult.users) {
    console.log(`- Auth UID: ${u.uid} | Email: ${u.email} | Claims: ${JSON.stringify(u.customClaims)}`);
    if (u.email && ['olivepizzarjn@gmail.com', 'webhub2811@gmail.com'].includes(u.email.toLowerCase())) {
      ownerUids.push(u.uid);
      // Ensure custom claims are fresh
      await auth.setCustomUserClaims(u.uid, {
        role: 'owner',
        admin: true,
        isGlobalOwner: true,
        isOwnerMode: true,
        permissions: ['*']
      });
      console.log(`  ✅ Refreshed custom claims with admin: true, role: 'owner' for ${u.email}`);
    }
  }

  console.log('\nAll Owner UIDs to whitelist in Firestore rules:', Array.from(new Set(ownerUids)));
}

inspectAllOwners().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
