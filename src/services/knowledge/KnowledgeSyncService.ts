/**
 * KnowledgeSyncService.ts — Realtime Knowledge Sync & RAM Memory Store for Olive Pizza AI
 * 
 * Listens to Firestore knowledgeVersion, downloads changed files from Cloudflare R2,
 * maintains local disk cache (cache/knowledge/), and refreshes RAM Memory Cache in real time.
 */

import { adminDb as db } from '../../config/firebase.js';
import { CloudflareR2Service } from '../storage/CloudflareR2Service.js';
import { KnowledgeGeneratorService, KnowledgeFileType, KnowledgePayload } from './KnowledgeGeneratorService.js';
import fs from 'fs';
import path from 'path';

const LOCAL_CACHE_DIR = path.resolve(process.cwd(), 'cache', 'knowledge');

export class KnowledgeMemoryStore {
  private static ramCache: Map<string, any> = new Map();
  private static isLoaded: boolean = false;

  /**
   * Updates RAM memory cache for a specific knowledge file.
   */
  static set(fileType: string, data: any): void {
    this.ramCache.set(fileType, data);
    console.log(`[RAM Knowledge Cache] Updated RAM cache for "${fileType}"`);
  }

  /**
   * Gets knowledge data directly from RAM.
   */
  static get<T = any>(fileType: string): T | null {
    return (this.ramCache.get(fileType) as T) || null;
  }

  /**
   * Returns entire RAM cache as structured object for AI prompt context.
   */
  static getFullContext(): Record<string, any> {
    const context: Record<string, any> = {};
    for (const [key, value] of this.ramCache.entries()) {
      context[key.replace('.json', '')] = value;
    }
    return context;
  }

  /**
   * Pre-loads all cached files from local disk into RAM on application boot.
   */
  static loadFromDisk(): void {
    if (this.isLoaded) return;
    if (!fs.existsSync(LOCAL_CACHE_DIR)) {
      fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
    }

    try {
      const files = fs.readdirSync(LOCAL_CACHE_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(LOCAL_CACHE_DIR, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content);
          this.ramCache.set(file, parsed.data || parsed);
        }
      }
      this.isLoaded = true;
      console.log(`[RAM Knowledge Cache] Pre-loaded ${this.ramCache.size} files into RAM memory cache.`);
    } catch (err: any) {
      console.warn('[RAM Knowledge Cache] Error loading from disk:', err.message);
    }
  }
}

export class KnowledgeSyncService {
  private static unsubscribeListener: (() => void) | null = null;
  private static lastKnownVersion: number = 0;

  /**
   * Initializes real-time listener on Firestore knowledgeVersion.
   */
  static initializeSync(): void {
    KnowledgeMemoryStore.loadFromDisk();

    if (this.unsubscribeListener) return;

    console.log('[KnowledgeSync] Starting real-time Firestore knowledgeVersion listener...');

    try {
      this.unsubscribeListener = db.collection('website').doc('knowledgeVersion').onSnapshot(
        async (snapshot: any) => {
          if (!snapshot.exists) return;
          const data = snapshot.data();
          const version = data?.version || 0;
          const changedFiles: KnowledgeFileType[] = data?.changedFiles || [];

          if (version > this.lastKnownVersion) {
            console.log(`[KnowledgeSync] 🔔 Knowledge Version change detected: v${version} (Changed: ${changedFiles.join(', ')})`);
            this.lastKnownVersion = version;

            await this.syncChangedFiles(changedFiles);
          }
        },
        (err: any) => console.error('[KnowledgeSync] Firestore listener error:', err.message)
      );
    } catch (err: any) {
      console.warn('[KnowledgeSync] Could not attach Firestore listener:', err.message);
    }
  }

  /**
   * Downloads ONLY changed files from Cloudflare R2 and updates local disk & RAM cache.
   */
  static async syncChangedFiles(changedFiles: KnowledgeFileType[]): Promise<void> {
    if (!fs.existsSync(LOCAL_CACHE_DIR)) {
      fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
    }

    const filesToSync = changedFiles.length > 0 ? changedFiles : [
      'restaurant.json',
      'products.json',
      'categories.json',
      'coupons.json',
      'offers.json',
      'faq.json',
      'policies.json',
      'delivery.json'
    ] as KnowledgeFileType[];

    for (const fileType of filesToSync) {
      try {
        const r2Key = `knowledge/${fileType}`;
        let payload: KnowledgePayload | null = null;

        if (CloudflareR2Service.isConfigured()) {
          payload = await CloudflareR2Service.downloadJson<KnowledgePayload>(r2Key);
        }

        if (payload) {
          const localPath = path.join(LOCAL_CACHE_DIR, fileType);
          fs.writeFileSync(localPath, JSON.stringify(payload, null, 2), 'utf-8');
          KnowledgeMemoryStore.set(fileType, payload.data || payload);
          console.log(`[KnowledgeSync] Successfully synced "${fileType}" from Cloudflare R2 to RAM & Disk.`);
        }
      } catch (err: any) {
        console.error(`[KnowledgeSync] Error syncing "${fileType}":`, err.message);
      }
    }
  }

  /**
   * Stops Firestore listener.
   */
  static stopSync(): void {
    if (this.unsubscribeListener) {
      this.unsubscribeListener();
      this.unsubscribeListener = null;
    }
  }
}
