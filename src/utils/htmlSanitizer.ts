/**
 * htmlSanitizer.ts — Strict Email HTML Content Sanitizer
 * Protects against Stored XSS, script injection, iframe phishing,
 * and dangerous URI schemes in email previews, campaigns, and dispatches.
 */

const DANGEROUS_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'base',
  'meta',
  'link',
  'frame',
  'frameset',
];

/**
 * Strips script tags, iframes, event handlers, and dangerous URL schemes.
 */
export function sanitizeEmailHtml(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  let sanitized = rawHtml;

  // 1. Remove dangerous elements entirely along with their inner contents
  for (const tag of DANGEROUS_TAGS) {
    const tagRegex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    sanitized = sanitized.replace(tagRegex, '');
    const selfClosingRegex = new RegExp(`<${tag}[^>]*\\/?>`, 'gi');
    sanitized = sanitized.replace(selfClosingRegex, '');
  }

  // 2. Strip all inline DOM event handlers (e.g. onload=, onclick=, onerror=, etc.)
  sanitized = sanitized.replace(/\s+on[a-zA-Z]+\s*=\s*(['\"][^'\"]*['\"]|[^\s>]+)/gi, '');

  // 3. Strip javascript: and vbscript: URIs from href, src, and style attributes
  sanitized = sanitized.replace(/\b(href|src|action)\s*=\s*['"]\s*(javascript|vbscript|data(?!\s*:\s*image\/(png|jpe?g|gif|webp))):[^'"]*['"]/gi, '$1="#"');
  sanitized = sanitized.replace(/\b(href|src|action)\s*=\s*(javascript|vbscript):[^\s>]+/gi, '$1="#"');

  // 4. Strip expression() and url(javascript:) in inline CSS style attributes
  sanitized = sanitized.replace(/style\s*=\s*(['"][^'"]*['"]|[^\s>]+)/gi, (match) => {
    let cleanStyle = match;
    cleanStyle = cleanStyle.replace(/expression\s*\([^)]*\)/gi, '');
    cleanStyle = cleanStyle.replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, '');
    cleanStyle = cleanStyle.replace(/behavior\s*:[^;]+;?/gi, '');
    return cleanStyle;
  });

  return sanitized.trim();
}
