import { BuiltInPageSchema } from '../../types/PageSchema.js';

export const BUILT_IN_TEMPLATES: Record<string, BuiltInPageSchema> = {
  default: {
    versionId: 'builtin-default',
    pageId: 'default',
    type: 'BUILT_IN',
    templateId: 'default',
    metadata: {
      name: 'Standard Olive Pizza',
      description: 'The classic, high-conversion menu layout.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'hero',
        type: 'HERO',
        isHidden: false,
        config: { headline: 'Olive Pizza', subtitle: 'Premium quality pizza delivered fast.' }
      },
      {
        id: 'ads',
        type: 'ADS',
        isHidden: false,
        config: {}
      },
      {
        id: 'categories',
        type: 'CATEGORIES',
        isHidden: false,
        config: {}
      },
      {
        id: 'coupons',
        type: 'COUPONS',
        isHidden: false,
        config: {}
      }
    ]
  },
  cricket: {
    versionId: 'builtin-cricket',
    pageId: 'cricket',
    type: 'BUILT_IN',
    templateId: 'cricket',
    metadata: {
      name: 'Cricket Match Day',
      description: 'High-energy template with live score integration space.',
      publishedBy: 'system',
      publishedAt: new Date().toISOString()
    },
    sections: [
      {
        id: 'hero',
        type: 'HERO',
        isHidden: false,
        config: { headline: '🏏 Match Day Special', subtitle: 'Enjoy the game with our pizza.' }
      },
      {
        id: 'categories',
        type: 'CATEGORIES',
        isHidden: false,
        config: {}
      }
    ]
  }
};
