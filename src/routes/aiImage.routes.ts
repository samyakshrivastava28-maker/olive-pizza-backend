/**
 * aiImage.routes.ts — Production Routes for AI Image Generation, Editing & Cloudinary Approval
 */

import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { ModelRegistry } from '../services/ai/models/ModelRegistry.js';
import { AIImageService } from '../services/ai/AIImageService.js';
import { ProviderRegistry } from '../services/ai/providers/ProviderRegistry.js';

const router = express.Router();

/**
 * GET /api/ai/image/models
 * Fetch active image models registry & provider capabilities
 */
router.get('/models', requireAuth, requireRole(['owner', 'admin', 'developer']), (_req, res) => {
  try {
    const models = ModelRegistry.getAllModels();
    const capabilities = ProviderRegistry.getAllCapabilities();
    res.json({ success: true, models, capabilities });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/ai/image/history
 * Fetch temporary generation history
 */
router.get('/history', requireAuth, requireRole(['owner', 'admin', 'developer']), (_req, res) => {
  try {
    const history = AIImageService.getHistory();
    res.json({ success: true, history });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/image/enhance-prompt
 * DeepSeek V4 Flash prompt enhancement for food photography
 */
router.post('/enhance-prompt', requireAuth, requireRole(['owner', 'admin', 'developer']), async (req, res) => {
  try {
    const { prompt, targetType, modelId } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    const enhancedPrompt = await AIImageService.enhanceFoodPrompt(prompt, targetType, modelId);
    res.json({ success: true, enhancedPrompt, originalPrompt: prompt, modelId: modelId || 'qwen-image' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Prompt enhancement failed: ' + err.message });
  }
});

/**
 * POST /api/ai/image/generate
 * Generate 4 temporary preview images with selected model
 */
router.post('/generate', requireAuth, requireRole(['owner', 'admin', 'developer']), async (req, res) => {
  try {
    const { prompt, enhancedPrompt, modelId, aspectRatio, count } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    const selectedModel = modelId || 'qwen-image';

    const result = await AIImageService.generateImages({
      prompt,
      enhancedPrompt,
      modelId: selectedModel,
      aspectRatio,
      count: count || 4,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(422).json({
        success: false,
        modelId: selectedModel,
        error: result.error || `Generation failed for ${selectedModel}. Please retry or choose another model.`,
      });
    }
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: `Generation error: ${err.message}`,
    });
  }
});

/**
 * POST /api/ai/image/edit
 * Iterative Image Editing via Qwen Image Edit
 */
router.post('/edit', requireAuth, requireRole(['owner', 'admin', 'developer']), async (req, res) => {
  try {
    const { tempId, baseImageUrl, editPrompt, modelId, aspectRatio } = req.body;
    if (!baseImageUrl || !editPrompt) {
      return res.status(400).json({ success: false, error: 'baseImageUrl and editPrompt are required' });
    }

    const selectedModel = modelId || 'qwen-image-edit';

    const result = await AIImageService.editImage({
      tempId,
      baseImageUrl,
      editPrompt,
      modelId: selectedModel,
      aspectRatio,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(422).json({
        success: false,
        modelId: selectedModel,
        error: result.error || `Editing failed for ${selectedModel}. Try another prompt.`,
      });
    }
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: `Editing error: ${err.message}`,
    });
  }
});

/**
 * POST /api/ai/image/approve
 * Upload approved image to Cloudinary & return permanent URL
 */
router.post('/approve', requireAuth, requireRole(['owner', 'admin', 'developer']), async (req, res) => {
  try {
    const { tempId, imageUrl, folder, metadata } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ success: false, error: 'imageUrl is required' });
    }

    const result = await AIImageService.approveAndStore({
      tempId,
      imageUrl,
      folder,
      metadata,
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Approval upload failed: ' + err.message });
  }
});

export default router;
