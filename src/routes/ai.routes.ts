import express from 'express';
import { generateEmailTemplate, generateImage, generateProductDescription, generateProductImage, generateChatReply, generateChatReplyStream, enhancePrompt, aiProviderStats } from '../services/ai.service.js';
import kb from '../services/KnowledgeBaseService.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { aiContextBuilder } from '../services/ai/AIContextBuilder.js';
import { recommendationEngine } from '../services/ai/RecommendationEngine.js';
import { optionalAuth, AuthRequest } from '../middleware/auth.middleware.js';
import { detectLanguage } from '../services/ai/languageDetector.js';
import { conversationMemory } from '../services/ai/conversationMemory.js';
import { executeBackendTool } from '../services/ai/toolExecutor.js';
import { AIFirewallFilter } from '../services/ai/AIFirewallFilter.js';

const router = express.Router();

// ─── AI Message Rate Limiter — 100 Messages Per Hour Per User / IP ─────────────
const hourlyMessageCounts = new Map<string, number[]>();

export function aiHourlyMessageLimiter(req: AuthRequest, res: any, next: any) {
  const identifier = req.user?.uid || req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxMessages = 100; // 100 messages per hour per user/IP

  const timestamps = (hourlyMessageCounts.get(identifier) || []).filter((t) => now - t < windowMs);

  if (timestamps.length >= maxMessages) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded: Maximum 100 AI messages per hour allowed.',
      reply: 'You have reached your limit of 100 AI messages per hour. Please try again in an hour! 🍕',
    });
  }

  timestamps.push(now);
  hourlyMessageCounts.set(identifier, timestamps);
  next();
}

// ─── KB Health & Status ───────────────────────────────────────────────────────
router.get('/kb-status', async (_req, res) => {
  try {
    const stats = kb.getStats();
    res.json({
      success: true,
      isReady: kb.isReady(),
      stats,
      categories: kb.getAllCategories().map(c => c.name),
      activeCoupons: kb.getAllCoupons().length,
      providers: {
        nvidia: aiProviderStats.nvidia,
        openrouter: aiProviderStats.openrouter,
        gemini: aiProviderStats.gemini,
        activeProvider: aiProviderStats.activeProvider,
        totalRequests: aiProviderStats.totalRequests,
        totalFailovers: aiProviderStats.totalFailovers,
        avgResponseMs: aiProviderStats.avgResponseMs,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/kb-rebuild', requireAuth, requireRole(['owner', 'admin']), async (_req, res) => {
  try {
    const stats = await kb.forceRebuild();
    res.json({ success: true, message: 'Knowledge base rebuilt successfully', stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

import { aiOperationsStore } from '../services/devOps/AIOperationsService.js';

// ─── Primary Chat Route — Intent-Aware Routing + Full Role Intelligence ────────
router.post('/chat', optionalAuth, aiHourlyMessageLimiter, async (req: AuthRequest, res) => {
  const routeStart = Date.now();
  try {
    const { message, history, frontendContext, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const userRole = (req.user?.role as 'guest' | 'customer' | 'owner' | 'developer' | 'delivery_partner') || 'guest';
    const userEmail = req.user?.email || 'guest';
    const userId = req.user?.uid;

    // ── Session Memory + Language Detection ──────────────────────────────────
    const activeSessionId = sessionId || `session-${userId || req.ip || 'guest'}`;
    const detectedLang = detectLanguage(message);
    conversationMemory.updateLanguage(activeSessionId, detectedLang);
    conversationMemory.getOrCreateSession(activeSessionId, userId, userRole);
    conversationMemory.addMessage(activeSessionId, { role: 'user', content: message });

    // ── TIER 0: Security Guardrail (instant block, no LLM call) ──────────────
    const msgLower = message.toLowerCase();
    const securityTerms = ['password', 'api key', 'secret', 'firebase_service_account', 'database url', 'jwt secret'];
    if (securityTerms.some(t => msgLower.includes(t))) {
      return res.json({
        success: true,
        reply: 'I cannot assist with queries regarding system credentials or internal configurations. Ask me about the menu, orders, or restaurant policies! 🍕',
        source: 'security_guardrail',
        products: [],
      });
    }

    // ── TIER 1: Local KB Quick Answer (0 API calls) ───────────────────────────
    const quickAnswer = kb.quickAnswer(message);
    if (quickAnswer) {
      const sanitizedQuick = AIFirewallFilter.sanitizeResponse(quickAnswer, { userRole });
      conversationMemory.addMessage(activeSessionId, { role: 'assistant', content: sanitizedQuick });
      return res.json({ success: true, reply: sanitizedQuick, source: 'local_kb', products: [] });
    }

    // ── Intent Classification + Qdrant Routing ────────────────────────────────
    // Run Qdrant retrieval and user context in parallel to save latency
    const [contextRes, userContext] = await Promise.all([
      aiContextBuilder.buildContextDetailed(message),
      userId
        ? (userRole === 'customer'
            ? recommendationEngine.getUserProfileContext(userId)
            : (userRole as string) === 'delivery_partner' || (userRole as string) === 'delivery'
              ? recommendationEngine.getDeliveryPartnerContext(userId)
              : (userRole as string) === 'owner' || (userRole as string) === 'admin'
                ? recommendationEngine.getOwnerContext()
                : userRole === 'developer'
                  ? Promise.resolve(recommendationEngine.getDeveloperContext())
                  : Promise.resolve(''))
        : Promise.resolve(''),
    ]);

    let kbContext = contextRes.contextStr;

    // For NON_RESTAURANT queries: bypass Pinecone, use pure LLM reasoning
    if (contextRes.queryIntent === 'NON_RESTAURANT') {
      kbContext = `You are Olive AI. This appears to be a general knowledge question outside the restaurant domain. Answer it helpfully using your general knowledge. If unsure, say so — never hallucinate.`;
    } else if (contextRes.groundingStatus === 'UNAVAILABLE') {
      // Soft fallback: Pinecone is down but we still have local KB + static JSON knowledge
      // Use live products if available, never block the customer
      const fallbackProducts = kb.getAllProducts().slice(0, 10);
      const fallbackSettings = kb.getSettings();
      kbContext = `--- OLIVE PIZZA KNOWLEDGE (Local Fallback Mode) ---\n`;
      if (fallbackSettings) {
        kbContext += `Restaurant: ${fallbackSettings.restaurantName} | Status: ${fallbackSettings.isOpen ? 'OPEN 🟢' : 'CLOSED 🔴'} | Delivery: ${fallbackSettings.estimatedDeliveryTime || '30-45 min'} | Phone: ${fallbackSettings.phone}\n`;
      }
      if (fallbackProducts.length > 0) {
        kbContext += `\nAVAILABLE MENU ITEMS:\n` + fallbackProducts.map(p => `- ${p.name}: ₹${p.discountedPrice || p.price} | ${p.category}`).join('\n');
      }
      kbContext += `\n\nOlive Pizza is 100% Pure Vegetarian 🟢. For full menu, visit /menu. For help, contact us via /contact.`;
    }

    // Append personalized user/role context
    if (userContext) kbContext += `\n\n${userContext}`;

    // ── Tier 2 & 3: LLM Generation ────────────────────────────────────────────
    const result = await generateChatReply(message, history || [], {
      ...frontendContext,
      kbContext,
      role: userRole,
      isAuthenticated: !!req.user,
      queryIntent: contextRes.queryIntent,
    });

    const elapsedTotal = Date.now() - routeStart;

    if (result.success && result.reply) {
      // 🛡️ Pass through AI Firewall Filter (intercepts & blocks raw source code output)
      result.reply = AIFirewallFilter.sanitizeResponse(result.reply, { userRole });

      // Store AI reply in session memory
      conversationMemory.addMessage(activeSessionId, { role: 'assistant', content: result.reply });

      // Match products from reply for card suggestions
      const replyLower = (result.reply + ' ' + message).toLowerCase();
      const allProducts = kb.getAllProducts();
      let matchedProducts = allProducts.filter(p =>
        p.isAvailable && (replyLower.includes(p.name.toLowerCase()) || replyLower.includes(p.category.toLowerCase()))
      );
      if (matchedProducts.length === 0) matchedProducts = kb.searchProducts(message, 4);
      matchedProducts = matchedProducts.slice(0, 4);

      const cacheStats = { hitRatio: contextRes.cacheHit ? 1.0 : 0.0 };
      const memStats = conversationMemory.getStats();

      const debugInfo = {
        groundingStatus: contextRes.groundingStatus,
        queryIntent: contextRes.queryIntent,
        cacheHit: contextRes.cacheHit,
        modelUsed: result.telemetry?.modelUsed || result.source,
        providerUsed: result.telemetry?.providerUsed,
        retrievedChunksCount: contextRes.chunks.length,
        topSimilarityScore: contextRes.chunks[0]?.score || 0,
        contextSizeChars: kbContext.length,
        userRole,
        userId: userId || null,
        sessionId: activeSessionId,
        sessionMessages: memStats.totalMessages,
        cacheHitRatio: cacheStats.hitRatio,
        telemetry: {
          embeddingLatencyMs: contextRes.telemetry.embeddingLatencyMs,
          embeddingModelUsed: contextRes.telemetry.embeddingModelUsed,
          qdrantLatencyMs: contextRes.telemetry.qdrantLatencyMs,
          llmLatencyMs: result.telemetry?.llmLatencyMs || 0,
          totalLatencyMs: elapsedTotal,
          slaExceeded: elapsedTotal > 4000,
        },
        tokens: {
          promptTokens: result.telemetry?.promptTokens || 0,
          completionTokens: result.telemetry?.completionTokens || 0,
          totalTokens: result.telemetry?.totalTokens || 0,
          estimatedCostUsd: result.telemetry?.estimatedCostUsd || 0,
        },
        similarityScores: contextRes.chunks.map(c => ({ score: c.score, source: c.metadata?.source })),
      };

      aiOperationsStore.pushLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        userRole: userRole as any,
        userEmail,
        message,
        reply: result.reply,
        actionExecuted: result.action,
        groundingStatus: contextRes.groundingStatus,
        isDomainQuery: contextRes.isDomainQuery,
        modelUsed: result.telemetry?.modelUsed || result.source || 'ai',
        providerUsed: result.telemetry?.providerUsed || 'ai',
        retrievedChunks: contextRes.chunks,
        telemetry: {
          embeddingLatencyMs: contextRes.telemetry.embeddingLatencyMs,
          embeddingModelUsed: contextRes.telemetry.embeddingModelUsed,
          qdrantLatencyMs: contextRes.telemetry.qdrantLatencyMs,
          llmLatencyMs: result.telemetry?.llmLatencyMs || 0,
          toolLatencyMs: 0,
          totalLatencyMs: elapsedTotal,
          slaExceeded: elapsedTotal > 4000,
        },
        promptDebug: {
          systemPrompt: 'Olive AI Artisan Concierge — Contextual Routing',
          userPrompt: message,
          kbContext: kbContext.slice(0, 500),
        },
        tokens: debugInfo.tokens,
      });

      return res.json({
        success: true,
        reply: result.reply,
        action: result.action,
        source: result.source || 'ai',
        debugInfo,
        products: matchedProducts.map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          discountedPrice: p.discountedPrice,
          category: p.category,
          description: p.description,
          imageUrl: p.imageUrl,
          rating: p.rating,
          preparationTime: p.preparationTime,
          isVeg: p.isVeg,
          isAvailable: p.isAvailable,
          ingredients: p.ingredients,
          sizes: p.sizes || ['Small', 'Medium', 'Large'],
          toppings: p.toppings || ['Extra Cheese', 'Jalapenos', 'Paneer'],
        })),
      });
    }

    // ── TIER 4: Offline Template ──────────────────────────────────────────────
    const products = kb.searchProducts(message, 4);
    const settings = kb.getSettings();
    let offlineReply = '';

    if (products.length > 0) {
      offlineReply = `🍕 Here's what I found:\n\n${products.map(p => `**${p.name}** — ₹${p.discountedPrice ?? p.price}\n${p.description}`).join('\n\n')}`;
    } else if (msgLower.includes('menu') || msgLower.includes('pizza')) {
      offlineReply = `Visit our [Menu page](/menu) to browse our full selection! 🍕`;
    } else if (settings) {
      offlineReply = `Olive Pizza is ${settings.isOpen ? 'currently OPEN 🟢' : 'currently CLOSED 🔴'}. Delivery: ${settings.estimatedDeliveryTime}. Ask me anything!`;
    } else {
      offlineReply = `I'm here to help! Ask me about the menu, offers, delivery, or anything else! 🍕`;
    }

    res.json({
      success: true,
      reply: offlineReply,
      source: 'offline_template',
      products: products.map(p => ({
        id: p.id, name: p.name, price: p.price, discountedPrice: p.discountedPrice,
        category: p.category, description: p.description, imageUrl: p.imageUrl,
        rating: p.rating, preparationTime: p.preparationTime, isVeg: p.isVeg, isAvailable: p.isAvailable,
      })),
    });
  } catch (err: any) {
    console.error('[AI Chat Route]', err.message);
    res.status(500).json({ success: false, error: 'Internal server error', reply: `I'm having a brief moment. Please try again! 🍕` });
  }
});

// ─── SSE Streaming Chat Route — Sub-1s first-token latency ────────────────────
router.post('/chat-stream', optionalAuth, aiHourlyMessageLimiter, async (req: AuthRequest, res: any) => {
  const routeStart = Date.now();
  try {
    const { message, history, frontendContext, sessionId } = req.body;
    if (!message) { res.status(400).json({ error: 'Message is required' }); return; }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const userRole = (req.user?.role as 'guest' | 'customer' | 'owner' | 'developer') || 'guest';
    const userId = req.user?.uid;
    const activeSessionId = sessionId || `session-${userId || req.ip || 'guest'}`;

    const detectedLang = detectLanguage(message);
    conversationMemory.updateLanguage(activeSessionId, detectedLang);
    conversationMemory.addMessage(activeSessionId, { role: 'user', content: message });

    // Security block
    const msgLower = message.toLowerCase();
    const securityTerms = ['password', 'api key', 'secret', 'firebase_service_account', 'database url'];
    if (securityTerms.some(t => msgLower.includes(t))) {
      sendEvent('done', { reply: 'I cannot assist with queries regarding system credentials.', source: 'security_guardrail' });
      res.end();
      return;
    }

    // Parallel: intent + context + user profile
    const [contextRes, userContext] = await Promise.all([
      aiContextBuilder.buildContextDetailed(message),
      userId
        ? (userRole === 'customer'
            ? recommendationEngine.getUserProfileContext(userId)
            : (userRole as string) === 'owner' || (userRole as string) === 'admin'
              ? recommendationEngine.getOwnerContext()
              : userRole === 'developer'
                ? Promise.resolve(recommendationEngine.getDeveloperContext())
                : Promise.resolve(''))
        : Promise.resolve(''),
    ]);

    let kbContext = contextRes.contextStr;
    if (contextRes.queryIntent === 'NON_RESTAURANT') {
      kbContext = 'Answer using general knowledge. Do not hallucinate Olive Pizza menu items.';
    } else if (contextRes.groundingStatus === 'UNAVAILABLE') {
      const allProds = kb.getAllProducts().slice(0, 10);
      kbContext = `--- OLIVE PIZZA KB FALLBACK ---\n` +
        allProds.map(p => `${p.name} | ₹${p.discountedPrice || p.price} | ${p.category}`).join('\n');
    }
    if (userContext) kbContext += `\n\n${userContext}`;

    // Emit context-ready event for diagnostics
    sendEvent('context', {
      groundingStatus: contextRes.groundingStatus,
      queryIntent: contextRes.queryIntent,
      cacheHit: contextRes.cacheHit,
      chunksRetrieved: contextRes.chunks.length,
      qdrantLatencyMs: contextRes.telemetry.qdrantLatencyMs,
    });

    // Stream LLM response
    try {
      if (typeof generateChatReplyStream === 'function') {
        await generateChatReplyStream(
          message,
          history || [],
          { ...frontendContext, kbContext, role: userRole, isAuthenticated: !!req.user },
          (token: string) => sendEvent('token', { token }),
          (fullReply: string, action: any, source: string) => {
            const sanitizedReply = AIFirewallFilter.sanitizeResponse(fullReply, { userRole });
            conversationMemory.addMessage(activeSessionId, { role: 'assistant', content: sanitizedReply });
            sendEvent('done', {
              reply: sanitizedReply,
              action,
              source,
              totalLatencyMs: Date.now() - routeStart,
            });
          }
        );
      } else {
        // Fallback: non-streaming
        const result = await generateChatReply(message, history || [], {
          ...frontendContext, kbContext, role: userRole, isAuthenticated: !!req.user,
        });
        if (result.reply) {
          const sanitizedReply = AIFirewallFilter.sanitizeResponse(result.reply, { userRole });
          conversationMemory.addMessage(activeSessionId, { role: 'assistant', content: sanitizedReply });
          sendEvent('done', { reply: sanitizedReply, action: result.action, source: result.source, totalLatencyMs: Date.now() - routeStart });
        }
      }
    } catch (llmErr: any) {
      sendEvent('error', { message: 'AI generation failed. Please try again.' });
    }

    res.end();
  } catch (err: any) {
    console.error('[AI Stream Route]', err.message);
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
  }
});

// ─── Session Memory Clear (call on logout) ────────────────────────────────────
router.post('/session-clear', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user?.uid;
    if (userId) conversationMemory.clearUserSessions(userId);
    if (sessionId) conversationMemory.clearSession(sessionId);
    res.json({ success: true, message: 'Session memory cleared.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

import { DeepSeekV4FlashGenerator } from '../services/ai/DeepSeekV4FlashGenerator.js';

// ─── Email Generation (DeepSeek V4 Flash) ──────────────────────────────────────
router.post('/generate-email', requireAuth, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res) => {
  try {
    const { prompt, selectedProducts, audienceType } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required' });
    const result = await DeepSeekV4FlashGenerator.generateEmailTemplate({
      prompt,
      selectedProducts: selectedProducts || [],
      targetAudience: audienceType || 'all customers',
    });
    res.json({ success: true, html: result.bodyHtml, subject: result.subject, model: result.model });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Email generation error' });
  }
});

router.post('/generate-image', requireAuth, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res) => {
  try {
    const { prompt, context, modelName, baseImageUrl } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    const result = await generateImage(prompt, context, modelName, baseImageUrl);
    if (result.success) {
      console.log('[IMAGE_INSERTED_IN_EDITOR] imageUrl:', result.imageUrl);
      res.json(result);
    } else {
      res.status(422).json({ error: result.error || 'Image generation failed', imageUrl: null, success: false });
    }
  } catch (error: any) { res.status(500).json({ error: 'Internal server error during image generation' }); }
});

// ─── Product & Combo Description Generator (DeepSeek V4 Flash) ──────────────────
router.post('/product-description', requireAuth, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res) => {
  try {
    const { name, productName, category, type, items, messages } = req.body;
    const itemName = name || productName || (Array.isArray(messages) ? messages.map((m: any) => m.content).join(' ') : 'Special Food Item');
    const result = await DeepSeekV4FlashGenerator.generateDescription({
      name: itemName,
      category,
      type: type || 'product',
      items,
    });
    res.json({ success: true, description: result.description, highlights: result.highlights, model: result.model });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Description generation error' });
  }
});

router.post('/generate-description', requireAuth, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res) => {
  try {
    const { name, productName, category, type, items } = req.body;
    const itemName = name || productName || 'Special Food Item';
    const result = await DeepSeekV4FlashGenerator.generateDescription({
      name: itemName,
      category,
      type: type || 'product',
      items,
    });
    res.json({ success: true, description: result.description, highlights: result.highlights, model: result.model });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Description generation error' });
  }
});

// ─── Interactive Assistant Chatbox (DeepSeek V4 Flash) ──────────────────────────
router.post('/interactive-assistant', requireAuth, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res) => {
  try {
    const { mode, message, history, contextData } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message is required' });
    const result = await DeepSeekV4FlashGenerator.handleInteractiveChat({
      mode: mode || 'product-description',
      message,
      history: history || [],
      contextData: contextData || {},
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Interactive assistant error' });
  }
});

// ─── STT Transcription Endpoint (Whisper 3 Large -> Canary 1B ASR) ───────────
import multer from 'multer';
import { transcribeAudioWhisper } from '../services/ai.service.js';
import { evaluateLLMs } from '../services/ai/ModelEvaluationService.js';

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/stt', audioUpload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Audio file is required for STT' });
    }
    const result = await transcribeAudioWhisper(req.file.buffer, req.file.mimetype || 'audio/wav');
    if (result.success) {
      res.json({ success: true, text: result.text });
    } else {
      res.status(500).json({ success: false, error: result.error || 'STT transcription failed' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LLM Model Evaluation Endpoint ──────────────────────────────────────────
router.post('/evaluate-models', requireAuth, requireRole(['owner', 'admin']), async (_req, res) => {
  try {
    const evalData = await evaluateLLMs();
    res.json({ success: true, ...evalData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Action Rate Limiter (Max 20 actions / min per user) ─────────────────────
const actionTimestamps = new Map<string, number[]>();

function aiActionLimiter(req: AuthRequest, res: any, next: any) {
  const identifier = req.user?.uid || req.ip || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxActions = 20; // Increased for multi-step ordering flows

  const timestamps = (actionTimestamps.get(identifier) || []).filter(t => now - t < windowMs);
  if (timestamps.length >= maxActions) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded for AI actions. Maximum 20 actions per minute.'
    });
  }
  timestamps.push(now);
  actionTimestamps.set(identifier, timestamps);
  next();
}

// ─── Production Agentic Tool Action Handler — All 24 Tools ───────────────────
router.post('/action', optionalAuth, aiActionLimiter, async (req: AuthRequest, res: any) => {
  const actionStart = Date.now();
  try {
    const { toolName, toolCallId, args } = req.body;

    if (!toolName) {
      return res.status(400).json({ success: false, error: 'toolName is required.' });
    }

    console.log(`[AI Action] ${toolName} | user: ${req.user?.uid || 'guest'} | args:`, JSON.stringify(args).slice(0, 200));

    const toolResult = await executeBackendTool(
      { id: toolCallId || `tc-${Date.now()}`, name: toolName, args: args || {} },
      req.user ? { uid: req.user.uid, email: req.user.email, role: req.user.role } : undefined
    );

    res.json({
      success: toolResult.status !== 'error',
      ...toolResult,
      toolLatencyMs: Date.now() - actionStart,
    });
  } catch (err: any) {
    console.error('[AI Action Route]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── AI Diagnostics — Expanded (Phase 9) ─────────────────────────────────────
router.get('/diagnostics', requireAuth, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  try {
    const memStats = conversationMemory.getStats();
    const opsStats = aiOperationsStore.getStats();

    res.json({
      success: true,
      knowledgeStore: {
        type: 'LOCAL_KB_CATALOG',
        status: 'GREEN',
        connectionStatus: 'CONNECTED',
      },
      conversationMemory: memStats,
      aiOperations: opsStats,
      providers: {
        nvidia: aiProviderStats.nvidia,
        openrouter: aiProviderStats.openrouter,
        gemini: aiProviderStats.gemini,
        activeProvider: aiProviderStats.activeProvider,
        totalRequests: aiProviderStats.totalRequests,
        totalFailovers: aiProviderStats.totalFailovers,
        avgResponseMs: aiProviderStats.avgResponseMs,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

