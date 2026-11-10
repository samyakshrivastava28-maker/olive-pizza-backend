import { adminDb } from '../../config/firebase.js';

export interface AIHealthMetrics {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  totalLatency: number; // in milliseconds
  failoversTriggered: number;
  providerUsage: {
    nvidia: number;
    openrouter: number;
    gemini: number;
  };
}

class AIHealthMonitor {
  private metrics: AIHealthMetrics = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    totalLatency: 0,
    failoversTriggered: 0,
    providerUsage: {
      nvidia: 0,
      openrouter: 0,
      gemini: 0
    }
  };

  // Sync to Firestore every 60 seconds to avoid too many writes
  private syncInterval: NodeJS.Timeout | null = null;
  private pendingSync = false;

  constructor() {
    this.startSyncTimer();
  }

  public recordRequest(provider: 'nvidia' | 'openrouter' | 'gemini', latencyMs: number, success: boolean, failovers: number) {
    this.metrics.totalRequests++;
    if (success) {
      this.metrics.successCount++;
    } else {
      this.metrics.failureCount++;
    }
    
    this.metrics.totalLatency += latencyMs;
    this.metrics.failoversTriggered += failovers;
    this.metrics.providerUsage[provider]++;
    
    this.pendingSync = true;
  }

  private startSyncTimer() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = setInterval(async () => {
      if (this.pendingSync) {
        await this.syncToFirestore();
      }
    }, 60000); // 60 seconds
  }

  private async syncToFirestore() {
    try {
      this.pendingSync = false;
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const docRef = adminDb.collection('ai_analytics').doc(today);
      
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        await docRef.set({ ...this.metrics, date: today, updatedAt: new Date().toISOString() });
      } else {
        const existing = docSnap.data() as AIHealthMetrics;
        await docRef.update({
          totalRequests: existing.totalRequests + this.metrics.totalRequests,
          successCount: existing.successCount + this.metrics.successCount,
          failureCount: existing.failureCount + this.metrics.failureCount,
          totalLatency: existing.totalLatency + this.metrics.totalLatency,
          failoversTriggered: existing.failoversTriggered + this.metrics.failoversTriggered,
          'providerUsage.nvidia': existing.providerUsage.nvidia + this.metrics.providerUsage.nvidia,
          'providerUsage.openrouter': existing.providerUsage.openrouter + this.metrics.providerUsage.openrouter,
          'providerUsage.gemini': existing.providerUsage.gemini + this.metrics.providerUsage.gemini,
          updatedAt: new Date().toISOString()
        });
      }

      // Reset local metrics after sync
      this.metrics = {
        totalRequests: 0,
        successCount: 0,
        failureCount: 0,
        totalLatency: 0,
        failoversTriggered: 0,
        providerUsage: { nvidia: 0, openrouter: 0, gemini: 0 }
      };

    } catch (error) {
      console.error('Failed to sync AI health metrics to Firestore:', error);
      this.pendingSync = true; // Retry next cycle
    }
  }
}

export const aiHealthMonitor = new AIHealthMonitor();
