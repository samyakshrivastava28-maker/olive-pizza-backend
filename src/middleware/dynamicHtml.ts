import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { adminDb as db } from '../config/firebase.js';

const BASE_URL = 'https://olivepizza.com';

const getMetaTags = (title: string, description: string, url: string, image: string, schema: any = null) => {
  let tags = `
    <title>${title}</title>
    <meta name="title" content="${title}">
    <meta name="description" content="${description}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${url}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="${url}">
    <meta property="twitter:title" content="${title}">
    <meta property="twitter:description" content="${description}">
    <meta property="twitter:image" content="${image}">
  `;

  if (schema) {
    tags += `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  }

  return tags;
};

export const dynamicHtmlInjector = async (req: Request, res: Response, next: NextFunction) => {
  const clientPath = path.resolve(process.cwd(), 'dist/client');
  const indexPath = path.join(clientPath, 'index.html');

  try {
    let html = await fs.promises.readFile(indexPath, 'utf-8');
    
    let title = 'Olive Pizza | Artisan Pizza Delivery';
    let description = 'Experience the best artisan pizza delivered hot and fresh to your door. Olive Pizza offers premium ingredients, fast delivery, and unforgettable taste.';
    let image = `${BASE_URL}/og-image.jpg`;
    let url = `${BASE_URL}${req.path}`;
    let schema = null;

    // Route matching for dynamic injection
    if (req.path.startsWith('/menu/product/')) {
      const productId = req.path.split('/').pop();
      if (productId) {
        let docSnap = await db.collection('products').doc(productId).get();
        if (!docSnap.exists) {
          docSnap = await db.collection('combos').doc(productId).get();
        }
        
        if (docSnap.exists) {
          const data = docSnap.data() as any;
          title = `${data.name || data.productName} - Olive Pizza`;
          description = data.description || `Order ${title} from Olive Pizza. Freshly baked and delivered hot.`;
          image = data.imageUrl || image;
          
          schema = {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": data.name || data.productName,
            "image": image,
            "description": description,
            "sku": productId,
            "brand": {
              "@type": "Brand",
              "name": "Olive Pizza"
            },
            "offers": {
              "@type": "Offer",
              "url": url,
              "priceCurrency": "USD",
              "price": data.offerPrice || data.basePrice || "0.00",
              "availability": "https://schema.org/InStock"
            }
          };
        }
      }
    } else if (req.path === '/menu') {
      title = 'Menu | Olive Pizza';
      description = 'Browse our extensive menu of artisan pizzas, sides, and beverages. Order online for fast delivery or pickup.';
    }

    const metaTags = getMetaTags(title, description, url, image, schema);
    
    // Inject before </head>
    html = html.replace('</head>', `${metaTags}\n</head>`);
    
    res.send(html);
  } catch (error) {
    console.error('Dynamic HTML Injection Error:', error);
    res.sendFile(indexPath); // Fallback to raw file
  }
};
