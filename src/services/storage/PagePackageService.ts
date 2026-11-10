import { CloudflareR2Service } from './CloudflareR2Service.js';
import { PageSchema, BuiltInPageSchema } from '../../types/PageSchema.js';
import AdmZip from 'adm-zip';

export const FALLBACK_STANDARD_SCHEMA: BuiltInPageSchema = {
  versionId: 'v0-fallback',
  pageId: 'default',
  type: 'BUILT_IN',
  templateId: 'default',
  metadata: {
    name: 'Standard Olive Pizza (Fallback)',
    description: 'System fallback',
    publishedBy: 'system',
    publishedAt: new Date().toISOString()
  },
  sections: [
    {
      id: 'default_hero',
      type: 'HERO',
      isHidden: false,
      config: { 
        headline: 'Olive Pizza',
        subtitle: 'Premium quality pizza delivered fast.',
        buttonText: 'ORDER NOW',
        buttonAction: { type: 'OPEN_MENU' }
      }
    },
    { 
      id: 'cravings', 
      type: 'CRAVINGS', 
      isHidden: false, 
      config: { headline: "WHAT'S YOUR CRAVING FOR?", subtitle: "Find something delicious." } 
    },
    { id: 'ads', type: 'ADS', isHidden: false, config: {} },
    { id: 'coupons', type: 'COUPONS', isHidden: false, config: {} },
    { id: 'featured', type: 'FEATURED', isHidden: false, config: {} },
    { id: 'app', type: 'DOWNLOAD_APP', isHidden: false, config: {} }
  ]
};

export interface LivePointer {
  activePageId: string;
  activeVersionId: string;
  since: string;
}

export class PagePackageService {
  private static LIVE_POINTER_KEY = 'home-pages/live-pointer.json';

  /**
   * Reads live-pointer.json from R2, then reads the manifest it points to.
   */
  static async getLiveManifest(): Promise<PageSchema> {
    try {
      const pointer = await CloudflareR2Service.downloadJson<LivePointer>(this.LIVE_POINTER_KEY);
      if (!pointer || !pointer.activePageId || !pointer.activeVersionId) {
        console.warn('[PagePackageService] live-pointer.json not found or invalid. Using fallback.');
        return FALLBACK_STANDARD_SCHEMA;
      }
      
      const manifestPath = `home-pages/versions/${pointer.activePageId}/${pointer.activeVersionId}/manifest.json`;
      const manifest = await CloudflareR2Service.downloadJson<PageSchema>(manifestPath);
      
      if (!manifest) {
        console.warn(`[PagePackageService] Manifest ${manifestPath} missing. Using fallback.`);
        return FALLBACK_STANDARD_SCHEMA;
      }
      
      return manifest;
    } catch (error) {
      console.error('[PagePackageService] Error getting live manifest:', error);
      return FALLBACK_STANDARD_SCHEMA; // Never break the site
    }
  }

  /**
   * Gets a specific manifest directly by pageId and versionId.
   */
  static async getManifest(pageId: string, versionId: string): Promise<PageSchema | null> {
    try {
      const manifestPath = `home-pages/versions/${pageId}/${versionId}/manifest.json`;
      return await CloudflareR2Service.downloadJson<PageSchema>(manifestPath);
    } catch (error) {
      console.error('[PagePackageService] Error getting manifest:', error);
      return null;
    }
  }

  /**
   * Saves a draft version without making it live.
   */
  static async saveDraft(schema: PageSchema): Promise<boolean> {
    try {
      if (!schema.versionId) {
        schema.versionId = `v${Date.now()}`;
      }
      
      const manifestPath = `home-pages/versions/${schema.pageId}/${schema.versionId}/manifest.json`;
      await CloudflareR2Service.uploadJson(manifestPath, schema);
      return true;
    } catch (error) {
      console.error('[PagePackageService] Error saving draft:', error);
      return false;
    }
  }

  /**
   * Atomically publishes a new version to R2.
   * 1. Writes immutable manifest to `versions/{pageId}/{versionId}/manifest.json`
   * 2. Points `live-pointer.json` to this version
   */
  static async publishLiveManifest(schema: PageSchema): Promise<boolean> {
    try {
      if (!schema.versionId) {
        schema.versionId = `v${Date.now()}`;
      }
      
      const manifestPath = `home-pages/versions/${schema.pageId}/${schema.versionId}/manifest.json`;
      
      // 1. Write Immutable Manifest
      await CloudflareR2Service.uploadJson(manifestPath, schema);
      
      // 2. Update Live Pointer
      const pointer: LivePointer = {
        activePageId: schema.pageId,
        activeVersionId: schema.versionId,
        since: new Date().toISOString()
      };
      
      await CloudflareR2Service.uploadJson(this.LIVE_POINTER_KEY, pointer);
      
      return true;
    } catch (error) {
      console.error('[PagePackageService] Error publishing live manifest:', error);
      return false;
    }
  }

  /**
   * Rollback to a specific page and version by changing live-pointer.json
   */
  static async rollbackManifest(pageId: string, versionId: string): Promise<boolean> {
    try {
      const manifestPath = `home-pages/versions/${pageId}/${versionId}/manifest.json`;
      
      // Check if version exists before rolling back
      const manifest = await CloudflareR2Service.downloadJson(manifestPath);
      if (!manifest) {
        throw new Error(`Manifest for page ${pageId}, version ${versionId} does not exist in R2.`);
      }
      
      const pointer: LivePointer = {
        activePageId: pageId,
        activeVersionId: versionId,
        since: new Date().toISOString()
      };
      
      await CloudflareR2Service.uploadJson(this.LIVE_POINTER_KEY, pointer);
      return true;
    } catch (error) {
      console.error('[PagePackageService] Error rolling back:', error);
      return false;
    }
  }

  /**
   * Uploads and unzips a custom static package to R2.
   * Validates file extensions (HTML, CSS, JS, WEBP, PNG, JPG, JSON) to ensure safety.
   */
  static async uploadCustomPackage(zipBuffer: Buffer, pageId: string, versionId: string): Promise<string> {
    const zip = new AdmZip(zipBuffer);
    const zipEntries = zip.getEntries();
    
    const allowedExtensions = ['.html', '.css', '.js', '.json', '.webp', '.png', '.jpg', '.jpeg', '.svg', '.woff2', '.ttf'];
    const basePath = `home-pages/custom/${pageId}/versions/${versionId}`;
    
    let entryFileFound = false;
    
    for (const entry of zipEntries) {
      if (entry.isDirectory) continue;
      
      const ext = entry.entryName.substring(entry.entryName.lastIndexOf('.')).toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        throw new Error(`Invalid file type in package: ${entry.entryName}. Only web assets are permitted.`);
      }
      
      if (entry.entryName.includes('index.html')) {
        entryFileFound = true;
      }
      
      const fileData = entry.getData();
      const contentType = this.getContentType(ext);
      
      await CloudflareR2Service.uploadBuffer(`${basePath}/${entry.entryName}`, fileData, contentType);
    }
    
    if (!entryFileFound) {
      throw new Error('Package must contain an index.html file.');
    }
    
    const publicUrlBase = process.env.CLOUDFLARE_R2_PUBLIC_URL || '';
    return `${publicUrlBase.replace(/\/$/, '')}/${basePath}`;
  }

  private static getContentType(ext: string): string {
    switch (ext) {
      case '.html': return 'text/html; charset=utf-8';
      case '.css': return 'text/css; charset=utf-8';
      case '.js': return 'application/javascript; charset=utf-8';
      case '.json': return 'application/json; charset=utf-8';
      case '.webp': return 'image/webp';
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.svg': return 'image/svg+xml';
      case '.woff2': return 'font/woff2';
      case '.ttf': return 'font/ttf';
      default: return 'application/octet-stream';
    }
  }
}
