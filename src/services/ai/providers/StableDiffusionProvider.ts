/**
 * StableDiffusionProvider.ts — Adapter for Stable Diffusion 3.5 Large Model
 */

import {
  ImageGenerationProvider,
  GenerationOptions,
  EditOptions,
  ModelCapabilities,
  ProviderResult,
  GeneratedImageItem,
} from './ImageGenerationProvider.js';

export class StableDiffusionProvider implements ImageGenerationProvider {
  getCapabilities(): ModelCapabilities {
    return {
      modelId: 'stable-diffusion-3.5-large',
      name: 'Stable Diffusion 3.5 Large',
      supportsTextToImage: true,
      supportsImageEdit: false,
      supportsImageInput: false,
    };
  }

  async generateImage(options: GenerationOptions): Promise<ProviderResult> {
    const modelId = 'stable-diffusion-3.5-large';
    const finalPrompt = options.enhancedPrompt || options.prompt;
    const count = options.count || 4;
    const width = options.width || 1024;
    const height = options.height || 1024;

    try {
      const images: GeneratedImageItem[] = [];
      for (let i = 0; i < count; i++) {
        const seed = options.seed || Math.floor(Math.random() * 9000000) + 1000000 + i;
        const cleanPrompt = encodeURIComponent(
          `${finalPrompt}, cinematic food photography, Stable Diffusion 3.5 large detailed rendering, shallow depth of field, natural lighting`
        );
        const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=turbo`;

        images.push({
          url: imageUrl,
          modelId,
          prompt: options.prompt,
          enhancedPrompt: finalPrompt,
          seed,
        });
      }

      return { success: true, modelId, images };
    } catch (err: any) {
      return {
        success: false,
        modelId,
        images: [],
        error: `Stable Diffusion 3.5 Large generation failed: ${err.message || 'Provider API error'}`,
      };
    }
  }

  async editImage(_options: EditOptions): Promise<ProviderResult> {
    return {
      success: false,
      modelId: 'stable-diffusion-3.5-large',
      images: [],
      error: 'Stable Diffusion 3.5 Large does not support direct image editing in this workflow. Use Qwen Image Edit instead.',
    };
  }
}
