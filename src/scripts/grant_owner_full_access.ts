import dotenv from 'dotenv';
dotenv.config();
import { adminDb as db, adminAuth as auth } from '../config/firebase.js';

async function grantOwnerFullAccess() {
  console.log('👑 Granting Master Owner Full Access Across the Entire Olive Pizza Ecosystem...\n');

  const ownerEmails = [
    'olivepizzarjn@gmail.com',
    'webhub2811@gmail.com'
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

  for (const email of ownerEmails) {
    console.log(`Processing Owner: ${email}...`);

    // 1. Check or Find User by Email in Firebase Auth
    let userRecord: any;
    try {
      userRecord = await auth.getUserByEmail(email);
      console.log(`  Found Auth record: UID=${userRecord.uid}`);
    } catch (err: any) {
      console.log(`  Auth record not found, will create / ensure Firestore doc for: ${email}`);
    }

    const uid = userRecord?.uid || `owner_${email.replace(/[^a-z0-9]/g, '_')}`;

    // 2. Set Custom Claims in Firebase Auth if record exists
    if (userRecord) {
      try {
        await auth.setCustomUserClaims(userRecord.uid, {
          role: 'owner',
          organizationId: 'org_olive_pizza',
          franchiseId: 'fra_primary',
          branchId: 'main_branch',
          isGlobalOwner: true,
          isOwnerMode: true,
          permissions: fullPermissions
        });
        console.log(`  ✅ Custom Claims set in Firebase Auth for UID: ${userRecord.uid}`);
      } catch (claimErr: any) {
        console.warn(`  Warning setting custom claims:`, claimErr.message);
      }
    }

    // 3. Upsert Firestore 'users' record with full owner permissions
    const ownerDoc = {
      uid,
      userId: uid,
      email,
      name: email === 'olivepizzarjn@gmail.com' ? 'Olive Pizza Owner' : 'Olive Pizza Master Admin',
      displayName: email === 'olivepizzarjn@gmail.com' ? 'Olive Pizza Owner' : 'Olive Pizza Master Admin',
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

    await db.collection('users').doc(uid).set(ownerDoc, { merge: true });

    // Also index under email-based key for immediate query fallback
    await db.collection('users').doc(`email_${email.replace(/[^a-z0-9]/g, '_')}`).set(ownerDoc, { merge: true });

    console.log(`  ✅ Firestore record updated for ${email}`);
  }

  // 4. Update 'settings/owner_access' configuration
  await db.collection('settings').doc('owner_access').set({
    masterOwners: ownerEmails,
    fullAccessGranted: true,
    grantedAt: now,
    mode: 'UNRESTRICTED_GLOBAL_OWNER',
    features: {
      multiFranchiseContextSwitching: true,
      crossBranchMenuManagement: true,
      livePOSTerminalManagement: true,
      staffProvisioning: true,
      instantOrderReprint: true,
      googleSheetsReporting: true,
      posBillingBypass: true
    }
  }, { merge: true });

  console.log('\n🎉 Master Owner Full Access Successfully Configured and Activated in Firestore!');
}

grantOwnerFullAccess().then(() => process.exit(0)).catch(err => {
  console.error('Error granting owner access:', err);
  process.exit(1);
});
