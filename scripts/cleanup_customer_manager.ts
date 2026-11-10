import admin from 'firebase-admin';
import * as dotenv from 'dotenv';
dotenv.config();

const key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '', 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });

async function cleanup() {
  const db = admin.firestore();
  await db.collection('restaurant_managers').doc('Uln5UKsRyZaCzTePgBmfourQngu1').delete();
  console.log('Deleted Uln5UKsRyZaCzTePgBmfourQngu1 from restaurant_managers');
  await db.collection('restaurant_managers').doc('mgr_1791468459869').delete();
  console.log('Deleted mgr_1791468459869 from restaurant_managers');

  // Verify
  const q = await db.collection('restaurant_managers').where('email', '==', 'samyaks695@gmail.com').get();
  console.log('Remaining docs with samyaks695@gmail.com in restaurant_managers:', q.size);

  // Ensure user doc has role: 'customer'
  await db.collection('users').doc('Uln5UKsRyZaCzTePgBmfourQngu1').update({
    role: 'customer'
  });
  console.log('Ensured users/Uln5UKsRyZaCzTePgBmfourQngu1 has role: customer');
  process.exit(0);
}

cleanup().catch(console.error);
