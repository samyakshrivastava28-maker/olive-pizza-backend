export type SupportedLanguage = 'en' | 'hi' | 'hinglish';

const HINGLISH_MARKERS = new Set([
  'bhai', 'chahiye', 'kardo', 'mujhe', 'batao', 'hai', 'kaise', 'kya',
  'dena', 'kitna', 'laga', 'mil', 'ha', 'haan', 'ji', 'mangwa', 'banao',
  'wale', 'sath', 'pizzas', 'chahiye', 'kuch', 'hoga', 'mera', 'meri',
  'karo', 'de', 'do', 'aur', 'par', 'se', 'koi', 'accha', 'achha', 'nahi',
  'haanji', 'bata', 'dikhao', 'wale', 'bhi', 'hum'
]);

/**
 * Lightweight language detector for AI context building.
 * Uses Unicode script boundaries + Hinglish dictionary matching.
 */
export function detectLanguage(text: string): SupportedLanguage {
  if (!text || typeof text !== 'string') return 'en';

  const trimmed = text.trim();
  if (!trimmed) return 'en';

  // 1. Devanagari Script Check (Hindi)
  const devanagariRegex = /[\u0900-\u097F]/;
  if (devanagariRegex.test(trimmed)) {
    return 'hi';
  }

  // 2. Hinglish Marker Match
  const words = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  let hinglishMatches = 0;

  for (const word of words) {
    if (HINGLISH_MARKERS.has(word)) {
      hinglishMatches++;
    }
  }

  // If at least 1 strong marker word is present, treat as Hinglish
  if (hinglishMatches >= 1) {
    return 'hinglish';
  }

  return 'en';
}

export function getMultilingualPromptInstruction(lang: SupportedLanguage): string {
  if (lang === 'hi') {
    return `Language Context: Hindi. Respond naturally in clear, polite Hindi (Devanagari script).`;
  }
  if (lang === 'hinglish') {
    return `Language Context: Hinglish. Respond naturally in Hinglish (mix of conversational Hindi words written in Roman script and English like a friendly Indian food associate e.g., "Sure bhai! Main aapke cart me Paneer Pizza add kar deta hu.").`;
  }
  return `Language Context: English. Respond in clear, crisp, professional English.`;
}
