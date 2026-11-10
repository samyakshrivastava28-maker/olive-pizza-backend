import { Router, Request, Response } from 'express';
import { adminDb } from '../config/firebase.js';
import { redisService } from '../services/redis/RedisService.js';

const router = Router();

const DEFAULT_APP_CONFIGS: Record<string, any> = {
  customer: {
    appName: 'Olive Pizza',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    updateUrl: 'https://play.google.com/store/apps/details?id=com.olivepizza.app',
    maintenanceMode: false,
    supportPhone: '+919109033338',
    supportEmail: 'olivepizzarjn@gmail.com',
    features: {
      aiAssistant: true,
      liveTracking: true,
      truecallerAuth: true,
      couponsEnabled: true,
      onlinePayments: true,
      codEnabled: true,
    },
    delivery: {
      freeDeliveryThreshold: 399,
      baseDeliveryFee: 30,
      maxDeliveryRadiusKm: 15,
      estimatedDeliveryTimeMin: 30
    }
  },
  owner: {
    appName: 'Olive Pizza Owner',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    maintenanceMode: false,
    features: {
      analytics: true,
      homePageManager: true,
      deliveryFleetRadar: true,
      reportsExport: true,
      emailStudio: true,
      pushNotifications: true
    }
  },
  manager: {
    appName: 'Olive Pizza Restaurant Management',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    features: {
      storeControl: true,
      scheduleManagement: true,
      serviceOverrides: true,
      staffDirectory: true,
      auditLogs: true
    }
  },
  delivery: {
    appName: 'Olive Pizza Delivery',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    updateUrl: 'https://play.google.com/store/apps/details?id=com.olivepizza.delivery',
    features: {
      gpsTracking: true,
      orderAlarms: true,
      offlineCache: true,
      locationStreamingIntervalMs: 2000
    }
  },
  pos: {
    appName: 'Olive Pizza POS',
    minVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    features: {
      escposPrinting: true,
      offlineBilling: true,
      autoSheetsSync: true,
      terminalBinding: true
    }
  }
};

router.get('/:app', async (req: Request, res: Response) => {
  try {
    const appKey = (req.params.app || '').toLowerCase();
    const fallback = DEFAULT_APP_CONFIGS[appKey] || DEFAULT_APP_CONFIGS.customer;

    const data = await redisService.fetchWithStampedeProtection(
      `cache:app_config:${appKey}`,
      async () => {
        try {
          const docSnap = await adminDb.collection('remote_configs').doc(appKey).get();
          if (docSnap.exists) {
            return {
              ...fallback,
              ...docSnap.data(),
              fetchedAt: new Date().toISOString()
            };
          }
        } catch (e) {
          // Non-fatal, return fallback
        }

        return {
          ...fallback,
          fetchedAt: new Date().toISOString()
        };
      },
      { ttlSeconds: 600, jitterSeconds: 60 }
    );

    return res.json({
      success: true,
      data
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch remote configuration'
    });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    return res.json({
      success: true,
      data: DEFAULT_APP_CONFIGS,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to list app configurations'
    });
  }
});

export default router;
