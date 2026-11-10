import { Router, Request, Response } from 'express';
import { AnalyticsService } from '../services/websiteConfig/AnalyticsService.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Public batch analytics ingestion from frontend clients
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: 'events array is required' });
    }
    const inserted = await AnalyticsService.recordBatchEvents(events);
    res.json({ success: true, count: inserted });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Protected summary metrics for Owner and Developer Dashboards
router.get('/summary', verifyToken, requireRole(['owner', 'admin', 'developer']), async (req: AuthRequest, res: Response) => {
  try {
    const days = parseInt((req.query.days as string) || '7', 10);
    const summary = await AnalyticsService.getSectionSummary(days);
    res.json({ success: true, summary });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Web Vitals for Developer Profiler
router.get('/web-vitals', verifyToken, requireRole(['developer']), async (_req: AuthRequest, res: Response) => {
  try {
    const vitals = await AnalyticsService.getWebVitals();
    res.json({ success: true, vitals });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
