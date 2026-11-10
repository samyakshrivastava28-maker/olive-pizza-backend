import cron from 'node-cron';
import { adminDb } from '../config/firebase.js';
import { distributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';

export class DataExpiryJob {
  /**
   * Helper to parse and extract the effective expiration Date from any document
   */
  static extractExpiryDate(data: any): Date | null {
    if (!data) return null;
    const rawExpiry =
      data.endDate ||
      data.expiryDate ||
      data.validUntil ||
      data.validTo ||
      data.expiresAt ||
      data.expiresOn ||
      data.validTill ||
      data.expirationDate;

    if (!rawExpiry) return null;

    // Handle Firestore Timestamp object
    if (typeof rawExpiry === 'object' && typeof rawExpiry.toDate === 'function') {
      return rawExpiry.toDate();
    }
    if (typeof rawExpiry === 'object' && rawExpiry._seconds) {
      return new Date(rawExpiry._seconds * 1000);
    }
    if (typeof rawExpiry === 'object' && rawExpiry.seconds) {
      return new Date(rawExpiry.seconds * 1000);
    }

    if (typeof rawExpiry === 'string') {
      const trimmed = rawExpiry.trim();
      if (!trimmed) return null;

      // If it's a date without time (e.g., "2026-06-23"), set to end of that day (23:59:59.999 local)
      if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [year, month, day] = trimmed.split('-').map(Number);
        const d = new Date(year, month - 1, day, 23, 59, 59, 999);
        return isNaN(d.getTime()) ? null : d;
      }

      const parsed = new Date(trimmed);
      return isNaN(parsed.getTime()) ? null : parsed;
    }

    if (typeof rawExpiry === 'number') {
      const d = new Date(rawExpiry);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  }

  /**
   * Initializes the cron job to run every 5 minutes and runs once on boot
   */
  static schedule() {
    // Run immediately on boot in background
    setTimeout(() => {
      this.processExpirations().catch((e) => {
        console.warn('[DataExpiryJob] Initial boot scan warning:', e?.message || e);
      });
    }, 5000);

    // Schedule to run every 5 minutes (coordinated across cluster)
    cron.schedule('*/5 * * * *', async () => {
      await distributedJobCoordinator.runScheduledSingleton('data_expiry_5min', 240, async () => {
        try {
          await this.processExpirations();
        } catch (e: any) {
          if (e.message?.includes('RESOURCE_EXHAUSTED') || e.message?.includes('Quota exceeded')) {
            console.warn('[DataExpiryJob] Firestore quota limit reached. Will retry next cycle.');
          } else {
            console.error('[DataExpiryJob] Error running expiry job:', e.message);
          }
        }
      });
    });
    console.log('[DataExpiryJob] Auto-expiry engine scheduled (running every 5 mins, distributed).');
  }

  /**
   * Scans collections for expired documents and archives them
   */
  static async processExpirations() {
    const now = new Date();
    const collections = [
      'coupons',
      'ads',
      'offers',
      'combos',
      'products',
      'banners',
      'promotions',
      'stories',
      'flash_deals',
      'announcements'
    ];

    let totalExpired = 0;

    for (const collectionName of collections) {
      try {
        // Query active documents
        const snap = await adminDb
          .collection(collectionName)
          .where('isActive', '==', true)
          .get();

        if (snap.empty) continue;

        const batch = adminDb.batch();
        let batchCount = 0;

        snap.forEach((doc) => {
          const data = doc.data();
          const expiryDate = this.extractExpiryDate(data);

          if (expiryDate && expiryDate < now) {
            batch.update(doc.ref, {
              isActive: false,
              isArchived: true,
              autoExpiredAt: now.toISOString(),
              expiryReason: `Expired on ${expiryDate.toISOString()}`
            });
            batchCount++;
            totalExpired++;
            console.log(`[DataExpiryJob] ⏰ Expired ${collectionName}/${doc.id} (Expiry was: ${expiryDate.toISOString()})`);
          }
        });

        if (batchCount > 0) {
          await batch.commit();
          console.log(`[DataExpiryJob] ✅ Committed ${batchCount} auto-expirations in "${collectionName}".`);
        }
      } catch (err: any) {
        if (err?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[DataExpiryJob] Firestore read quota hit on collection ${collectionName}.`);
          break;
        }
        // Collection might not exist in database yet; continue silently
      }
    }

    if (totalExpired > 0) {
      console.log(`[DataExpiryJob] 🏁 Total ${totalExpired} expired documents auto-archived.`);
      try {
        await adminDb.collection('system_events').add({
          type: 'cache_invalidate',
          targets: ['menu', 'coupons', 'ads', 'offers', 'ai_knowledge'],
          timestamp: now.toISOString(),
          expiredCount: totalExpired
        });
      } catch {}
    }
  }
}
