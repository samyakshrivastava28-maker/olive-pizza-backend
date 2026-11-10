import dotenv from 'dotenv';
dotenv.config();
import { adminDb as db, adminAuth as auth } from '../config/firebase.js';

async function grantAllDevAndOwnerFullAccess() {
  console.log('👑 Elevating All Developer and Owner Accounts to Full Unrestricted Owner Access...\n');

  const adminEmails = [
    'olivepizzarjn@gmail.com',
    'webhub2811@gmail.com',
    'samyakshrivastava28@gmail.com',
    'ssamyak265@gmail.com',
    's.callhub2811@gmail.com',
    'samyaks695@gmail.com',
    'shrivastavadhirendra587@gmail.com',
    'shrishikhar184@gmail.com',
    'homkumarsahu@gmail.com'
  ];

  const fullPermissions = [
    'owner.all',
    'admin.all',
    'pos.all',
    'pos.view',
    'pos.create_bill',
    'pos.accept_online_order',
    'pos.manage_products',
    'pos.apply_discount',
    'pos.refund',
    'pos.reprint_bill',
    'pos.view_history',
    'pos.manage_shift',
    'menu.manage',
    'menu.pricing',
    'menu.customizations',
    'menu.channels',
    'products.delete',
    'products.manage',
    'franchise.view',
    'franchise.manage',
    'franchise.create',
    'franchise.switch_context',
    'reports.view',
    'reports.export',
    'reports.google_sheets',
    'analytics.all',
    'users.manage',
    'users.provision_pos'
  ];

  const now = new Date().toISOString();

  for (const email of adminEmails) {
    try {
      let userRecord: any;
      try {
        userRecord = await auth.getUserByEmail(email);
      } catch {}

      const uid = userRecord?.uid || `owner_${email.replace(/[^a-z0-9]/g, '_')}`;

      if (userRecord) {
        await auth.setCustomUserClaims(userRecord.uid, {
          role: 'owner',
          admin: true,
          isGlobalOwner: true,
          isOwnerMode: true,
          permissions: fullPermissions
        });
        console.log(`  ✅ Auth Custom Claims updated for ${email} (UID: ${userRecord.uid})`);
      }

      const userDoc = {
        uid,
        userId: uid,
        email,
        name: email.split('@')[0],
        displayName: email.split('@')[0],
        role: 'owner',
        organizationId: 'org_olive_pizza',
        franchiseId: 'fra_primary',
        branchId: 'main_branch',
        terminalId: 'POS-OWNER-01',
        status: 'ACTIVE',
        isActive: true,
        isGlobalOwner: true,
        isOwnerMode: true,
        permissions: fullPermissions,
        updatedAt: now
      };

      await db.collection('users').doc(uid).set(userDoc, { merge: true });
      await db.collection('users').doc(`email_${email.replace(/[^a-z0-9]/g, '_')}`).set(userDoc, { merge: true });
      console.log(`  ✅ Firestore user profile created/updated for ${email}`);
    } catch (err: any) {
      console.warn(`  Warning processing ${email}:`, err.message);
    }
  }

  console.log('\n🎉 All accounts elevated to Full Master Owner permissions!');
}

grantAllDevAndOwnerFullAccess().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
