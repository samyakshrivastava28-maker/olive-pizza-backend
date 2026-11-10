import { knowledgeSync } from './src/services/ai/KnowledgeSync.js';
import kb from './src/services/KnowledgeBaseService.js';
import { adminDb } from './src/config/firebase.js';

async function run() {
  try {
    console.log('Initializing Knowledge Base (Live DB)...');
    await kb.initialize();

    console.log('Syncing live data to local knowledge cache...');
    const result = await knowledgeSync.syncAll();
    console.log('Sync Result:', result);

    process.exit(0);
  } catch (error) {
    console.error('Reindex Error:', error);
    process.exit(1);
  }
}

run();
