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

async function cleanupAndKeepOnlyRajnandgaon() {
  console.log('--- STARTING CLEANUP: KEEP ONLY RAJNANDGAON FRANCHISE ---');

  // 1. Clean Delivery Partners: Remove non-Rajnandgaon delivery partners
  const delDpRes = await pool.query(`
    DELETE FROM delivery_partners 
    WHERE franchise_id != 'fra_rajnandgaon' 
       OR id NOT IN ('dp_rjn_samyak_01')
    RETURNING id, name, email, franchise_id;
  `);
  console.log('Removed test delivery partners from PG:', delDpRes.rows);

  // 2. Clean Branches: Keep only Rajnandgaon branches (branch_rjn_main, main_branch)
  // First update any foreign key references if any (e.g., canonical_orders branch_id)
  await pool.query(`
    UPDATE canonical_orders 
    SET branch_id = 'branch_rjn_main', franchise_id = 'fra_rajnandgaon' 
    WHERE franchise_id != 'fra_rajnandgaon' OR branch_id NOT IN ('branch_rjn_main', 'main_branch');
  `);

  const delBranchesRes = await pool.query(`
    DELETE FROM restaurant_branches 
    WHERE franchise_id != 'fra_rajnandgaon' 
       OR id NOT IN ('branch_rjn_main', 'main_branch')
    RETURNING id, name, franchise_id;
  `);
  console.log('Removed test branches from PG:', delBranchesRes.rows);

  // 3. Clean Franchises: Keep only fra_rajnandgaon
  const delFranchisesRes = await pool.query(`
    DELETE FROM franchises 
    WHERE id != 'fra_rajnandgaon'
    RETURNING id, name;
  `);
  console.log('Removed test franchises from PG:', delFranchisesRes.rows);

  // Verify what remains in PostgreSQL
  const remainingF = await pool.query('SELECT id, name, status FROM franchises');
  console.log('Active Franchises in PG:', remainingF.rows);
  const remainingB = await pool.query('SELECT id, franchise_id, name, is_open, accepting_orders FROM restaurant_branches');
  console.log('Active Branches in PG:', remainingB.rows);
  const remainingDP = await pool.query('SELECT id, franchise_id, name, email, status, is_online FROM delivery_partners');
  console.log('Active Delivery Partners in PG:', remainingDP.rows);

  // 4. Clean Firestore
  if (adminDb) {
    console.log('--- CLEANING FIRESTORE COLLECTIONS ---');
    try {
      // Clean franchises
      const fSnap = await adminDb.collection('franchises').get();
      for (const doc of fSnap.docs) {
        if (doc.id !== 'fra_rajnandgaon') {
          await doc.ref.delete();
          console.log(`Deleted Firestore franchise: ${doc.id}`);
        }
      }

      // Clean restaurant_branches
      const bSnap = await adminDb.collection('restaurant_branches').get();
      for (const doc of bSnap.docs) {
        if (doc.id !== 'branch_rjn_main' && doc.id !== 'main_branch') {
          await doc.ref.delete();
          console.log(`Deleted Firestore branch: ${doc.id}`);
        }
      }

      // Clean delivery_partners
      const dpSnap = await adminDb.collection('delivery_partners').get();
      for (const doc of dpSnap.docs) {
        const data = doc.data();
        if (data.franchise_id && data.franchise_id !== 'fra_rajnandgaon') {
          await doc.ref.delete();
          console.log(`Deleted Firestore delivery partner: ${doc.id}`);
        }
      }
      console.log('Firestore cleanup completed successfully.');
    } catch (e) {
      console.log('Firestore cleanup note (quota or permission):', e.message);
    }
  }

  await pool.end();
  console.log('--- CLEANUP FINISHED ---');
  process.exit(0);
}

cleanupAndKeepOnlyRajnandgaon().catch((err) => {
  console.error('Cleanup error:', err);
  process.exit(1);
});
