/**
 * CloudflareR2Service.ts — Central Cloudflare R2 Object Storage Service
 * 
 * Secure backend-only service for uploading/downloading AI knowledge JSON,
 * SDUI backups, reports, and assets to Cloudflare R2.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

export interface R2ObjectMetadata {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: Date;
  contentType?: string;
}

export class CloudflareR2Service {
  private static s3Client: S3Client | null = null;

  /**
   * Checks whether Cloudflare R2 credentials are configured in environment variables.
   */
  static isConfigured(): boolean {
    const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
    const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME;
    const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

    return Boolean(
      accountId && accountId.trim().length > 0 &&
      bucketName && bucketName.trim().length > 0 &&
      accessKeyId && accessKeyId.trim().length > 0 &&
      secretAccessKey && secretAccessKey.trim().length > 0
    );
  }

  /**
   * Returns configured S3Client instance targeting Cloudflare R2 endpoint.
   */
  private static getClient(): S3Client {
    if (this.s3Client) return this.s3Client;

    const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
    const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error('Cloudflare R2 credentials missing. Please set CLOUDFLARE_R2_ACCOUNT_ID, CLOUDFLARE_R2_ACCESS_KEY_ID, and CLOUDFLARE_R2_SECRET_ACCESS_KEY in environment variables.');
    }

    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
      },
    });

    return this.s3Client;
  }

  private static getBucketName(): string {
    const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME;
    if (!bucket || !bucket.trim()) {
      throw new Error('CLOUDFLARE_R2_BUCKET_NAME is not set.');
    }
    return bucket.trim();
  }

  /**
   * Uploads a JSON object to Cloudflare R2 with automatic retry logic.
   * If credentials are missing, falls back to local disk (.r2_mock).
   */
  static async uploadJson(key: string, data: any, retries: number = 3): Promise<{ key: string; checksum: string; url?: string }> {
    const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonString, 'utf-8');
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    if (!this.isConfigured()) {
      const fs = await import('fs');
      const path = await import('path');
      const mockDir = path.join(process.cwd(), '.r2_mock');
      const filePath = path.join(mockDir, key);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
      console.warn(`[Cloudflare R2] Credentials not set. Wrote JSON to local mock: "${filePath}"`);
      return { key, checksum };
    }

    let lastError: any;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const client = this.getClient();
        const bucket = this.getBucketName();

        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: 'application/json; charset=utf-8',
            CacheControl: 'no-cache, max-age=0',
            Metadata: {
              checksum,
              uploadedAt: new Date().toISOString(),
            },
          })
        );

        console.log(`[Cloudflare R2] Successfully uploaded "${key}" (${buffer.length} bytes, sha256: ${checksum.slice(0, 8)}...)`);
        
        const publicUrlBase = process.env.CLOUDFLARE_R2_PUBLIC_URL;
        const publicUrl = publicUrlBase ? `${publicUrlBase.replace(/\/$/, '')}/${key}` : undefined;

        return { key, checksum, url: publicUrl };
      } catch (err: any) {
        lastError = err;
        console.warn(`[Cloudflare R2] Upload attempt ${attempt}/${retries} failed for "${key}": ${err.message}`);
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, 500 * attempt));
        }
      }
    }

    throw new Error(`Cloudflare R2 upload failed for "${key}": ${lastError?.message}`);
  }

  /**
   * Downloads a JSON object from Cloudflare R2.
   * If credentials are missing, falls back to local disk (.r2_mock).
   */
  static async downloadJson<T = any>(key: string): Promise<T | null> {
    if (!this.isConfigured()) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.join(process.cwd(), '.r2_mock', key);
        if (fs.existsSync(filePath)) {
          const str = fs.readFileSync(filePath, 'utf-8');
          return JSON.parse(str) as T;
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    try {
      const client = this.getClient();
      const bucket = this.getBucketName();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      if (!response.Body) return null;
      const str = await response.Body.transformToString('utf-8');
      return JSON.parse(str) as T;
    } catch (err: any) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.error(`[Cloudflare R2] Error downloading "${key}":`, err.message);
      throw err;
    }
  }

  /**
   * Deletes an object from Cloudflare R2.
   */
  static async deleteObject(key: string): Promise<boolean> {
    if (!this.isConfigured()) return false;

    try {
      const client = this.getClient();
      const bucket = this.getBucketName();

      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      console.log(`[Cloudflare R2] Deleted object "${key}"`);
      return true;
    } catch (err: any) {
      console.error(`[Cloudflare R2] Error deleting "${key}":`, err.message);
      return false;
    }
  }

  /**
  /**
   * Uploads raw File Buffer (images, PDFs, documents).
   * If R2 is unconfigured, saves buffer to local disk (.r2_mock).
   */
  static async uploadBuffer(key: string, buffer: Buffer, contentType: string = 'application/octet-stream'): Promise<{ key: string; url?: string }> {
    if (!this.isConfigured()) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.join(process.cwd(), '.r2_mock', key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);
        console.log(`[Cloudflare R2] R2 unconfigured. Saved buffer to local mock: "${filePath}"`);
      } catch (err: any) {
        console.warn(`[Cloudflare R2] Failed writing local mock buffer:`, err.message);
      }
      return { key };
    }

    const client = this.getClient();
    const bucket = this.getBucketName();

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    const publicUrlBase = process.env.CLOUDFLARE_R2_PUBLIC_URL;
    const publicUrl = publicUrlBase ? `${publicUrlBase.replace(/\/$/, '')}/${key}` : undefined;

    return { key, url: publicUrl };
  }

  /**
   * Reads raw File Buffer from R2 or local disk fallback (.r2_mock).
   */
  static async getBuffer(key: string): Promise<Buffer | null> {
    if (!this.isConfigured()) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.join(process.cwd(), '.r2_mock', key);
        if (fs.existsSync(filePath)) {
          return fs.readFileSync(filePath);
        }
        return null;
      } catch (err) {
        return null;
      }
    }

    try {
      const client = this.getClient();
      const bucket = this.getBucketName();

      const response = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );

      if (!response.Body) return null;
      const arrayBytes = await response.Body.transformToByteArray();
      return Buffer.from(arrayBytes);
    } catch (err: any) {
      console.warn(`[Cloudflare R2] Error getting buffer for "${key}":`, err.message);
      return null;
    }
  }

  /**
   * Generates a signed URL for secure temporary view or attachment download.
   * If responseContentDisposition is provided, it is included in GetObjectCommand before signing
   * to preserve AWS S3 V4 signature integrity.
   */
  static async generatePreSignedUrl(
    key: string, 
    expiresInSeconds: number = 3600,
    responseContentDisposition?: string
  ): Promise<string | null> {
    if (!this.isConfigured()) return null;

    try {
      const client = this.getClient();
      const bucket = this.getBucketName();

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(responseContentDisposition ? { ResponseContentDisposition: responseContentDisposition } : {}),
      });

      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    } catch (err: any) {
      console.error(`[Cloudflare R2] Error generating pre-signed URL for "${key}":`, err.message);
      return null;
    }
  }

  /**
   * Lists objects with prefix.
   */
  static async listObjects(prefix: string = ''): Promise<R2ObjectMetadata[]> {
    if (!this.isConfigured()) return [];

    try {
      const client = this.getClient();
      const bucket = this.getBucketName();

      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
        })
      );

      return (response.Contents || []).map((item) => ({
        key: item.Key || '',
        size: item.Size,
        etag: item.ETag,
        lastModified: item.LastModified,
      }));
    } catch (err: any) {
      console.error(`[Cloudflare R2] Error listing objects with prefix "${prefix}":`, err.message);
      return [];
    }
  }
}
