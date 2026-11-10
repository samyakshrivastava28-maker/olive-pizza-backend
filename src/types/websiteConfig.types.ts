export type SectionType =
  | 'categories'
  | 'coupons'
  | 'ads'
  | 'hero'
  | 'gallery'
  | 'testimonials'
  | 'video'
  | 'faq'
  | 'best_sellers'
  | 'trending'
  | 'recommendations'
  | 'download_app'
  | 'timeline'
  | 'stats'
  | 'blogs'
  | 'contact'
  | 'maps'
  | 'instagram'
  | 'custom_html'
  | 'custom_react'
  | 'blank';

export interface Section {
  id: string;
  type: string;
  label: string;
  subtitle?: string;
  isVisible: boolean;
  order: number;
  config: Record<string, any>;
  isLocked?: boolean;
  isProtected?: boolean;
}

export interface HomepageConfig {
  publishedAt?: string | null;
  publishedBy?: string | null;
  version: number;
  sections: Section[];
  changelog?: string;
}

export interface ThemeConfig {
  publishedAt?: string | null;
  version: number;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  borderRadius: Record<string, string>;
  effects: Record<string, any>;
  mode: string;
  spacing?: string;
  cardStyle?: string;
}

export interface NavigationConfig {
  publishedAt?: string | null;
  version: number;
  header: any;
  bottomNav: any;
  footer?: any;
}

export interface FeatureFlags {
  [key: string]: any;
}

export interface Announcement {
  id: string;
  isActive: boolean;
  type: string;
  text: string;
  emoji?: string;
  link?: string | null;
  linkText?: string | null;
  backgroundColor?: string;
  textColor?: string;
  closeable?: boolean;
  priority?: number;
}

export interface Campaign {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  theme?: any;
  announcement?: any;
}

export interface Banner {
  id: string;
  title: string;
  imageUrl: string;
  link?: string;
  isActive: boolean;
  priority?: number;
  [key: string]: any;
}

export interface RolePermissions {
  [role: string]: string[];
}

export interface ABTest {
  id: string;
  name: string;
  status: string;
  traffic?: any;
  startAt?: any;
  variants?: any;
  [key: string]: any;
}

export interface WebsiteAnalyticsEvent {
  id: string;
  eventType: string;
  sectionId?: string;
  sectionType?: string;
  sessionId?: string;
  userId?: string;
  metadata?: any;
  createdAt?: string;
  timestamp: string;
  [key: string]: any;
}

export interface WebsiteVersion {
  versionId: string;
  version: number;
  type: string;
  publishedAt: string;
  publishedBy: any;
  changelog?: string;
  snapshot: any;
}
