import { google, drive_v3 } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DriveUploadResult {
  fileId: string;
  driveLink: string;
  webContentLink?: string;
  folderId: string;
  isReplacement: boolean;
}

class GoogleDriveService {
  private drive: drive_v3.Drive | null = null;
  public isEnabled: boolean = false;
  private authClient: any = null;
  private rootFolderName = 'Olive Pizza Reports';
  private serviceAccountEmail: string = '';

  // Operational metrics for diagnostics
  public metrics = {
    totalUploads: 0,
    successfulUploads: 0,
    failedUploads: 0,
    lastError: '',
    lastUploadAt: '',
  };

  constructor() {
    this.init();
  }

  private init() {
    // Check if explicitly enabled or if service account credentials exist in env
    const enabledEnv = process.env.GOOGLE_DRIVE_ENABLED;
    const hasCredentialsEnv = !!(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH);

    if (enabledEnv === 'false') {
      console.log('[Google Drive] Service disabled via GOOGLE_DRIVE_ENABLED=false');
      this.isEnabled = false;
      return;
    }

    try {
      let credentials: any = null;

      // 1. Try inline JSON or Base64 string from env (Recommended for Render / Cloud deployments)
      if (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
        const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.trim();
        try {
          // Check if Base64
          const jsonStr = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
          credentials = JSON.parse(jsonStr);
          console.log('[Google Drive] Loaded Service Account from GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON');
        } catch (e: any) {
          console.error('[Google Drive] Failed to parse GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON:', e.message);
        }
      }

      // 2. Fall back to file path
      if (!credentials && process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH) {
        const serviceAccountPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;
        const normalizedPath = serviceAccountPath.replace(/^backend[\/\\]/, '');

        const candidatePaths = [
          path.resolve(process.cwd(), serviceAccountPath),
          path.resolve(process.cwd(), normalizedPath),
          path.resolve(__dirname, '../../', serviceAccountPath),
          path.resolve(__dirname, '../../credentials/google-drive-service-account.json'),
          path.resolve(__dirname, '../credentials/google-drive-service-account.json'),
        ];

        let absolutePath = candidatePaths.find(p => fs.existsSync(p));

        if (absolutePath && fs.existsSync(absolutePath)) {
          const content = fs.readFileSync(absolutePath, 'utf8');
          credentials = JSON.parse(content);
          console.log(`[Google Drive] Loaded Service Account from file: ${absolutePath}`);
        } else {
          console.warn(`[Google Drive] Service account file not found in candidates: ${candidatePaths.join(', ')}`);
        }
      }

      if (!credentials) {
        console.warn('[Google Drive] Credentials not found. Google Drive features will run in offline mode.');
        this.isEnabled = false;
        return;
      }

      this.serviceAccountEmail = credentials.client_email || 'service-account@google.com';

      this.authClient = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });

      this.drive = google.drive({ version: 'v3', auth: this.authClient });
      this.isEnabled = true;
      console.log(`[Google Drive] Initialized successfully for account: ${this.serviceAccountEmail}`);
    } catch (error: any) {
      console.error('[Google Drive] Initialization error:', error.message);
      this.isEnabled = false;
    }
  }

  /**
   * Health status for diagnostics dashboard
   */
  public async getHealthStatus() {
    if (!this.isEnabled || !this.drive) {
      return {
        connected: false,
        error: this.metrics.lastError || 'Service disabled or credentials missing',
        metrics: this.metrics,
      };
    }

    try {
      const response = await this.drive.about.get({
        fields: 'user, storageQuota',
      });

      return {
        connected: true,
        user: response.data.user?.emailAddress || this.serviceAccountEmail,
        folderConfigured: true,
        folderAccessible: true,
        quota: response.data.storageQuota,
        metrics: this.metrics,
      };
    } catch (error: any) {
      return {
        connected: false,
        folderConfigured: false,
        folderAccessible: false,
        error: error.message,
        metrics: this.metrics,
      };
    }
  }

  /**
   * Finds or creates a folder by name inside a parent folder ID (or 'root').
   */
  public async ensureFolder(folderName: string, parentFolderId: string = 'root'): Promise<string> {
    if (!this.drive) throw new Error('Google Drive service not initialized');

    try {
      // Search for existing folder
      const query = `name = '${folderName}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
      const res = await this.drive.files.list({
        q: query,
        fields: 'files(id, name)',
        spaces: 'drive',
      });

      if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id!;
      }
    } catch (err: any) {
      if (parentFolderId !== 'root') {
        console.warn(`[Google Drive] Parent folder ID ${parentFolderId} inaccessible (${err.message}). Falling back to 'root'.`);
        return this.ensureFolder(folderName, 'root');
      }
    }

    // Create new folder
    const folderMetadata: drive_v3.Schema$File = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId === 'root' ? 'root' : parentFolderId],
    };

    try {
      const folder = await this.drive.files.create({
        requestBody: folderMetadata,
        fields: 'id',
      });

      console.log(`[Google Drive] Created folder "${folderName}" (ID: ${folder.data.id})`);

      // Auto-share root folders created by the service account with the owner
      if (parentFolderId === 'root' && process.env.OWNER_EMAIL) {
        try {
          await this.drive.permissions.create({
            fileId: folder.data.id!,
            requestBody: { role: 'writer', type: 'user', emailAddress: process.env.OWNER_EMAIL },
            sendNotificationEmail: true,
          });
          console.log(`[Google Drive] Shared folder "${folderName}" with ${process.env.OWNER_EMAIL}`);
        } catch (e: any) {
          console.warn(`[Google Drive] Failed to share folder "${folderName}" with ${process.env.OWNER_EMAIL}:`, e.message);
        }
      }

      return folder.data.id!;
    } catch (createErr: any) {
      if (parentFolderId !== 'root') {
        console.warn(`[Google Drive] Creation in parent ${parentFolderId} failed. Creating in 'root'.`);
        return this.ensureFolder(folderName, 'root');
      }
      throw createErr;
    }
  }

  /**
   * Ensures the nested folder structure:
   * Olive Pizza Reports / {Year} / {SubfolderName} (e.g. Week 29 or July)
   */
  public async getReportFolderId(year: number, subfolderName: string): Promise<string> {
    let yearFolderId = '';
    const configuredFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    if (configuredFolderId) {
      try {
        yearFolderId = await this.ensureFolder(year.toString(), configuredFolderId);
      } catch (err: any) {
        console.warn(`[Google Drive] Configured GOOGLE_DRIVE_FOLDER_ID (${configuredFolderId}) not found or inaccessible. Creating root "Olive Pizza Reports" folder.`);
      }
    }

    if (!yearFolderId) {
      const rootFolderId = await this.ensureFolder(this.rootFolderName, 'root');
      yearFolderId = await this.ensureFolder(year.toString(), rootFolderId);
    }

    const targetFolderId = await this.ensureFolder(subfolderName, yearFolderId);
    return targetFolderId;
  }

  /**
   * Uploads a Buffer as a file to Google Drive under the nested folder structure.
   * If a file with the same name exists in that folder, it updates (replaces) the file content.
   */
  public async uploadReportPdf(
    fileName: string,
    buffer: Buffer,
    year: number,
    subfolderName: string
  ): Promise<DriveUploadResult> {
    this.metrics.totalUploads++;

    if (!this.isEnabled || !this.drive) {
      this.metrics.failedUploads++;
      this.metrics.lastError = 'Google Drive service is not enabled';
      throw new Error('Google Drive service is not enabled.');
    }

    try {
      // 1. Get destination folder ID
      const folderId = await this.getReportFolderId(year, subfolderName);


      // 2. Check if file already exists in folder (duplicate prevention / overwrite)
      const query = `name = '${fileName}' and '${folderId}' in parents and trashed = false`;
      const searchRes = await this.drive.files.list({
        q: query,
        fields: 'files(id, name, webViewLink, webContentLink)',
        spaces: 'drive',
      });

      const existingFile = searchRes.data.files && searchRes.data.files.length > 0 ? searchRes.data.files[0] : null;

      const stream = new Readable();
      stream.push(buffer);
      stream.push(null);

      const media = {
        mimeType: 'application/pdf',
        body: stream,
      };

      let fileId = '';
      let isReplacement = false;

      if (existingFile) {
        // Update existing file content
        fileId = existingFile.id!;
        isReplacement = true;
        await this.drive.files.update({
          fileId,
          media,
          fields: 'id',
        });
        console.log(`[Google Drive] Replaced existing report "${fileName}" (ID: ${fileId})`);
      } else {
        // Create new file
        const fileMetadata: drive_v3.Schema$File = {
          name: fileName,
          parents: [folderId],
        };
        const createRes = await this.drive.files.create({
          requestBody: fileMetadata,
          media,
          fields: 'id',
        });
        fileId = createRes.data.id!;
        console.log(`[Google Drive] Created new report "${fileName}" (ID: ${fileId})`);
      }

      // 3. Make public viewable via link
      try {
        await this.drive.permissions.create({
          fileId,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        });
      } catch (permErr: any) {
        // Safe to ignore if permissions cannot be altered in restricted domain
        console.warn('[Google Drive] Could not set public permission:', permErr.message);
      }

      const driveLink = `https://drive.google.com/file/d/${fileId}/view`;

      this.metrics.successfulUploads++;
      this.metrics.lastUploadAt = new Date().toISOString();

      return {
        fileId,
        driveLink,
        folderId,
        isReplacement,
      };
    } catch (error: any) {
      this.metrics.failedUploads++;
      this.metrics.lastError = error.message;
      console.error(`[Google Drive] Upload failed for ${fileName}:`, error.message);
      throw error;
    }
  }

  /**
   * Helper to upload generic buffer (compatible with legacy callers)
   */
  public async uploadBuffer(fileName: string, buffer: Buffer, mimeType: string): Promise<string | null> {
    if (!this.isEnabled || !this.drive) {
      throw new Error('Google Drive service is not enabled.');
    }
    const year = new Date().getFullYear();
    const monthName = new Date().toLocaleString('default', { month: 'long' });
    const result = await this.uploadReportPdf(fileName, buffer, year, monthName);
    return result.fileId;
  }

  public async deleteFile(fileId: string): Promise<boolean> {
    if (!this.isEnabled || !this.drive) return false;
    try {
      await this.drive.files.delete({ fileId });
      return true;
    } catch (error: any) {
      console.error(`[Google Drive] Failed to delete file ${fileId}:`, error.message);
      return false;
    }
  }
}

export const googleDriveService = new GoogleDriveService();
