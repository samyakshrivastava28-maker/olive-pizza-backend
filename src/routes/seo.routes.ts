import express, { Request, Response } from 'express';
import { adminDb as db } from '../config/firebase.js';

const router = express.Router();

function getBaseUrl(req: Request): string {
  if (process.env.PUBLIC_WEBSITE_URL) return process.env.PUBLIC_WEBSITE_URL.replace(/\/$/, '');
  const host = req.get('host') || 'olivepizza.in';
  const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

router.get('/robots.txt', (req: Request, res: Response): void => {
  const baseUrl = getBaseUrl(req);
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Allow: /menu
Allow: /product/
Allow: /offers
Allow: /about
Allow: /contact
Allow: /privacy-policy
Allow: /terms

# Disallow authenticated, operational & private routes
Disallow: /api/
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /order-tracking
Disallow: /pos
Disallow: /owner
Disallow: /franchise
Disallow: /manager
Disallow: /delivery

Sitemap: ${baseUrl}/sitemap.xml
`);
});

router.get('/sitemap.xml', async (req: Request, res: Response): Promise<void> => {
  try {
    const baseUrl = getBaseUrl(req);
    const now = new Date().toISOString().split('T')[0];

    interface SitemapItem {
      loc: string;
      lastmod: string;
      changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
      priority: string;
      image?: string;
      title?: string;
    }

    const publicUrls: SitemapItem[] = [
      { loc: `${baseUrl}/`, lastmod: now, changefreq: 'daily', priority: '1.0' },
      { loc: `${baseUrl}/menu`, lastmod: now, changefreq: 'daily', priority: '0.9' },
      { loc: `${baseUrl}/offers`, lastmod: now, changefreq: 'weekly', priority: '0.8' },
      { loc: `${baseUrl}/about`, lastmod: now, changefreq: 'monthly', priority: '0.6' },
      { loc: `${baseUrl}/contact`, lastmod: now, changefreq: 'monthly', priority: '0.6' },
      { loc: `${baseUrl}/privacy-policy`, lastmod: now, changefreq: 'yearly', priority: '0.3' },
      { loc: `${baseUrl}/terms`, lastmod: now, changefreq: 'yearly', priority: '0.3' },
      { loc: `${baseUrl}/refund-policy`, lastmod: now, changefreq: 'yearly', priority: '0.3' },
      { loc: `${baseUrl}/delivery-policy`, lastmod: now, changefreq: 'yearly', priority: '0.3' },
      { loc: `${baseUrl}/faq`, lastmod: now, changefreq: 'monthly', priority: '0.5' }
    ];

    // Fetch dynamic products from Firestore
    try {
      const productsSnap = await db.collection('products').get();
      productsSnap.forEach((doc) => {
        const d = doc.data();
        if (d.isActive !== false && d.isAvailable !== false) {
          publicUrls.push({
            loc: `${baseUrl}/product/${doc.id}`,
            lastmod: d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString().split('T')[0] : now,
            changefreq: 'weekly',
            priority: '0.8',
            image: d.imageUrl || d.image,
            title: d.name
          });
        }
      });
    } catch (e: any) {
      console.warn('[Sitemap] Could not fetch dynamic products from db:', e.message);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${publicUrls
  .map(
    (item) => `  <url>
    <loc>${item.loc}</loc>
    <lastmod>${item.lastmod}</lastmod>
    <changefreq>${item.changefreq}</changefreq>
    <priority>${item.priority}</priority>${
      item.image
        ? `
    <image:image>
      <image:loc>${item.image}</image:loc>
      <image:title>${item.title || 'Olive Pizza'}</image:title>
    </image:image>`
        : ''
    }
  </url>`
  )
  .join('\n')}
</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml.trim());
  } catch (error: any) {
    console.error('Sitemap generation error:', error);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><error>Sitemap generation failed</error>');
  }
});

export default router;
