import cron from 'node-cron';
import crypto from 'crypto';

const AI_BACKEND_URL = process.env.AI_BACKEND_URL || 'https://olive-pizza-ai.onrender.com';
const TRACKING_TOKEN_SECRET = process.env.TRACKING_TOKEN_SECRET || process.env.JWT_SECRET || '';

export class AIHeartbeatJob {
  private static retryCount = 0;
  private static backoffDelays = [30000, 60000, 120000, 300000]; // 30s, 1m, 2m, 5m

  public static schedule() {
    console.log('⏰ Scheduling AI Keep-Alive Heartbeat Job (every 10 minutes)');
    
    // Run every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      await AIHeartbeatJob.sendHeartbeat();
    });
  }

  private static async sendHeartbeat() {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const payload = `${timestamp}:${nonce}`;
    
    const signature = crypto
      .createHmac('sha256', TRACKING_TOKEN_SECRET)
      .update(payload)
      .digest('hex');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${AI_BACKEND_URL}/api/internal/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp, nonce, signature }),
        signal: controller.signal as any
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`AI Backend returned ${response.status}`);
      }

      console.log(`💓 [AI Heartbeat] Successfully pinged AI backend.`);
      AIHeartbeatJob.retryCount = 0; // Reset on success

    } catch (error: any) {
      console.warn(`⚠️ [AI Heartbeat] Ping failed: ${error.message}`);
      AIHeartbeatJob.handleFailure();
    }
  }

  private static handleFailure() {
    if (AIHeartbeatJob.retryCount < AIHeartbeatJob.backoffDelays.length) {
      const delay = AIHeartbeatJob.backoffDelays[AIHeartbeatJob.retryCount];
      console.log(`⏳ [AI Heartbeat] Retrying in ${delay / 1000} seconds (Attempt ${AIHeartbeatJob.retryCount + 1})...`);
      
      setTimeout(async () => {
        AIHeartbeatJob.retryCount++;
        await AIHeartbeatJob.sendHeartbeat();
      }, delay);
    } else {
      console.error(`🚨 [AI Heartbeat] CRITICAL: AI Backend is unreachable after all retries!`);
      // Here we could trigger Task 9 Error Notifications (Email/Dashboard)
      AIHeartbeatJob.retryCount = 0; // Reset for the next 10-minute cron window
    }
  }
}
