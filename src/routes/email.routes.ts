import express from 'express';
import { queueEmail, transporter } from '../services/email.service.js';
import { pgPool } from '../config/postgres.js';
import dotenv from 'dotenv';
import { adminAuth, adminDb } from '../config/firebase.js';
import {
  buildOrderPlacedEmail,
  buildOrderConfirmedEmail,
  buildDeliveryPartnerAssignedEmail,
  buildOrderDeliveredEmail
} from '../services/emailTemplates.service.js';
import { sanitizeEmailHtml } from '../utils/htmlSanitizer.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';

// Internal service or staff authorization guard for sensitive email actions
const requireInternalOrAdmin = (req: any, res: any, next: any) => {
  const secretHeader = req.headers['x-internal-auth'] || req.headers['x-service-token'];
  const expectedSecret = process.env.INTERNAL_SERVICE_TOKEN || process.env.JWT_SECRET || 'olive-internal-service-secret';
  if (secretHeader && secretHeader === expectedSecret) {
    return next();
  }
  return verifyToken(req, res, () => {
    requireRole(['owner', 'admin', 'developer', 'system'])(req, res, next);
  });
};

dotenv.config();

// ─── Olive Pizza Brand Assets ───────────────────────────────────────────────
const LOGO_URL = 'https://res.cloudinary.com/dxmlvkff1/image/upload/v1782376898/olive-pizza/brand/logo.png';
const BRAND_COLOR = '#f97316';
const BRAND_DARK = '#0B0F14';
const BRAND_FOOTER_BG = '#1E293B';

// ─── Email Header with Real Logo ─────────────────────────────────────────────
const EMAIL_HEADER = `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${BRAND_DARK};">
    <tr>
      <td align="center" style="padding: 28px 20px 20px;">
        <img
          src="${LOGO_URL}"
          alt="Olive Pizza Logo"
          width="72"
          height="72"
          style="display: block; border-radius: 16px; margin-bottom: 10px;"
        />
        <div style="color: ${BRAND_COLOR}; font-family: Arial, sans-serif; font-size: 22px; font-weight: 900; letter-spacing: 2px; text-transform: uppercase;">
          Olive Pizza
        </div>
        <div style="color: #94a3b8; font-family: Arial, sans-serif; font-size: 12px; margin-top: 4px; letter-spacing: 1px;">
          Premium Pizza Delivery · Rajnandgaon
        </div>
      </td>
    </tr>
  </table>
`;

// ─── Email Footer ─────────────────────────────────────────────────────────────
const EMAIL_FOOTER = `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${BRAND_FOOTER_BG};">
    <tr>
      <td align="center" style="padding: 20px; color: #64748b; font-family: Arial, sans-serif; font-size: 11px; line-height: 1.6;">
        <img src="${LOGO_URL}" alt="Olive Pizza" width="32" height="32" style="border-radius: 8px; margin-bottom: 8px; display: block; margin-left: auto; margin-right: auto;" />
        <div>Olive Pizza | Dongargaon Rd, near Saraswati School, Gokul Nagar</div>
        <div>Rajnandgaon, Chhattisgarh 491441</div>
        <div style="margin-top: 6px;">
          <a href="https://olivepizza.app/menu" style="color: ${BRAND_COLOR}; text-decoration: none; margin: 0 8px;">Order Now</a>
          <span style="color: #334155;">|</span>
          <a href="https://olivepizza.app" style="color: ${BRAND_COLOR}; text-decoration: none; margin: 0 8px;">Website</a>
        </div>
        <div style="margin-top: 8px; color: #475569;">© ${new Date().getFullYear()} Olive Pizza. All rights reserved.</div>
      </td>
    </tr>
  </table>
`;

// ─── Full Email Wrapper ───────────────────────────────────────────────────────
const wrapper = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Olive Pizza</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td align="center" style="padding: 24px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);">
          <tr><td>${EMAIL_HEADER}</td></tr>
          <tr>
            <td style="background-color: #ffffff; padding: 32px 36px; font-family: Arial, sans-serif; color: #1e293b; line-height: 1.6;">
              ${content}
            </td>
          </tr>
          <tr><td>${EMAIL_FOOTER}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

const router = express.Router();

// 1. Transactional Triggers
router.post('/transactional', requireInternalOrAdmin, async (req, res) => {
  const startTime = Date.now();
  try {
    const { event, data } = req.body;
    const ownerEmail = process.env.OWNER_EMAIL || 'webhub2811@gmail.com';
    
    if (event === 'REGISTER') {
      await queueEmail(
        data.email,
        'Welcome to Olive Pizza! 🍕',
        wrapper(`
          <h2 style="color: #0f172a;">Welcome, ${data.name || 'Pizza Lover'}!</h2>
          <p>Thank you for joining Olive Pizza. We are thrilled to have you.</p>
          <p>Get ready to experience the most premium pizzas in Rajnandgaon.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="https://olivepizza.app/menu" style="background-color: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Order Now</a>
          </div>
        `),
        'transactional'
      );
      console.log(`[Email] Transactional | Recipient: ${data.email} | Template: REGISTER | Success: true | Duration: ${Date.now() - startTime}ms`);
    }

    if (['ORDER_PLACED', 'ORDER_STATUS_CHANGED'].includes(event) && data.orderId) {
      const orderSnap = await adminDb.collection('orders').doc(data.orderId).get();
      if (orderSnap.exists) {
        const order = { id: orderSnap.id, ...orderSnap.data() } as any;
        const customerEmail = order.customerInfo?.email || data.customerEmail;
        
        if (customerEmail) {
          if (event === 'ORDER_PLACED') {
            await queueEmail(customerEmail, '🍕 Your Olive Pizza order has been placed successfully!', wrapper(buildOrderPlacedEmail(order)), 'transactional');
          } else if (event === 'ORDER_STATUS_CHANGED') {
            const status = data.status || order.status;
            
            switch (status) {
              case 'preparing':
                await queueEmail(customerEmail, '✅ Your order has been confirmed!', wrapper(buildOrderConfirmedEmail(order)), 'transactional');
                break;

              case 'ready':
                if (order.deliveryPartnerId) {
                  let partnerName = 'Delivery Partner';
                  let partnerPhoto = '';
                  let vehicleInfo = '';
                  try {
                    const partnerSnap = await adminDb.collection('users').doc(order.deliveryPartnerId).get();
                    if (partnerSnap.exists) {
                      const partner = partnerSnap.data();
                      partnerName = partner?.name || partnerName;
                      partnerPhoto = partner?.photoUrl || partnerPhoto;
                      vehicleInfo = partner?.vehicleType ? `${partner.vehicleType} (${partner.vehicleNumber || 'No number'})` : vehicleInfo;
                    }
                  } catch (e) {}
                  await queueEmail(customerEmail, '🚴 Your delivery partner is on the way!', wrapper(buildDeliveryPartnerAssignedEmail(order, partnerName, partnerPhoto, vehicleInfo)), 'transactional');
                }
                break;

              case 'delivered': {
                let recommendedProducts: any[] = [];
                try {
                  const productsSnap = await adminDb.collection('products').where('isAvailable', '==', true).limit(3).get();
                  recommendedProducts = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                } catch (e) {}
                await queueEmail(customerEmail, '🎉 Enjoy your meal!', wrapper(buildOrderDeliveredEmail(order, recommendedProducts)), 'transactional');
                break;
              }

              default:
                break;
            }
          }
          console.log(`[Email] Transactional | Recipient: ${customerEmail} | Template: ${event} (${data.status}) | Success: true`);
        } else {
          console.log(`[Email] Transactional | No customer email found for order ${data.orderId}`);
        }
      }
    }

    res.json({ success: true, message: "Transactional trigger processed" });
  } catch (error: any) {
    console.error(`[Email] Transactional | Template: ${req.body?.event} | Success: false | Duration: ${Date.now() - startTime}ms | Error: ${error.message}\n${error.stack}`);
    res.status(500).json({ success: false, error: 'Failed to process trigger' });
  }
});

// 2. AI Alerts
router.post('/ai-alert', requireInternalOrAdmin, async (req, res) => {
  try {
    const { to, subject, htmlBody } = req.body;
    
    // Very basic security: Only accept internal AI alerts
    if (!subject || !htmlBody) {
      res.status(400).json({ error: 'Missing subject or htmlBody' });
      return;
    }

    const recipients = Array.isArray(to) ? to : [to];
    for (const recipient of recipients) {
      if (recipient) {
        await queueEmail(recipient, subject, htmlBody, 'transactional');
      }
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error(`[Email] AI Alert Error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to queue AI alert' });
  }
});

// ─── Owner Tools ──────────────────────────────────────────────────────────────

router.get('/debug', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  try {
    const isReady = transporter ? true : false;
    let smtpConnected = false;
    let lastError = null;
    
    if (isReady) {
      try {
        await Promise.race([
          transporter.verify(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timeout')), 5000))
        ]);
        smtpConnected = true;
      } catch (err: any) {
        lastError = err.message;
      }
    }

    let templatesCount = 0;
    try {
      const templateResult = await Promise.race([
        pgPool.query('SELECT count(*) FROM email_templates'),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('DB Query timeout')), 3000))
      ]);
      templatesCount = parseInt(templateResult?.rows?.[0]?.count, 10) || 0;
    } catch(e) {}

    res.json({
      success: true,
      diagnostics: {
        smtpConnected,
        smtpProvider: process.env.SMTP_HOST || 'Unknown',
        authenticationStatus: smtpConnected ? 'Verified' : 'Failed',
        senderEmail: process.env.SMTP_USER || 'Not Configured',
        lastError,
        environmentLoaded: !!process.env.SMTP_PASS,
        templatesLoaded: templatesCount,
        nodemailerReady: isReady
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to generate debug info', details: error.message });
  }
});

router.post('/preview', verifyToken, requireRole(['owner', 'admin', 'developer']), (req: AuthRequest, res) => {
  try {
    const { htmlContent } = req.body;
    const sanitizedHtml = sanitizeEmailHtml(htmlContent || '<p>No content provided</p>');
    res.json({ success: true, html: wrapper(sanitizedHtml) });
  } catch (error: any) {
    console.error('[Email] Preview Error:', error.message);
    res.status(500).json({ success: false, error: 'Preview generation failed' });
  }
});

router.post('/test', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  const startTime = Date.now();
  const { htmlContent, subject, recipient } = req.body;
  const testRecipient = recipient || 'olivepizzarjn@gmail.com';
  const sanitizedHtml = sanitizeEmailHtml(htmlContent || '<p>Test Email Content</p>');
  
  try {
    const info = await transporter.sendMail({
      from: `"Olive Pizza" <${process.env.SMTP_USER}>`,
      to: testRecipient,
      subject: subject || 'Test Email from Owner Dashboard',
      html: wrapper(sanitizedHtml),
    });
    
    const duration = Date.now() - startTime;
    console.log(`[Email] Test | Recipient: ${testRecipient} | Subject: ${subject} | Success: true | Duration: ${duration}ms`);
    res.json({ 
      success: true, 
      message: `Test email sent to ${testRecipient}`,
      diagnostics: {
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
        durationMs: duration
      }
    });
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Email] Test | Recipient: ${testRecipient} | Success: false | Duration: ${duration}ms | Error: ${error.message}\n${error.stack}`);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to send test email',
      diagnostics: {
        code: error.code,
        command: error.command,
        durationMs: duration,
        stack: error.stack
      }
    });
  }
});

// ─── Direct Send ──────────────────────────────────────────────────────────────
router.post('/auth/welcome', requireInternalOrAdmin, async (req, res) => {
  const startTime = Date.now();
  const { email, name, isReturning } = req.body;
  try {
    if (isReturning) {
      await queueEmail(email, 'Welcome back to Olive Pizza!', wrapper(`<h2>Welcome Back, ${name || 'Pizza Lover'}!</h2><p>Ready for another delicious pizza?</p>`), 'transactional');
    } else {
      await queueEmail(email, 'Welcome to Olive Pizza! 🍕', wrapper(`<h2>Welcome, ${name || 'Pizza Lover'}!</h2><p>Thank you for joining Olive Pizza.</p>`), 'transactional');
    }
    console.log(`[Email] Auth Welcome | Recipient: ${email} | Success: true | Duration: ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Welcome email queued' });
  } catch (err: any) {
    console.error(`[Email] Auth Welcome | Recipient: ${email} | Success: false | Duration: ${Date.now() - startTime}ms | Error: ${err.message}\n${err.stack}`);
    res.status(500).json({ success: false, error: 'Failed to send welcome email' });
  }
});

router.post('/auth/reset', requireInternalOrAdmin, async (req, res) => {
  const startTime = Date.now();
  const { email } = req.body;
  try {
    const link = await adminAuth.generatePasswordResetLink(email);
    await queueEmail(email, 'Password Reset Request', wrapper(`
      <h2>Reset Your Password</h2>
      <p>Click the link below to reset your Olive Pizza account password:</p>
      <a href="${link}" style="background-color: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Reset Password</a>
    `), 'transactional');
    console.log(`[Email] Auth Reset | Recipient: ${email} | Success: true | Duration: ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Reset email queued' });
  } catch (err: any) {
    console.error(`[Email] Auth Reset | Recipient: ${email} | Success: false | Duration: ${Date.now() - startTime}ms | Error: ${err.message}\n${err.stack}`);
    res.status(500).json({ success: false, error: 'Failed to send reset email' });
  }
});

router.post('/auth/verify', requireInternalOrAdmin, async (req, res) => {
  const startTime = Date.now();
  const { email } = req.body;
  try {
    const link = await adminAuth.generateEmailVerificationLink(email);
    await queueEmail(email, 'Verify your email address', wrapper(`
      <h2>Verify Email</h2>
      <p>Click the link below to verify your Olive Pizza account:</p>
      <a href="${link}" style="background-color: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Verify Email</a>
    `), 'transactional');
    console.log(`[Email] Auth Verify | Recipient: ${email} | Success: true | Duration: ${Date.now() - startTime}ms`);
    res.json({ success: true, message: 'Verification email queued' });
  } catch (err: any) {
    console.error(`[Email] Auth Verify | Recipient: ${email} | Success: false | Duration: ${Date.now() - startTime}ms | Error: ${err.message}\n${err.stack}`);
    res.status(500).json({ success: false, error: 'Failed to send verification email' });
  }
});

// 2. Fetch Templates
router.get('/templates', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  try {
    const result = await pgPool.query('SELECT * FROM email_templates ORDER BY created_at DESC');
    res.json({ success: true, templates: result.rows });
  } catch (error: any) {
    console.error('[Email] Fetch Templates Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch templates' });
  }
});

// 3. Create Campaign
router.post('/send-campaign', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  const startTime = Date.now();
  let campaignName: string = '', targetAudience: string = '', subject: string = '';
  
  try {
    campaignName = req.body.campaignName || req.body.name;
    targetAudience = req.body.targetAudience;
    subject = req.body.subject;
    const rawHtmlContent = req.body.htmlContent;
    const isFestival = req.body.isFestival;
    
    if (!campaignName || !subject || !rawHtmlContent) {
      return res.status(400).json({ success: false, error: 'Missing required campaign fields' });
    }
    const htmlContent = sanitizeEmailHtml(rawHtmlContent);
    
    // First save the template
    const templateQuery = `
      INSERT INTO email_templates (name, type, subject, html_content, is_festival)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const templateResult = await pgPool.query(templateQuery, [campaignName, 'marketing', subject, htmlContent, isFestival || false]);
    const templateId = templateResult.rows[0].id;

    // Create Campaign
    const campaignQuery = `
      INSERT INTO email_campaigns (name, target_audience, template_id, status)
      VALUES ($1, $2, $3, 'processing')
      RETURNING id
    `;
    const campaignResult = await pgPool.query(campaignQuery, [campaignName, targetAudience, templateId]);
    const campaignId = campaignResult.rows[0].id;

    // Process Audience & Dispatch (Background)
    (async () => {
      try {
        let emails: string[] = [];
        const { getFirestore } = await import('firebase-admin/firestore');
        const adminDb = getFirestore();
        const usersSnap = await adminDb.collection('users').get();
        
        usersSnap.forEach(doc => {
          const u = doc.data();
          if (!u.email) return;
          
          if (targetAudience === 'all') emails.push(u.email);
          else if (targetAudience === 'new') {
            const daysSinceJoin = (Date.now() - (u.createdAt?.toDate()?.getTime() || 0)) / (1000 * 3600 * 24);
            if (daysSinceJoin <= 30) emails.push(u.email);
          }
          else if (targetAudience === 'active' || targetAudience === 'vip') {
            if (u.ordersCount > (targetAudience === 'vip' ? 10 : 0)) emails.push(u.email);
          }
        });

        // Dedup and send
        emails = [...new Set(emails)];
        
        let sentCount = 0;
        let failCount = 0;

        for (const email of emails) {
          try {
            // Inject Tracking Pixel
            const trackedHtml = htmlContent + `<img src="https://olivepizza.app/api/email/track/open/${campaignId}" width="1" height="1" style="display:none;" />`;
            await queueEmail(email, subject, wrapper(trackedHtml), 'marketing');
            sentCount++;
          } catch (e) {
            failCount++;
          }
        }

        await pgPool.query(
          'UPDATE email_campaigns SET status = $1, sent_count = $2, fail_count = $3 WHERE id = $4',
          ['completed', sentCount, failCount, campaignId]
        );
        console.log(`[Email] Campaign Background Dispatch | Name: ${campaignName} | Sent: ${sentCount} | Failed: ${failCount}`);
      } catch (err: any) {
        console.error(`[Email] Campaign Dispatch Error: ${err.message}\n${err.stack}`);
        await pgPool.query('UPDATE email_campaigns SET status = $1 WHERE id = $2', ['failed', campaignId]);
      }
    })();

    console.log(`[Email] Send Campaign | Name: ${campaignName} | Audience: ${targetAudience} | Success: true | Duration: ${Date.now() - startTime}ms`);
    res.json({ success: true, campaignId, message: "Campaign successfully queued" });
  } catch (error: any) {
    console.error(`[Email] Send Campaign | Name: ${campaignName} | Success: false | Duration: ${Date.now() - startTime}ms | Error: ${error.message}\n${error.stack}`);
    res.status(500).json({ success: false, error: 'Failed to create campaign' });
  }
});

// 4. Analytics
router.get('/analytics', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  try {
    const metricsResult = await pgPool.query(`
      SELECT 
        COUNT(*) as total_sent,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as total_failed
      FROM email_queue
    `);
    
    const campaignsResult = await pgPool.query(`
      SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 10
    `);

    res.json({
      success: true,
      metrics: {
        totalSent: parseInt(metricsResult.rows[0].total_sent) || 0,
        totalFailed: parseInt(metricsResult.rows[0].total_failed) || 0,
      },
      campaigns: campaignsResult.rows
    });
  } catch (error: any) {
    console.error('[Email] Analytics Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch email analytics' });
  }
});

// 4.5 Logs (Transactional & Marketing)
router.get('/logs', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res) => {
  try {
    const { type, limit = 50, offset = 0, search = '' } = req.query;
    
    let query = `
      SELECT id, recipient, subject, type, status, retry_count, last_error, created_at, sent_at 
      FROM email_queue 
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (search) {
      query += ` AND (recipient ILIKE $${paramIndex} OR subject ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit as string, 10));
    params.push(parseInt(offset as string, 10));

    const result = await pgPool.query(query, params);
    
    // Get total count
    const countQuery = `SELECT COUNT(*) FROM email_queue WHERE 1=1 ${type ? `AND type = '${type}'` : ''} ${search ? `AND (recipient ILIKE '%${search}%' OR subject ILIKE '%${search}%')` : ''}`;
    const countResult = await pgPool.query(countQuery);
    
    res.json({
      success: true,
      logs: result.rows,
      total: parseInt(countResult.rows[0].count, 10)
    });
  } catch (error: any) {
    console.error('[Email] Logs Error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch email logs' });
  }
});

// 5. Tracking Endpoints
router.get('/track/open/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    // Update open count in campaigns table
    await pgPool.query(
      'UPDATE email_campaigns SET open_count = open_count + 1 WHERE id = $1',
      [campaignId]
    );
    // Return a 1x1 transparent tracking pixel
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': pixel.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private'
    });
    res.end(pixel);
  } catch (error) {
    res.status(500).end();
  }
});

router.get('/track/click/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { url } = req.query;
    
    // Update click count in campaigns table
    await pgPool.query(
      'UPDATE email_campaigns SET click_count = COALESCE(click_count, 0) + 1 WHERE id = $1',
      [campaignId]
    );
    
    if (url && typeof url === 'string') {
      return res.redirect(url);
    }
    res.redirect('https://olivepizza.app');
  } catch (error) {
    res.redirect('https://olivepizza.app');
  }
});

export default router;
