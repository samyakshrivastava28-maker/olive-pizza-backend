/**
 * knowledge.routes.ts — Cloudflare R2 Knowledge & Status Management Routes
 */

import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { CloudflareR2Service } from '../services/storage/CloudflareR2Service.js';
import { KnowledgeGeneratorService, KnowledgeFileType } from '../services/knowledge/KnowledgeGeneratorService.js';
import { KnowledgeSyncService, KnowledgeMemoryStore } from '../services/knowledge/KnowledgeSyncService.js';

const router = Router();

/**
 * GET /api/knowledge/status
 * Returns Cloudflare R2 status, knowledge version, and RAM cache details.
 */
router.get('/status', async (_req, res: Response) => {
  try {
    const isR2Configured = CloudflareR2Service.isConfigured();
    const ramContext = KnowledgeMemoryStore.getFullContext();
    const cachedFiles = Object.keys(ramContext);

    let r2ObjectsCount = 0;
    if (isR2Configured) {
      const objects = await CloudflareR2Service.listObjects('knowledge/');
      r2ObjectsCount = objects.length;
    }

    res.json({
      success: true,
      r2: {
        configured: isR2Configured,
        bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME || 'Not Configured',
        accountId: process.env.CLOUDFLARE_R2_ACCOUNT_ID ? '✓ Configured' : 'Missing',
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ? '✓ Configured' : 'Missing',
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ? '✓ Configured' : 'Missing',
        publicUrl: process.env.CLOUDFLARE_R2_PUBLIC_URL || null,
        knowledgeObjectsCount: r2ObjectsCount,
      },
      ramCache: {
        fileCount: cachedFiles.length,
        files: cachedFiles.map(f => `${f}.json`),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/knowledge/sync
 * Manually triggers knowledge generation and Cloudflare R2 sync.
 */
router.post('/sync', verifyToken, requireRole(['owner', 'developer']), async (_req: AuthRequest, res: Response) => {
  try {
    const result = await KnowledgeGeneratorService.syncAllKnowledge();
    await KnowledgeSyncService.syncChangedFiles(result.updatedFiles as KnowledgeFileType[]);

    res.json({
      success: true,
      message: `Knowledge synced successfully (Version v${result.version}).`,
      updatedFiles: result.updatedFiles,
      version: result.version,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/knowledge/file/:filename
 * Fetches JSON knowledge file directly from RAM cache or Cloudflare R2.
 */
router.get('/file/:filename', async (req, res: Response) => {
  try {
    const filename = req.params.filename as KnowledgeFileType;
    const ramData = KnowledgeMemoryStore.get(filename);

    if (ramData) {
      return res.json({ source: 'ram', filename, data: ramData });
    }

    if (CloudflareR2Service.isConfigured()) {
      const r2Data = await CloudflareR2Service.downloadJson(`knowledge/${filename}`);
      if (r2Data) {
        return res.json({ source: 'r2', filename, data: r2Data });
      }
    }

    // Generate on-the-fly fallback
    const fallback = await KnowledgeGeneratorService.generateFileKnowledge(filename);
    res.json({ source: 'generated', filename, data: fallback.json.data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
