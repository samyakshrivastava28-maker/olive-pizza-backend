/**
 * KnowledgeGeneratorService.ts — AI Knowledge Generator & Cloudflare R2 Exporter
 * 
 * Monitors restaurant Firestore data, generates structured JSON knowledge files,
 * uploads ONLY changed JSON files to Cloudflare R2, and updates knowledgeVersion in Firestore.
 */

import { adminDb as db } from '../../config/firebase.js';
import { CloudflareR2Service } from '../storage/CloudflareR2Service.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface KnowledgePayload<T = any> {
  version: number;
  updatedAt: string;
  checksum: string;
  data: T;
}

export type KnowledgeFileType =
  | 'restaurant.json'
  | 'menu.json'
  | 'products.json'
  | 'categories.json'
  | 'combos.json'
  | 'offers.json'
  | 'coupons.json'
  | 'ads.json'
  | 'faq.json'
  | 'policies.json'
  | 'website_pages.json'
  | 'navigation.json'
  | 'delivery.json'
  | 'theme.json'
  | 'analytics.json';

export class KnowledgeGeneratorService {
  private static checksumCache: Map<string, string> = new Map();
  private static currentVersion: number = 1;
  private static isInitialSyncDone: boolean = false;

  /**
   * Initializes knowledge generator and performs initial full sync check.
   */
  static async initialize(): Promise<void> {
    if (this.isInitialSyncDone) return;
    console.log('[KnowledgeGenerator] Initializing Knowledge Generator & Version Tracker...');
    
    try {
      // Fetch latest knowledgeVersion from Firestore
      const versionDoc = await db.collection('website').doc('knowledgeVersion').get();
      if (versionDoc.exists) {
        const data = versionDoc.data();
        if (data?.version) this.currentVersion = data.version;
      }
    } catch (err: any) {
      console.warn('[KnowledgeGenerator] Warning fetching knowledgeVersion:', err.message);
    }

    this.isInitialSyncDone = true;
  }

  /**
   * Generates JSON knowledge for specified file type from Firestore.
   */
  static async generateFileKnowledge(fileType: KnowledgeFileType): Promise<{ key: string; json: KnowledgePayload; checksum: string }> {
    await this.initialize();
    let rawData: any = null;

    switch (fileType) {
      case 'restaurant.json': {
        const doc = await db.collection('settings').doc('restaurant').get();
        rawData = doc.exists ? doc.data() : {
          name: 'Olive Pizza',
          tagline: 'Artisanal Wood-Fired Pizza',
          phone: '+1 (800) 555-PIZZA',
          email: 'support@olivepizza.com',
          address: '123 Gourmet Way, Culinary City',
          cuisine: 'Italian Wood-Fired Pizza',
          businessHours: '11:00 AM - 11:00 PM Daily',
        };
        break;
      }

      case 'products.json':
      case 'menu.json': {
        const snap = await db.collection('products').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        if (rawData.length === 0) {
          rawData = [
            { id: 'p_margherita', name: 'Margherita Speciale', price: 14.99, category: 'pizzas', isVeg: true, description: 'San Marzano tomatoes, fresh buffalo mozzarella, organic basil, extra virgin olive oil' },
            { id: 'p_pepperoni', name: 'Truffle Pepperoni Feast', price: 17.99, category: 'pizzas', isVeg: false, description: 'Spicy pepperoni, truffle glaze, smoked provolone, chili flakes' },
            { id: 'p_tandoori', name: 'Tandoori Paneer Supreme', price: 16.99, category: 'pizzas', isVeg: true, description: 'Spiced paneer cubes, red onion, bell peppers, mint yogurt drizzle' },
          ];
        }
        break;
      }

      case 'categories.json': {
        const snap = await db.collection('categories').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        if (rawData.length === 0) {
          rawData = [
            { id: 'cat_pizzas', name: 'Wood-Fired Pizzas', emoji: '🍕' },
            { id: 'cat_sides', name: 'Garlic Bread & Sides', emoji: '🧄' },
            { id: 'cat_beverages', name: 'Beverages & Shakes', emoji: '🥤' },
            { id: 'cat_desserts', name: 'Artisanal Desserts', emoji: '🍰' },
          ];
        }
        break;
      }

      case 'coupons.json': {
        const snap = await db.collection('coupons').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        if (rawData.length === 0) {
          rawData = [
            { code: 'WELCOME50', discount: '50% OFF', description: '50% off first order up to $10', minOrder: 20 },
            { code: 'DIWALI50', discount: '50% CASHBACK', description: 'Diwali Festive Special Cashback', minOrder: 30 },
            { code: 'FREEDEL', discount: 'FREE DELIVERY', description: 'Free delivery on all orders above $25', minOrder: 25 },
          ];
        }
        break;
      }

      case 'offers.json':
      case 'combos.json': {
        const snap = await db.collection('offers').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        if (rawData.length === 0) {
          rawData = [
            { id: 'combo_family', name: 'Family Feast Combo', price: 34.99, items: '2 Large Pizzas + Garlic Bread + 2L Soda' },
            { id: 'combo_duo', name: 'Couple Pizza Date', price: 24.99, items: '1 Medium Pizza + Side + 2 Shakes' },
          ];
        }
        break;
      }

      case 'ads.json': {
        const snap = await db.collection('ads').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        break;
      }

      case 'faq.json': {
        const snap = await db.collection('faq').get();
        rawData = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        if (rawData.length === 0) {
          rawData = [
            { question: 'What are your delivery hours?', answer: 'We deliver daily from 11:00 AM to 11:00 PM.' },
            { question: 'Are your pizzas 100% wood-fired?', answer: 'Yes! All pizzas are baked in our authentic 900°F brick oven.' },
            { question: 'Do you offer gluten-free crusts?', answer: 'Yes, gluten-free crust options are available for all medium pizzas.' },
          ];
        }
        break;
      }

      case 'policies.json': {
        rawData = {
          refundPolicy: '100% refund or replacement within 30 minutes if quality issue occurs.',
          privacyPolicy: 'We strictly protect customer data and never share details with third parties.',
          deliveryPolicy: 'Average delivery time 20-30 minutes within 10km radius.',
        };
        break;
      }

      case 'website_pages.json': {
        const doc = await db.collection('website').doc('homepage').get();
        rawData = doc.exists ? doc.data() : { version: 1, sections: [] };
        break;
      }

      case 'navigation.json': {
        const doc = await db.collection('website').doc('navigation').get();
        rawData = doc.exists ? doc.data() : {};
        break;
      }

      case 'delivery.json': {
        const doc = await db.collection('settings').doc('delivery').get();
        rawData = doc.exists ? doc.data() : { maxRadiusKm: 15, baseFee: 2.99, freeAboveAmount: 25 };
        break;
      }

      case 'theme.json': {
        const doc = await db.collection('website').doc('theme').get();
        rawData = doc.exists ? doc.data() : {};
        break;
      }

      case 'analytics.json': {
        rawData = { updated: new Date().toISOString(), totalOrders: 15000, avgRating: 4.9 };
        break;
      }

      default:
        rawData = {};
    }

    const dataString = JSON.stringify(rawData);
    const checksum = crypto.createHash('sha256').update(dataString).digest('hex');

    const json: KnowledgePayload = {
      version: this.currentVersion,
      updatedAt: new Date().toISOString(),
      checksum,
      data: rawData,
    };

    return { key: `knowledge/${fileType}`, json, checksum };
  }

  /**
   * Regenerates and uploads ONLY changed JSON knowledge files to Cloudflare R2.
   */
  static async onDataChanged(fileTypes: KnowledgeFileType[]): Promise<{ updatedFiles: string[]; version: number }> {
    await this.initialize();
    const changedFiles: KnowledgeFileType[] = [];

    for (const fileType of fileTypes) {
      try {
        const { key, json, checksum } = await this.generateFileKnowledge(fileType);
        const cachedChecksum = this.checksumCache.get(fileType);

        // Checksum verification: ONLY upload if data actually changed
        if (cachedChecksum !== checksum) {
          await CloudflareR2Service.uploadJson(key, json);
          this.checksumCache.set(fileType, checksum);
          changedFiles.push(fileType);
          console.log(`[KnowledgeGenerator] Changed file updated: "${fileType}"`);
        } else {
          console.log(`[KnowledgeGenerator] Skipping unchanged file: "${fileType}"`);
        }
      } catch (err: any) {
        console.error(`[KnowledgeGenerator] Error processing "${fileType}":`, err.message);
      }
    }

    if (changedFiles.length > 0) {
      this.currentVersion += 1;
      const nextVersion = this.currentVersion;
      const updatedAt = new Date().toISOString();

      // Build collections hash manifest for version.json manifest
      const collectionsManifest: Record<string, { version: number; hash: string }> = {};
      this.checksumCache.forEach((hash, file) => {
        const colName = file.replace('.json', '');
        collectionsManifest[colName] = {
          version: nextVersion,
          hash,
        };
      });

      const versionManifest = {
        version: nextVersion,
        generatedAt: updatedAt,
        collections: collectionsManifest,
        changedFiles,
      };

      // Upload central version.json manifest to Cloudflare R2
      await CloudflareR2Service.uploadJson('knowledge/version.json', versionManifest);

      // Update Firestore knowledgeVersion trigger document for Olive Pizza AI
      await db.collection('website').doc('knowledgeVersion').set({
        version: nextVersion,
        updatedAt,
        changedFiles,
        collections: collectionsManifest,
      });

      console.log(`[KnowledgeGenerator] 🚀 Updated knowledgeVersion to v${nextVersion} (Uploaded version.json, Changed: ${changedFiles.join(', ')})`);
      return { updatedFiles: changedFiles, version: nextVersion };
    }

    return { updatedFiles: [], version: this.currentVersion };
  }

  /**
   * Performs full synchronization across all 15 knowledge files.
   */
  static async syncAllKnowledge(): Promise<{ updatedFiles: string[]; version: number }> {
    const allFiles: KnowledgeFileType[] = [
      'restaurant.json',
      'menu.json',
      'products.json',
      'categories.json',
      'combos.json',
      'offers.json',
      'coupons.json',
      'ads.json',
      'faq.json',
      'policies.json',
      'website_pages.json',
      'navigation.json',
      'delivery.json',
      'theme.json',
      'analytics.json',
    ];

    return await this.onDataChanged(allFiles);
  }
}
