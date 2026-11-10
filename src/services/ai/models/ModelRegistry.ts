/**
 * ModelRegistry.ts — Production Model Registry for Olive Pizza AI Image System
 * 
 * Manages model specs, providers, capabilities, and fallback options.
 */

export interface AIImageModelSpec {
  modelId: string;
  name: string;
  provider: string;
  badge: 'Fast' | 'Best Quality' | 'Edit Existing' | 'Standard';
  supportsTextToImage: boolean;
  supportsImageEdit: boolean;
  supportsNegativePrompt: boolean;
  supportsAspectRatio: boolean;
  maxImages: number;
  description: string;
  defaultAspectRatio?: '1:1' | '4:3' | '3:4' | '16:9';
}

export const AI_IMAGE_MODELS: Record<string, AIImageModelSpec> = {
  'flux.2-klein-4b': {
    modelId: 'flux.2-klein-4b',
    name: 'FLUX.2 Klein 4B',
    provider: 'FLUX / NVIDIA NIM',
    badge: 'Fast',
    supportsTextToImage: true,
    supportsImageEdit: false,
    supportsNegativePrompt: true,
    supportsAspectRatio: true,
    maxImages: 4,
    description: 'Fast generation',
    defaultAspectRatio: '1:1',
  },
  'qwen-image': {
    modelId: 'qwen-image',
    name: 'Qwen Image',
    provider: 'Qwen / OpenRouter',
    badge: 'Best Quality',
    supportsTextToImage: true,
    supportsImageEdit: false,
    supportsNegativePrompt: true,
    supportsAspectRatio: true,
    maxImages: 4,
    description: 'High-quality product generation',
    defaultAspectRatio: '1:1',
  },
  'qwen-image-edit': {
    modelId: 'qwen-image-edit',
    name: 'Qwen Image Edit',
    provider: 'Qwen Edit / OpenRouter',
    badge: 'Edit Existing',
    supportsTextToImage: false,
    supportsImageEdit: true,
    supportsNegativePrompt: true,
    supportsAspectRatio: true,
    maxImages: 4,
    description: 'Best for modifying an existing image',
    defaultAspectRatio: '1:1',
  },
  'stable-diffusion-3.5-large': {
    modelId: 'stable-diffusion-3.5-large',
    name: 'Stable Diffusion 3.5 Large',
    provider: 'Stability AI / NVIDIA NIM',
    badge: 'Best Quality',
    supportsTextToImage: true,
    supportsImageEdit: false,
    supportsNegativePrompt: true,
    supportsAspectRatio: true,
    maxImages: 4,
    description: 'Detailed image generation',
    defaultAspectRatio: '1:1',
  },
};

export class ModelRegistry {
  static getModel(modelId: string): AIImageModelSpec | null {
    return AI_IMAGE_MODELS[modelId] || null;
  }

  static getAllModels(): AIImageModelSpec[] {
    return Object.values(AI_IMAGE_MODELS);
  }

  static getTextToImageModels(): AIImageModelSpec[] {
    return Object.values(AI_IMAGE_MODELS).filter((m) => m.supportsTextToImage);
  }

  static getImageEditModels(): AIImageModelSpec[] {
    return Object.values(AI_IMAGE_MODELS).filter((m) => m.supportsImageEdit);
  }
}
