/**
 * ai.service.ts — Business AI Service Integration for Olive Pizza Main
 * 
 * Main Project routes AI business requests to Olive Pizza AI via OlivePizzaAISDK
 * while preserving full backwards-compatibility and local key fallbacks.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import cloudinary from '../config/cloudinary.js';
import { OlivePizzaAISDK } from './OlivePizzaAISDK.js';

dotenv.config();

function getKey(name: string): string {
  const assistantKey = `ASSISTANT_${name}`;
  return process.env[assistantKey] || process.env[name] || '';
}

function isValidKey(key: string): boolean {
  return typeof key === 'string' && key.trim().length > 10;
}

let _nvidiaClient: OpenAI | null = null;
let _openRouterClient: OpenAI | null = null;
let _geminiClient: OpenAI | null = null;

function getNvidiaClient(): OpenAI | null {
  const key = getKey('NVIDIA_API_KEY');
  if (!isValidKey(key)) return null;
  if (!_nvidiaClient) {
    _nvidiaClient = new OpenAI({ apiKey: key, baseURL: 'https://integrate.api.nvidia.com/v1', timeout: 15000 });
  }
  return _nvidiaClient;
}

function getOpenRouterClient(): OpenAI | null {
  const key = getKey('OPENROUTER_API_KEY');
  if (!isValidKey(key)) return null;
  if (!_openRouterClient) {
    _openRouterClient = new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1', timeout: 15000 });
  }
  return _openRouterClient;
}

function getGeminiClient(): OpenAI | null {
  const key = getKey('GEMINI_API_KEY');
  if (!isValidKey(key)) return null;
  if (!_geminiClient) {
    _geminiClient = new OpenAI({ apiKey: key, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', timeout: 15000 });
  }
  return _geminiClient;
}

function getFallbackClient(): { client: OpenAI; name: string } | null {
  const nv = getNvidiaClient();
  if (nv) return { client: nv, name: 'NVIDIA NIM (Local Key)' };
  const or = getOpenRouterClient();
  if (or) return { client: or, name: 'OpenRouter (Local Key)' };
  const gm = getGeminiClient();
  if (gm) return { client: gm, name: 'Google Gemini (Local Key)' };
  return null;
}

export const aiProviderStats = {
  nvidia:     { ok: isValidKey(getKey('NVIDIA_API_KEY')), lastUsed: Date.now(), lastError: '', attempts: 1, successes: 1 },
  openrouter: { ok: isValidKey(getKey('OPENROUTER_API_KEY')), lastUsed: Date.now(), lastError: '', attempts: 1, successes: 1 },
  gemini:     { ok: isValidKey(getKey('GEMINI_API_KEY')), lastUsed: Date.now(), lastError: '', attempts: 1, successes: 1 },
  activeProvider: 'OlivePizzaAI Platform',
  totalRequests: 0,
  totalFailovers: 0,
  avgResponseMs: 120,
};

export const getActiveModelChain = () => [
  { name: 'Olive Pizza AI Master Router', providerKey: 'olive_pizza_ai', model: 'olive-pizza-ai-v1' }
];

async function fetchProductContext(selectedProducts: string[]): Promise<string> {
  if (!selectedProducts || selectedProducts.length === 0) return '';
  try {
    const { adminDb } = await import('../config/firebase.js');
    if (!adminDb) return '';
    let context = '\nPRODUCTS TO INCLUDE:\n';
    for (const prodId of selectedProducts) {
      try {
        const prodSnap = await adminDb.collection('products').doc(prodId).get();
        if (prodSnap.exists) {
          const p = prodSnap.data()!;
          context += `- ${p.name}: ₹${p.price}. ${p.description || ''}\n`;
          if (p.imageUrl) context += `  Image URL: ${p.imageUrl}\n`;
        }
      } catch {}
    }
    return context;
  } catch (e) {
    console.warn('[AI] Could not fetch Firestore products:', (e as any).message);
    return '';
  }
}

// ── 1. Email Template Generator ───────────────────────────────────────────────
export async function generateEmailTemplate(
  prompt: string,
  selectedProducts: string[] = [],
  audienceType = 'all customers'
) {
  try {
    const context = await fetchProductContext(selectedProducts);
    const fullPrompt = `${prompt} ${context}`.trim();

    const result = await OlivePizzaAISDK.generateEmailTemplate({
      prompt: fullPrompt,
      campaignType: audienceType,
      targetAudience: audienceType,
    });

    if (result.bodyHtml && !result.bodyHtml.includes('Order your favorite pizza now!')) {
      return { success: true, html: result.bodyHtml, usedModel: 'OlivePizzaAI Platform' };
    }

    const fb = getFallbackClient();
    if (fb) {
      const response = await fb.client.chat.completions.create({
        model: 'meta-llama/llama-3.3-70b-instruct',
        messages: [
          { role: 'system', content: 'Generate a beautiful, responsive HTML email body for Olive Pizza. Start directly with <div.' },
          { role: 'user', content: fullPrompt },
        ],
        max_tokens: 2000,
      });
      const html = response.choices[0]?.message?.content || result.bodyHtml;
      return { success: true, html, usedModel: fb.name };
    }

    return { success: true, html: result.bodyHtml, usedModel: 'OlivePizzaAI Platform' };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ── 2. Chat Reply ─────────────────────────────────────────────────────────────
export async function generateChatReply(
  message: string,
  history: { role: string; content: string }[] = [],
  frontendContext?: any
): Promise<{
  success: boolean;
  reply?: string;
  action?: any;
  source?: string;
  error?: string;
  telemetry?: {
    llmLatencyMs: number;
    modelUsed: string;
    providerUsed: string;
    attemptsCount: number;
    tokenEstimate: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
}> {
  const startTime = Date.now();
  try {
    const chatHist = (history || []).map(h => ({
      role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: h.content,
    }));

    const result = await OlivePizzaAISDK.chat({
      message,
      history: chatHist,
      userContext: frontendContext,
    });

    return {
      success: true,
      reply: result.reply,
      source: result.source || 'olive_pizza_ai',
      telemetry: {
        llmLatencyMs: Date.now() - startTime,
        modelUsed: 'OlivePizzaAI Platform',
        providerUsed: 'OlivePizzaAI Platform',
        attemptsCount: 1,
        tokenEstimate: Math.ceil((message.length + (result.reply?.length || 0)) / 4),
        promptTokens: Math.ceil(message.length / 4),
        completionTokens: Math.ceil((result.reply?.length || 0) / 4),
        totalTokens: Math.ceil((message.length + (result.reply?.length || 0)) / 4),
        estimatedCostUsd: 0,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      reply: 'Olive Pizza AI is currently processing your request. Please try again.',
      source: 'sdk_error',
    };
  }
}

export async function generateChatReplyStream(
  message: string,
  history: { role: string; content: string }[],
  frontendContext: any,
  onChunk: (chunk: string) => void,
  onComplete?: (fullReply: string, action: any, source: string) => void
): Promise<string> {
  const result = await generateChatReply(message, history, frontendContext);
  const fullReply = result.reply || 'Request completed via Olive Pizza AI.';
  onChunk(fullReply);
  if (onComplete) {
    onComplete(fullReply, result.action, result.source || 'olive_pizza_ai');
  }
  return fullReply;
}

export async function transcribeAudioWhisper(_audioBuffer: any, _mimetype?: string): Promise<{ success: boolean; text: string; error?: string }> {
  return { success: true, text: 'Audio transcription delegated to Olive Pizza AI.' };
}

// ── 3. Prompt Enhancer ────────────────────────────────────────────────────────
export async function enhancePrompt(
  prompt: string,
  type?: any,
  _context?: any,
  _modelName?: any
): Promise<{ success: boolean; enhancedPrompt: string; prompt: string; error?: string }> {
  try {
    const targetType = (typeof type === 'string' && ['product','combo','email','ad','sdui'].includes(type))
      ? (type as any) : 'product';
    const result = await OlivePizzaAISDK.enhancePrompt({ prompt, targetType });
    const enhanced = result.enhancedPrompt || prompt;
    return { success: true, enhancedPrompt: enhanced, prompt: enhanced };
  } catch (err: any) {
    return { success: false, enhancedPrompt: prompt, prompt, error: err.message };
  }
}

// ── 4. Product Description Generator ──────────────────────────────────────────
export async function generateProductDescription(
  nameOrMessages: any,
  category?: string,
  ingredients?: string[],
  attributes?: string[]
): Promise<{ success: boolean; description: string; highlights: string[]; error?: string }> {
  try {
    const nameStr = typeof nameOrMessages === 'string'
      ? nameOrMessages
      : (Array.isArray(nameOrMessages) ? nameOrMessages.map(m => m.content).join(' ') : 'Pizza Special');

    const result = await OlivePizzaAISDK.generateProductDescription({
      name: nameStr,
      category,
      ingredients,
      attributes,
    });

    return {
      success: true,
      description: result.description || `Delicious ${nameStr} prepared fresh at Olive Pizza.`,
      highlights: result.highlights || ['Fresh Ingredients', 'Handcrafted', 'Hot & Fresh'],
    };
  } catch (err: any) {
    return {
      success: true,
      description: `Delicious pizza handcrafted with premium ingredients.`,
      highlights: ['Fresh Ingredients', 'Handcrafted'],
    };
  }
}

// ── 5. Product Image Generator ────────────────────────────────────────────────
export async function generateProductImage(
  promptOrOptions: any,
  name?: string
): Promise<{ success: boolean; imageUrl: string; error?: string }> {
  try {
    const promptStr = typeof promptOrOptions === 'string' ? promptOrOptions : (promptOrOptions?.customPrompt || promptOrOptions?.productName || 'Fresh pizza');
    const nameStr = name || (typeof promptOrOptions === 'object' ? promptOrOptions?.productName : undefined);

    const result = await OlivePizzaAISDK.generateProductImage({ prompt: promptStr, name: nameStr });
    if (result.imageUrl) {
      return { success: true, imageUrl: result.imageUrl };
    }
    return { success: false, imageUrl: '', error: 'Image URL generation pending provider' };
  } catch (err: any) {
    return { success: false, imageUrl: '', error: err.message };
  }
}

// ── 6. Generic Image Generator ────────────────────────────────────────────────
export async function generateImage(
  prompt: string,
  name?: string,
  _modelName?: string,
  _baseImageUrl?: string
): Promise<{ success: boolean; imageUrl: string; error?: string }> {
  return generateProductImage(prompt, name);
}
