/**
 * AIFirewallFilter.ts — AI Security Firewall & Code Leak Protection
 * 
 * Intercepts AI responses to ensure source code, code blocks, JS/HTML injection,
 * system internal architecture, credentials, or code snippets are NEVER exposed to normal users.
 */

export interface FirewallCheckOptions {
  userRole?: string;
  allowCode?: boolean;
}

export class AIFirewallFilter {
  /**
   * Detects if text contains raw source code, code blocks, or internal system code
   */
  static containsCodeOutput(text: string): boolean {
    if (!text) return false;

    // Pattern 1: Fenced code blocks (```js, ```ts, ```html, ```python, etc.)
    if (/```[a-z0-9]*\s*[\s\S]*?```/i.test(text)) {
      return true;
    }

    // Pattern 2: Typical code keyword signatures
    const codeKeywords = [
      /import\s+[\s\S]+?from\s+['"]/i,
      /export\s+(default\s+)?(class|function|const|let|var|interface|type)\s+/i,
      /function\s+\w+\s*\(.*?\)\s*\{/i,
      /const\s+\w+\s*=\s*\(.*?\)\s*=>/i,
      /<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/i,
      /<\s*html[^>]*>[\s\S]*?<\s*\/\s*html\s*>/i,
      /<\s*div[^>]*class=/i,
      /process\.env\.\w+/i,
      /npm\s+install\s+/i,
      /git\s+clone\s+/i,
      /SELECT\s+[\s\S]+?\s+FROM\s+/i,
    ];

    return codeKeywords.some((pattern) => pattern.test(text));
  }

  /**
   * Sanitizes AI response text. Strips code or replaces response if restricted.
   */
  static sanitizeResponse(text: string, options: FirewallCheckOptions = {}): string {
    if (!text || !text.trim()) return text;

    const { userRole = 'guest', allowCode = false } = options;

    // Developer and owner roles retain code inspection when explicitly allowed
    if (allowCode || userRole === 'developer' || userRole === 'owner' || userRole === 'admin') {
      return text;
    }

    // If text contains code output, sanitize it
    if (this.containsCodeOutput(text)) {
      console.warn('[AIFirewallFilter] 🛡️ Intercepted and blocked code output from customer AI response.');

      // Strip out markdown code blocks if any
      let cleaned = text.replace(/```[a-z0-9]*\s*[\s\S]*?```/gi, '').trim();

      // If after stripping code, text is empty or still contains code keywords, return safe natural language response
      if (!cleaned || this.containsCodeOutput(cleaned)) {
        return "I am Olive AI, your concierge for Olive Pizza! I can help you browse our menu, check active offers, customize pizzas, and track your orders. How can I help you today? 🍕";
      }

      return cleaned;
    }

    return text;
  }
}
