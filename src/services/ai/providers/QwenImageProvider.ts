/**
 * QwenImageProvider.ts — Adapter for Qwen Image (Photorealistic Product Photography)
 */

import {
  ImageGenerationProvider,
  GenerationOptions,
  EditOptions,
  ModelCapabilities,
  ProviderResult,
  GeneratedImageItem,
} from './ImageGenerationProvider.js';

export class QwenImageProvider implements ImageGenerationProvider {
  getCapabilities(): ModelCapabilities {
    return {
      modelId: 'qwen-image',
      name: 'Qwen Image',
      supportsTextToImage: true,
      supportsImageEdit: false,
      supportsImageInput: false,
    };
  }

  async generateImage(options: GenerationOptions): Promise<ProviderResult> {
    const modelId = 'qwen-image';
    const finalPrompt = options.enhancedPrompt || options.prompt;
    const count = options.count || 4;
    const width = options.width || 1024;
    const height = options.height || 1024;

    try {
      const images: GeneratedImageItem[] = [];
      for (let i = 0; i < count; i++) {
        const seed = options.seed || Math.floor(Math.random() * 9000000) + 1000000 + i;
        const cleanPrompt = encodeURIComponent(
          `${finalPrompt}, commercial restaurant product photography, photorealistic food texture, appetizing oven-baked appearance, studio lighting, clean backdrop`
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
        error: `Qwen Image generation failed: ${err.message || 'Provider API error'}`,
      };
    }
  }

  async editImage(_options: EditOptions): Promise<ProviderResult> {
    return {
      success: false,
      modelId: 'qwen-image',
      images: [],
      error: 'Qwen Image does not support direct image editing. Switch model to Qwen Image Edit.',
    };
  }
}
