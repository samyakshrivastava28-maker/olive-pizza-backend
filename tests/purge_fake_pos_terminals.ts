import { adminDb } from '../src/config/firebase.js';

async function purgeFakePosTerminals() {
  console.log('=== PURGING FAKE / TEST POS TERMINALS ===');
  const snap = await adminDb.collection('pos_terminals').get();
  console.log(`Found ${snap.docs.length} POS terminals to purge.`);

  for (const doc of snap.docs) {
    const data = doc.data();
    console.log(`  Deleting fake POS terminal: ID=${doc.id}, Name=${data.terminalName || 'Unnamed'}, Franchise=${data.franchiseId}, Branch=${data.branchId}`);
    await doc.ref.delete();
  }

  const remaining = await adminDb.collection('pos_terminals').get();
  console.log(`\n✅ Done! Remaining POS terminals count: ${remaining.docs.length}`);
}

purgeFakePosTerminals().then(() => process.exit(0)).catch(e => {
  console.error('Error purging POS terminals:', e);
  process.exit(1);
});
