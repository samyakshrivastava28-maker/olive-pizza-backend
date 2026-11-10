import { pgPool } from '../../config/postgres.js';
import { adminDb as db } from '../../config/firebase.js';
import { notificationEngine } from '../notification/NotificationEngine.js';
import { queueEmail } from '../email.service.js';
import { MediaOptimizationService } from '../storage/MediaOptimizationService.js';

export class BackgroundTaskWorker {
  private isRunning = false;
  private interval: NodeJS.Timeout | null = null;

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.interval = setInterval(() => this.processNextBatch(), 5000);
    console.log('[BackgroundWorker] Started processing tasks...');
  }

  public stop() {
    this.isRunning = false;
    if (this.interval) clearInterval(this.interval);
    console.log('[BackgroundWorker] Stopped.');
  }

  public async scheduleTask(orderId: string | null, taskType: 'push' | 'email' | 'media_optimize', payload: any) {
    const client = await pgPool.connect();
    try {
      await client.query(
        `INSERT INTO background_tasks (order_id, task_type, payload) VALUES ($1, $2, $3)`,
        [orderId || 'system', taskType, JSON.stringify(payload)]
      );
    } catch (e) {
      console.error('[BackgroundWorker] Failed to schedule task:', e);
    } finally {
      client.release();
    }
  }

  private async processNextBatch() {
    if (!this.isRunning) return;

    const client = await pgPool.connect();
    try {
      // Pick 10 pending tasks, lock them so other worker instances don't grab them
      const result = await client.query(
        `UPDATE background_tasks 
         SET status = 'processing', started_at = NOW() 
         WHERE id IN (
           SELECT id FROM background_tasks 
           WHERE status IN ('pending', 'failed') AND retry_count < 3
           ORDER BY created_at ASC 
           LIMIT 10 
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`
      );

      const tasks = result.rows;
      if (tasks.length === 0) return;

      for (const task of tasks) {
        const startTime = Date.now();
        let success = false;
        let errorMessage = null;

        try {
          if (task.task_type === 'push') {
            await this.processPushTask(task.payload);
            success = true;
          } else if (task.task_type === 'email') {
            await this.processEmailTask(task.payload);
            success = true;
          } else if (task.task_type === 'media_optimize') {
            const res = await MediaOptimizationService.processOptimizationJob(task.payload);
            success = res.success;
          } else {
            throw new Error(`Unknown task type: ${task.task_type}`);
          }
        } catch (e: any) {
          success = false;
          errorMessage = e.message;
        }

        const duration = Date.now() - startTime;
        const newStatus = success ? 'completed' : 'failed';
        
        await client.query(
          `UPDATE background_tasks 
           SET status = $1, finished_at = NOW(), duration_ms = $2, 
               last_error = $3, retry_count = retry_count + $4
           WHERE id = $5`,
          [newStatus, duration, errorMessage, success ? 0 : 1, task.id]
        );
      }
    } catch (e) {
      console.error('[BackgroundWorker] Batch error:', e);
    } finally {
      client.release();
    }
  }

  private async processPushTask(payload: any) {
    const { targetUid, targetUids, pushPayload, priority, options } = payload;
    if (targetUid) {
      await notificationEngine.sendBulk([targetUid], pushPayload, { ...options, priority });
    } else if (targetUids && targetUids.length > 0) {
      await notificationEngine.sendBulk(targetUids, pushPayload, { ...options, priority });
    }
  }

  private async processEmailTask(payload: any) {
    const { to, subject, html, category } = payload;
    await queueEmail(to, subject, html, category);
  }
}

export const backgroundTaskWorker = new BackgroundTaskWorker();
