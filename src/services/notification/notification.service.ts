export type NotificationCategory = 'orders' | 'delivery' | 'inventory' | 'security' | 'support' | 'general' | 'errors';

export interface NotificationEvent {
  type: string;
  category: NotificationCategory;
  title: string;
  details?: string;
  blocks?: any[];
  thread_ts?: string;
  skipWebPush?: boolean;
}

interface QueueItem {
  event: NotificationEvent;
  channel: string;
  attempts: number;
}

// Default channel fallback when Firestore config not yet saved
const DEFAULT_CHANNELS: Record<NotificationCategory, string> = {
  orders:    '#orders',
  delivery:  '#delivery',
  inventory: '#inventory',
  security:  '#security',
  support:   '#support',
  general:   '#general',
  errors:    '#errors',
};

class NotificationService {
  public async dispatch(_event: NotificationEvent): Promise<void> {}
  public async dispatchImmediate(_event: NotificationEvent): Promise<string | null> { return null; }
}

export const notificationService = new NotificationService();
