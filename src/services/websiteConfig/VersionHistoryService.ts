import { adminDb as db } from '../../config/firebase.js';
import { WebsiteVersion, HomepageConfig } from '../../types/websiteConfig.types.js';

export class VersionHistoryService {
  /**
   * List all saved snapshots (keeps last 50)
   */
  static async listVersions(limitCount = 50): Promise<WebsiteVersion[]> {
    try {
      const snap = await db
        .collection('website_versions')
        .orderBy('publishedAt', 'desc')
        .limit(limitCount)
        .get();

      return snap.docs.map((d: any) => d.data() as WebsiteVersion);
    } catch (e) {
      console.error('[VersionHistoryService] listVersions error:', e);
      return [];
    }
  }

  /**
   * Get specific version snapshot
   */
  static async getVersion(versionId: string): Promise<WebsiteVersion | null> {
    try {
      const doc = await db.collection('website_versions').doc(versionId).get();
      if (!doc.exists) return null;
      return doc.data() as WebsiteVersion;
    } catch (e) {
      console.error('[VersionHistoryService] getVersion error:', e);
      return null;
    }
  }

  /**
   * Rollback homepage to a past version snapshot
   */
  static async rollbackHomepage(versionId: string, userId: string, isDeveloper = false): Promise<HomepageConfig> {
    const target = await this.getVersion(versionId);
    if (!target) throw new Error(`Snapshot ${versionId} not found`);

    const targetHomepage = target.snapshot.homepage;
    if (!targetHomepage) throw new Error(`Snapshot ${versionId} does not contain homepage config`);

    const currentDoc = await db.collection('website_config').doc('homepage').get();
    const currentData = currentDoc.exists ? (currentDoc.data() as HomepageConfig) : null;

    // Preserve locked sections if rolled back by non-developer
    let finalSections = targetHomepage.sections || [];
    if (!isDeveloper && currentData?.sections) {
      const lockedSections = currentData.sections.filter((s: any) => s.isLocked);
      finalSections = finalSections.map((s: any) => {
        const matchingLocked = lockedSections.find((ls: any) => ls.id === s.id);
        return matchingLocked ? matchingLocked : s;
      });
    }

    const restoredConfig: HomepageConfig = {
      ...targetHomepage,
      sections: finalSections,
      version: (currentData?.version ?? 0) + 1,
      publishedAt: new Date().toISOString(),
      publishedBy: userId,
      changelog: `Rollback to v${target.version} (${target.changelog || 'Previous version'})`,
    };

    // Save active configuration
    await db.collection('website_config').doc('homepage').set(restoredConfig);

    // Save snapshot of rollback action
    const newVersionId = `v_${Date.now()}`;
    const newVersion: WebsiteVersion = {
      versionId: newVersionId,
      version: restoredConfig.version,
      type: 'homepage',
      publishedAt: restoredConfig.publishedAt || new Date().toISOString(),
      publishedBy: { uid: userId },
      changelog: restoredConfig.changelog || 'Rollback',
      snapshot: {
        homepage: restoredConfig,
      },
    };
    await db.collection('website_versions').doc(newVersionId).set(newVersion);

    return restoredConfig;
  }
}
