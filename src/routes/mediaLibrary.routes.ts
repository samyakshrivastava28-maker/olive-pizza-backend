import { Router, Request, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import cloudinary from '../config/cloudinary.js';

const router = Router();

router.use(verifyToken);
router.use(requireRole(['owner', 'admin', 'developer']));

// Search & list assets across all Olive Pizza folders
router.get('/assets', async (req: AuthRequest, res: Response) => {
  try {
    const folder = (req.query.folder as string) || 'olive-pizza';
    const tag = req.query.tag as string | undefined;
    const search = req.query.q as string | undefined;
    const maxResults = parseInt((req.query.max as string) || '100', 10);

    let expression = `folder:${folder}*`;
    if (tag) expression += ` AND tags=${tag}`;
    if (search) expression += ` AND ${search}`;

    const result = await cloudinary.search
      .expression(expression)
      .sort_by('created_at', 'desc')
      .max_results(maxResults)
      .with_field('tags')
      .with_field('context')
      .execute();

    const assets = (result.resources || []).map((r: any) => ({
      id: r.public_id,
      name: r.filename || r.public_id.split('/').pop(),
      url: r.secure_url,
      thumbnailUrl: r.secure_url.replace('/upload/', '/upload/c_thumb,w_300,h_300/'),
      folder: r.folder,
      format: r.format,
      sizeBytes: r.bytes,
      width: r.width,
      height: r.height,
      tags: r.tags || [],
      uploadedAt: r.created_at,
    }));

    res.json({ success: true, assets, total: result.total_count });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Add/update tags for an asset
router.post('/tags', async (req: AuthRequest, res: Response) => {
  try {
    const { publicId, tag } = req.body;
    if (!publicId || !tag) return res.status(400).json({ error: 'publicId and tag are required' });

    await cloudinary.uploader.add_tag(tag, [publicId]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Remove tag
router.delete('/tags', async (req: AuthRequest, res: Response) => {
  try {
    const { publicId, tag } = req.body;
    if (!publicId || !tag) return res.status(400).json({ error: 'publicId and tag are required' });

    await cloudinary.uploader.remove_tag(tag, [publicId]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
