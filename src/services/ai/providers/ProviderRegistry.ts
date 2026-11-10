/**
 * ProviderRegistry.ts — Registry for ImageGenerationProvider instances
 */

import { ImageGenerationProvider, ModelCapabilities } from './ImageGenerationProvider.js';
import { FluxProvider } from './FluxProvider.js';
import { QwenImageProvider } from './QwenImageProvider.js';
import { QwenImageEditProvider } from './QwenImageEditProvider.js';
import { StableDiffusionProvider } from './StableDiffusionProvider.js';

export class ProviderRegistry {
  private static providers: Map<string, ImageGenerationProvider> = new Map();

  static {
    const flux = new FluxProvider();
    const qwen = new QwenImageProvider();
    const qwenEdit = new QwenImageEditProvider();
    const sd = new StableDiffusionProvider();

    this.providers.set('flux.2-klein-4b', flux);
    this.providers.set('qwen-image', qwen);
    this.providers.set('qwen-image-edit', qwenEdit);
    this.providers.set('stable-diffusion-3.5-large', sd);
  }

  static getProvider(modelId: string): ImageGenerationProvider {
    const provider = this.providers.get(modelId);
    if (!provider) {
      // Default to qwen-image if unrecognized
      return this.providers.get('qwen-image')!;
    }
    return provider;
  }

  static getAllCapabilities(): ModelCapabilities[] {
    return Array.from(this.providers.values()).map((p) => p.getCapabilities());
  }
}
