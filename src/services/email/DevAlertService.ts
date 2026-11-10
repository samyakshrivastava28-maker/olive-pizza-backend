/**
 * DevAlertService — Dedicated System Failure Alert Dispatcher
 *
 * Sends high-priority email alerts strictly to webhub2811@gmail.com
 * for critical backend exceptions, Google Drive upload failures, SMTP queue errors,
 * and background job failures.
 *
 * Features:
 *  - Recipient locked strictly to webhub2811@gmail.com
 *  - Rate-limiting (15-min cooldown per error key) to prevent inbox flooding
 *  - Asynchronous & non-blocking (never crashes caller)
 */

import { transporter } from '../email.service.js';

const DEVELOPER_EMAIL = 'webhub2811@gmail.com';
const alertCooldowns = new Map<string, number>();
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

export interface DevAlertOptions {
  service: string;
  action: string;
  error: Error | string;
  context?: Record<string, any>;
  key?: string;
}

export class DevAlertService {
  /**
   * Send a critical alert to webhub2811@gmail.com
   */
  public static async sendAlert(options: DevAlertOptions): Promise<boolean> {
    const errorKey = options.key || `${options.service}_${options.action}`;
    const now = Date.now();
    const lastSent = alertCooldowns.get(errorKey) || 0;

    // Rate-limit duplicate errors within 15 minutes
    if (now - lastSent < COOLDOWN_MS) {
      console.log(`[DevAlertService] Suppressing duplicate alert for key: ${errorKey}`);
      return false;
    }

    alertCooldowns.set(errorKey, now);

    const errorMessage = typeof options.error === 'string' ? options.error : options.error.message;
    const errorStack = typeof options.error === 'object' ? options.error.stack : '';

    // Create developer-friendly explanation based on error type
    let humanReadableCause = 'A system alert was raised during operation execution.';
    let responsibleComponent = options.service;
    let suggestedFix = 'Inspect the context metadata below and check backend logs.';

    if (errorMessage.includes('ESTREAM') || errorMessage.includes('type string or an instance of Buffer')) {
      responsibleComponent = 'Email Service (Attachment Buffer Converter)';
      humanReadableCause = 'An email attachment in the background email queue was stored as a JSON object instead of being decoded back into a Node.js Buffer before sending.';
      suggestedFix = 'The system auto-converts attachment JSON buffers back to Buffer instances in email.service.ts. Re-queueing the pending email will deliver it successfully.';
    } else if (errorMessage.includes('Cloudflare R2') || errorMessage.includes('S3')) {
      responsibleComponent = 'Cloudflare R2 Storage Service';
      humanReadableCause = 'Failed to upload or generate pre-signed URL for an asset/report on Cloudflare R2.';
      suggestedFix = 'Check Cloudflare R2 credentials (CLOUDFLARE_R2_ACCOUNT_ID, ACCESS_KEY, BUCKET_NAME) in environment configuration.';
    } else if (errorMessage.includes('SMTP') || errorMessage.includes('transporter')) {
      responsibleComponent = 'Nodemailer SMTP Transporter';
      humanReadableCause = 'SMTP server connection or authentication failed while dispatching outgoing emails.';
      suggestedFix = 'Verify SMTP host, port, user, and pass in backend environment variables.';
    }

    const subject = `🚨 [Olive Pizza DevOps] ${options.service}: ${options.action}`;

    const contextHtml = options.context ? Object.entries(options.context)
      .map(([k, v]) => `
        <tr style="border-bottom: 1px solid #1e293b;">
          <td style="padding: 8px 12px; font-weight: bold; color: #f97316; font-size: 13px;">${k}:</td>
          <td style="padding: 8px 12px; color: #cbd5e1; font-size: 13px;">${typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
        </tr>
      `).join('') : '';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #06070a; color: #f8fafc; padding: 20px; margin: 0; }
          .container { max-width: 620px; margin: 0 auto; background: #0b0d13; border: 1px solid #ef4444; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(239, 68, 68, 0.15); }
          .header { background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%); padding: 24px; border-bottom: 1px solid #ef444433; }
          .badge { display: inline-block; background: #ef444422; border: 1px solid #ef444466; color: #fca5a5; font-size: 11px; font-weight: bold; padding: 4px 10px; border-radius: 6px; text-transform: uppercase; letter-spacing: 1px; }
          .title { color: #ffffff; font-size: 20px; font-weight: 800; margin: 10px 0 4px 0; }
          .content { padding: 24px; }
          .box { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
          .box-title { font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: #f97316; margin-bottom: 6px; }
          .box-text { font-size: 14px; color: #cbd5e1; line-height: 1.5; margin: 0; }
          .fix-box { background: #064e3b22; border: 1px solid #10b98144; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
          .fix-title { font-size: 12px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: #34d399; margin-bottom: 6px; }
          .table-container { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; margin-top: 16px; }
          table { width: 100%; border-collapse: collapse; }
          .log-toggle { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 12px; margin-top: 16px; font-family: monospace; font-size: 11px; color: #fca5a5; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
          .footer { padding: 16px; border-top: 1px solid #1e293b; text-align: center; font-size: 11px; color: #64748b; background: #07090e; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <span class="badge">🚨 Developer Diagnostic Alert</span>
            <h1 class="title">${options.service} — ${options.action}</h1>
            <div style="color: #94a3b8; font-size: 12px; margin-top: 4px;">Triggered: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (IST)</div>
          </div>
          
          <div class="content">
            <!-- Responsible Component -->
            <div class="box">
              <div class="box-title">🔧 Responsible System Component</div>
              <div class="box-text"><strong>${responsibleComponent}</strong></div>
            </div>

            <!-- Human Readable Cause -->
            <div class="box">
              <div class="box-title">💡 Issue Summary & Root Cause</div>
              <div class="box-text">${humanReadableCause}</div>
            </div>

            <!-- Recommended Fix -->
            <div class="fix-box">
              <div class="fix-title">🛠️ Recommended Action / Solution</div>
              <div class="box-text" style="color: #a7f3d0;">${suggestedFix}</div>
            </div>

            <!-- Context Metadata -->
            ${contextHtml ? `
              <div style="font-size: 13px; font-weight: bold; color: #f8fafc; margin-top: 20px; margin-bottom: 8px;">📋 Event Context Metadata</div>
              <div class="table-container">
                <table>${contextHtml}</table>
              </div>
            ` : ''}

            <!-- Raw Technical Details -->
            <div style="font-size: 12px; font-weight: bold; color: #64748b; margin-top: 20px; margin-bottom: 6px;">🔍 Technical Diagnostic Log (Raw Message)</div>
            <div class="log-toggle">
${errorMessage}
${errorStack ? `\n--- STACK TRACE ---\n${errorStack.slice(0, 500)}...` : ''}
            </div>
          </div>

          <div class="footer">
            Olive Pizza Lead DevOps Monitor • Strictly targeted to Lead Developer (<code>${DEVELOPER_EMAIL}</code>)
          </div>
        </div>
      </body>
      </html>
    `;

    // Asynchronous non-blocking dispatch
    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || '"Olive Pizza Alerts" <noreply@olivepizza.app>',
          to: DEVELOPER_EMAIL,
          subject,
          html: htmlContent,
        });
        console.log(`[DevAlertService] ✅ Developer alert dispatched to ${DEVELOPER_EMAIL}`);
      } catch (err: any) {
        console.error(`[DevAlertService] Failed to send developer alert:`, err.message);
      }
    });

    return true;
  }
}
