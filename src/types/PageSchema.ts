export type PageType = 'BUILT_IN' | 'CUSTOM_SCHEMA' | 'CUSTOM_STATIC_PACKAGE';

export type CuratedFontFamily = 
  | 'Inter'
  | 'Outfit'
  | 'Poppins'
  | 'Manrope'
  | 'Plus Jakarta Sans'
  | 'DM Sans'
  | 'Playfair Display'
  | 'Space Grotesk';

export type TextAnimationType =
  | 'None'
  | 'Fade'
  | 'Word Reveal'
  | 'Character Reveal'
  | 'Typewriter'
  | 'Slide'
  | 'Mask Reveal'
  | 'Letter Spacing'
  | 'Soft Scale';

export type AnimationTrigger = 'on_load' | 'when_visible' | 'on_scroll' | 'on_enter';
export type AnimationEasing = 'ease_out' | 'ease_in_out' | 'spring' | 'linear';

export interface ResponsiveValue<T> {
  desktop: T;
  tablet: T;
  mobile: T;
}

export interface TypographyConfig {
  fontFamily: CuratedFontFamily;
  headingSize?: ResponsiveValue<number>;
  subtitleSize?: ResponsiveValue<number>;
  bodySize?: ResponsiveValue<number>;
  buttonSize?: ResponsiveValue<number>;
  textAnimation?: TextAnimationType;
}

export type ThemePreset = 'Clean' | 'Pizza Energy' | 'Midnight Glow' | 'Minimal' | 'Bold Festival';

export interface BasePageSchema {
  versionId: string; // e.g., v1
  pageId: string; // Used to identify the template collection it belongs to
  type: PageType;
  metadata: {
    name: string;
    description: string;
    publishedBy: string; // uid
    publishedAt: string; // ISO string
    hash?: string;
    themePreset?: ThemePreset;
    typography?: TypographyConfig;
  };
  globalSettings?: {
    themePreset?: ThemePreset;
    typography?: TypographyConfig;
    primaryColor?: string;
    backgroundColor?: string;
    borderRadius?: number;
    reducedMotion?: boolean;
  };
}

export interface BuiltInPageSchema extends BasePageSchema {
  type: 'BUILT_IN';
  templateId: string;
  sections: SimplifiedSectionSchema[];
}

export interface CustomSchemaPageSchema extends BasePageSchema {
  type: 'CUSTOM_SCHEMA';
  sections: SimplifiedSectionSchema[];
}

export interface CustomStaticPackageSchema extends BasePageSchema {
  type: 'CUSTOM_STATIC_PACKAGE';
  r2Url: string;
  entryFile: string;
}

export type PageSchema = BuiltInPageSchema | CustomSchemaPageSchema | CustomStaticPackageSchema;

export type SectionType = 
  | 'HERO' 
  | 'CATEGORIES' 
  | 'CRAVINGS'
  | 'CRAVING_CATEGORIES'
  | 'COUPONS' 
  | 'ADS' 
  | 'RECOMMENDATIONS' 
  | 'DOWNLOAD_APP' 
  | 'FEATURED'
  | 'VIDEO_HERO'
  | 'PIZZA_SHOWCASE'
  | 'TESTIMONIALS'
  | 'COUNTDOWN'
  | 'GALLERY'
  | 'ORDER_AGAIN'
  | 'COMPLETE_MEAL'
  | 'WHY_US'
  | 'DELIVERY_AREA'
  | 'CTA'
  | 'FOOTER';

export type AnimationType = 
  | 'None' 
  | 'Fade' 
  | 'Fade Up' 
  | 'Fade Down' 
  | 'Fade Left'
  | 'Fade Right'
  | 'Slide' 
  | 'Scale' 
  | 'Pop' 
  | 'Floating' 
  | 'Stagger'
  | 'Blur In';

export interface AnimationSettings {
  type: AnimationType;
  durationMs?: number;
  delayMs?: number;
  easing?: AnimationEasing;
  trigger?: AnimationTrigger;
  direction?: 'up' | 'down' | 'left' | 'right';
  hoverEffect?: 'none' | 'lift' | 'scale' | 'glow';
}

export interface SectionBackground {
  type?: 'solid' | 'gradient' | 'image' | 'video';
  solidColor?: string;
  gradient?: string;
  mediaUrl?: string;
  optimizedMediaUrl?: string;
  posterUrl?: string;
  overlayOpacity?: number; // 0-100
  blur?: number; // 0-20
  brightness?: number; // 0-100
}

export interface SimplifiedSectionSchema {
  id: string;
  type: SectionType;
  isHidden: boolean;
  config: {
    headline?: string;
    subtitle?: string;
    description?: string;
    buttonText?: string;
    buttonAction?: ActionPayload;
    secondaryButtonText?: string;
    secondaryButtonAction?: ActionPayload;
    mediaUrl?: string; // Cloudinary URL
    mobileMediaUrl?: string;
    useSeparateMobileMedia?: boolean;
    posterUrl?: string;
    animationType?: AnimationType;
    animationSettings?: AnimationSettings;
    background?: SectionBackground;
    typography?: Partial<TypographyConfig>;
    layout?: {
      contentAlignment?: 'left' | 'center' | 'right';
      contentWidth?: 'contained' | 'wide' | 'full';
      sectionHeight?: 'compact' | 'standard' | 'cinematic' | 'fullscreen';
      paddingY?: 'none' | 'small' | 'medium' | 'large';
    };
    styleOverrides?: {
      backgroundColor?: string;
      textColor?: string;
      paddingY?: 'none' | 'small' | 'medium' | 'large';
      borderRadius?: number;
      boxShadow?: string;
    };
    [key: string]: any;
  };
}

export type ApprovedActionType = 
  | 'OPEN_MENU'
  | 'OPEN_CART'
  | 'ADD_TO_CART'
  | 'OPEN_CHECKOUT'
  | 'LOGIN'
  | 'OPEN_OFFERS'
  | 'OPEN_PROFILE'
  | 'EXTERNAL_LINK';

export interface ActionPayload {
  type: ApprovedActionType;
  url?: string;
  productId?: string;
}
