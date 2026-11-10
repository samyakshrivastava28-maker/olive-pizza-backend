import axios from 'axios';
import NodeCache from 'node-cache';
import { CustomerOrderingContextService } from '../order/CustomerOrderingContextService.js';

export interface NormalizedLocationResult {
  id: string;
  provider: 'mapbox' | 'geoapify' | 'photon' | 'nominatim' | 'mappls' | 'local';
  name: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  city?: string;
  district?: string;
  state?: string;
  country?: string;
  pincode?: string;
  type?: string;
  relevance?: number;
  matchedProviders: string[];
  providerCount: number;
  isServiceable?: boolean;
  serviceabilityMessage?: string;
  distanceKm?: number;
  address?: {
    road?: string;
    suburb?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

export interface ParallelSearchParams {
  query: string;
  city?: string;
  lat?: number;
  lng?: number;
  country?: string;
  limit?: number;
}

export interface ParallelSearchResponse {
  success: boolean;
  query: string;
  total: number;
  results: NormalizedLocationResult[];
  providersQueried: string[];
  activeProviders: string[];
  source?: 'cache' | 'network';
}

const geocodeCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // 30 min TTL

export class MultiProviderGeocodeService {
  /**
   * Main parallel search entry point.
   * Concurrently queries all enabled geocoding providers, normalizes outputs,
   * deduplicates spatially and semantically, and calculates multi-provider confidence ranking.
   */
  public static async searchParallel(params: ParallelSearchParams): Promise<ParallelSearchResponse> {
    const rawQuery = (params.query || '').trim();
    if (!rawQuery || rawQuery.length < 2) {
      return {
        success: true,
        query: rawQuery,
        total: 0,
        results: [],
        providersQueried: [],
        activeProviders: []
      };
    }

    const city = (params.city || '').trim();
    const lat = params.lat != null && !isNaN(Number(params.lat)) ? Number(params.lat) : undefined;
    const lng = params.lng != null && !isNaN(Number(params.lng)) ? Number(params.lng) : undefined;
    const limit = params.limit || 10;

    // Cache key normalized by query, city, and rounded coordinates
    const latKey = lat != null ? lat.toFixed(2) : '';
    const lngKey = lng != null ? lng.toFixed(2) : '';
    const cacheKey = `parallel_geo_${rawQuery.toLowerCase()}_${city.toLowerCase()}_${latKey}_${lngKey}`;

    const cachedResults = geocodeCache.get<NormalizedLocationResult[]>(cacheKey);
    if (cachedResults && cachedResults.length > 0) {
      return {
        success: true,
        query: rawQuery,
        total: cachedResults.length,
        results: cachedResults.slice(0, limit),
        providersQueried: ['cache'],
        activeProviders: ['cache'],
        source: 'cache'
      };
    }

    // Determine configured providers
    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN || process.env.VITE_MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_API_KEY;
    const geoapifyKey = process.env.GEOAPIFY_API_KEY || process.env.VITE_GEOAPIFY_API_KEY;
    const mapplsKey = process.env.MAPPLS_API_KEY || process.env.VITE_MAPPLS_API_KEY;

    const providersQueried: string[] = [];
    const searchPromises: Array<Promise<{ provider: string; results: NormalizedLocationResult[] }>> = [];

    // 1. Photon (OpenStreetMap Komoot) — always available, fast, supports lat/lon proximity
    providersQueried.push('photon');
    searchPromises.push(this.queryPhoton(rawQuery, city, lat, lng));

    // 2. Nominatim (OpenStreetMap) — throttled, high-accuracy Indian addresses
    providersQueried.push('nominatim');
    searchPromises.push(this.queryNominatim(rawQuery, city, lat, lng));

    // 3. Mapbox — if token configured
    if (mapboxToken) {
      providersQueried.push('mapbox');
      searchPromises.push(this.queryMapbox(rawQuery, city, lat, lng, mapboxToken));
    }

    // 4. Geoapify — if key configured
    if (geoapifyKey) {
      providersQueried.push('geoapify');
      searchPromises.push(this.queryGeoapify(rawQuery, city, lat, lng, geoapifyKey));
    }

    // 5. Mappls — if key configured
    if (mapplsKey) {
      providersQueried.push('mappls');
      searchPromises.push(this.queryMappls(rawQuery, city, lat, lng, mapplsKey));
    }

    // Concurrently execute all provider queries
    const settled = await Promise.allSettled(searchPromises);
    const activeProviders: string[] = [];
    const allNormalized: NormalizedLocationResult[] = [];

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value.results.length > 0) {
        activeProviders.push(result.value.provider);
        allNormalized.push(...result.value.results);
      }
    }

    // Deduplicate across providers using spatial clustering (<180m) + text similarity
    const mergedResults = this.combineAndDeduplicate(allNormalized);

    // Score and rank based on provider agreement, query match, and geographic proximity
    const rankedResults = this.rankResults(mergedResults, rawQuery, lat, lng);

    // Attach authoritative in-memory serviceability check for top candidates (0 Firestore reads)
    const topCandidates = rankedResults.slice(0, limit);
    const serviceChecks = await CustomerOrderingContextService.checkBatchServiceability(topCandidates);

    const finalResults = topCandidates.map((item, idx) => {
      const check = serviceChecks[idx];
      item.isServiceable = check?.isServiceable ?? false;
      item.serviceabilityMessage = check?.serviceabilityMessage ?? 'Outside current delivery radius';
      item.distanceKm = check?.distanceKm;
      return item;
    });

    if (finalResults.length > 0) {
      geocodeCache.set(cacheKey, finalResults);
    }

    return {
      success: true,
      query: rawQuery,
      total: finalResults.length,
      results: finalResults,
      providersQueried,
      activeProviders,
      source: 'network'
    };
  }

  // ─── Provider: Photon (OpenStreetMap Komoot) ───────────────────────────────
  private static async queryPhoton(
    query: string,
    city?: string,
    lat?: number,
    lng?: number
  ): Promise<{ provider: string; results: NormalizedLocationResult[] }> {
    try {
      const q = city ? `${query} ${city}` : query;
      const params: Record<string, any> = {
        q,
        limit: 8,
        lang: 'en'
      };
      if (lat != null && lng != null) {
        params.lat = lat;
        params.lon = lng;
      }

      const res = await axios.get('https://photon.komoot.io/api/', {
        params,
        timeout: 1600
      });

      const features = res.data?.features || [];
      const results: NormalizedLocationResult[] = [];

      for (const feat of features) {
        const props = feat.properties || {};
        const coords = feat.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;

        const longitude = Number(coords[0]);
        const latitude = Number(coords[1]);
        if (isNaN(latitude) || isNaN(longitude)) continue;

        const name = (props.name || props.street || query).trim();
        const subtitleParts = [
          props.street,
          props.locality || props.district || props.suburb,
          props.city || city,
          props.state,
          props.country || 'India'
        ].filter(Boolean).filter((val, idx, arr) => arr.indexOf(val) === idx);

        const formattedAddress = [name, ...subtitleParts.filter((p) => p !== name)].join(', ');

        results.push({
          id: `photon_${props.osm_id || Math.random().toString(36).substring(2, 9)}`,
          provider: 'photon',
          name,
          formattedAddress,
          latitude,
          longitude,
          city: props.city || city,
          district: props.district || props.county,
          state: props.state,
          country: props.country || 'India',
          pincode: props.postcode,
          type: props.osm_value || props.type || 'place',
          relevance: 0.8,
          matchedProviders: ['photon'],
          providerCount: 1,
          address: {
            road: props.street,
            suburb: props.locality || props.district,
            city: props.city || city,
            state: props.state,
            postcode: props.postcode,
            country: props.country || 'India'
          }
        });
      }

      return { provider: 'photon', results };
    } catch {
      return { provider: 'photon', results: [] };
    }
  }

  // ─── Provider: OpenStreetMap Nominatim ─────────────────────────────────────
  private static lastNominatimRequestTime = 0;
  private static nominatimLock: Promise<void> = Promise.resolve();

  private static async throttleNominatim(): Promise<void> {
    const currentLock = this.nominatimLock;
    let release = () => {};
    this.nominatimLock = new Promise<void>((resolve) => { release = resolve; });
    await currentLock;
    const now = Date.now();
    const elapsed = now - this.lastNominatimRequestTime;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    this.lastNominatimRequestTime = Date.now();
    release();
  }

  private static async queryNominatim(
    query: string,
    city?: string,
    lat?: number,
    lng?: number
  ): Promise<{ provider: string; results: NormalizedLocationResult[] }> {
    try {
      await this.throttleNominatim();
      const q = city ? `${query}, ${city}` : query;
      const params: Record<string, any> = {
        q,
        format: 'json',
        addressdetails: 1,
        limit: 8,
        countrycodes: 'in'
      };

      if (lat != null && lng != null) {
        // Bias search towards user coordinate (+- 0.35 deg ~ 35km)
        params.viewbox = `${(lng - 0.35).toFixed(4)},${(lat + 0.35).toFixed(4)},${(lng + 0.35).toFixed(4)},${(lat - 0.35).toFixed(4)}`;
        params.bounded = 0;
      }

      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params,
        headers: {
          'User-Agent': 'OlivePizzaApp/1.0 (contact: olivepizzarjn@gmail.com; platform: backend-search)',
          'Accept-Language': 'en-IN,en;q=0.9',
        },
        timeout: 2200
      });

      const items = Array.isArray(res.data) ? res.data : [];
      const results: NormalizedLocationResult[] = [];

      for (const item of items) {
        const latitude = Number(item.lat);
        const longitude = Number(item.lon);
        if (isNaN(latitude) || isNaN(longitude)) continue;

        const addr = item.address || {};
        const name = (addr.road || addr.suburb || addr.neighbourhood || item.name || query).trim();
        const formattedAddress = item.display_name || name;

        results.push({
          id: `nom_${item.osm_id || Math.random().toString(36).substring(2, 9)}`,
          provider: 'nominatim',
          name,
          formattedAddress,
          latitude,
          longitude,
          city: addr.city || addr.town || addr.village || city,
          district: addr.state_district || addr.county,
          state: addr.state,
          country: addr.country || 'India',
          pincode: addr.postcode,
          type: item.type || item.class || 'place',
          relevance: 0.85,
          matchedProviders: ['nominatim'],
          providerCount: 1,
          address: {
            road: addr.road,
            suburb: addr.suburb || addr.neighbourhood,
            city: addr.city || addr.town || addr.village || city,
            state: addr.state,
            postcode: addr.postcode,
            country: addr.country || 'India'
          }
        });
      }

      return { provider: 'nominatim', results };
    } catch {
      return { provider: 'nominatim', results: [] };
    }
  }


  // ─── Provider: Mapbox Geocoding API ────────────────────────────────────────
  private static async queryMapbox(
    query: string,
    city: string | undefined,
    lat: number | undefined,
    lng: number | undefined,
    token: string
  ): Promise<{ provider: string; results: NormalizedLocationResult[] }> {
    try {
      const q = city ? `${query} ${city}` : query;
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`;
      const params: Record<string, any> = {
        access_token: token,
        country: 'in',
        limit: 8,
        language: 'en',
        types: 'poi,address,neighborhood,locality,place,postcode'
      };

      if (lat != null && lng != null) {
        params.proximity = `${lng},${lat}`;
      }

      const res = await axios.get(url, { params, timeout: 1600 });
      const features = res.data?.features || [];
      const results: NormalizedLocationResult[] = [];

      for (const feat of features) {
        const coords = feat.center;
        if (!coords || coords.length < 2) continue;

        const longitude = Number(coords[0]);
        const latitude = Number(coords[1]);
        if (isNaN(latitude) || isNaN(longitude)) continue;

        const name = (feat.text || feat.place_name?.split(',')[0] || query).trim();
        const formattedAddress = feat.place_name || name;

        // Context parsing
        let resolvedCity = city;
        let resolvedDistrict: string | undefined;
        let resolvedState: string | undefined;
        let resolvedPincode: string | undefined;

        if (Array.isArray(feat.context)) {
          for (const ctx of feat.context) {
            const id = String(ctx.id || '');
            if (id.startsWith('place')) resolvedCity = ctx.text;
            if (id.startsWith('district')) resolvedDistrict = ctx.text;
            if (id.startsWith('region')) resolvedState = ctx.text;
            if (id.startsWith('postcode')) resolvedPincode = ctx.text;
          }
        }

        results.push({
          id: `mapbox_${feat.id || Math.random().toString(36).substring(2, 9)}`,
          provider: 'mapbox',
          name,
          formattedAddress,
          latitude,
          longitude,
          city: resolvedCity,
          district: resolvedDistrict,
          state: resolvedState,
          country: 'India',
          pincode: resolvedPincode,
          type: feat.place_type?.[0] || 'place',
          relevance: Number(feat.relevance || 0.9),
          matchedProviders: ['mapbox'],
          providerCount: 1,
          address: {
            road: feat.properties?.address,
            city: resolvedCity,
            state: resolvedState,
            postcode: resolvedPincode,
            country: 'India'
          }
        });
      }

      return { provider: 'mapbox', results };
    } catch {
      return { provider: 'mapbox', results: [] };
    }
  }

  // ─── Provider: Geoapify Geocoding API ──────────────────────────────────────
  private static async queryGeoapify(
    query: string,
    city: string | undefined,
    lat: number | undefined,
    lng: number | undefined,
    apiKey: string
  ): Promise<{ provider: string; results: NormalizedLocationResult[] }> {
    try {
      const q = city ? `${query}, ${city}` : query;
      const url = 'https://api.geoapify.com/v1/geocode/autocomplete';
      const params: Record<string, any> = {
        text: q,
        apiKey,
        filter: 'countrycode:in',
        limit: 8,
        lang: 'en'
      };

      if (lat != null && lng != null) {
        params.bias = `proximity:${lng},${lat}`;
      }

      const res = await axios.get(url, { params, timeout: 1600 });
      const features = res.data?.features || [];
      const results: NormalizedLocationResult[] = [];

      for (const feat of features) {
        const props = feat.properties || {};
        const coords = feat.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;

        const longitude = Number(coords[0]);
        const latitude = Number(coords[1]);
        if (isNaN(latitude) || isNaN(longitude)) continue;

        const name = (props.name || props.street || props.formatted?.split(',')[0] || query).trim();
        const formattedAddress = props.formatted || `${name}, ${props.city || city || ''}`;

        results.push({
          id: `geoapify_${props.place_id || Math.random().toString(36).substring(2, 9)}`,
          provider: 'geoapify',
          name,
          formattedAddress,
          latitude,
          longitude,
          city: props.city || city,
          district: props.district || props.county,
          state: props.state,
          country: props.country || 'India',
          pincode: props.postcode,
          type: props.result_type || 'place',
          relevance: Number(props.rank?.confidence || 0.85),
          matchedProviders: ['geoapify'],
          providerCount: 1,
          address: {
            road: props.street,
            suburb: props.suburb || props.district,
            city: props.city || city,
            state: props.state,
            postcode: props.postcode,
            country: props.country || 'India'
          }
        });
      }

      return { provider: 'geoapify', results };
    } catch {
      return { provider: 'geoapify', results: [] };
    }
  }

  // ─── Provider: Mappls (MapmyIndia) ─────────────────────────────────────────
  private static async queryMappls(
    query: string,
    city: string | undefined,
    lat: number | undefined,
    lng: number | undefined,
    apiKey: string
  ): Promise<{ provider: string; results: NormalizedLocationResult[] }> {
    try {
      const q = city ? `${query} ${city}` : query;
      const url = `https://atlas.mappls.com/api/places/search/json?query=${encodeURIComponent(q)}`;
      const headers: Record<string, string> = {
        Authorization: `bearer ${apiKey}`
      };

      const res = await axios.get(url, { headers, timeout: 1600 });
      const places = res.data?.suggestedLocations || [];
      const results: NormalizedLocationResult[] = [];

      for (const p of places) {
        const latitude = Number(p.latitude);
        const longitude = Number(p.longitude);
        if (isNaN(latitude) || isNaN(longitude)) continue;

        const name = (p.placeName || query).trim();
        const formattedAddress = p.placeAddress || `${name}, ${city || ''}`;

        results.push({
          id: `mappls_${p.eLoc || Math.random().toString(36).substring(2, 9)}`,
          provider: 'mappls',
          name,
          formattedAddress,
          latitude,
          longitude,
          city: p.city || city,
          state: p.state,
          country: 'India',
          pincode: p.pincode,
          type: p.type || 'place',
          relevance: 0.85,
          matchedProviders: ['mappls'],
          providerCount: 1,
          address: {
            road: p.placeAddress,
            city: p.city || city,
            state: p.state,
            postcode: p.pincode,
            country: 'India'
          }
        });
      }

      return { provider: 'mappls', results };
    } catch {
      return { provider: 'mappls', results: [] };
    }
  }

  // ─── Deduplication: Spatial Clustering (<180m) + Semantic Matching ─────────
  private static combineAndDeduplicate(candidates: NormalizedLocationResult[]): NormalizedLocationResult[] {
    const combined: NormalizedLocationResult[] = [];

    for (const item of candidates) {
      // Find matching existing item
      const matchIndex = combined.findIndex((existing) => {
        const distKm = CustomerOrderingContextService.haversineDistanceKm(
          existing.latitude,
          existing.longitude,
          item.latitude,
          item.longitude
        );

        // Within 180 meters physically: definitely the same real-world location
        if (distKm < 0.18) return true;

        // Within 1.2km and near-identical cleaned name
        if (distKm < 1.2) {
          const normA = existing.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const normB = item.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (normA && normB && (normA === normB || normA.includes(normB) || normB.includes(normA))) {
            return true;
          }
        }

        return false;
      });

      if (matchIndex >= 0) {
        const existing = combined[matchIndex];
        if (!existing.matchedProviders.includes(item.provider)) {
          existing.matchedProviders.push(item.provider);
          existing.providerCount += 1;
        }

        // Keep most detailed formatted address
        if (item.formattedAddress.length > existing.formattedAddress.length && item.formattedAddress.includes(',')) {
          existing.formattedAddress = item.formattedAddress;
        }
        if (!existing.pincode && item.pincode) existing.pincode = item.pincode;
        if (!existing.city && item.city) existing.city = item.city;
        if (!existing.district && item.district) existing.district = item.district;
        if (!existing.state && item.state) existing.state = item.state;
      } else {
        combined.push({
          ...item,
          matchedProviders: [item.provider],
          providerCount: 1
        });
      }
    }

    return combined;
  }

  // ─── Ranking: Multi-Provider Agreement + Text Relevance + Proximity Bias ──
  private static rankResults(
    items: NormalizedLocationResult[],
    query: string,
    biasLat?: number,
    biasLng?: number
  ): NormalizedLocationResult[] {
    const cleanQuery = query.toLowerCase().trim();
    const queryTokens = cleanQuery.split(/\s+/).filter(Boolean);

    const scored = items.map((item) => {
      let score = item.relevance || 0.7;

      // 1. Multi-provider agreement boost (+0.35 per agreeing provider)
      score += (item.providerCount - 1) * 0.35;

      // 2. Query Text Relevance
      const itemName = item.name.toLowerCase();
      const itemAddress = item.formattedAddress.toLowerCase();

      if (itemName === cleanQuery) {
        score += 0.6; // Exact name match
      } else if (itemName.startsWith(cleanQuery)) {
        score += 0.4; // Starts with query
      } else if (itemName.includes(cleanQuery)) {
        score += 0.25; // Contains full query
      }

      // Check token coverage
      const coveredTokens = queryTokens.filter((token) => itemName.includes(token) || itemAddress.includes(token));
      score += (coveredTokens.length / Math.max(1, queryTokens.length)) * 0.3;

      // 3. Geographic Proximity Bias (if bias coordinates available)
      if (biasLat != null && biasLng != null) {
        const distKm = CustomerOrderingContextService.haversineDistanceKm(
          biasLat,
          biasLng,
          item.latitude,
          item.longitude
        );

        if (distKm <= 3) score += 0.45;
        else if (distKm <= 10) score += 0.3;
        else if (distKm <= 25) score += 0.15;
        else if (distKm > 60) score -= 0.3; // Penalty for far away locations
      }

      return { item, finalScore: score };
    });

    // Sort descending by calculated multi-provider score
    scored.sort((a, b) => b.finalScore - a.finalScore);
    return scored.map((s) => s.item);
  }
}
