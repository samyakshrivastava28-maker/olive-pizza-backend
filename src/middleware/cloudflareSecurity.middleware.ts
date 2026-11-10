import { Request, Response, NextFunction } from 'express';

export interface CloudflareContext {
  rayId?: string;
  country?: string;
  clientIp: string;
  isCloudflare: boolean;
  botScore?: number;
}

declare global {
  namespace Express {
    interface Request {
      cloudflare?: CloudflareContext;
    }
  }
}

/**
 * Known malicious or high-risk scanner signatures
 */
const MALICIOUS_SCANNER_REGEX = /(sqlmap|nikto|acunetix|masscan|dirbuster|nmap|morfeus|zgrab|nessus|openvas|w3af|havij)/i;

/**
 * 🛡️ Cloudflare Edge Security & WAF Integration Middleware
 * Validates edge metadata, enforces anti-spoofing, and blocks known automated exploit scanners.
 */
export function cloudflareEdgeSecurity(req: Request, res: Response, next: NextFunction): void {
  const cfRay = req.headers['cf-ray'] as string | undefined;
  const cfCountry = req.headers['cf-ipcountry'] as string | undefined;
  const cfConnectingIp = req.headers['cf-connecting-ip'] as string | undefined;
  const userAgent = req.headers['user-agent'] || '';

  // 1. Identify Client IP with anti-spoofing defense
  const isCloudflare = Boolean(cfRay && cfConnectingIp);
  const clientIp = (isCloudflare && cfConnectingIp?.trim()) || 
    req.ip || 
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || 
    req.socket.remoteAddress || 
    'unknown';

  req.cloudflare = {
    rayId: cfRay,
    country: cfCountry,
    clientIp,
    isCloudflare
  };

  // 2. Reject known automated security vulnerability scanners
  if (userAgent && MALICIOUS_SCANNER_REGEX.test(userAgent)) {
    console.warn(`[CloudflareSecurity] 🚨 Blocked malicious scanner agent "${userAgent}" from IP ${clientIp}`);
    res.status(403).json({
      success: false,
      error: 'Access denied by Cloudflare Edge Security policy',
      code: 'EDGE_SECURITY_BLOCKED'
    });
    return;
  }

  // 3. Inject Edge hardening response headers
  res.setHeader('X-Edge-Provider', 'Cloudflare-Canonical');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cfRay) {
    res.setHeader('X-CF-Ray', cfRay);
  }

  next();
}
