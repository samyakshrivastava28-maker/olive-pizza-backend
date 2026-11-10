import admin from 'firebase-admin';
import * as dotenv from 'dotenv';
dotenv.config();

const key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '', 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });

async function check() {
  const db = admin.firestore();
  const uid = 'Uln5UKsRyZaCzTePgBmfourQngu1';
  const email = 'samyaks695@gmail.com';
  
  const collections = ['restaurant_managers', 'delivery_partners', 'franchise_users', 'pos_accounts'];
  for (const c of collections) {
    const byId = await db.collection(c).doc(uid).get();
    console.log(`[${c}] by ID (${uid}): exists=${byId.exists}`, byId.exists ? byId.data() : '');
    const byEmail = await db.collection(c).where('email', '==', email).get();
    console.log(`[${c}] by Email (${email}): count=${byEmail.size}`);
    byEmail.forEach(d => console.log(`   doc ${d.id}:`, d.data()));
  }
  process.exit(0);
}

check().catch(console.error);
