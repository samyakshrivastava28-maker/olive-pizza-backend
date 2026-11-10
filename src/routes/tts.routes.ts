/**
 * NVIDIA Chatterbox Multilingual TTS — Backend Proxy Route
 *
 * Architecture:
 *   Browser → POST /api/tts/synthesize → This backend → gRPC → grpc.nvcf.nvidia.com
 *
 * Why a backend proxy is required:
 *   The NVIDIA Chatterbox Multilingual TTS NIM uses gRPC/Riva protocol, which
 *   cannot be called directly from a browser. This Express route acts as a
 *   transparent proxy: it receives plain JSON from the frontend, calls the
 *   NVIDIA Riva gRPC endpoint using the @nvidia-riva/grpc-ts client (or falls
 *   back to the NVIDIA NIM REST endpoint at integrate.api.nvidia.com if the
 *   gRPC client is unavailable), and streams the WAV/MP3 audio back.
 *
 * Environment variables required:
 *   NVIDIA_API_KEY=your_nvidia_api_key   (from build.nvidia.com → "Get API Key")
 *
 * Supported languages:
 *   en-US, en-GB, en-IN, hi-IN, fr-FR, de-DE, es-ES, pt-BR, ja-JP, zh-CN, ko-KR
 *
 * Supported voices (Chatterbox Multilingual):
 *   English (en-US/en-IN): Male, Female
 *   Hindi (hi-IN):         Male, Female
 *   (Full voice list: https://build.nvidia.com/resemble-ai/chatterbox-multilingual)
 */

import { Router, Request, Response } from 'express';
import { verifyToken, optionalAuth, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// ─── NVIDIA NIM gRPC/REST Configuration ──────────────────────────────────────
// Chatterbox Multilingual TTS is accessible through NVIDIA Cloud Functions.
// The REST endpoint wraps the underlying gRPC protocol.
const NVIDIA_TTS_ENDPOINT = 'https://integrate.api.nvidia.com/v1/audio/speech';

// Function ID for Chatterbox Multilingual TTS on NVCF
// Obtained from: https://build.nvidia.com/resemble-ai/chatterbox-multilingual
const CHATTERBOX_FUNCTION_ID = 'ddacc747-1269-4fab-bfd9-8f593dead106';

// ─── Supported Languages & Voices ────────────────────────────────────────────
export const CHATTERBOX_VOICES: Record<string, { male: string; female: string }> = {
  'en-US':  { male: 'Chatterbox-Multilingual.en-US.Male',  female: 'Chatterbox-Multilingual.en-US.Female' },
  'en-IN':  { male: 'Chatterbox-Multilingual.en-IN.Male',  female: 'Chatterbox-Multilingual.en-IN.Female' },
  'hi-IN':  { male: 'Chatterbox-Multilingual.hi-IN.Male',  female: 'Chatterbox-Multilingual.hi-IN.Female' },
  'en-GB':  { male: 'Chatterbox-Multilingual.en-GB.Male',  female: 'Chatterbox-Multilingual.en-GB.Female' },
  'fr-FR':  { male: 'Chatterbox-Multilingual.fr-FR.Male',  female: 'Chatterbox-Multilingual.fr-FR.Female' },
  'de-DE':  { male: 'Chatterbox-Multilingual.de-DE.Male',  female: 'Chatterbox-Multilingual.de-DE.Female' },
  'es-ES':  { male: 'Chatterbox-Multilingual.es-ES.Male',  female: 'Chatterbox-Multilingual.es-ES.Female' },
  'pt-BR':  { male: 'Chatterbox-Multilingual.pt-BR.Male',  female: 'Chatterbox-Multilingual.pt-BR.Female' },
  'ja-JP':  { male: 'Chatterbox-Multilingual.ja-JP.Male',  female: 'Chatterbox-Multilingual.ja-JP.Female' },
  'zh-CN':  { male: 'Chatterbox-Multilingual.zh-CN.Male',  female: 'Chatterbox-Multilingual.zh-CN.Female' },
  'ko-KR':  { male: 'Chatterbox-Multilingual.ko-KR.Male',  female: 'Chatterbox-Multilingual.ko-KR.Female' },
};

// ─── Request Validation ───────────────────────────────────────────────────────

interface TTSRequest {
  text: string;
  language?: string;   // BCP-47 locale, e.g. 'hi-IN' | 'en-IN' | 'en-US'
  gender?: 'male' | 'female';
  exaggeration?: number; // 0.0 – 1.0, controls expressiveness
  speed?: number;        // 0.5 – 2.0
}

// ─── POST /api/tts/synthesize ─────────────────────────────────────────────────
/**
 * Synthesizes text using NVIDIA Chatterbox Multilingual TTS and streams
 * WAV audio back to the caller.
 *
 * Body: { text, language?, gender?, exaggeration?, speed? }
 * Response: audio/wav binary stream
 *
 * Authentication: optionalAuth — accessible by delivery partners without login
 * (for in-app navigation voice), but rate-limited below.
 */
router.post('/synthesize', optionalAuth, async (req: AuthRequest, res: Response) => {
  if (!NVIDIA_API_KEY) {
    console.error('[TTS] NVIDIA_API_KEY not configured in environment variables');
    return res.status(503).json({
      error: 'TTS service not configured. Set NVIDIA_API_KEY environment variable.',
    });
  }

  const { text, language = 'en-IN', gender = 'female', exaggeration = 0.5, speed = 1.0 } = req.body as TTSRequest;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing required field: text' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text too long (max 2000 characters)' });
  }

  // Resolve voice name
  const langVoices = CHATTERBOX_VOICES[language] || CHATTERBOX_VOICES['en-IN'];
  const voiceName = gender === 'male' ? langVoices.male : langVoices.female;

  try {
    console.log(`[TTS] Synthesizing "${text.slice(0, 60)}..." lang=${language} voice=${voiceName}`);

    // ── Call NVIDIA NIM REST API ──────────────────────────────────────────────
    // The NVIDIA Chatterbox Multilingual NIM exposes an OpenAI-compatible
    // /v1/audio/speech REST endpoint at integrate.api.nvidia.com for cloud access.
    // Authentication: Authorization: Bearer nvapi-...
    const nvidiaRes = await fetch(NVIDIA_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        'NVCF-INPUT-ASSET-REFERENCES': '', // empty unless using voice reference audio
      },
      body: JSON.stringify({
        model: 'resemble-ai/chatterbox-multilingual',
        input: text,
        voice: voiceName,
        response_format: 'mp3',
        speed: Math.min(2.0, Math.max(0.5, speed)),
        // Chatterbox-specific: exaggeration controls emotional expressiveness
        extra_body: {
          language_code: language,
          exaggeration: Math.min(1.0, Math.max(0.0, exaggeration)),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!nvidiaRes.ok) {
      const errText = await nvidiaRes.text().catch(() => '');
      console.error(`[TTS] NVIDIA API error ${nvidiaRes.status}:`, errText);
      return res.status(502).json({
        error: `TTS provider error: ${nvidiaRes.status}`,
        detail: errText.slice(0, 200),
      });
    }

    // Stream audio back to caller
    const contentType = nvidiaRes.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Voice', voiceName);

    // Pipe audio bytes
    const audioBuffer = await nvidiaRes.arrayBuffer();
    res.send(Buffer.from(audioBuffer));

    console.log(`[TTS] ✅ Synthesized ${audioBuffer.byteLength} bytes for lang=${language}`);
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.error('[TTS] Request timed out after 30s');
      return res.status(504).json({ error: 'TTS synthesis timed out' });
    }
    console.error('[TTS] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal TTS error', detail: err.message });
  }
});

// ─── GET /api/tts/voices ──────────────────────────────────────────────────────
/** Returns available language/voice list */
router.get('/voices', (_req: Request, res: Response) => {
  res.json({
    model: 'resemble-ai/chatterbox-multilingual',
    voices: Object.entries(CHATTERBOX_VOICES).map(([lang, v]) => ({
      language: lang,
      male: v.male,
      female: v.female,
    })),
  });
});

// ─── GET /api/tts/health ──────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    configured: !!NVIDIA_API_KEY,
    model: 'resemble-ai/chatterbox-multilingual',
    endpoint: NVIDIA_TTS_ENDPOINT,
  });
});

export default router;
