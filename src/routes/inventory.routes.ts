import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { InventoryService } from '../services/inventory/InventoryService.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';

const router = Router();
router.use(verifyToken);

/**
 * GET /api/inventory
 * List raw materials & stock for the caller's branch
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const branchId = FranchiseScopeService.getEffectiveBranchId(scope, req.query.branchId as string);
    const items = await InventoryService.listItems(branchId);
    res.json({ success: true, count: items.length, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/inventory
 * Add new raw material item (Manager/Owner)
 */
router.post('/', requireRole(['owner', 'admin', 'manager', 'restaurant_manager', 'franchise_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const branchId = FranchiseScopeService.getEffectiveBranchId(scope, req.body.branchId);

    const item = await InventoryService.createItem({
      ...req.body,
      branchId,
      franchiseId: scope.franchiseId,
      organizationId: scope.organizationId,
    }, req.user?.uid || 'manager');

    res.json({ success: true, item });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/inventory/adjust
 * Record stock adjustment (Usage, Restock, Wastage)
 */
router.post('/adjust', requireRole(['owner', 'admin', 'manager', 'restaurant_manager', 'kitchen_staff']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { itemId, quantityChanged, adjustmentType, reason } = req.body;
    if (!itemId || quantityChanged === undefined || !adjustmentType) {
      res.status(400).json({ error: 'itemId, quantityChanged, and adjustmentType are required' });
      return;
    }

    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const branchId = FranchiseScopeService.getEffectiveBranchId(scope, req.body.branchId);

    const result = await InventoryService.adjustStock({
      itemId,
      branchId,
      franchiseId: scope.franchiseId,
      adjustmentType,
      quantityChanged: Number(quantityChanged),
      reason,
      performedBy: req.user?.uid || 'staff',
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/inventory/alerts
 * Get active low-stock alerts for branch or franchise
 */
router.get('/alerts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const scope = req.user?.scope || FranchiseScopeService.resolveScope(req.user);
    const branchId = FranchiseScopeService.getEffectiveBranchId(scope, req.query.branchId as string);
    const alerts = await InventoryService.getLowStockAlerts({
      branchId: scope.isBranchScoped ? branchId : (req.query.branchId as string),
      franchiseId: scope.isFranchiseOwner ? scope.franchiseId : (req.query.franchiseId as string),
    });
    res.json({ success: true, count: alerts.length, alerts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
