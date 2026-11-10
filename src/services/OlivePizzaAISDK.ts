/**
 * OlivePizzaAISDK.ts — Official SDK Client for Olive Pizza AI Platform
 * 
 * Main Project MUST NOT generate AI responses locally.
 * All AI requests (chat, prompt enhancement, product description, image generation,
 * email template generation, SDUI design generation) are routed through this SDK to Olive Pizza AI.
 */

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const OLIVE_PIZZA_AI_URL = process.env.OLIVE_PIZZA_AI_URL || 'https://olive-pizza-ai.onrender.com';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequestOptions {
  message: string;
  history?: ChatMessage[];
  sessionId?: string;
  userContext?: any;
  authToken?: string;
}

export interface EnhancePromptOptions {
  prompt: string;
  targetType?: 'product' | 'combo' | 'email' | 'ad' | 'sdui';
  context?: any;
}

export interface ProductDescriptionOptions {
  name: string;
  category?: string;
  price?: number;
  ingredients?: string[];
  attributes?: string[];
}

export interface ProductImageOptions {
  prompt: string;
  name?: string;
  category?: string;
}

export interface EmailTemplateOptions {
  prompt: string;
  campaignType?: string;
  targetAudience?: string;
}

export interface SDUIDesignOptions {
  prompt: string;
  screenType?: string;
  currentDraft?: any;
}

export class OlivePizzaAISDK {
  private static getBaseUrl(): string {
    return (process.env.OLIVE_PIZZA_AI_URL || OLIVE_PIZZA_AI_URL).replace(/\/+$/, '');
  }

  private static generateHeaders(bodyPayload: any, authToken?: string): Record<string, string> {
    const secret = process.env.AI_GATEWAY_SECRET?.trim();
    if (!secret) {
      // Never sign with a known default. Surface the real configuration error to the caller.
      throw new Error('AI_GATEWAY_SECRET is not configured; cannot sign requests to Olive Pizza AI.');
    }
    const timestamp = Date.now().toString();
    const payload = `${timestamp}:${JSON.stringify(bodyPayload || {})}`;
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-AI-Signature': signature,
      'X-AI-Timestamp': timestamp,
      'X-Source-System': 'Olive-Pizza-Main',
    };

    if (authToken) {
      headers['Authorization'] = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
    }

    return headers;
  }

  /**
   * Route conversational chat request to Olive Pizza AI
   */
  static async chat(options: ChatRequestOptions): Promise<{ reply: string; source: string; products?: any[] }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/chat`;
      const headers = this.generateHeaders(options, options.authToken);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[OlivePizzaAISDK] Chat request failed (${res.status}): ${errText}`);
        return {
          reply: 'Olive Pizza AI is processing your request. Please try again in a moment. 🍕',
          source: 'olive_pizza_ai_fallback',
        };
      }

      const data = await res.json();
      return {
        reply: data.reply || data.response || 'Thank you for reaching out to Olive Pizza AI.',
        source: data.source || 'olive_pizza_ai',
        products: data.products || [],
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Chat fetch error:', err.message);
      return {
        reply: 'Olive Pizza AI connection unavailable. Please check your network connection.',
        source: 'sdk_error',
      };
    }
  }

  /**
   * Route prompt enhancement to Olive Pizza AI
   */
  static async enhancePrompt(options: EnhancePromptOptions): Promise<{ enhancedPrompt: string }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/enhance-prompt`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        return { enhancedPrompt: options.prompt };
      }

      const data = await res.json();
      return { enhancedPrompt: data.enhancedPrompt || data.prompt || options.prompt };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Enhance prompt error:', err.message);
      return { enhancedPrompt: options.prompt };
    }
  }

  /**
   * Route product description generation to Olive Pizza AI
   */
  static async generateProductDescription(options: ProductDescriptionOptions): Promise<{ description: string; highlights: string[] }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/generate-product-description`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        return {
          description: `Delicious ${options.name} crafted with fresh ingredients and authentic Olive Pizza recipe.`,
          highlights: ['Fresh Ingredients', 'Handcrafted', 'Hot & Fresh'],
        };
      }

      const data = await res.json();
      return {
        description: data.description || `Delicious ${options.name} prepared fresh at Olive Pizza.`,
        highlights: data.highlights || ['Fresh', 'Authentic Taste'],
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Product description error:', err.message);
      return {
        description: `Delicious ${options.name} crafted with care at Olive Pizza.`,
        highlights: ['Fresh', 'Delicious'],
      };
    }
  }

  /**
   * Route product image generation to Olive Pizza AI
   */
  static async generateProductImage(options: ProductImageOptions): Promise<{ imageUrl: string }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/generate-product-image`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        throw new Error(`AI Service returned status ${res.status}`);
      }

      const data = await res.json();
      return { imageUrl: data.imageUrl || data.url || '' };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Product image error:', err.message);
      throw err;
    }
  }

  /**
   * Route email template generation to Olive Pizza AI
   */
  static async generateEmailTemplate(options: EmailTemplateOptions): Promise<{ subject: string; bodyHtml: string; ctaText: string }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/generate-email`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        return {
          subject: 'Special Offer from Olive Pizza! 🍕',
          bodyHtml: '<p>Enjoy delicious pizzas handcrafted fresh for you at Olive Pizza!</p>',
          ctaText: 'Order Now',
        };
      }

      const data = await res.json();
      return {
        subject: data.subject || 'Olive Pizza Special Offer',
        bodyHtml: data.bodyHtml || data.html || '<p>Order your favorite pizza now!</p>',
        ctaText: data.ctaText || 'Order Now',
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Email template error:', err.message);
      return {
        subject: 'Olive Pizza Announcement',
        bodyHtml: '<p>Check out our latest menu and deals!</p>',
        ctaText: 'View Menu',
      };
    }
  }

  /**
   * Route SDUI layout generation to Olive Pizza AI
   */
  static async generateSDUIDesign(options: SDUIDesignOptions): Promise<{ sections: any[]; explanation: string }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/generate-sdui`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        return { sections: [], explanation: 'Failed to generate SDUI layout' };
      }

      const data = await res.json();
      return {
        sections: data.sections || [],
        explanation: data.explanation || 'SDUI design generated by Olive Pizza AI',
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] SDUI design error:', err.message);
      return { sections: [], explanation: err.message };
    }
  }

  /**
   * Route owner NL command to Olive Pizza AI
   */
  static async processOwnerCommand(command: string, userId: string, sessionId?: string): Promise<any> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/owner-command`;
      const payload = { command, userId, sessionId };
      const headers = this.generateHeaders(payload);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        return {
          success: false,
          explanation: 'Olive Pizza AI was unable to process the owner command.',
          diff: {},
          previewReady: false,
          suggestions: [],
          latencyMs: 0,
          modelUsed: 'OlivePizzaAI',
        };
      }

      return await res.json();
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Owner command error:', err.message);
      return {
        success: false,
        explanation: `SDK Connection Error: ${err.message}`,
        diff: {},
        previewReady: false,
        suggestions: [],
        latencyMs: 0,
        modelUsed: 'OlivePizzaAI',
      };
    }
  }

  /**
   * Check health of Olive Pizza AI connection
   */
  static async getAIHealthStatus(): Promise<{ ok: boolean; platform: string; version: string }> {
    try {
      const url = `${this.getBaseUrl()}/api/ai/health`;
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        return { ok: true, platform: 'Olive Pizza AI Platform', version: data.version || '1.0.0' };
      }
      return { ok: false, platform: 'Olive Pizza AI Platform', version: 'unknown' };
    } catch {
      return { ok: false, platform: 'Olive Pizza AI Platform', version: 'offline' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SDUI Design Agent Methods — All delegated to Olive Pizza AI via SDK
  // No local AI, no local RAG, no local LLM. Olive Pizza AI is the ONLY intelligence platform.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Route design reasoning request to DeepSeek V4 Pro on Olive Pizza AI.
   * Analyzes owner prompt and returns structured design intent + layout strategy.
   */
  static async requestDesignReasoning(options: {
    ownerPrompt: string;
    context?: { restaurantInfo?: any; activeProducts?: number; activeCoupons?: number };
  }): Promise<{ reasoning: string; layoutStrategy: string; keyElements: string[]; modelUsed: string; latencyMs: number }> {
    const startTime = Date.now();
    try {
      const url = `${this.getBaseUrl()}/api/ai/design-reasoning`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[OlivePizzaAISDK] Design reasoning failed (${res.status}): ${errText}`);
        return {
          reasoning: `Analyzing prompt: "${options.ownerPrompt}". Focus on mobile-first premium layout with Olive Pizza brand system.`,
          layoutStrategy: 'Hero → Categories → Best Sellers → Coupons → Offers → Download App',
          keyElements: ['Hero banner', 'Category cards', 'Product grid', 'Coupon carousel'],
          modelUsed: 'DeepSeek V4 Pro (fallback)',
          latencyMs: Date.now() - startTime,
        };
      }

      const data = await res.json();
      return {
        reasoning: data.reasoning || data.explanation || '',
        layoutStrategy: data.layoutStrategy || data.strategy || '',
        keyElements: data.keyElements || data.elements || [],
        modelUsed: data.modelUsed || 'DeepSeek V4 Pro',
        latencyMs: Date.now() - startTime,
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Design reasoning error:', err.message);
      return {
        reasoning: `Layout strategy for: "${options.ownerPrompt}"`,
        layoutStrategy: 'Hero → Categories → Best Sellers → Coupons',
        keyElements: ['Hero', 'Categories', 'Products', 'Coupons'],
        modelUsed: 'DeepSeek V4 Pro (sdk_error)',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Route design advice request to GLM 5.2 on Olive Pizza AI.
   * Provides second-opinion layout strategy and design tips.
   */
  static async requestDesignAdvice(options: {
    ownerPrompt: string;
    reasoningFromDeepSeek: string;
  }): Promise<{ advice: string; improvements: string[]; colorSuggestions: string[]; modelUsed: string; latencyMs: number }> {
    const startTime = Date.now();
    try {
      const url = `${this.getBaseUrl()}/api/ai/design-advice`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        return {
          advice: `Complement with glassmorphic card sections and smooth Framer Motion animations for a premium feel.`,
          improvements: ['Add testimonials section', 'Use gradient hero background', 'Increase card border-radius'],
          colorSuggestions: ['#f97316 (primary orange)', '#0d0e12 (surface dark)', '#f59e0b (gold accent)'],
          modelUsed: 'GLM 5.2 (fallback)',
          latencyMs: Date.now() - startTime,
        };
      }

      const data = await res.json();
      return {
        advice: data.advice || data.suggestion || '',
        improvements: data.improvements || [],
        colorSuggestions: data.colorSuggestions || [],
        modelUsed: data.modelUsed || 'GLM 5.2',
        latencyMs: Date.now() - startTime,
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Design advice error:', err.message);
      return {
        advice: 'Focus on mobile-first layout with glassmorphic elements.',
        improvements: ['Add section animations', 'Improve CTA contrast'],
        colorSuggestions: ['#f97316', '#0d0e12'],
        modelUsed: 'GLM 5.2 (sdk_error)',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Route Stitch prompt formatting to DeepSeek V4 Flash on Olive Pizza AI.
   * Converts reasoning+advice into an optimized Google Stitch design specification.
   */
  static async enhanceStitchPrompt(options: {
    ownerPrompt: string;
    reasoning: string;
    advice: string;
  }): Promise<{ stitchPrompt: string; modelUsed: string; latencyMs: number }> {
    const startTime = Date.now();
    try {
      const url = `${this.getBaseUrl()}/api/ai/enhance-stitch-prompt`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        // Construct a rich Stitch spec as fallback
        const spec = `👑 [Google Stitch Design Specification — Olive Pizza]\nPrompt: "${options.ownerPrompt}"\n${options.reasoning}\nDesign Notes: ${options.advice}\nVisual Theme: Ultra-luxury artisanal wood-fired pizzeria, dark obsidian canvas (#06070a), primary orange (#f97316), secondary gold (#f59e0b).\nComponents: Cinematic hero banner, 3D glassmorphic cards, certified wood-fired badges, responsive mobile-first layout.`;
        return { stitchPrompt: spec, modelUsed: 'DeepSeek V4 Flash (fallback)', latencyMs: Date.now() - startTime };
      }

      const data = await res.json();
      return {
        stitchPrompt: data.stitchPrompt || data.enhancedPrompt || options.ownerPrompt,
        modelUsed: data.modelUsed || 'DeepSeek V4 Flash',
        latencyMs: Date.now() - startTime,
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Stitch prompt error:', err.message);
      return {
        stitchPrompt: `Premium Olive Pizza layout: ${options.ownerPrompt}. Dark theme, glassmorphic cards, orange accent.`,
        modelUsed: 'DeepSeek V4 Flash (sdk_error)',
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Route design safety review to DeepSeek V4 Pro on Olive Pizza AI.
   * Validates generated sections for visual quality + business action preservation.
   */
  static async reviewDesignSafety(options: {
    sections: any[];
    ownerPrompt: string;
  }): Promise<{
    overallScore: number;
    visualScore: number;
    functionalScore: number;
    ragScore: number;
    buttonMapping: Array<{ buttonText: string; action: string; isSafe: boolean; suggestedAction?: string }>;
    unmappedButtons: string[];
    suggestions: Array<{ severity: 'info' | 'warning' | 'critical'; message: string }>;
    modelUsed: string;
    latencyMs: number;
  }> {
    const startTime = Date.now();

    // Supported business actions — NEVER allow bypassing these mappings
    const SUPPORTED_ACTIONS = [
      'ADD_TO_CART', 'OPEN_MENU', 'OPEN_CART', 'OPEN_CHECKOUT',
      'APPLY_COUPON', 'LOGIN', 'LOGOUT', 'TRACK_ORDER', 'VIEW_PRODUCT',
      'OPEN_OFFERS', 'NAVIGATE', 'SCROLL_TO',
    ];

    try {
      const url = `${this.getBaseUrl()}/api/ai/review-design-safety`;
      const headers = this.generateHeaders(options);

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        // Local safety analysis when AI is unavailable
        return this._localSafetyAnalysis(options.sections, SUPPORTED_ACTIONS, startTime);
      }

      const data = await res.json();
      return {
        overallScore: data.overallScore ?? 80,
        visualScore: data.visualScore ?? 80,
        functionalScore: data.functionalScore ?? 85,
        ragScore: data.ragScore ?? 75,
        buttonMapping: data.buttonMapping || [],
        unmappedButtons: data.unmappedButtons || [],
        suggestions: data.suggestions || [],
        modelUsed: data.modelUsed || 'DeepSeek V4 Pro',
        latencyMs: Date.now() - startTime,
      };
    } catch (err: any) {
      console.error('[OlivePizzaAISDK] Design safety review error:', err.message);
      return this._localSafetyAnalysis(options.sections, SUPPORTED_ACTIONS, startTime);
    }
  }

  /**
   * Local structural safety analysis when Olive Pizza AI is unavailable.
   * Does NOT call any local LLM or RAG — purely structural inspection.
   */
  private static _localSafetyAnalysis(
    sections: any[],
    supportedActions: string[],
    startTime: number,
  ) {
    const hasHero = sections.some((s: any) => s.type === 'hero');
    const hasCoupons = sections.some((s: any) => s.type === 'coupons');
    const hasCategories = sections.some((s: any) => s.type === 'categories');
    const buttonMapping: Array<{ buttonText: string; action: string; isSafe: boolean; suggestedAction?: string }> = [];
    const unmappedButtons: string[] = [];
    const suggestions: Array<{ severity: 'info' | 'warning' | 'critical'; message: string }> = [];

    // Scan sections for button actions
    sections.forEach((s: any) => {
      const ctaText = s.config?.ctaText || s.config?.buttonText;
      const ctaAction = s.config?.ctaAction;
      if (ctaText) {
        const isSafe = !ctaAction || supportedActions.includes(ctaAction);
        buttonMapping.push({ buttonText: ctaText, action: ctaAction || 'OPEN_MENU', isSafe });
        if (!isSafe) unmappedButtons.push(ctaText);
      }
    });

    if (!hasHero) suggestions.push({ severity: 'critical', message: 'Missing Hero section — this is the first thing customers see.' });
    if (!hasCoupons) suggestions.push({ severity: 'warning', message: 'Add a Coupons section to boost conversion rates.' });
    if (!hasCategories) suggestions.push({ severity: 'warning', message: 'Menu Categories help customers navigate faster.' });

    const visualScore = (hasHero ? 30 : 0) + (hasCategories ? 20 : 0) + (hasCoupons ? 15 : 0) + 35;
    const functionalScore = unmappedButtons.length === 0 ? 95 : Math.max(60, 95 - unmappedButtons.length * 10);
    const ragScore = 75; // Structural check only, no RAG access on main project

    return {
      overallScore: Math.round((visualScore + functionalScore + ragScore) / 3),
      visualScore,
      functionalScore,
      ragScore,
      buttonMapping,
      unmappedButtons,
      suggestions,
      modelUsed: 'Local Safety Check (Olive Pizza AI Offline)',
      latencyMs: Date.now() - startTime,
    };
  }
}

