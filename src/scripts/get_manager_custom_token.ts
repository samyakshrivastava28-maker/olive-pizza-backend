import { adminAuth } from '../config/firebase.js';

async function getToken() {
  const user = await adminAuth.getUserByEmail('samyakssaamm@gmail.com');
  const customToken = await adminAuth.createCustomToken(user.uid, {
    role: 'restaurant_manager',
    allowedApps: ['RESTAURANT_MANAGER', 'POS'],
    franchiseId: 'fra_op_durg_01',
    branchId: 'fra_op_durg_01_main_branch'
  });
  console.log('CUSTOM_TOKEN:', customToken);
  process.exit(0);
}

getToken().catch(console.error);
