import { adminDb } from '../src/config/firebase.ts';
import { query, pgPool } from '../src/config/postgres.ts';

async function run() {
  try {
    console.log("Checking Firestore doc for samyaks695@gmail.com / Uln5UKsRyZaCzTePgBmfourQngu1...");
    const snap = await adminDb.collection('users').doc('Uln5UKsRyZaCzTePgBmfourQngu1').get();
    if (snap.exists) {
      console.log("Firestore User Data:", JSON.stringify(snap.data(), null, 2));
    } else {
      console.log("Firestore User Doc DOES NOT EXIST");
    }

    const pgUser = await query("SELECT * FROM app_users WHERE email = 'samyaks695@gmail.com' OR id = 'Uln5UKsRyZaCzTePgBmfourQngu1'");
    console.log("PG User Data:", JSON.stringify(pgUser.rows, null, 2));

  } catch (e) {
    console.error("Error:", e);
  } finally {
    try { await pgPool.end(); } catch {}
    process.exit(0);
  }
}

run();
