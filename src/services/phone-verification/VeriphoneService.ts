import axios from 'axios';

export interface VeriphoneResponse {
  status: string;
  phone: string;
  phone_valid: boolean;
  phone_type?: string;
  phone_region?: string;
  country?: string;
  country_code?: string;
  country_prefix?: string;
  international_number?: string;
  local_number?: string;
  e164?: string;
  carrier?: string;
  mode?: string;
  timezone?: string[];
  geographical?: boolean;
}

import { adminDb } from '../../config/firebase.js';

export class VeriphoneService {
  private static instance: VeriphoneService;
  private apiKey: string;
  private apiUrl: string = 'https://api.veriphone.io/v2/verify';
  private memoryCache: Map<string, { data: VeriphoneResponse; timestamp: number }> = new Map();
  private readonly CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cache

  private constructor() {
    this.apiKey = process.env.VERIPHONE_API_KEY || '9A278366811B4244AB0A1C1A06A3AEC4';
  }

  public static getInstance(): VeriphoneService {
    if (!VeriphoneService.instance) {
      VeriphoneService.instance = new VeriphoneService();
    }
    return VeriphoneService.instance;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 5);
  }

  private normalizeKey(phone: string): string {
    let clean = phone.replace(/\D/g, '').trim();
    if (clean.length === 10) clean = `91${clean}`;
    return `+${clean}`;
  }

  public async verifyNumber(phone: string): Promise<VeriphoneResponse> {
    const normalized = this.normalizeKey(phone);

    // 1. Check in-memory cache first (zero external calls)
    const memCached = this.memoryCache.get(normalized);
    if (memCached && Date.now() - memCached.timestamp < this.CACHE_TTL_MS) {
      return memCached.data;
    }

    // 2. Check Firestore persistent cache (zero external calls across server restarts)
    try {
      const snap = await adminDb.collection('phone_intelligence').doc(normalized).get();
      if (snap.exists) {
        const cachedData = snap.data() as VeriphoneResponse;
        this.memoryCache.set(normalized, { data: cachedData, timestamp: Date.now() });
        return cachedData;
      }
    } catch (err: any) {
      console.warn('[Veriphone] Firestore cache lookup warning:', err.message);
    }

    if (!this.apiKey) {
      throw new Error('Veriphone API key is missing.');
    }

    // 3. Only if not cached anywhere, call live Veriphone API once
    const params = new URLSearchParams({
      key: this.apiKey,
      phone: phone.trim()
    });

    const response = await axios.get<VeriphoneResponse>(`${this.apiUrl}?${params.toString()}`, {
      timeout: 8000
    });

    const result = response.data;

    // Cache in memory and in Firestore
    this.memoryCache.set(normalized, { data: result, timestamp: Date.now() });
    try {
      await adminDb.collection('phone_intelligence').doc(normalized).set({
        ...result,
        cachedAt: Date.now()
      }, { merge: true });
    } catch {}

    return result;
  }
}

export const veriphoneService = VeriphoneService.getInstance();
