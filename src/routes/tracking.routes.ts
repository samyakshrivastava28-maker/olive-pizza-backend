import { Router, Request, Response } from 'express';
import { pgPool } from '../config/postgres.js';
import { adminDb } from '../config/firebase.js';
import { verifyToken, requireRole, optionalAuth, AuthRequest } from '../middleware/auth.middleware.js';
import { generateTrackingToken, verifyTrackingToken } from '../utils/trackingToken.js';
import { SupabaseGpsService } from '../services/gps/SupabaseGpsService.js';
import { RedisGpsService } from '../services/gps/RedisGpsService.js';

const router = Router();

// Helper to calculate distance in km using Haversine formula
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Helper to calculate ETA (assuming average speed of 30 km/h in city if no speed provided)
function calculateETA(distanceKm: number, speedKmh?: number): number {
  const avgSpeed = speedKmh && speedKmh > 0 ? speedKmh : 30;
  return Math.ceil((distanceKm / avgSpeed) * 60); // returns minutes
}

import { webSocketServer } from '../services/websocket/WebSocketServer.js';

// Default Olive Pizza Main Branch Coordinates (Rajnandgaon)
const DEFAULT_BRANCH_LAT = 21.0967;
const DEFAULT_BRANCH_LNG = 81.0315;
const DEFAULT_MAX_DELIVERY_RADIUS_KM = 12.0;


// ─── GPS TELEMETRY VALIDATION & DEPARTURE REMINDER ENGINE ──────────────────
interface GpsValidationResult {
  valid: boolean;
  error?: string;
}

function validateGpsTelemetry(lat: number, lng: number, speed?: number, timestamp?: string): GpsValidationResult {
  if (isNaN(lat) || lat < -90 || lat > 90) {
    return { valid: false, error: 'Invalid latitude value (-90 to 90 required)' };
  }
  if (isNaN(lng) || lng < -180 || lng > 180) {
    return { valid: false, error: 'Invalid longitude value (-180 to 180 required)' };
  }
  // Max realistic speed: 150 km/h (41.6 m/s)
  if (speed !== undefined && speed !== null && (speed < 0 || speed > 42)) {
    return { valid: false, error: 'Unrealistic rider speed detected' };
  }
  if (timestamp) {
    const timeMs = new Date(timestamp).getTime();
    const nowMs = Date.now();
    // Reject timestamps older than 2 minutes or more than 1 minute in the future
    if (nowMs - timeMs > 120000) {
      return { valid: false, error: 'Stale GPS timestamp (> 2 minutes old)' };
    }
    if (timeMs - nowMs > 60000) {
      return { valid: false, error: 'Future GPS timestamp detected' };
    }
  }
  return { valid: true };
}

// Updates delivery partner location
router.post('/location/update', verifyToken, requireRole(['delivery', 'delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { partnerId, orderId, latitude, longitude, lat, lng, accuracy, speed, heading, battery, isMoving } = req.body;
    const actualPartnerId = partnerId || req.user?.uid;
    const actualLat = latitude !== undefined ? latitude : lat;
    const actualLng = longitude !== undefined ? longitude : lng;
    
    if (!actualPartnerId || actualLat === undefined || actualLng === undefined) {
      return res.status(400).json({ error: 'Missing required location data' });
    }

    const validation = validateGpsTelemetry(Number(actualLat), Number(actualLng), speed, req.body.timestamp);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    if (req.user?.uid !== actualPartnerId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Cannot update other partner locations' });
    }

    // ⚡ INSTANT WEBSOCKET BROADCAST (<5ms latency to all listening customers & owners)
    webSocketServer.handleDriverLocationUpdate({
      deliveryPartnerId: actualPartnerId,
      orderId: orderId || null,
      lat: Number(actualLat),
      lng: Number(actualLng),
      accuracy: accuracy || 5,
      speed: speed || 0,
      heading: heading || 0,
      battery: battery || 100,
      isMoving: isMoving !== undefined ? isMoving : (Number(speed || 0) > 1),
      timestamp: new Date().toISOString(),
      status: 'ONLINE'
    });

    // 1. Authoritative Capacity-Safe Redis live GPS telemetry update (Layerbase Redis 7.2.15)
    await RedisGpsService.updateLocation({
      deliveryPartnerId: actualPartnerId,
      franchiseId: req.user?.franchiseId || 'fra_primary',
      branchId: req.user?.branchId || 'main_branch',
      activeOrderId: orderId || null,
      latitude: Number(actualLat),
      longitude: Number(actualLng),
      accuracy: accuracy ? Number(accuracy) : null,
      speed: speed ? Number(speed) : null,
      heading: heading ? Number(heading) : null,
      battery: battery ? Number(battery) : null,
      onlineStatus: true,
      timestamp: req.body.timestamp
    });

    let client: any = null;
    try {
      client = await pgPool.connect();

      // ── 300M RESTAURANT DEPARTURE REMINDER RULE ──────────────────────────
      if (orderId) {
        try {
          const orderSnap = await adminDb.collection('orders').doc(orderId).get();
          if (orderSnap.exists) {
            const oData = orderSnap.data()!;
            const oStatus = (oData.status || '').toLowerCase();
            
            // Trigger reminder if rider is assigned/ready but has not moved to 'picked_up' or 'out_for_delivery'
            if (['partner_assigned', 'ready'].includes(oStatus)) {
              const restLat = oData.branchLat || DEFAULT_BRANCH_LAT;
              const restLng = oData.branchLng || DEFAULT_BRANCH_LNG;
              const distFromRestM = calculateDistance(Number(actualLat), Number(actualLng), Number(restLat), Number(restLng)) * 1000;
              
              if (distFromRestM >= 300 && (accuracy || 10) <= 35) {
                console.log(`[DepartureRule] Rider ${actualPartnerId} is ${Math.round(distFromRestM)}m from store for order ${orderId}. Reminder triggered.`);
                // Emit instant departure reminder event to rider
                webSocketServer.broadcastToUser(actualPartnerId, {
                  type: 'DEPARTURE_REMINDER',
                  data: {
                    orderId,
                    distanceMeters: Math.round(distFromRestM),
                    message: 'You have moved 300m away from the restaurant. Please update your order status to Picked Up.'
                  }
                });
              }
            }
          }
        } catch (depErr: any) {
          console.warn('[DepartureRule] Check notice:', depErr.message);
        }

        // If there's an active order, update distance and ETA in delivery_routes
        try {
          const routeResult = await client.query('SELECT customer_lat, customer_lng FROM delivery_routes WHERE order_id = $1 AND delivery_partner_id = $2', [orderId, actualPartnerId]);
          
          if (routeResult.rows.length > 0) {
            const route = routeResult.rows[0];
            if (route.customer_lat && route.customer_lng) {
              const distance = calculateDistance(actualLat, actualLng, route.customer_lat, route.customer_lng);
              const eta = calculateETA(distance, speed ? speed * 3.6 : 30); // speed in m/s to km/h if available

              await client.query(`
                UPDATE delivery_routes 
                SET distance_km = $1, estimated_minutes = $2 
                WHERE order_id = $3 AND delivery_partner_id = $4
              `, [distance, eta, orderId, actualPartnerId]);
            }
          }
        } catch (rErr: any) {
          // delivery_routes table might not exist in all environments; fail safely
        }
      }
    } finally {
      if (client) client.release();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Returns current location of a partner (Authorized for that partner, managers, or owners)
router.get('/location/:partnerId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { partnerId } = req.params;
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const isSelf = user.uid === partnerId;
    const isStaffOrOwner = ['owner', 'admin', 'developer', 'restaurant_manager', 'manager', 'franchise_owner', 'platform_owner'].includes(user.role || '');

    if (!isSelf && !isStaffOrOwner) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to view this partner location' });
    }

    const loc = await SupabaseGpsService.getLatestLocation(partnerId);
    if (!loc) {
      return res.status(404).json({ error: 'Partner location not found' });
    }
    res.json(loc);
  } catch (error) {
    console.error('Error getting location:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get active deliveries for Owner
router.get('/active', verifyToken, requireRole(['owner']), async (req: Request, res: Response) => {
  try {
    // Single Source of Truth: Authoritative live locations from Supabase
    const activeLocations = await SupabaseGpsService.getActiveLocations();
    let routesMap = new Map<string, any>();
    try {
      const client = await pgPool.connect();
      const routesRes = await client.query(`SELECT * FROM delivery_routes WHERE is_active = true OR created_at > NOW() - INTERVAL '2 hours'`).catch(() => ({ rows: [] }));
      client.release();
      routesRes.rows.forEach((r: any) => routesMap.set(r.delivery_partner_id, r));
    } catch {}

    const combined = activeLocations.map((loc: any) => {
      const route = routesMap.get(loc.delivery_partner_id) || {};
      return {
        ...loc,
        distance_km: route.distance_km || null,
        estimated_minutes: route.estimated_minutes || null,
        order_id: loc.active_order_id || route.order_id || null
      };
    });

    res.json(combined);
  } catch (error) {
    console.error('Error getting active tracking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Tracking Token Endpoint — Generate signed token for an order ────────────
// Called by authenticated clients to get a token for embedding in shareable links.
router.get('/token/:orderId', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const orderDoc = await adminDb.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data()!;

    const isOwner = req.user?.role === 'owner' || req.user?.role === 'admin';
    const isCustomer = req.user?.uid === order.userId || req.user?.uid === order.customerId;
    const isPartner = req.user?.uid === order.deliveryPartnerId;

    if (!isOwner && !isCustomer && !isPartner) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const token = generateTrackingToken(orderId);
    return res.json({ token, expiresInHours: 4 });
  } catch (error) {
    console.error('Error generating tracking token:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Returns Partner location, ETA, Distance for an order
// Accepts EITHER a valid signed trackingToken query param (unauthenticated deep links)
// OR an authenticated session where the user is the order customer/owner/partner.
router.get('/order/:orderId', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.params;

    // Security Check: Verify user is authorized to view this GPS data
    const orderDoc = await adminDb.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderDoc.data();
    const isOwner = req.user?.role === 'owner' || req.user?.role === 'admin';
    const isAssignedPartner = req.user?.uid === order?.deliveryPartnerId;
    const isCustomer = req.user?.uid === order?.userId || req.user?.uid === order?.customerId;

    // Also allow access via a valid signed tracking token (push notification deep links)
    const rawToken = req.query.trackingToken as string | undefined;
    const tokenOrderId = rawToken ? verifyTrackingToken(rawToken) : null;
    const hasValidToken = tokenOrderId === orderId;

    if (!isOwner && !isAssignedPartner && !isCustomer && !hasValidToken) {
      return res.status(403).json({ error: 'Forbidden: You do not have permission to track this order' });
    }

    // Single Source of Truth: Authoritative live location from Supabase
    const partnerId = order?.deliveryPartnerId;
    let liveLoc: any = null;
    if (partnerId) {
      liveLoc = await SupabaseGpsService.getLatestLocation(partnerId);
    } else {
      liveLoc = await SupabaseGpsService.getLatestLocationByOrder(orderId);
    }

    let routeData: any = {};
    try {
      const client = await pgPool.connect();
      const result = await client.query(`
        SELECT distance_km, estimated_minutes, customer_lat, customer_lng, restaurant_lat, restaurant_lng
        FROM delivery_routes
        WHERE order_id = $1
      `, [orderId]);
      client.release();
      if (result.rows.length > 0) {
        routeData = result.rows[0];
      }
    } catch {}

    const partnerLat = liveLoc?.latitude != null ? Number(liveLoc.latitude) : (order?.driverLocation?.lat || null);
    const partnerLng = liveLoc?.longitude != null ? Number(liveLoc.longitude) : (order?.driverLocation?.lng || null);

    return res.json({
      order_id: orderId,
      status: order?.status || 'accepted',
      restaurant_lat: routeData.restaurant_lat || order?.restaurantLat || DEFAULT_BRANCH_LAT,
      restaurant_lng: routeData.restaurant_lng || order?.restaurantLng || DEFAULT_BRANCH_LNG,
      customer_lat: routeData.customer_lat || order?.deliveryAddress?.lat || null,
      customer_lng: routeData.customer_lng || order?.deliveryAddress?.lng || null,
      delivery_partner_id: partnerId || null,
      partner_lat: partnerLat,
      partner_lng: partnerLng,
      heading: liveLoc?.heading != null ? Number(liveLoc.heading) : (order?.driverLocation?.heading || 0),
      speed: liveLoc?.speed != null ? Number(liveLoc.speed) : (order?.driverLocation?.speed || 0),
      distance_km: routeData.distance_km || null,
      estimated_minutes: routeData.estimated_minutes || null,
      partner_name: order?.deliveryPartnerName || null,
      partner_phone: order?.deliveryPartnerPhone || null,
      last_updated: liveLoc?.last_updated || order?.driverLocation?.updatedAt || order?.updatedAt || new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting tracking info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Creates tracking session
router.post('/navigation/start', verifyToken, requireRole(['delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, partnerId, customerLat, customerLng, restaurantLat, restaurantLng } = req.body;
    
    if (!orderId || !partnerId) {
      return res.status(400).json({ error: 'Missing orderId or partnerId' });
    }

    if (req.user?.uid !== partnerId) {
      return res.status(403).json({ error: 'Forbidden: Cannot start tracking for other partners' });
    }

    const client = await pgPool.connect();
    
    await client.query(`
      INSERT INTO delivery_routes 
        (order_id, delivery_partner_id, customer_lat, customer_lng, restaurant_lat, restaurant_lng)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [orderId, partnerId, customerLat, customerLng, restaurantLat, restaurantLng]);
    
    client.release();
    
    // Authoritative update in Supabase delivery_locations (Single Source of Truth for live GPS)
    await SupabaseGpsService.setActiveOrder(partnerId, orderId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error starting navigation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ends tracking session
router.post('/navigation/stop', verifyToken, requireRole(['delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, partnerId } = req.body;
    
    if (!orderId || !partnerId) {
      return res.status(400).json({ error: 'Missing orderId or partnerId' });
    }

    if (req.user?.uid !== partnerId) {
      return res.status(403).json({ error: 'Forbidden: Cannot stop tracking for other partners' });
    }

    const client = await pgPool.connect();
    
    // Get route data before deleting
    const routeResult = await client.query('SELECT * FROM delivery_routes WHERE order_id = $1', [orderId]);
    
    if (routeResult.rows.length > 0) {
      const route = routeResult.rows[0];
      
      // Move to history
      await client.query(`
        INSERT INTO delivery_history 
          (order_id, delivery_partner_id, pickup_time, delivery_time, distance_km)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
      `, [orderId, partnerId, route.created_at, route.distance_km]);
      
      // Delete route
      await client.query('DELETE FROM delivery_routes WHERE order_id = $1', [orderId]);
    }
    client.release();

    // Clear active order from Supabase live GPS location
    await SupabaseGpsService.clearActiveOrder(partnerId, orderId);

    res.json({ success: true });
  } catch (error) {
    console.error('Error stopping navigation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update offline status
router.post('/status', verifyToken, requireRole(['delivery_partner']), async (req: AuthRequest, res: Response) => {
  try {
    const { partnerId, status } = req.body; // status: boolean

    if (req.user?.uid !== partnerId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update status for other partners' });
    }

    // Authoritative update in Supabase delivery_locations
    await SupabaseGpsService.setOnlineStatus(partnerId, Boolean(status));

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check if customer coordinate is within store delivery radius
router.post('/boundary-check', async (req: Request, res: Response) => {
  try {
    const { lat, lng, branchLat, branchLng, maxRadiusKm } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    const bLat = Number(branchLat || DEFAULT_BRANCH_LAT);
    const bLng = Number(branchLng || DEFAULT_BRANCH_LNG);
    const radiusLimit = Number(maxRadiusKm || DEFAULT_MAX_DELIVERY_RADIUS_KM);

    const distanceKm = Number(calculateDistance(Number(lat), Number(lng), bLat, bLng).toFixed(2));
    const inside = distanceKm <= radiusLimit;
    const estimatedMinutes = calculateETA(distanceKm, 25);

    res.json({
      success: true,
      inside,
      distanceKm,
      maxRadiusKm: radiusLimit,
      estimatedMinutes,
      message: inside ? 'Location is within our delivery zone' : `Location is ${distanceKm} km away, which exceeds our maximum delivery radius of ${radiusLimit} km.`
    });
  } catch (error: any) {
    console.error('Error in boundary check:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get real-time driver active fleet status (Staff & Owner only)
router.get('/active-drivers', verifyToken, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'manager', 'franchise_owner', 'platform_owner']), async (_req: AuthRequest, res: Response) => {
  try {
    const activeDrivers = webSocketServer.getActiveDriverLocations();
    res.json({ success: true, count: activeDrivers.length, data: activeDrivers });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get active driver locations for owner / manager tracking (Single Source of Truth: Supabase)
router.get('/locations/active', verifyToken, requireRole(['owner', 'admin', 'developer', 'restaurant_manager', 'manager', 'franchise_owner', 'platform_owner']), async (req: AuthRequest, res: Response) => {
  try {
    const activeLocations = await SupabaseGpsService.getActiveLocations();
    const locations = activeLocations.map((loc: any) => ({
      id: loc.id || loc.delivery_partner_id,
      delivery_partner_id: loc.delivery_partner_id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      speed: loc.speed || 0,
      bearing: loc.heading || 0,
      updated_at: loc.last_updated || new Date().toISOString(),
      active_order_id: loc.active_order_id || null
    }));
    res.json(locations);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
