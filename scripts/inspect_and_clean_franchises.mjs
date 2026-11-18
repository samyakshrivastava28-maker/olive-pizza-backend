import { createRequire } from 'module';
import path from 'path';

const require = createRequire('C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\package.json');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: 'C:\\Users\\RYZEN\\Downloads\\olive-pizza-backend\\.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

import { adminDb } from '../src/config/firebase.js';

async function inspect() {
  console.log('=== POSTGRESQL INSPECTION ===');
  const franchises = await pool.query('SELECT * FROM franchises');
  console.log('Franchises in PG:', franchises.rows);

  const branches = await pool.query('SELECT * FROM restaurant_branches');
  console.log('Branches in PG:', branches.rows);

  const deliveryPartners = await pool.query('SELECT * FROM delivery_partners');
  console.log('Delivery Partners in PG:', deliveryPartners.rows);

  const users = await pool.query('SELECT id, email, role, franchise_id, branch_id FROM users');
  console.log('Users in PG:', users.rows);

  console.log('=== FIRESTORE INSPECTION ===');
  try {
    if (adminDb) {
      const fSnap = await adminDb.collection('franchises').get();
      console.log('Franchises in Firestore:', fSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      const bSnap = await adminDb.collection('restaurant_branches').get();
      console.log('Branches in Firestore:', bSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
  } catch (e) {
    console.log('Firestore read error:', e.message);
  }

  await pool.end();
}

inspect().catch(console.error);
