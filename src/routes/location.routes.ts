import { Router, Request, Response } from 'express';
import axios from 'axios';
import NodeCache from 'node-cache';
import { adminDb } from '../config/firebase.js';
import { verifyToken, AuthRequest } from '../middleware/auth.middleware.js';
import { CustomerOrderingContextService } from '../services/order/CustomerOrderingContextService.js';
import { MultiProviderGeocodeService } from '../services/location/MultiProviderGeocodeService.js';
import { publicLimiter, userLimiter } from '../config/security.config.js';

const router = Router();

// In-memory cache for Nominatim and City queries (1 hour TTL for geocoding, 60 seconds for cities)
const geocodeCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const citiesCache = new NodeCache({ stdTTL: 60, checkperiod: 30 });

// Global application-wide throttling lock for Nominatim reverse-geocoding (strictly max 1 req/sec app-wide per OSM policy)
let lastNominatimRequestTime = 0;
let nominatimQueuePromise: Promise<void> = Promise.resolve();

const throttleNominatimApplicationWide = async (): Promise<void> => {
  const currentLock = nominatimQueuePromise;
  let release: () => void = () => {};
  nominatimQueuePromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  await currentLock;
  const now = Date.now();
  const timeSinceLast = now - lastNominatimRequestTime;
  if (timeSinceLast < 1000) {
    const delay = 1000 - timeSinceLast;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  lastNominatimRequestTime = Date.now();
  release();
};

// ============================================================================
// 1. GET /api/location/serviceable-cities
// Authoritative dynamic list of cities served by active Olive Pizza branches
// ============================================================================
router.get('/serviceable-cities', publicLimiter, async (_req: Request, res: Response): Promise<void> => {
  try {
    const cached = citiesCache.get<any[]>('serviceable_cities');
    if (cached) {
      res.json({ success: true, cities: cached, source: 'cache' });
      return;
    }

    interface CityInfo {
      id: string;
      city: string;
      name: string;
      state: string;
      country: string;
      center: { lat: number; lng: number };
      deliveryRadiusKm: number;
      viewbox: number[]; // [minLon, maxLat, maxLon, minLat] for OSM bounding
      activeBranches: number;
      branchNames: string[];
      branches: Array<{
        id: string;
        name: string;
        lat: number;
        lng: number;
        deliveryRadiusKm: number;
      }>;
      popularLocalities?: Array<{
        id?: string;
        title: string;
        subtitle: string;
        lat: number;
        lng: number;
        pincode?: string;
        type?: string;
        isServiceable?: boolean;
      }>;
      serviceable: boolean;
    }

    const cityMap = new Map<string, CityInfo>();

    // 1. Query franchises (branch records) collection
    const franchisesSnap = await adminDb.collection('franchises').get();
    for (const doc of franchisesSnap.docs) {
      const data = doc.data();
      const statusLower = String(data.status || '').toLowerCase();
      if (
        data.isActive === false ||
        statusLower === 'deleted' ||
        statusLower === 'deactivated' ||
        statusLower === 'suspended' ||
        statusLower === 'planned'
      ) {
        continue;
      }

      const rawCity = (data.city || '').trim();
      if (!rawCity) continue;

      const cityKey = rawCity.toLowerCase();
      const lat = Number(data.lat ?? data.coordinates?.lat ?? data.location?.lat);
      const lng = Number(data.lng ?? data.coordinates?.lng ?? data.location?.lng);
      const radius = Number(
        data.maxDeliveryRadiusKm ||
        data.deliverySettings?.maxDeliveryRadiusKm ||
        data.deliveryRadiusKm ||
        data.deliveryRadius ||
        15
      );
      const state = data.state || 'Chhattisgarh';
      const branchName = data.name || `Olive Pizza ${rawCity}`;

      const rawPopular = Array.isArray(data.popularLocalities) && data.popularLocalities.length > 0
        ? data.popularLocalities
        : Array.isArray(data.popularLocations) && data.popularLocations.length > 0
          ? data.popularLocations
          : [];

      if (!isNaN(lat) && !isNaN(lng)) {
        const deltaLat = radius / 110.574;
        const deltaLng = radius / (111.320 * Math.cos((lat * Math.PI) / 180));
        const viewbox = [
          Number((lng - deltaLng).toFixed(6)),
          Number((lat + deltaLat).toFixed(6)),
          Number((lng + deltaLng).toFixed(6)),
          Number((lat - deltaLat).toFixed(6)),
        ];

        const branchInfo = {
          id: doc.id,
          name: branchName,
          lat,
          lng,
          deliveryRadiusKm: radius,
        };

        if (!cityMap.has(cityKey)) {
          cityMap.set(cityKey, {
            id: `city_${cityKey}`,
            city: rawCity,
            name: rawCity,
            state,
            country: 'India',
            center: { lat, lng },
            deliveryRadiusKm: radius,
            viewbox,
            activeBranches: 1,
            branchNames: [branchName],
            branches: [branchInfo],
            popularLocalities: [...rawPopular],
            serviceable: true,
          });
        } else {
          const existing = cityMap.get(cityKey)!;
          existing.activeBranches += 1;
          existing.branchNames.push(branchName);
          existing.branches.push(branchInfo);
          existing.deliveryRadiusKm = Math.max(existing.deliveryRadiusKm, radius);
          existing.viewbox = [
            Math.min(existing.viewbox[0], viewbox[0]),
            Math.max(existing.viewbox[1], viewbox[1]),
            Math.max(existing.viewbox[2], viewbox[2]),
            Math.min(existing.viewbox[3], viewbox[3]),
          ];
          if (rawPopular.length > 0) {
            const existingIds = new Set(existing.popularLocalities.map((p) => (p.title || '').toLowerCase()));
            for (const item of rawPopular) {
              if (!existingIds.has((item.title || '').toLowerCase())) {
                existing.popularLocalities.push(item);
                existingIds.add((item.title || '').toLowerCase());
              }
            }
          }
        }
      }
    }

    // 2. Also check franchise_entities collection if franchises had no branches for an active franchise
    try {
      const entitiesSnap = await adminDb.collection('franchise_entities').get();
      for (const eDoc of entitiesSnap.docs) {
        const eData = eDoc.data();
        const eStatusLower = String(eData.status || '').toLowerCase();
        if (
          eData.isActive === false ||
          eStatusLower === 'deleted' ||
          eStatusLower === 'deactivated' ||
          eStatusLower === 'suspended' ||
          eStatusLower === 'planned'
        ) {
          continue;
        }

        const rawCity = (eData.city || '').trim();
        if (!rawCity) continue;

        const cityKey = rawCity.toLowerCase();
        // If this city is not yet in cityMap and has valid coordinates, include it
        if (!cityMap.has(cityKey)) {
          const lat = Number(eData.lat ?? eData.coordinates?.lat ?? eData.location?.lat);
          const lng = Number(eData.lng ?? eData.coordinates?.lng ?? eData.location?.lng);
          const radius = Number(
            eData.deliverySettings?.maxDeliveryRadiusKm ||
            eData.maxDeliveryRadiusKm ||
            eData.deliveryRadiusKm ||
            15
          );
          const state = eData.state || eData.region || 'Chhattisgarh';
          const branchName = eData.name || `Olive Pizza ${rawCity}`;

          if (!isNaN(lat) && !isNaN(lng)) {
            const deltaLat = radius / 110.574;
            const deltaLng = radius / (111.320 * Math.cos((lat * Math.PI) / 180));
            const viewbox = [
              Number((lng - deltaLng).toFixed(6)),
              Number((lat + deltaLat).toFixed(6)),
              Number((lng + deltaLng).toFixed(6)),
              Number((lat - deltaLat).toFixed(6)),
            ];

            cityMap.set(cityKey, {
              id: `city_${cityKey}`,
              city: rawCity,
              name: rawCity,
              state,
              country: 'India',
              center: { lat, lng },
              deliveryRadiusKm: radius,
              viewbox,
              activeBranches: 1,
              branchNames: [branchName],
              branches: [{
                id: eData.mainBranchId || eDoc.id,
                name: branchName,
                lat,
                lng,
                deliveryRadiusKm: radius,
              }],
              serviceable: true,
            });
          }
        }
      }
    } catch (entityErr) {
      // Non-fatal
    }

    // 100% database-driven: NO hardcoded fallback cities!
    const cities = Array.from(cityMap.values());

    // Dynamic auto-discovery for any city (current or future) that has no explicit popularLocalities configured
    await Promise.all(
      cities.map(async (c) => {
        if (c.popularLocalities && c.popularLocalities.length > 0) return;
        try {
          const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(c.name)}&lat=${c.center.lat}&lon=${c.center.lng}&limit=12`;
          const resp = await axios.get(photonUrl, { timeout: 3500 });
          if (resp.data && Array.isArray(resp.data.features) && resp.data.features.length > 0) {
            const places: any[] = [];
            const seen = new Set<string>();
            for (const feat of resp.data.features) {
              const props = feat.properties || {};
              const coords = feat.geometry?.coordinates;
              if (!coords || coords.length < 2) continue;
              const name = (props.name || '').trim();
              if (!name || seen.has(name.toLowerCase())) continue;
              seen.add(name.toLowerCase());

              const subtitleParts = [
                props.street,
                props.suburb || props.district,
                props.city || c.name,
                props.state || c.state,
              ].filter(Boolean);

              places.push({
                id: `dyn_${props.osm_id || Math.random().toString(36).substr(2, 9)}`,
                title: name,
                subtitle: subtitleParts.join(', '),
                lat: coords[1],
                lng: coords[0],
                pincode: props.postcode || '',
                type: props.osm_value || 'locality',
                isServiceable: true,
              });
              if (places.length >= 10) break;
            }
            if (places.length > 0) {
              c.popularLocalities = places;
              return;
            }
          }
        } catch {
          // Non-fatal
        }

        c.popularLocalities = [
          {
            id: `center_${c.id}`,
            title: `${c.name} Center`,
            subtitle: `${c.name}, ${c.state}, India`,
            lat: c.center.lat,
            lng: c.center.lng,
            type: 'center',
            isServiceable: true,
          },
        ];
      })
    );

    citiesCache.set('serviceable_cities', cities);

    res.json({
      success: true,
      cities,
      total: cities.length,
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Error fetching serviceable cities:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve serviceable cities' });
  }
});

// ============================================================================
// 1b. GET /api/location/popular-locations
// Returns instant popular localities for a selected city or all active cities
// ============================================================================
router.get('/popular-locations', async (req: Request, res: Response): Promise<void> => {
  try {
    const cityName = String(req.query.city || '').trim().toLowerCase();
    let cities = citiesCache.get<any[]>('serviceable_cities');
    if (!cities) {
      // Trigger internal resolution by querying franchises
      const franchisesSnap = await adminDb.collection('franchises').get();
      const cityMap = new Map<string, any>();
      for (const doc of franchisesSnap.docs) {
        const data = doc.data();
        const dataStatus = String(data.status || '').toLowerCase();
        if (
          data.isActive === false ||
          dataStatus === 'deleted' ||
          dataStatus === 'deactivated' ||
          dataStatus === 'suspended' ||
          dataStatus === 'planned'
        ) {
          continue;
        }
        const rawCity = (data.city || '').trim();
        if (!rawCity) continue;
        const cityKey = rawCity.toLowerCase();
        const popular = Array.isArray(data.popularLocalities) ? data.popularLocalities : [];
        if (!cityMap.has(cityKey)) {
          cityMap.set(cityKey, {
            name: rawCity,
            popularLocalities: popular,
          });
        }
      }
      cities = Array.from(cityMap.values());
    }

    if (cityName && cities) {
      const match = cities.find(
        (c: any) =>
          (c.city && c.city.toLowerCase() === cityName) ||
          (c.name && c.name.toLowerCase() === cityName)
      );
      if (match) {
        res.json({
          success: true,
          city: match.name || match.city,
          localities: match.popularLocalities || [],
        });
        return;
      }
    }

    res.json({
      success: true,
      cities: (cities || []).map((c: any) => ({
        city: c.name || c.city,
        localities: c.popularLocalities || [],
      })),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to retrieve popular locations' });
  }
});

// ============================================================================
// 2. GET & POST /api/location/search & /api/location/search-parallel
// Multi-provider parallel geocoding (Mapbox, Geoapify, Photon, Nominatim, Mappls)
// ============================================================================
const handleParallelSearch = async (req: Request, res: Response): Promise<void> => {
  try {
    const query = String(req.query.q || req.query.query || req.body?.q || req.body?.query || '').trim();
    const city = String(req.query.city || req.body?.city || '').trim();
    const rawLat = req.query.lat ?? req.body?.lat;
    const rawLng = req.query.lng ?? req.body?.lng;
    const lat = rawLat != null ? parseFloat(String(rawLat)) : undefined;
    const lng = rawLng != null ? parseFloat(String(rawLng)) : undefined;
    const limit = req.query.limit != null 
      ? parseInt(String(req.query.limit), 10) 
      : (req.body?.limit != null ? parseInt(String(req.body?.limit), 10) : 10);

    if (!query || query.length < 2) {
      res.status(400).json({ success: false, error: 'Search query must be at least 2 characters.' });
      return;
    }

    const response = await MultiProviderGeocodeService.searchParallel({
      query,
      city,
      lat: isNaN(lat!) ? undefined : lat,
      lng: isNaN(lng!) ? undefined : lng,
      limit,
    });

    res.json(response);
  } catch (error: any) {
    console.error('[LocationRoutes] Parallel search error:', error?.message);
    res.status(500).json({ success: false, error: 'Parallel location search failed.' });
  }
};

router.get('/search-parallel', publicLimiter, handleParallelSearch);
router.post('/search-parallel', publicLimiter, handleParallelSearch);
router.get('/search', publicLimiter, handleParallelSearch);
router.post('/search', publicLimiter, handleParallelSearch);

// ============================================================================
// 2a. GET & POST /api/location/serviceability & /api/location/ordering-context/resolve
// Canonical serviceability and delivery radius verification
// ============================================================================
const handleServiceabilityCheck = async (req: Request, res: Response): Promise<void> => {
  try {
    const rawLat = req.query.lat ?? req.body?.lat;
    const rawLng = req.query.lng ?? req.body?.lng;
    const lat = parseFloat(String(rawLat));
    const lng = parseFloat(String(rawLng));
    const addressLine = String(req.query.addressLine ?? req.body?.addressLine ?? '').trim();
    const customerId = (req as any).user?.uid || String(req.query.customerId ?? req.body?.customerId ?? 'guest');

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ success: false, isServiceable: false, error: 'Valid latitude and longitude numbers are required.' });
      return;
    }

    const resolution = await CustomerOrderingContextService.resolveOrderingContext({
      customerId,
      lat,
      lng,
      addressLine
    });

    res.json(resolution);
  } catch (err: any) {
    console.error('[LocationRoutes] Serviceability check error:', err);
    res.status(500).json({ success: false, isServiceable: false, error: 'Failed to verify serviceability' });
  }
};

router.get('/serviceability', publicLimiter, handleServiceabilityCheck);
router.post('/serviceability', publicLimiter, handleServiceabilityCheck);
router.post('/ordering-context/resolve', publicLimiter, handleServiceabilityCheck);

// ============================================================================
// 2b. GET /api/location/geocode
// Authoritative parallel multi-provider search with backward-compatible format
// ============================================================================
router.get('/geocode', publicLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    const city = String(req.query.city || '').trim();
    const lat = req.query.lat != null ? parseFloat(String(req.query.lat)) : undefined;
    const lng = req.query.lng != null ? parseFloat(String(req.query.lng)) : undefined;

    if (!query || query.length < 2) {
      res.status(400).json({ success: false, error: 'Search query must be at least 2 characters.' });
      return;
    }

    const parallelResponse = await MultiProviderGeocodeService.searchParallel({
      query,
      city,
      lat: isNaN(lat!) ? undefined : lat,
      lng: isNaN(lng!) ? undefined : lng,
      limit: 10,
    });

    // Format for full compatibility while providing rich multi-provider data
    const formattedResults = parallelResponse.results.map((r) => ({
      placeId: r.id,
      title: r.name,
      subtitle: r.formattedAddress.replace(r.name, '').replace(/^,\s*/, '') || r.formattedAddress,
      displayName: r.formattedAddress,
      lat: r.latitude,
      lng: r.longitude,
      type: r.type || 'place',
      isServiceable: r.isServiceable ?? false,
      serviceabilityMessage: r.serviceabilityMessage,
      matchedProviders: r.matchedProviders,
      providerCount: r.providerCount,
      relevance: r.relevance,
      address: r.address || {
        road: '',
        suburb: r.district || '',
        city: r.city || city,
        state: r.state || '',
        postcode: r.pincode || '',
        country: r.country || 'India',
      },
    }));

    res.json({
      success: true,
      results: formattedResults,
      providersQueried: parallelResponse.providersQueried,
      activeProviders: parallelResponse.activeProviders,
      attribution: 'Multi-Provider Search (Mapbox, Geoapify, Photon, Mappls)',
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Geocode proxy error:', error?.message);
    res.status(500).json({ success: false, error: 'Location lookup failed. Please select your location on the map.' });
  }
});

// ============================================================================
// 3. GET /api/location/reverse-geocode
// Reverse geocodes map pin coordinates to formatted address string + authoritative serviceability check
// ============================================================================
router.get('/reverse-geocode', publicLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ success: false, error: 'Valid latitude and longitude are required.' });
      return;
    }

    const roundedKey = `rev_${lat.toFixed(4)}_${lng.toFixed(4)}`;
    const cached = geocodeCache.get<any>(roundedKey);
    if (cached) {
      res.json({
        success: true,
        location: cached,
        isServiceable: cached.isServiceable,
        source: 'cache',
      });
      return;
    }

    await throttleNominatimApplicationWide();

    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        lat,
        lon: lng,
        format: 'json',
        addressdetails: 1,
        zoom: 18,
      },
      headers: {
        'User-Agent': 'OlivePizzaApp/1.0 (contact: olivepizzarjn@gmail.com; platform: customer-web)',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      timeout: 8000,
    });

    const data = response.data;
    const addr = data?.address || {};
    const formattedAddress =
      data?.display_name ||
      `${addr.road || ''}, ${addr.suburb || ''}, ${addr.city || addr.town || ''}`.replace(/^,\s*/, '');

    const resolvedCity = addr.city || addr.town || addr.village || addr.county || addr.state_district || '';
    const resolvedState = addr.state || '';
    const resolvedPostcode = addr.postcode || '';
    const resolvedCountry = addr.country || 'India';

    // Authoritative serviceability check
    const orderingResolution = await CustomerOrderingContextService.resolveOrderingContext({
      customerId: (req as any).user?.uid || 'guest',
      lat,
      lng,
      addressLine: formattedAddress,
    });

    const locationResult = {
      displayName: formattedAddress,
      lat,
      lng,
      road: addr.road || addr.pedestrian || '',
      neighbourhood: addr.neighbourhood || addr.suburb || '',
      city: resolvedCity,
      state: resolvedState,
      postcode: resolvedPostcode,
      country: resolvedCountry,
      isServiceable: orderingResolution.isServiceable,
      resolvedBranchId: orderingResolution.context?.branchId,
      resolvedFranchiseId: orderingResolution.context?.franchiseId,
      branchName: orderingResolution.context?.branchName,
      distanceKm: orderingResolution.context?.distanceKm,
      deliveryRadiusKm: orderingResolution.context?.deliveryRadiusKm,
      serviceabilityMessage: orderingResolution.isServiceable
        ? `Within delivery coverage (${orderingResolution.context?.distanceKm} km from ${orderingResolution.context?.branchName})`
        : orderingResolution.error || "We currently don't deliver to this location.",
    };

    geocodeCache.set(roundedKey, locationResult);

    res.json({
      success: true,
      location: locationResult,
      isServiceable: orderingResolution.isServiceable,
      attribution: '© OpenStreetMap contributors (ODbL)',
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Reverse geocode error:', error?.message);
    res.status(500).json({
      success: false,
      error: 'Could not resolve address details. You can continue with your selected pin.',
    });
  }
});

// ============================================================================
// ============================================================================
// 4. GET, POST, DELETE /api/location/save & /api/location/addresses
// Authoritative 8-location limit management with permanent DB deletion
// ============================================================================

// GET /api/location/saved & /api/location/addresses — List all saved delivery locations for authenticated user
router.get(['/saved', '/addresses', '/saved-locations'], verifyToken, userLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const userDoc = await adminDb.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data()! : {};

    // Harmonize across field naming conventions
    const addresses = userData.addresses || userData.savedAddresses || userData.locations || [];
    res.json({
      success: true,
      addresses,
      count: addresses.length,
      maxAllowed: 8,
      isLimitReached: addresses.length >= 8
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Fetch saved addresses error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch saved addresses.' });
  }
});

// POST /api/location/save — Add or update delivery location with strict 8-location maximum
router.post('/save', verifyToken, userLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user?.uid) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const {
      id,
      formattedAddress,
      addressLine,
      lat,
      lng,
      city,
      houseNumber,
      houseFlat,
      street,
      streetArea,
      landmark,
      floor,
      building,
      buildingName,
      pincode,
      deliveryInstructions,
      instructions,
      recipientName,
      recipientPhone,
      type = 'Home',
      label,
      isDefault
    } = req.body;

    const resolvedAddress = String(formattedAddress || addressLine || '').trim();
    if (!resolvedAddress || lat == null || lng == null) {
      res.status(400).json({
        success: false,
        error: 'Address and valid map coordinates are required.',
      });
      return;
    }

    const numLat = Number(lat);
    const numLng = Number(lng);

    if (isNaN(numLat) || isNaN(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
      res.status(400).json({ success: false, error: 'Invalid coordinate numbers provided.' });
      return;
    }

    // 1. Authoritative Backend Serviceability Verification
    const orderingResolution = await CustomerOrderingContextService.resolveOrderingContext({
      customerId: user.uid,
      lat: numLat,
      lng: numLng,
      addressLine: resolvedAddress,
    });

    if (!orderingResolution.isServiceable) {
      res.status(400).json({
        success: false,
        isServiceable: false,
        error: orderingResolution.error || "This location is currently outside Olive Pizza's delivery zone.",
        code: orderingResolution.code || 'OUT_OF_DELIVERY_ZONE',
      });
      return;
    }

    const userRef = adminDb.collection('users').doc(user.uid);
    const userSnap = await userRef.get();
    const existingUserData = userSnap.exists ? userSnap.data()! : {};
    const existingAddresses: any[] = existingUserData.addresses || existingUserData.savedAddresses || existingUserData.locations || [];

    const locationId = String(id || `loc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    const isExisting = existingAddresses.some((a) => a.id === locationId);

    // 2. Enforce 8-location maximum per user account
    if (!isExisting && existingAddresses.length >= 8) {
      res.status(400).json({
        success: false,
        code: 'LOCATION_LIMIT_EXCEEDED',
        error: 'Location limit reached (8/8). You can save up to 8 delivery locations. Please delete an existing location first.',
        currentCount: existingAddresses.length,
        maxLimit: 8
      });
      return;
    }

    const now = new Date().toISOString();
    const resolvedLabel = label || type || 'Other';

    const locationRecord = {
      id: locationId,
      type: type || 'Home',
      label: resolvedLabel,
      formattedAddress: resolvedAddress,
      addressLine: resolvedAddress,
      lat: numLat,
      lng: numLng,
      city: String(city || orderingResolution.context?.branchName || '').trim(),
      street: String(street || streetArea || '').trim() || null,
      streetArea: String(streetArea || street || '').trim() || null,
      houseNumber: String(houseNumber || houseFlat || '').trim() || null,
      houseFlat: String(houseFlat || houseNumber || '').trim() || null,
      landmark: String(landmark || '').trim() || null,
      floor: String(floor || '').trim() || null,
      building: String(building || buildingName || '').trim() || null,
      buildingName: String(buildingName || building || '').trim() || null,
      pincode: String(pincode || '').trim() || null,
      deliveryInstructions: String(deliveryInstructions || instructions || '').trim() || null,
      instructions: String(instructions || deliveryInstructions || '').trim() || null,
      recipientName: String(recipientName || '').trim() || null,
      recipientPhone: String(recipientPhone || '').trim() || null,
      isDefault: Boolean(isDefault ?? existingAddresses.length === 0),
      createdAt: isExisting ? (existingAddresses.find((a) => a.id === locationId)?.createdAt || now) : now,
      updatedAt: now,
    };

    // Update addresses array
    let updatedAddresses: any[];
    if (isExisting) {
      updatedAddresses = existingAddresses.map((a) => (a.id === locationId ? locationRecord : a));
    } else {
      updatedAddresses = [locationRecord, ...existingAddresses];
    }

    if (locationRecord.isDefault) {
      updatedAddresses = updatedAddresses.map((a) => ({
        ...a,
        isDefault: a.id === locationId
      }));
    }

    // 3. Persist to subcollection users/{uid}/saved_locations/{locationId}
    await userRef.collection('saved_locations').doc(locationId).set(locationRecord, { merge: true });

    // 4. Update primary user document across all legacy and canonical fields
    await userRef.set(
      {
        uid: user.uid,
        defaultLocationId: locationRecord.isDefault ? locationId : existingUserData.defaultLocationId || locationId,
        locationSetupCompleted: true,
        role: 'customer',
        location: {
          lat: numLat,
          lng: numLng,
          address: resolvedAddress,
          city: locationRecord.city,
          landmark: locationRecord.landmark,
          houseNumber: locationRecord.houseNumber,
        },
        fullAddress: resolvedAddress,
        full_address: resolvedAddress,
        lat: numLat,
        lng: numLng,
        addresses: updatedAddresses,
        savedAddresses: updatedAddresses,
        locations: updatedAddresses,
        updatedAt: now,
      },
      { merge: true }
    );

    res.json({
      success: true,
      message: 'Delivery location saved successfully.',
      location: locationRecord,
      addresses: updatedAddresses,
      orderingContext: orderingResolution.context,
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Save location error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Failed to save delivery location.' });
  }
});

// DELETE /api/location/saved/:id & /api/location/addresses/:id — Permanently deletes a saved location from DB
router.delete(['/saved/:id', '/addresses/:id', '/saved-locations/:id'], verifyToken, userLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const locationId = req.params.id;

    if (!uid || !locationId) {
      res.status(400).json({ success: false, error: 'User ID and Location ID are required.' });
      return;
    }

    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    const userData = userSnap.data()!;
    const existing: any[] = userData.addresses || userData.savedAddresses || userData.locations || [];
    const target = existing.find((a) => a.id === locationId);

    const remaining = existing.filter((a) => a.id !== locationId);

    // If default location was deleted and others remain, make the first remaining address default
    if (target?.isDefault && remaining.length > 0) {
      remaining[0].isDefault = true;
    }

    // 1. Permanently delete from subcollection
    await userRef.collection('saved_locations').doc(locationId).delete().catch(() => {});

    // 2. Permanently update user document arrays
    const updates: Record<string, any> = {
      addresses: remaining,
      savedAddresses: remaining,
      locations: remaining,
      updatedAt: new Date().toISOString()
    };

    if (remaining.length > 0 && target?.isDefault) {
      updates.defaultLocationId = remaining[0].id;
      updates.lat = remaining[0].lat;
      updates.lng = remaining[0].lng;
      updates.fullAddress = remaining[0].formattedAddress || remaining[0].addressLine;
      updates.full_address = updates.fullAddress;
    }

    await userRef.update(updates);

    res.json({
      success: true,
      message: 'Location permanently deleted from database.',
      deletedId: locationId,
      remainingCount: remaining.length,
      addresses: remaining
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Delete address error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete address.' });
  }
});

// ============================================================================
// 5. POST /api/location/select
// Authoritatively sets and validates selected delivery coordinates
// ============================================================================
router.post('/select', userLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const rawLat = req.body?.lat ?? req.body?.latitude;
    const rawLng = req.body?.lng ?? req.body?.longitude;
    const addressLine = String(req.body?.addressLine || req.body?.formattedAddress || '').trim();
    const customerId = (req as any).user?.uid || req.body?.customerId || 'guest';

    const lat = parseFloat(String(rawLat));
    const lng = parseFloat(String(rawLng));

    if (isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ success: false, error: 'Valid latitude and longitude numbers are required.' });
      return;
    }

    const resolution = await CustomerOrderingContextService.resolveOrderingContext({
      customerId,
      lat,
      lng,
      addressLine,
    });

    res.json({
      success: true,
      selectedLocation: {
        latitude: lat,
        longitude: lng,
        formattedAddress: addressLine,
        isServiceable: resolution.isServiceable,
        branchId: resolution.context?.branchId,
        branchName: resolution.context?.branchName,
        distanceKm: resolution.context?.distanceKm,
        deliveryFee: resolution.context?.deliveryFee,
      },
      orderingContext: resolution.context,
      isServiceable: resolution.isServiceable,
      error: resolution.error,
    });
  } catch (error: any) {
    console.error('[LocationRoutes] Location select error:', error);
    res.status(500).json({ success: false, error: 'Failed to set selected location.' });
  }
});

export default router;
