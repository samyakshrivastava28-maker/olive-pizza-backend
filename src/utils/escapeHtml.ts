/**
 * escapeHtml.ts
 *
 * Centralized HTML Escaping Utility (Phase 92 - XSS & Injection Safety).
 *
 * Escapes unsafe characters in untrusted user-supplied data (such as customer names,
 * phone numbers, delivery notes, product titles, customization addons, addresses)
 * before rendering them inside HTML emails, PDF receipts, or printable invoice templates.
 */

export function escapeHtml(str: any): string {
  if (str === null || str === undefined) return '';
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Escapes all string properties of an object recursively for safe HTML interpolation.
 */
export function escapeHtmlObject<T = any>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return escapeHtml(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(escapeHtmlObject) as unknown as T;
  if (typeof obj === 'object') {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      res[k] = escapeHtmlObject(v);
    }
    return res as T;
  }
  return obj;
}
