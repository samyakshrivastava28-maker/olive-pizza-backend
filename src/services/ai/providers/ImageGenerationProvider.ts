/**
 * ImageGenerationProvider.ts — Internal Abstraction Interface for AI Image Models
 * 
 * Every image generation model (FLUX, Qwen, Qwen Edit, Stable Diffusion)
 * implements this clean adapter interface.
 */

export interface GenerationOptions {
  prompt: string;
  enhancedPrompt?: string;
  aspectRatio?: '1:1' | '4:3' | '3:4' | '16:9';
  count?: number;
  width?: number;
  height?: number;
  seed?: number;
}

export interface EditOptions {
  baseImageUrl: string;
  editPrompt: string;
  aspectRatio?: '1:1' | '4:3' | '3:4' | '16:9';
  width?: number;
  height?: number;
  seed?: number;
}

export interface ModelCapabilities {
  modelId: string;
  name: string;
  supportsTextToImage: boolean;
  supportsImageEdit: boolean;
  supportsImageInput: boolean;
}

export interface GeneratedImageItem {
  url: string;
  modelId: string;
  prompt: string;
  enhancedPrompt: string;
  seed: number;
}

export interface ProviderResult {
  success: boolean;
  modelId: string;
  images: GeneratedImageItem[];
  error?: string;
}

export interface ImageGenerationProvider {
  getCapabilities(): ModelCapabilities;
  generateImage(options: GenerationOptions): Promise<ProviderResult>;
  editImage(options: EditOptions): Promise<ProviderResult>;
}
