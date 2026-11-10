import { Router, Request, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';

const router = Router();
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

export interface LatLng {
  lat: number;
  lng: number;
}

function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / 1e5, lat / 1e5]); // [lng, lat]
  }
  return coords;
}

// ─── POST /api/navigation/route ──────────────────────────────────────────────
router.post('/route', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { origin, destination, orderId } = req.body;

    const oLat = Number(origin?.lat);
    const oLng = Number(origin?.lng);
    const dLat = Number(destination?.lat);
    const dLng = Number(destination?.lng);

    if (
      !Number.isFinite(oLat) || !Number.isFinite(oLng) ||
      !Number.isFinite(dLat) || !Number.isFinite(dLng) ||
      oLat < -90 || oLat > 90 || dLat < -90 || dLat > 90 ||
      oLng < -180 || oLng > 180 || dLng < -180 || dLng > 180
    ) {
      res.status(400).json({ error: 'Valid numeric origin and destination coordinates are required' });
      return;
    }

    const url = `${OSRM_BASE}/${oLng},${oLat};${dLng},${dLat}?overview=full&geometries=polyline&steps=true&annotations=false`;
    const fetchRes = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!fetchRes.ok) {
      throw new Error(`OSRM API error: ${fetchRes.status}`);
    }

    const data: any = await fetchRes.json();

    if (!data.routes || data.routes.length === 0) {
      res.status(404).json({ error: 'No route found between coordinates' });
      return;
    }

    const route = data.routes[0];
    const distanceMeters = Math.round(route.distance);
    const durationSeconds = Math.round(route.duration);
    const coordinates = decodePolyline(route.geometry);

    const steps = (route.legs?.[0]?.steps || []).map((s: any) => ({
      instruction: s.maneuver?.instruction || s.name || 'Proceed along route',
      distanceMeters: Math.round(s.distance),
      durationSeconds: Math.round(s.duration),
      modifier: s.maneuver?.modifier || null,
      type: s.maneuver?.type || 'turn'
    }));

    res.json({
      success: true,
      orderId: orderId || null,
      distanceKm: Number((distanceMeters / 1000).toFixed(2)),
      durationMinutes: Math.ceil(durationSeconds / 60),
      geometry: route.geometry,
      coordinates,
      steps
    });
  } catch (err: any) {
    console.error('[NavigationRoute] Route calculation error:', err.message);
    res.status(500).json({ error: 'Failed to calculate navigation route' });
  }
});

// ─── POST /api/navigation/session/start ─────────────────────────────────────
router.post('/session/start', verifyToken, requireRole(['delivery', 'delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    const deliveryPartnerId = req.user?.uid;

    if (!orderId || !deliveryPartnerId) {
      res.status(400).json({ error: 'Missing orderId or deliveryPartnerId' });
      return;
    }

    const sessionId = `nav_${orderId}_${deliveryPartnerId}`;
    await SupabaseGpsService.startNavigationSession({
      sessionId,
      orderId,
      deliveryPartnerId
    });

    res.json({ success: true, sessionId, status: 'ACTIVE' });
  } catch (err: any) {
    console.error('[NavigationSession] Start session error:', err.message);
    res.status(500).json({ error: 'Failed to start navigation session' });
  }
});

// ─── POST /api/navigation/session/update ────────────────────────────────────
router.post('/session/update', verifyToken, requireRole(['delivery', 'delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, latitude, longitude, speed, heading, accuracy } = req.body;
    const deliveryPartnerId = req.user?.uid;

    if (!orderId || latitude === undefined || longitude === undefined || !deliveryPartnerId) {
      res.status(400).json({ error: 'Missing required navigation update fields' });
      return;
    }

    const sessionId = `nav_${orderId}_${deliveryPartnerId}`;

    // Ensure session is ACTIVE & record telemetry point directly in Supabase
    await SupabaseGpsService.startNavigationSession({
      sessionId,
      orderId,
      deliveryPartnerId
    });

    await SupabaseGpsService.appendNavigationPoint({
      sessionId,
      orderId,
      latitude: Number(latitude),
      longitude: Number(longitude),
      speed: speed != null ? Number(speed) : null,
      heading: heading != null ? Number(heading) : null,
      accuracy: accuracy != null ? Number(accuracy) : null
    });

    res.json({ success: true, sessionId });
  } catch (err: any) {
    console.error('[NavigationSession] Update session error:', err.message);
    res.status(500).json({ error: 'Failed to record navigation telemetry' });
  }
});

// ─── POST /api/navigation/session/stop ─────────────────────────────────────
router.post('/session/stop', verifyToken, requireRole(['delivery', 'delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.body;
    const deliveryPartnerId = req.user?.uid;

    if (!orderId || !deliveryPartnerId) {
      res.status(400).json({ error: 'Missing orderId or deliveryPartnerId' });
      return;
    }

    const sessionId = `nav_${orderId}_${deliveryPartnerId}`;
    await SupabaseGpsService.endNavigationSession(sessionId);

    res.json({ success: true, sessionId, status: 'STOPPED', expiresAtInMinutes: 5 });
  } catch (err: any) {
    console.error('[NavigationSession] Stop session error:', err.message);
    res.status(500).json({ error: 'Failed to stop navigation session' });
  }
});

export default router;
