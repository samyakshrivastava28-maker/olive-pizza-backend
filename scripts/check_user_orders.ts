import admin from 'firebase-admin';
import * as dotenv from 'dotenv';
dotenv.config();

const key = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '', 'base64').toString('utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(key) });

async function run() {
  const db = admin.firestore();
  const q = await db.collection('orders').where('userId', '==', 'Uln5UKsRyZaCzTePgBmfourQngu1').get();
  console.log('Total orders for user:', q.size);
  let activeCount = 0;
  q.forEach(d => {
    const data = d.data();
    const st = (data.status || '').toLowerCase();
    const isAct = !['delivered', 'cancelled', 'rejected', 'failed'].includes(st);
    if (isAct) activeCount++;
    console.log(`Order: ${d.id} | status: ${data.status} | active: ${isAct} | createdAt: ${data.createdAt}`);
  });
  console.log('Total active orders:', activeCount);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
