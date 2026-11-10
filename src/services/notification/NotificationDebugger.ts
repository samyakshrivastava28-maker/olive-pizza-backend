import { adminDb as db } from '../../config/firebase.js';

export type NotificationStage = 
  | 'Created'
  | 'Queued'
  | 'FCM Tokens Found'
  | 'Payload Generated'
  | 'Sent to Firebase'
  | 'Firebase Response'
  | 'Delivered'
  | 'Opened'
  | 'Clicked'
  | 'Action Completed'
  | 'Failed';

export interface NotificationLog {
  id?: string; // Will be generated if not provided
  userId: string;
  type: string; // 'push', 'in-app'
  category: string; // e.g., 'promotion', 'order_update', 'custom'
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'failed';
  stage: NotificationStage;
  error?: string;
  tokensFound: number;
  timestamp: string;
  updatedAt: string;
  queueId?: string; // Identifier for the queue entry
}

export class NotificationDebugger {
  /**
   * Initializes a new notification tracking session.
   * Returns the generated Notification ID.
   */
  public async logCreation(data: Omit<NotificationLog, 'id' | 'status' | 'stage' | 'timestamp' | 'updatedAt'>, customId?: string): Promise<string> {
    const docRef = customId ? db.collection('notification_history').doc(customId) : db.collection('notification_history').doc();
    const log: NotificationLog = {
      ...data,
      id: docRef.id,
      status: 'pending',
      stage: 'Created',
      timestamp: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await docRef.set(log);
    console.log(`[NotificationDebugger] [${log.id}] Stage: Created | User: ${log.userId} | Category: ${log.category}`);
    return docRef.id;
  }

  /**
   * Updates an existing notification's stage.
   */
  public async updateStage(id: string, stage: NotificationStage, updates: Partial<NotificationLog> = {}): Promise<void> {
    const docRef = db.collection('notification_history').doc(id);
    const finalUpdates: Partial<NotificationLog> = {
      ...updates,
      stage,
      updatedAt: new Date().toISOString(),
    };

    // Auto-map status based on stage
    if (stage === 'Failed') finalUpdates.status = 'failed';
    else if (stage === 'Firebase Response' && !updates.status) finalUpdates.status = 'sent';
    else if (stage === 'Delivered') finalUpdates.status = 'delivered';
    else if (stage === 'Opened') finalUpdates.status = 'opened';
    else if (stage === 'Clicked') finalUpdates.status = 'clicked';

    try {
      await docRef.update(finalUpdates);
      console.log(`[NotificationDebugger] [${id}] Stage Updated: ${stage}`);
    } catch (err) {
      console.error(`[NotificationDebugger] Failed to update stage for ${id}:`, err);
    }
  }

  /**
   * Complete shortcut for failing a notification
   */
  public async markFailed(id: string, errorMsg: string): Promise<void> {
    await this.updateStage(id, 'Failed', { error: errorMsg, status: 'failed' });
  }
}

export const notificationDebugger = new NotificationDebugger();
