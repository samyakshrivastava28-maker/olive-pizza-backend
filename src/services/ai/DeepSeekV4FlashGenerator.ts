/**
 * DeepSeekV4FlashGenerator.ts
 * Multi-model fallback hierarchy for Olive Pizza approved text tasks:
 * 1. Primary (NVIDIA NIM): Kimi K3, GLM 5.3, GLM 5.3 Flash, DeepSeek V4 Flash, MiniMax M3
 * 2. Secondary Fallback: GLM 5.2
 * 3. Final Fallback: Nemotron 3 Ultra -> OpenRouter nvidia/nemotron-3.5-lightning:free
 * 4. Deterministic Local Fallback (Guarantees zero blocking of core business flows)
 *
 * Supported text tasks:
 * - Product & Combo Descriptions
 * - Email Campaign Templates (HTML + Subject)
 * - Push Notification Titles & Bodies
 * - Interactive AI Assistant Marketing Chat
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

interface ModelCandidate {
  provider: 'nvidia' | 'openrouter';
  model: string;
  name: string;
}

const APPROVED_MODEL_HIERARCHY: ModelCandidate[] = [
  // Primary (NVIDIA NIM)
  { provider: 'nvidia', model: 'moonshotai/kimi-k3', name: 'Kimi K3 (NVIDIA NIM)' },
  { provider: 'nvidia', model: 'thudm/glm-5.3', name: 'GLM 5.3 (NVIDIA NIM)' },
  { provider: 'nvidia', model: 'thudm/glm-5.3-flash', name: 'GLM 5.3 Flash (NVIDIA NIM)' },
  { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash (NVIDIA NIM)' },
  { provider: 'nvidia', model: 'minimax/minimax-m3', name: 'MiniMax M3 (NVIDIA NIM)' },

  // Secondary Fallback
  { provider: 'nvidia', model: 'thudm/glm-5.2', name: 'GLM 5.2 (NVIDIA NIM)' },
  { provider: 'openrouter', model: 'thudm/glm-5.2', name: 'GLM 5.2 (OpenRouter)' },

  // Final Fallback
  { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra', name: 'Nemotron 3 Ultra (NVIDIA NIM)' },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (OpenRouter)' },
  { provider: 'openrouter', model: 'deepseek/deepseek-chat', name: 'DeepSeek Chat (OpenRouter)' },
];

let cachedNvidiaClient: OpenAI | null = null;
let cachedOpenRouterClient: OpenAI | null = null;

function getClientForProvider(provider: 'nvidia' | 'openrouter'): OpenAI | null {
  if (provider === 'nvidia') {
    const key = process.env.NVIDIA_API_KEY || process.env.ASSISTANT_NVIDIA_API_KEY;
    if (!key || key.trim().length < 10) return null;
    if (!cachedNvidiaClient) {
      cachedNvidiaClient = new OpenAI({
        apiKey: key.trim(),
        baseURL: 'https://integrate.api.nvidia.com/v1',
        timeout: 15000,
      });
    }
    return cachedNvidiaClient;
  }

  if (provider === 'openrouter') {
    const key = process.env.OPENROUTER_API_KEY || process.env.ASSISTANT_OPENROUTER_API_KEY;
    if (!key || key.trim().length < 10) return null;
    if (!cachedOpenRouterClient) {
      cachedOpenRouterClient = new OpenAI({
        apiKey: key.trim(),
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 15000,
      });
    }
    return cachedOpenRouterClient;
  }

  return null;
}

async function executeModelChain(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 500,
  temperature: number = 0.7
): Promise<{ content: string; modelName: string } | null> {
  for (const candidate of APPROVED_MODEL_HIERARCHY) {
    const client = getClientForProvider(candidate.provider);
    if (!client) continue;

    try {
      const response = await client.chat.completions.create({
        model: candidate.model,
        messages: messages as any,
        temperature,
        max_tokens: maxTokens,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (content) {
        return { content, modelName: candidate.name };
      }
    } catch (err: any) {
      console.warn(`[AI Model Fallback] Candidate ${candidate.name} failed: ${err.message}. Trying next candidate...`);
    }
  }

  return null;
}

export class DeepSeekV4FlashGenerator {
  /**
   * Generate Food Product / Combo Description using approved model hierarchy
   */
  static async generateDescription(options: {
    name: string;
    category?: string;
    type?: 'product' | 'combo';
    items?: string[];
  }): Promise<{ success: boolean; description: string; highlights: string[]; model: string }> {
    const isCombo = options.type === 'combo';
    const systemPrompt = `You are an expert food copywriter for Olive Pizza. 
Write a mouthwatering, irresistible ${isCombo ? 'combo deal' : 'pizza/food'} product description in 2-3 sentences.
Focus on taste, fresh ingredients, wood-fired quality, and customer savings.
Return valid JSON format ONLY:
{
  "description": "2-3 mouthwatering sentences...",
  "highlights": ["Highlight 1", "Highlight 2", "Highlight 3"]
}`;

    const userPrompt = `Item Name: ${options.name}
Category: ${options.category || 'Pizzas'}
${isCombo && options.items?.length ? `Combo Items Included: ${options.items.join(', ')}` : ''}`;

    const fallbackOutput = {
      success: true,
      description: isCombo
        ? `Savor the ultimate ${options.name} featuring ${options.items?.join(', ') || 'our top menu specials'}. Handcrafted to perfection with 100% mozzarella cheese and fresh toppings at an unbeatable price!`
        : `Delicious ${options.name} handcrafted with fresh ingredients, signature tomato sauce, and 100% real mozzarella cheese baked hot & fresh at Olive Pizza.`,
      highlights: isCombo ? ['Combo Savings', 'Handcrafted', 'Hot & Fresh'] : ['100% Mozzarella', 'Wood Fired', 'Fresh Toppings'],
      model: 'Deterministic Fallback',
    };

    try {
      const result = await executeModelChain([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], 400);

      if (!result) return fallbackOutput;

      const cleanJson = result.content.replace(/```json/gi, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        return {
          success: true,
          description: parsed.description || result.content,
          highlights: parsed.highlights || ['Fresh', 'Delicious', 'Olive Pizza Special'],
          model: result.modelName,
        };
      } catch {
        return {
          success: true,
          description: result.content || fallbackOutput.description,
          highlights: ['Fresh Toppings', 'Authentic Taste', 'Olive Pizza Special'],
          model: result.modelName,
        };
      }
    } catch (err: any) {
      console.error('[AI Generator] Description error:', err.message);
      return fallbackOutput;
    }
  }

  /**
   * Generate Responsive Email Campaign Template HTML using approved model hierarchy
   */
  static async generateEmailTemplate(options: {
    prompt: string;
    campaignType?: string;
    targetAudience?: string;
    selectedProducts?: string[];
  }): Promise<{ success: boolean; subject: string; bodyHtml: string; model: string }> {
    const systemPrompt = `You are an expert email marketing designer for Olive Pizza.
Create a responsive HTML email campaign.
Return valid JSON format ONLY:
{
  "subject": "Catchy email subject line with emoji",
  "bodyHtml": "<div style='font-family:sans-serif; max-width:600px; margin:0 auto; background:#0f172a; color:#fff; padding:20px; border-radius:16px;'>...</div>"
}
Ensure the HTML is modern, clean, mobile-responsive, includes a dark-theme header, call to action button, and festive Olive Pizza branding (#f97316 primary color).`;

    const userPrompt = `Campaign Topic/Offer: ${options.prompt}
Campaign Audience: ${options.targetAudience || 'All Customers'}
${options.selectedProducts?.length ? `Featured Products: ${options.selectedProducts.join(', ')}` : ''}`;

    const fallbackSubject = `🍕 Special Offer: ${options.prompt.slice(0, 40)}...`;
    const fallbackHtml = `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width:600px; margin:0 auto; background-color:#0f172a; color:#f8fafc; padding:30px; border-radius:20px; border: 1px solid #1e293b;">
  <div style="text-align:center; padding-bottom:20px; border-bottom:2px solid #f97316;">
    <h1 style="color:#f97316; margin:0; font-size:28px;">🍕 OLIVE PIZZA</h1>
    <p style="color:#94a3b8; font-size:14px; margin-top:4px;">Hot, Fresh & Handcrafted To Order</p>
  </div>
  <div style="padding:25px 0; text-align:center;">
    <h2 style="font-size:22px; color:#ffffff; margin-bottom:12px;">${options.prompt}</h2>
    <p style="color:#cbd5e1; font-size:15px; line-height:1.6; max-width:480px; margin:0 auto;">
      Treat yourself to handcrafted gourmet pizzas baked hot and fresh! Use this special offer today and enjoy fast delivery straight to your doorstep.
    </p>
    <div style="margin-top:25px;">
      <a href="https://olivepizza.in/menu" style="background-color:#f97316; color:#ffffff; padding:14px 28px; text-decoration:none; border-radius:12px; font-weight:bold; font-size:16px; display:inline-block; box-shadow: 0 4px 12px rgba(249,115,22,0.4);">
        ORDER NOW ON OLIVE PIZZA 🍕
      </a>
    </div>
  </div>
  <div style="text-align:center; padding-top:20px; border-top:1px solid #334155; color:#64748b; font-size:12px;">
    <p>Olive Pizza Store • Fresh Ingredients Daily • Fast Delivery</p>
  </div>
</div>`;

    const fallbackOutput = {
      success: true,
      subject: fallbackSubject,
      bodyHtml: fallbackHtml,
      model: 'Deterministic Fallback',
    };

    try {
      const result = await executeModelChain([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], 1200);

      if (!result) return fallbackOutput;

      const cleanJson = result.content.replace(/```json/gi, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        return {
          success: true,
          subject: parsed.subject || `🍕 Special Offer from Olive Pizza!`,
          bodyHtml: parsed.bodyHtml || result.content,
          model: result.modelName,
        };
      } catch {
        return {
          success: true,
          subject: `🍕 ${options.prompt.slice(0, 40)}`,
          bodyHtml: result.content || fallbackHtml,
          model: result.modelName,
        };
      }
    } catch (err: any) {
      console.error('[AI Generator] Email error:', err.message);
      return fallbackOutput;
    }
  }

  /**
   * Generate Push Notification Title & Body using approved model hierarchy
   */
  static async generateNotification(options: {
    topic: string;
    offerDetails?: string;
    targetAudience?: string;
  }): Promise<{ success: boolean; title: string; body: string; model: string }> {
    const systemPrompt = `You are an expert mobile notification copywriter for Olive Pizza.
Write an urgent, high-CTR push notification for pizza lovers.
Return valid JSON format ONLY:
{
  "title": "Catchy Title with Emojis (Max 45 chars)",
  "body": "Irresistible push notification body with offer details & urgency (Max 110 chars)"
}`;

    const userPrompt = `Notification Topic: ${options.topic}
${options.offerDetails ? `Offer Details: ${options.offerDetails}` : ''}
Target Audience: ${options.targetAudience || 'All Customers'}`;

    const fallbackOutput = {
      success: true,
      title: `🍕 Hungry? Free Garlic Bread Offer!`,
      body: `Order your favorite hot & cheesy pizza from Olive Pizza today and enjoy instant delivery to your doorstep! 🚀`,
      model: 'Deterministic Fallback',
    };

    try {
      const result = await executeModelChain([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ], 250);

      if (!result) return fallbackOutput;

      const cleanJson = result.content.replace(/```json/gi, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        return {
          success: true,
          title: parsed.title || `🍕 Special Offer Alert!`,
          body: parsed.body || `Order fresh hot pizza now at Olive Pizza!`,
          model: result.modelName,
        };
      } catch {
        return {
          success: true,
          title: `🍕 Olive Pizza Special Deal`,
          body: result.content || fallbackOutput.body,
          model: result.modelName,
        };
      }
    } catch (err: any) {
      console.error('[AI Generator] Notification error:', err.message);
      return fallbackOutput;
    }
  }

  /**
   * Interactive Assistant Chat Handler powered by approved model hierarchy
   */
  static async handleInteractiveChat(options: {
    mode: 'product-description' | 'combo-description' | 'email-template' | 'notification';
    message: string;
    history?: { role: string; content: string }[];
    contextData?: any;
  }): Promise<{
    success: boolean;
    chatReply: string;
    description?: string;
    html?: string;
    subject?: string;
    title?: string;
    body?: string;
    model: string;
  }> {
    const systemPrompt = `You are an expert AI assistant for Olive Pizza store owners.
Your role:
1. Answer the user's questions or clarifications in a friendly, helpful conversational chat reply.
2. Generate the requested final marketing copy based on their context and instructions.
Return valid JSON format ONLY:
{
  "chatReply": "Conversational response to the user...",
  "description": "Product/Combo description if mode is product-description or combo-description...",
  "subject": "Catchy email subject line if mode is email-template...",
  "html": "Full HTML email template if mode is email-template...",
  "title": "Push notification title with emojis if mode is notification...",
  "body": "Push notification body text if mode is notification..."
}`;

    const contextStr = options.contextData ? `Context: ${JSON.stringify(options.contextData)}` : '';
    const userPrompt = `Mode: ${options.mode}
${contextStr}
User Request: ${options.message}`;

    const fallbackChat = {
      success: true,
      chatReply: `I've generated the content for ${options.message}!`,
      description: options.mode.includes('description') ? `Delicious handcrafted pizza made with 100% real mozzarella cheese and fresh gourmet ingredients baked to perfection at Olive Pizza.` : undefined,
      html: options.mode === 'email-template' ? `<div style="font-family:sans-serif; max-width:600px; margin:0 auto; background:#0f172a; color:#fff; padding:24px; border-radius:16px; text-align:center;"><h2 style="color:#f97316;">${options.message}</h2><p>Order hot & fresh gourmet pizzas from Olive Pizza!</p><a href="https://olivepizza.in/menu" style="background:#f97316; color:#fff; padding:12px 24px; text-decoration:none; border-radius:10px; font-weight:bold; display:inline-block; margin-top:15px;">Order Now 🍕</a></div>` : undefined,
      subject: options.mode === 'email-template' ? `🍕 Exclusive Deal from Olive Pizza!` : undefined,
      title: options.mode === 'notification' ? `🍕 Special Offer Today!` : undefined,
      body: options.mode === 'notification' ? `Order your favorite pizzas fresh from Olive Pizza today and enjoy fast delivery! 🚀` : undefined,
      model: 'Deterministic Fallback',
    };

    try {
      const messagesPayload: any[] = [{ role: 'system', content: systemPrompt }];
      if (options.history && Array.isArray(options.history)) {
        options.history.forEach((h) => {
          messagesPayload.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
        });
      }
      messagesPayload.push({ role: 'user', content: userPrompt });

      const result = await executeModelChain(messagesPayload, 1200);
      if (!result) return fallbackChat;

      const cleanJson = result.content.replace(/```json/gi, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(cleanJson);
        return {
          success: true,
          chatReply: parsed.chatReply || 'Here is your updated content!',
          description: parsed.description,
          html: parsed.html,
          subject: parsed.subject,
          title: parsed.title,
          body: parsed.body,
          model: result.modelName,
        };
      } catch {
        return {
          success: true,
          chatReply: result.content,
          description: options.mode.includes('description') ? result.content : undefined,
          html: options.mode === 'email-template' ? result.content : undefined,
          body: options.mode === 'notification' ? result.content : undefined,
          model: result.modelName,
        };
      }
    } catch (err: any) {
      console.error('[AI Generator] Interactive chat error:', err.message);
      return fallbackChat;
    }
  }
}
