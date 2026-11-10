import { adminDb } from '../config/firebase.js';

export class HeartbeatService {
  /**
   * Records a heartbeat for a user device
   */
  public async recordHeartbeat(userId: string, data: {
    deviceName?: string;
    browser?: string;
    platform?: string;
    appVersion?: string;
    notificationReady?: boolean;
    batteryLevel?: number;
    connectionQuality?: string;
  }) {
    try {
      const deviceName = data.deviceName || 'Unknown Device';
      // Use userId + deviceName (sanitized) as the document ID for deduplication
      const safeDeviceName = deviceName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const docId = `${userId}_${safeDeviceName}`;
      
      const docRef = adminDb.collection('device_heartbeats').doc(docId);
      
      await docRef.set({
        user_id: userId,
        device_name: deviceName,
        browser: data.browser || null,
        platform: data.platform || null,
        app_version: data.appVersion || null,
        is_online: true,
        last_seen: new Date().toISOString(),
        notification_ready: data.notificationReady !== false,
        battery_level: data.batteryLevel || null,
        connection_quality: data.connectionQuality || null,
        updated_at: new Date().toISOString()
      }, { merge: true });
      
    } catch (error) {
      console.error('[HeartbeatService] Error recording heartbeat:', error);
    }
  }

  /**
   * Retrieves active devices for a user
   */
  public async getActiveDevices(userId: string) {
    try {
      const snapshot = await adminDb.collection('device_heartbeats')
        .where('user_id', '==', userId)
        .orderBy('last_seen', 'desc')
        .get();
        
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('[HeartbeatService] Error fetching devices:', error);
      return [];
    }
  }
}

export const heartbeatService = new HeartbeatService();
