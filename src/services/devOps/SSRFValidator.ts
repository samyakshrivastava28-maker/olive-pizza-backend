/**
 * SSRFValidator.ts — Server-Side Request Forgery & Hostname Protection
 *
 * Validates connection URIs and API endpoints for Data Manager custom database integrations.
 * Strictly blocks:
 *  - Loopback addresses (127.0.0.1, localhost, ::1)
 *  - Cloud metadata endpoints (169.254.169.254, metadata.google.internal, etc.)
 *  - RFC 1918 Private IP blocks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 *  - Link-local and multicast ranges
 *  - Non-HTTP/HTTPS/PostgreSQL/MongoDB protocols unless explicitly allowed
 */

import net from 'net';
import dns from 'dns';
import { URL } from 'url';

export class SSRFValidator {
  private static BLOCKED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.aws.internal',
    'metadata.internal',
    'instance-data',
    '100.100.100.200', // Alibaba metadata
    '169.254.169.250',
    '169.254.169.251',
    '169.254.169.252',
    '169.254.169.253',
  ]);

  /**
   * Fast synchronous check for static keywords, protocols, and raw IP literals.
   */
  public static validate(
    targetUrl: string,
    allowedSchemes: string[] = ['http:', 'https:', 'postgresql:', 'postgres:', 'mongodb:', 'mongodb+srv:', 'redis:', 'rediss:']
  ): { safe: boolean; reason?: string } {
    if (!targetUrl || typeof targetUrl !== 'string') {
      return { safe: false, reason: 'Empty or invalid URL provided.' };
    }

    const trimmed = targetUrl.trim();

    // Fast check for special keywords
    for (const blocked of this.BLOCKED_HOSTS) {
      if (trimmed.toLowerCase().includes(blocked)) {
        return { safe: false, reason: `Access to restricted internal/metadata host "${blocked}" is strictly blocked for security.` };
      }
    }

    try {
      let parsedUrl: URL;
      if (trimmed.includes('://')) {
        parsedUrl = new URL(trimmed);
      } else {
        parsedUrl = new URL(`https://${trimmed}`);
      }

      // Check scheme
      if (!allowedSchemes.includes(parsedUrl.protocol)) {
        return {
          safe: false,
          reason: `Protocol "${parsedUrl.protocol}" is not allowed. Allowed protocols: ${allowedSchemes.join(', ')}`,
        };
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

      // Check blocked hostnames
      if (this.BLOCKED_HOSTS.has(cleanHost)) {
        return { safe: false, reason: `Access to restricted host "${cleanHost}" is blocked.` };
      }

      // Check IP literals
      if (net.isIP(cleanHost)) {
        if (this.isPrivateOrLoopbackIP(cleanHost)) {
          return { safe: false, reason: `Direct access to private or loopback IP "${cleanHost}" is forbidden.` };
        }
      }

      return { safe: true };
    } catch (err: any) {
      return { safe: false, reason: `URL parsing failed: ${err.message}` };
    }
  }

  /**
   * Asynchronous validation resolving DNS to inspect all destination IPs before connection.
   * Prevents DNS rebinding and private LAN SSRF via external hostnames.
   */
  public static async validateAsync(
    targetUrl: string,
    allowedSchemes: string[] = ['http:', 'https:', 'postgresql:', 'postgres:', 'mongodb:', 'mongodb+srv:', 'redis:', 'rediss:']
  ): Promise<{ safe: boolean; reason?: string }> {
    const syncCheck = this.validate(targetUrl, allowedSchemes);
    if (!syncCheck.safe) {
      return syncCheck;
    }

    try {
      const trimmed = targetUrl.trim();
      const parsedUrl = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
      const hostname = parsedUrl.hostname.toLowerCase();
      const cleanHost = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

      // If already an IP literal, sync check already validated it
      if (net.isIP(cleanHost)) {
        return { safe: true };
      }

      // Resolve DNS
      const addresses = await dns.promises.lookup(cleanHost, { all: true, verbatim: true });
      if (!addresses || addresses.length === 0) {
        return { safe: false, reason: `Hostname "${cleanHost}" could not be resolved.` };
      }

      for (const addr of addresses) {
        if (this.isPrivateOrLoopbackIP(addr.address)) {
          return {
            safe: false,
            reason: `Access to "${cleanHost}" is forbidden: resolves to restricted IP ${addr.address}.`,
          };
        }
      }

      return { safe: true };
    } catch (err: any) {
      return { safe: false, reason: `DNS lookup failed for target: ${err.message}` };
    }
  }

  /**
   * Safe fetch helper that:
   * 1. Pre-validates URL and DNS against SSRF
   * 2. Re-validates every redirect destination against SSRF
   * 3. Enforces request timeout (default 8s)
   * 4. Enforces maximum redirect count (default 3)
   */
  public static async safeFetch(
    url: string,
    options: RequestInit & { maxRedirects?: number; timeoutMs?: number } = {}
  ): Promise<Response> {
    const maxRedirects = options.maxRedirects ?? 3;
    const timeoutMs = options.timeoutMs ?? 8000;
    let currentUrl = url;
    let redirectCount = 0;

    while (true) {
      const check = await this.validateAsync(currentUrl, ['http:', 'https:']);
      if (!check.safe) {
        throw new Error(`SSRF Validation Rejected: ${check.reason}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const fetchOptions: RequestInit = {
          ...options,
          redirect: 'manual',
          signal: controller.signal,
        };

        const response = await fetch(currentUrl, fetchOptions);

        // Handle redirects securely
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`HTTP redirect ${response.status} missing Location header.`);
          }

          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error(`Exceeded maximum allowed redirects (${maxRedirects}).`);
          }

          // Resolve relative redirect URLs
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        return response;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  public static isPrivateOrLoopbackIP(ip: string): boolean {
    // Check for IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (net.isIPv6(ip)) {
      const lower = ip.toLowerCase();
      if (lower.startsWith('::ffff:')) {
        const mappedPart = lower.slice(7);
        if (net.isIPv4(mappedPart)) {
          return this.isPrivateOrLoopbackIP(mappedPart);
        }
      }

      if (lower === '::1' || lower === '::') return true;
      if (lower.startsWith('fe80:')) return true; // Link-local
      if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true; // Unique local
      if (lower.startsWith('ff00:')) return true; // Multicast
      if (lower.startsWith('2001:db8:')) return true; // Documentation
    }

    // IPv4 checks
    if (net.isIPv4(ip)) {
      const parts = ip.split('.').map(Number);
      const [first, second] = parts;

      // 0.0.0.0/8 (Current network)
      if (first === 0) return true;

      // 10.0.0.0/8 (Private network)
      if (first === 10) return true;

      // 100.64.0.0/10 (Carrier-grade NAT)
      if (first === 100 && second >= 64 && second <= 127) return true;

      // 127.0.0.0/8 (Loopback)
      if (first === 127) return true;

      // 169.254.0.0/16 (Link-local & AWS/GCP metadata)
      if (first === 169 && second === 254) return true;

      // 172.16.0.0/12 (Private network)
      if (first === 172 && second >= 16 && second <= 31) return true;

      // 192.0.0.0/24 (IETF Protocol Assignments)
      if (first === 192 && second === 0 && parts[2] === 0) return true;

      // 192.0.2.0/24 (TEST-NET-1)
      if (first === 192 && second === 0 && parts[2] === 2) return true;

      // 192.168.0.0/16 (Private network)
      if (first === 192 && second === 168) return true;

      // 198.18.0.0/15 (Network benchmark tests)
      if (first === 198 && (second === 18 || second === 19)) return true;

      // 198.51.100.0/24 (TEST-NET-2)
      if (first === 198 && second === 51 && parts[2] === 100) return true;

      // 203.0.113.0/24 (TEST-NET-3)
      if (first === 203 && second === 0 && parts[2] === 113) return true;

      // 224.0.0.0/4 (Multicast)
      if (first >= 224 && first <= 239) return true;

      // 240.0.0.0/4 (Reserved / Future use)
      if (first >= 240) return true;
    }

    return false;
  }
}
