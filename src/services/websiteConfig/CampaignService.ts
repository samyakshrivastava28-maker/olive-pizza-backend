import { adminDb as db } from '../../config/firebase.js';
import { Campaign, Banner, Announcement } from '../../types/websiteConfig.types.js';

export class CampaignService {
  /**
   * List all campaigns
   */
  static async listCampaigns(): Promise<Campaign[]> {
    try {
      const snap = await db.collection('campaigns').get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Campaign));
    } catch (e) {
      return [];
    }
  }

  static async saveCampaign(campaign: Partial<Campaign>): Promise<Campaign> {
    const id = campaign.id || `camp_${Date.now()}`;
    const docRef = db.collection('campaigns').doc(id);
    const data = { ...campaign, id, isActive: campaign.isActive ?? false };
    await docRef.set(data);
    return data as Campaign;
  }

  static async toggleCampaign(campaignId: string, isActive: boolean): Promise<boolean> {
    await db.collection('campaigns').doc(campaignId).update({ isActive });
    return true;
  }

  /**
   * Banners
   */
  static async listBanners(): Promise<Banner[]> {
    try {
      const snap = await db.collection('banners').orderBy('priority', 'asc').get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Banner));
    } catch (e) {
      return [];
    }
  }

  static async saveBanner(banner: Partial<Banner>): Promise<Banner> {
    const id = banner.id || `banner_${Date.now()}`;
    const docRef = db.collection('banners').doc(id);
    const data = { ...banner, id, isActive: banner.isActive ?? true, priority: banner.priority || 1 };
    await docRef.set(data);
    return data as Banner;
  }

  static async deleteBanner(bannerId: string): Promise<boolean> {
    await db.collection('banners').doc(bannerId).delete();
    return true;
  }

  /**
   * Announcements
   */
  static async listAnnouncements(): Promise<Announcement[]> {
    try {
      const snap = await db.collection('announcements').get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as Announcement));
    } catch (e) {
      return [];
    }
  }

  static async saveAnnouncement(ann: Partial<Announcement>): Promise<Announcement> {
    const id = ann.id || `ann_${Date.now()}`;
    const docRef = db.collection('announcements').doc(id);
    const data = { ...ann, id, isActive: ann.isActive ?? true };
    await docRef.set(data);
    return data as Announcement;
  }

  static async deleteAnnouncement(annId: string): Promise<boolean> {
    await db.collection('announcements').doc(annId).delete();
    return true;
  }
}
