import admin from 'firebase-admin';
import * as dotenv from 'dotenv';
dotenv.config();

const key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '', 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });

async function run() {
  const d = await admin.firestore().collection('users').doc('Uln5UKsRyZaCzTePgBmfourQngu1').get();
  console.log('User document fields:', JSON.stringify(d.data(), null, 2));
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
