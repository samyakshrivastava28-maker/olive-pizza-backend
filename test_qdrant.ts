import { storageAnalyzer } from './src/services/storageAnalyzer.service.js';
storageAnalyzer.getQdrantUsage().then(console.log).catch(console.error);
