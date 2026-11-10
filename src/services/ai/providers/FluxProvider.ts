/**
 * FluxProvider.ts — Adapter for FLUX.2 Klein 4B Model
 */

import {
  ImageGenerationProvider,
  GenerationOptions,
  EditOptions,
  ModelCapabilities,
  ProviderResult,
  GeneratedImageItem,
} from './ImageGenerationProvider.js';

export class FluxProvider implements ImageGenerationProvider {
  getCapabilities(): ModelCapabilities {
    return {
      modelId: 'flux.2-klein-4b',
      name: 'FLUX.2 Klein 4B',
      supportsTextToImage: true,
      supportsImageEdit: false,
      supportsImageInput: false,
    };
  }

  async generateImage(options: GenerationOptions): Promise<ProviderResult> {
    const modelId = 'flux.2-klein-4b';
    const finalPrompt = options.enhancedPrompt || options.prompt;
    const count = options.count || 4;
    const width = options.width || 1024;
    const height = options.height || 1024;

    try {
      const images: GeneratedImageItem[] = [];
      for (let i = 0; i < count; i++) {
        const seed = options.seed || Math.floor(Math.random() * 9000000) + 1000000 + i;
        const cleanPrompt = encodeURIComponent(
          `${finalPrompt}, ultra-fast realistic food photography, high quality presentation, crisp details, natural shadows`
        );
        const imageUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;

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
        error: `FLUX.2 Klein 4B generation failed: ${err.message || 'Provider API error'}`,
      };
    }
  }

  async editImage(_options: EditOptions): Promise<ProviderResult> {
    return {
      success: false,
      modelId: 'flux.2-klein-4b',
      images: [],
      error: 'FLUX.2 Klein 4B does not support direct image-to-image editing. Use Qwen Image Edit instead.',
    };
  }
}
