import NodeCache from 'node-cache';

// TTLs in seconds
const TTL_MAP = {
  menu: 5 * 60,
  coupon: 2 * 60,
  product: 5 * 60,
  settings: 30 * 60,
  user_context: 60,
  popular_products: 10 * 60,
  analytics: 5 * 60
};

class AICacheService {
  private cache: NodeCache;

  constructor() {
    this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
  }

  public get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  public set<T>(key: string, value: T, type: keyof typeof TTL_MAP): void {
    const ttl = TTL_MAP[type];
    this.cache.set(key, value, ttl);
  }

  public del(key: string): void {
    this.cache.del(key);
  }

  public flush(): void {
    this.cache.flushAll();
  }
}

export const aiCache = new AICacheService();
