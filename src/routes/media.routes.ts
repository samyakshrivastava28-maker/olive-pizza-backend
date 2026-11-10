import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import multer from 'multer';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import cloudinary from '../config/cloudinary.js';
import { MediaOptimizationService } from '../services/storage/MediaOptimizationService.js';
import { backgroundTaskWorker } from '../services/background/BackgroundTaskWorker.js';

const router = Router();
const verifyAdminOrOwner = [requireAuth, requireRole(['owner', 'admin'])];

// Memory storage for fast buffering & stream piping to Cloudinary
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max ceiling
});

const ALLOWED_IMAGE_TYPES = MediaOptimizationService.ALLOWED_IMAGE_TYPES;
const ALLOWED_VIDEO_TYPES = MediaOptimizationService.ALLOWED_VIDEO_TYPES;

const ALLOWED_FOLDERS = [
  'olive-pizza/ads',
  'olive-pizza/banners',
  'olive-pizza/menu',
  'olive-pizza/products',
  'olive-pizza/ai-generated',
  'olive-pizza/ai-product-images',
  'olive-pizza/avatars',
  'olive-pizza/promotions',
  'olive-pizza/media',
  'olive-pizza/videos',
  'olive-pizza/special-categories',
  'olive-pizza/delivery-proofs',
  'olive-pizza/general'
];

/**
 * Stream buffer to Cloudinary with timeout and error handling
 */
function uploadBufferToCloudinary(
  buffer: Buffer,
  options: {
    folder: string;
    resource_type: 'image' | 'video' | 'auto';
    tags?: string[];
  }
): Promise<any> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder,
        resource_type: options.resource_type,
        tags: options.tags,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    const readable = new Readable();
    readable._read = () => {};
    readable.push(buffer);
    readable.push(null);
    readable.pipe(stream);
  });
}

router.get('/test', async (req: Request, res: Response) => {
  try {
    const config = cloudinary.config();
    res.json({
      success: true,
      cloudinaryConnected: !!config.cloud_name && !!config.api_key && !!config.api_secret,
      cloudName: config.cloud_name
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/media/performance-summary
 * Returns media performance and optimization metrics for Owner Dashboard
 */
router.get('/performance-summary', verifyAdminOrOwner, async (req: Request, res: Response) => {
  try {
    const summary = await MediaOptimizationService.getPerformanceSummary();
    res.json({ success: true, summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/media/retry-optimization
 * Retries failed or pending media optimization jobs
 */
router.post('/retry-optimization', verifyAdminOrOwner, async (req: Request, res: Response) => {
  try {
    const { publicId, url, resourceType, docId } = req.body;
    if (!publicId || !url) {
      return res.status(400).json({ success: false, error: 'publicId and url are required' });
    }

    const result = await MediaOptimizationService.processOptimizationJob({
      publicId,
      url,
      resourceType: resourceType || 'image',
      docId
    });

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/media/upload
 * Server-side validated direct upload endpoint for Owner/Admin/Delivery
 * Accepts multipart/form-data with field name 'image', 'file', or 'video'
 */
router.post('/upload', verifyAdminOrOwner, uploadMiddleware.any(), async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    const file = files && files.length > 0 ? files[0] : (req as any).file;

    if (!file || !file.buffer) {
      return res.status(400).json({ success: false, error: 'No media file provided in request' });
    }

    // 1. Centralized Media Validation
    const validation = MediaOptimizationService.validateMedia(file);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const isVideo = validation.resourceType === 'video';
    const mime = validation.mimeType;

    // Folder resolution & sanitation
    const requestedFolder = (req.body?.folder || req.query?.folder) as string | undefined;
    let targetFolder = isVideo ? 'olive-pizza/videos' : 'olive-pizza/media';

    if (requestedFolder && typeof requestedFolder === 'string') {
      const sanitized = requestedFolder.replace(/[^a-zA-Z0-9_\-\/]/g, '');
      if (sanitized.startsWith('olive-pizza/') || ALLOWED_FOLDERS.includes(sanitized)) {
        targetFolder = sanitized;
      }
    }

    // Upload to Cloudinary
    const subTag = targetFolder.replace('olive-pizza/', '') || 'media';
    const uploadResult = await uploadBufferToCloudinary(file.buffer, {
      folder: targetFolder,
      resource_type: isVideo ? 'video' : 'image',
      tags: ['olive_pizza', isVideo ? 'video' : 'image', subTag],
    });

    const secureUrl = uploadResult.secure_url || uploadResult.url;
    const publicId = uploadResult.public_id;
    const format = uploadResult.format || (file.originalname.split('.').pop() || 'bin');

    // 2. Automated Media Optimization Pipeline
    let variants: any;
    let optimizedUrl = secureUrl;
    let thumbnailUrl = secureUrl;
    let posterUrl = '';

    if (isVideo) {
      const vidVariants = MediaOptimizationService.buildOptimizedVideoVariants(secureUrl);
      variants = vidVariants;
      optimizedUrl = vidVariants.optimizedUrl;
      posterUrl = vidVariants.posterUrl;
      thumbnailUrl = vidVariants.posterUrl || secureUrl;
    } else {
      const imgVariants = MediaOptimizationService.buildOptimizedImageVariants(secureUrl);
      variants = imgVariants;
      optimizedUrl = imgVariants.optimizedUrl;
      thumbnailUrl = imgVariants.thumbnailUrl;
    }

    // Register asset in Firestore media_library collection
    let firestoreDocId = '';
    try {
      const { adminDb } = await import('../config/firebase.js');
      if (adminDb) {
        const docRef = await adminDb.collection('media_library').add({
          mediaUrl: secureUrl,
          optimizedUrl,
          thumbnailUrl,
          posterUrl: posterUrl || null,
          variants,
          cloudinaryPublicId: publicId,
          mediaType: mime,
          format,
          bytes: uploadResult.bytes || file.size,
          width: uploadResult.width || null,
          height: uploadResult.height || null,
          duration: uploadResult.duration || null,
          uploadedAt: new Date().toISOString(),
          folder: targetFolder,
          source: 'DIRECT_UPLOAD',
          resourceType: uploadResult.resource_type || (isVideo ? 'video' : 'image'),
          status: 'OPTIMIZED',
        });
        firestoreDocId = docRef.id;
      }
    } catch (fsErr: any) {
      console.warn('[MediaRoutes] Firestore media_library save warning:', fsErr.message);
    }

    // Register asset in PostgreSQL media_assets if available
    try {
      const { pgPool } = await import('../config/postgres.js');
      const client = await pgPool.connect();
      try {
        await client.query(
          `INSERT INTO media_assets 
            (public_id, url, optimized_url, thumbnail_url, poster_url, resource_type, format, bytes, width, height, duration, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPTIMIZED')
           ON CONFLICT (public_id) DO UPDATE SET 
            optimized_url = EXCLUDED.optimized_url,
            thumbnail_url = EXCLUDED.thumbnail_url,
            poster_url = EXCLUDED.poster_url,
            status = 'OPTIMIZED'`,
          [
            publicId,
            secureUrl,
            optimizedUrl,
            thumbnailUrl,
            posterUrl || null,
            isVideo ? 'video' : 'image',
            format,
            uploadResult.bytes || file.size,
            uploadResult.width || null,
            uploadResult.height || null,
            uploadResult.duration || null,
          ]
        );
      } finally {
        client.release();
      }
    } catch (pgErr) {
      // Non-blocking in test environment
    }

    res.json({
      success: true,
      url: secureUrl,
      secure_url: secureUrl,
      optimized_url: optimizedUrl,
      optimizedUrl,
      thumbnail_url: thumbnailUrl,
      thumbnailUrl,
      poster_url: posterUrl,
      posterUrl,
      variants,
      public_id: publicId,
      publicId,
      format,
      bytes: uploadResult.bytes || file.size,
      width: uploadResult.width || null,
      height: uploadResult.height || null,
      duration: uploadResult.duration || null,
      resource_type: uploadResult.resource_type || (isVideo ? 'video' : 'image'),
      status: 'OPTIMIZED',
      docId: firestoreDocId
    });
  } catch (error: any) {
    console.error('[MediaRoutes] Upload error:', error);
    res.status(500).json({ success: false, error: error.message || 'Media upload failed' });
  }
});

router.get('/sign-upload', verifyAdminOrOwner, (req: Request, res: Response) => {
  try {
    const timestamp = Math.round((new Date).getTime() / 1000);
    const requestedFolder = req.query.folder as string | undefined;
    let folder = 'olive-pizza/media';

    if (requestedFolder && typeof requestedFolder === 'string') {
      const sanitized = requestedFolder.replace(/[^a-zA-Z0-9_\-\/]/g, '');
      if (sanitized.startsWith('olive-pizza/') || ALLOWED_FOLDERS.includes(sanitized)) {
        folder = sanitized;
      }
    }
    
    const paramsToSign: any = { timestamp, folder };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign, 
      cloudinary.config().api_secret as string
    );

    res.json({
      success: true,
      timestamp,
      signature,
      cloudName: cloudinary.config().cloud_name,
      apiKey: cloudinary.config().api_key,
      folder
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/ai-images', verifyAdminOrOwner, async (req: Request, res: Response) => {
  try {
    const imagesMap = new Map<string, any>();

    // 1. Try Cloudinary Search API
    try {
      const searchRes = await cloudinary.search
        .expression('folder:olive-pizza*')
        .sort_by('created_at', 'desc')
        .max_results(500)
        .execute();
      if (searchRes && searchRes.resources) {
        searchRes.resources.forEach((img: any) => {
          if (img.secure_url) {
            imagesMap.set(img.secure_url, {
              public_id: img.public_id,
              secure_url: img.secure_url,
              format: img.format || 'jpg',
              created_at: img.created_at,
            });
          }
        });
      }
    } catch (e: any) {
      console.warn('[MediaRoutes] Cloudinary search failed, trying Admin API fallback:', e.message);
    }

    // 2. Try Cloudinary Admin Resources API fallback
    if (imagesMap.size === 0) {
      try {
        const apiRes = await cloudinary.api.resources({
          type: 'upload',
          prefix: 'olive-pizza',
          max_results: 500,
        });
        if (apiRes && apiRes.resources) {
          apiRes.resources.forEach((img: any) => {
            if (img.secure_url) {
              imagesMap.set(img.secure_url, {
                public_id: img.public_id,
                secure_url: img.secure_url,
                format: img.format || 'jpg',
                created_at: img.created_at,
              });
            }
          });
        }
      } catch (apiErr: any) {
        console.warn('[MediaRoutes] Cloudinary resources API fallback failed:', apiErr.message);
      }
    }

    // 3. Fallback/Supplement from Firestore media_library and products
    try {
      const { adminDb } = await import('../config/firebase.js');
      if (adminDb) {
        const mediaDocs = await adminDb.collection('media_library').get();
        mediaDocs.forEach((doc) => {
          const data = doc.data();
          if (data.mediaUrl && !imagesMap.has(data.mediaUrl)) {
            imagesMap.set(data.mediaUrl, {
              public_id: data.cloudinaryPublicId || doc.id,
              secure_url: data.mediaUrl,
              format: data.format || 'jpg',
              created_at: data.uploadedAt || new Date().toISOString(),
            });
          }
        });

        const prodDocs = await adminDb.collection('products').get();
        prodDocs.forEach((doc) => {
          const data = doc.data();
          const pUrl = data.imageUrl || data.image;
          if (pUrl && typeof pUrl === 'string' && pUrl.startsWith('http') && !imagesMap.has(pUrl)) {
            imagesMap.set(pUrl, {
              public_id: data.cloudinaryPublicId || doc.id,
              secure_url: pUrl,
              format: 'jpg',
              created_at: data.createdAt || new Date().toISOString(),
            });
          }
        });
      }
    } catch (dbErr: any) {
      console.warn('[MediaRoutes] Firestore media query warning:', dbErr.message);
    }

    const imagesList = Array.from(imagesMap.values());
    res.json({ success: true, images: imagesList });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:publicId(*)', verifyAdminOrOwner, async (req: Request, res: Response) => {
  try {
    const { publicId } = req.params;
    if (!publicId) {
      return res.status(400).json({ error: 'Missing publicId' });
    }

    const result = await cloudinary.uploader.destroy(publicId, { invalidate: true });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to fetch Cloudinary usage stats
router.get('/usage', verifyAdminOrOwner, async (req: Request, res: Response) => {
  try {
    // Usage API requires provisioned access, but we can try to fetch it
    const usage = await cloudinary.api.usage();
    res.json(usage);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
