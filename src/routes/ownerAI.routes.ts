import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { OwnerAIService } from '../services/ai/OwnerAIService.js';

const router = Router();

router.use(verifyToken);
router.use(requireRole(['owner', 'admin', 'developer']));

router.post('/command', async (req: AuthRequest, res: Response) => {
  try {
    const { command, sessionId } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'Command text is required' });
    }
    const result = await OwnerAIService.processOwnerCommand(
      command,
      req.user?.uid || 'anonymous',
      sessionId
    );
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const history = await OwnerAIService.getAISessionHistory(limit);
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
