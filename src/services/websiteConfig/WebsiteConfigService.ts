import { adminDb as db } from '../../config/firebase.js';
import { CloudflareR2Service } from '../storage/CloudflareR2Service.js';
import { KnowledgeGeneratorService } from '../knowledge/KnowledgeGeneratorService.js';
import {
  HomepageConfig,
  ThemeConfig,
  NavigationConfig,
  FeatureFlags,
  Announcement,
  Campaign,
  Banner,
  RolePermissions,
  Section
} from '../../types/websiteConfig.types.js';

export type {
  HomepageConfig,
  ThemeConfig,
  NavigationConfig,
  FeatureFlags,
  Announcement,
  Campaign,
  Banner,
  RolePermissions,
  Section
};

export const DEFAULT_HOMEPAGE_CONFIG: HomepageConfig = {
  publishedAt: new Date().toISOString(),
  publishedBy: 'system',
  version: 1,
  sections: [
    {
      id: 'default_hero',
      type: 'hero',
      isVisible: true,
      order: 0,
      label: 'Hero Section',
      config: {
        headline: 'Fresh Pizzas, Delivered Hot 🍕',
        subheadline: "Order from Olive Pizza — Rajnandgaon's favorite pizza restaurant",
        backgroundType: 'gradient',
        backgroundValue: 'linear-gradient(135deg, #0B0F14 0%, #1a0a00 100%)',
        ctaText: 'Order Now',
        ctaLink: '/menu',
        ctaStyle: 'primary',
        animationType: 'fadeUp',
        height: 'large',
        particles: true,
      },
      isLocked: true, // Protected default hero
    },
    {
      id: 'cravings',
      type: 'cravings',
      isVisible: true,
      order: 1,
      label: "What's Your Craving For?",
      config: {
        title: "WHAT'S YOUR CRAVING FOR?",
        subtitle: 'Explore our freshly handcrafted artisan creations & chef specials.',
        displayStyle: 'horizontal-scroll',
        showImages: true,
        showCount: true,
      },
    },
    {
      id: 'ads',
      type: 'ads',
      isVisible: true,
      order: 2,
      label: 'Advertisements & Announcements',
      config: {
        title: 'Featured Promotions & News',
        autoplay: true,
        autoplayInterval: 7000,
        showDots: true,
      },
    },
    {
      id: 'default_coupons',
      type: 'coupons',
      isVisible: true,
      order: 3,
      label: 'Live Coupons',
      config: {
        title: 'Special Deals & Offers',
        displayStyle: 'cards',
        showExpiry: true,
        showCode: true,
        maxVisible: 4,
      },
    },
    {
      id: 'default_recommendations',
      type: 'featured',
      isVisible: true,
      order: 4,
      label: 'Chef Recommendations',
      config: {
        title: 'Chef Recommendations',
        subtitle: 'Handpicked favorites by our master pizzaiolo',
        maxItems: 6,
      },
    },
    {
      id: 'default_download_app',
      type: 'download_app',
      isVisible: true,
      order: 5,
      label: 'Download App',
      config: {
        headline: 'Get the Olive Pizza App',
        subheadline: 'Faster ordering, live 3D tracking & exclusive discounts on Android.',
        playStoreLink: 'https://play.google.com',
      },
    },
  ],
};

export const DEFAULT_THEME_CONFIG: ThemeConfig = {
  publishedAt: new Date().toISOString(),
  version: 1,
  colors: {
    primary: '#f97316',
    accent: '#fb923c',
    background: '#0B0F14',
    surface: '#111827',
    text: '#f9fafb',
    textMuted: '#9ca3af',
    border: 'rgba(255,255,255,0.1)',
    success: '#22c55e',
    error: '#ef4444',
  },
  fonts: {
    heading: 'Inter',
    body: 'Inter',
    mono: 'JetBrains Mono',
  },
  borderRadius: {
    sm: '6px',
    md: '12px',
    lg: '20px',
    xl: '32px',
    full: '9999px',
  },
  effects: {
    glassmorphism: true,
    neumorphism: false,
    animations: 'smooth',
    animationSpeed: 1.0,
    blur: '12px',
    shadowIntensity: 'md',
  },
  mode: 'dark',
  spacing: 'comfortable',
  cardStyle: 'glass',
};

export const DEFAULT_NAVIGATION_CONFIG: NavigationConfig = {
  publishedAt: new Date().toISOString(),
  version: 1,
  header: {
    logoPosition: 'left',
    links: [
      { id: '1', label: 'Home', path: '/', visibility: 'all' },
      { id: '2', label: 'Menu', path: '/menu', visibility: 'all' },
      { id: '3', label: 'Contact', path: '/contact', visibility: 'all' },
    ],
    ctaButton: { label: 'Order Now', link: '/menu', style: 'primary', isVisible: true },
    style: 'glass',
    height: 'md',
    isSticky: true,
    showSearch: true,
  },
  bottomNav: {
    items: [
      { id: '1', label: 'Home', path: '/', icon: 'Home', visibility: 'all' },
      { id: '2', label: 'Menu', path: '/menu', icon: 'Menu', visibility: 'all' },
      { id: '3', label: 'Orders', path: '/dashboard', icon: 'ReceiptText', visibility: 'authenticated' },
      { id: '4', label: 'Profile', path: '/dashboard', icon: 'User', visibility: 'all' },
    ],
    showBadges: true,
  },
  footer: {
    columns: [
      {
        heading: 'Quick Links',
        links: [
          { label: 'Menu', url: '/menu' },
          { label: 'Order Tracking', url: '/dashboard' },
          { label: 'Contact Us', url: '/contact' },
        ],
      },
      {
        heading: 'Legal',
        links: [
          { label: 'Privacy Policy', url: '/privacy-policy' },
          { label: 'Terms of Service', url: '/terms' },
          { label: 'Delivery Policy', url: '/delivery-policy' },
        ],
      },
    ],
    socialLinks: [],
    copyrightText: `© ${new Date().getFullYear()} Olive Pizza. All rights reserved.`,
    locationText: 'Dongargaon Rd, near Saraswati School, Gokul Nagar, Rajnandgaon, Chhattisgarh 491441',
    showDeveloperCredit: true,
    developerCreditUrl: 'https://28webhub.netlify.app',
  },
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  coupons: { enabled: true, description: 'Show coupon section and apply coupons', rolloutPercent: 100 },
  wallet: { enabled: true, description: 'Customer wallet and credits', rolloutPercent: 100 },
  aiAssistant: { enabled: true, description: 'AI chat assistant bubble', rolloutPercent: 100 },
  voiceAssistant: { enabled: true, description: 'Voice input for AI', rolloutPercent: 100 },
  recommendations: { enabled: true, description: 'Personalized product recommendations', rolloutPercent: 100 },
  referral: { enabled: false, description: 'Referral program and codes', rolloutPercent: 0 },
  reviews: { enabled: true, description: 'Customer reviews and ratings', rolloutPercent: 100 },
  tracking: { enabled: true, description: 'Live order tracking map', rolloutPercent: 100 },
  notifications: { enabled: true, description: 'Push notification prompts', rolloutPercent: 100 },
  socialLogin: { enabled: true, description: 'Google OAuth login', rolloutPercent: 100 },
  guestCheckout: { enabled: false, description: 'Allow checkout without account', rolloutPercent: 0 },
  darkMode: { enabled: true, description: 'Dark/light mode toggle for customers', rolloutPercent: 100 },
  offlineMode: { enabled: true, description: 'Offline cart and menu caching', rolloutPercent: 100 },
  abTesting: { enabled: true, description: 'A/B test framework', rolloutPercent: 100 },
  betaFeatures: { enabled: false, description: 'Unreleased beta UI features', rolloutPercent: 0 },
  maintenanceMode: { enabled: false, description: 'Show maintenance page to customers', rolloutPercent: 0 },
};

export class WebsiteConfigService {
  /**
   * Get current published homepage config
   */
  static async getHomepage(): Promise<HomepageConfig> {
    try {
      const docSnap = await db.collection('website_config').doc('homepage').get();
      if (docSnap.exists) {
        return docSnap.data() as HomepageConfig;
      }
      // Auto-seed default config if missing
      await db.collection('website_config').doc('homepage').set(DEFAULT_HOMEPAGE_CONFIG);
      return DEFAULT_HOMEPAGE_CONFIG;
    } catch (e) {
      console.error('[WebsiteConfigService] getHomepage error:', e);
      return DEFAULT_HOMEPAGE_CONFIG;
    }
  }

  /**
   * Get draft homepage config
   */
  static async getHomepageDraft(): Promise<HomepageConfig> {
    try {
      const docSnap = await db.collection('website_config').doc('homepage_draft').get();
      if (docSnap.exists) {
        return docSnap.data() as HomepageConfig;
      }
      const published = await this.getHomepage();
      return published;
    } catch (e) {
      console.error('[WebsiteConfigService] getHomepageDraft error:', e);
      return await this.getHomepage();
    }
  }

  /**
   * Save draft homepage config
   */
  static async saveHomepageDraft(config: Partial<HomepageConfig>, userId: string, isDeveloper = false): Promise<boolean> {
    try {
      const currentDraft = await this.getHomepageDraft();

      // Enforce Section Lock Protection: Prevent non-developers from modifying or deleting locked sections
      if (!isDeveloper && config.sections) {
        const lockedSectionMap = new Map<string, Section>();
        currentDraft.sections.forEach((s: any) => {
          if (s.isLocked) lockedSectionMap.set(s.id, s);
        });

        // Ensure all locked sections remain present and untouched unless developer
        lockedSectionMap.forEach((lockedSec, id) => {
          const incoming = config.sections?.find((s: any) => s.id === id);
          if (!incoming) {
            throw new Error(`Section "${lockedSec.label}" is locked by platform developer and cannot be deleted.`);
          }
        });
      }

      const updatedDraft: HomepageConfig = {
        ...currentDraft,
        ...config,
        publishedBy: userId,
        version: currentDraft.version || 1,
      };

      await db.collection('website_config').doc('homepage_draft').set(updatedDraft);
      return true;
    } catch (e) {
      console.error('[WebsiteConfigService] saveHomepageDraft error:', e);
      throw e;
    }
  }

  /**
   * Publish Draft to Live
   */
  static async publishHomepage(userId: string, userEmail?: string, changelog?: string, isDeveloper = false): Promise<HomepageConfig> {
    try {
      const draft = await this.getHomepageDraft();
      const currentLive = await this.getHomepage();

      const newVersionNumber = (currentLive.version || 0) + 1;
      const publishedAt = new Date().toISOString();

      const newPublishedConfig: HomepageConfig = {
        ...draft,
        publishedAt,
        publishedBy: userId,
        version: newVersionNumber,
        changelog: changelog || (isDeveloper ? 'Developer Force Published' : 'Owner Published Updates'),
      };

      // 1. Write to published homepage
      await db.collection('website_config').doc('homepage').set(newPublishedConfig);

      // 2. Snapshot to website_versions
      const versionId = `v_${newVersionNumber}_${Date.now()}`;
      await db.collection('website_versions').doc(versionId).set({
        versionId,
        version: newVersionNumber,
        type: 'homepage',
        publishedAt,
        publishedBy: { uid: userId, email: userEmail, role: isDeveloper ? 'developer' : 'owner' },
        changelog: newPublishedConfig.changelog,
        snapshot: { homepage: newPublishedConfig },
      });

      // 3. Upload SDUI JSON Backup to Cloudflare R2
      try {
        await CloudflareR2Service.uploadJson(`sdui_backups/sdui_v${newVersionNumber}_${Date.now()}.json`, newPublishedConfig);
      } catch (r2Err: any) {
        console.warn('[WebsiteConfigService] R2 SDUI backup notice:', r2Err.message);
      }

      // 4. Trigger Knowledge Sync for Website Pages & Layout
      KnowledgeGeneratorService.onDataChanged(['website_pages.json', 'theme.json', 'navigation.json']).catch(err => {
        console.warn('[WebsiteConfigService] Knowledge sync notice:', err.message);
      });

      return newPublishedConfig;
    } catch (e) {
      console.error('[WebsiteConfigService] publishHomepage error:', e);
      throw e;
    }
  }

  /**
   * Theme Management
   */
  static async getTheme(): Promise<ThemeConfig> {
    try {
      const docSnap = await db.collection('website_config').doc('theme').get();
      if (docSnap.exists) {
        return docSnap.data() as ThemeConfig;
      }
      await db.collection('website_config').doc('theme').set(DEFAULT_THEME_CONFIG);
      return DEFAULT_THEME_CONFIG;
    } catch (e) {
      return DEFAULT_THEME_CONFIG;
    }
  }

  static async saveTheme(theme: Partial<ThemeConfig>, userId: string): Promise<ThemeConfig> {
    const current = await this.getTheme();
    const updated: ThemeConfig = {
      ...current,
      ...theme,
      version: (current.version || 0) + 1,
      publishedAt: new Date().toISOString(),
    };
    await db.collection('website_config').doc('theme').set(updated);
    return updated;
  }

  /**
   * Navigation Management
   */
  static async getNavigation(): Promise<NavigationConfig> {
    try {
      const docSnap = await db.collection('website_config').doc('navigation').get();
      if (docSnap.exists) {
        return docSnap.data() as NavigationConfig;
      }
      await db.collection('website_config').doc('navigation').set(DEFAULT_NAVIGATION_CONFIG);
      return DEFAULT_NAVIGATION_CONFIG;
    } catch (e) {
      return DEFAULT_NAVIGATION_CONFIG;
    }
  }

  static async saveNavigation(nav: Partial<NavigationConfig>): Promise<NavigationConfig> {
    const current = await this.getNavigation();
    const updated: NavigationConfig = {
      ...current,
      ...nav,
      version: (current.version || 0) + 1,
      publishedAt: new Date().toISOString(),
    };
    await db.collection('website_config').doc('navigation').set(updated);
    return updated;
  }

  /**
   * Feature Flags Management
   */
  static async getFeatureFlags(): Promise<FeatureFlags> {
    try {
      const docSnap = await db.collection('website_config').doc('feature_flags').get();
      if (docSnap.exists) {
        return docSnap.data() as FeatureFlags;
      }
      await db.collection('website_config').doc('feature_flags').set(DEFAULT_FEATURE_FLAGS);
      return DEFAULT_FEATURE_FLAGS;
    } catch (e) {
      return DEFAULT_FEATURE_FLAGS;
    }
  }

  static async updateFeatureFlags(flags: Partial<FeatureFlags>): Promise<FeatureFlags> {
    const current = await this.getFeatureFlags();
    const updated = { ...current, ...flags };
    await db.collection('website_config').doc('feature_flags').set(updated);
    return updated;
  }

  /**
   * Section Template Library
   */
  static async getSectionTemplates(): Promise<any[]> {
    try {
      const snap = await db.collection('sections_library').get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (e) {
      return [];
    }
  }

  static async saveSectionTemplate(section: any, userId: string): Promise<any> {
    const docRef = db.collection('sections_library').doc(section.id || `tpl_${Date.now()}`);
    const data = { ...section, createdAt: new Date().toISOString(), createdBy: userId };
    await docRef.set(data);
    return data;
  }

  static async deleteSectionTemplate(id: string): Promise<boolean> {
    await db.collection('sections_library').doc(id).delete();
    return true;
  }

  /**
   * Developer Raw JSON Operations
   */
  static async updateRawConfig(collectionDoc: string, rawJson: any, userId: string): Promise<boolean> {
    await db.collection('website_config').doc(collectionDoc).set({
      ...rawJson,
      lastModifiedBy: userId,
      lastModifiedAt: new Date().toISOString(),
    });
    return true;
  }
}
