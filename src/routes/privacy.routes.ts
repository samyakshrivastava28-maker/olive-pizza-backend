import { Router, Response } from 'express';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';
import { PrivacyService } from '../services/privacy/PrivacyService.js';
import { adminDb } from '../config/firebase.js';

const router = Router();

// ────────────────────────────────────────────────────────────────────────────
// 1. PUBLIC / CUSTOMER NOTICE
// ────────────────────────────────────────────────────────────────────────────

// GET /api/privacy/policy — Retrieve active Privacy Notice (Publicly accessible)
router.get('/policy', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const policy = await PrivacyService.getActivePolicy();
    res.json({ success: true, policy });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch privacy policy:', error);
    res.status(500).json({ error: 'Failed to fetch privacy policy' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. AUTHENTICATED CUSTOMER PRIVACY ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────

// GET /api/privacy/consents — Fetch authenticated user's consent choices
router.get('/consents', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const consents = await PrivacyService.getUserConsents(uid);
    res.json({ success: true, consents });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch consents:', error);
    res.status(500).json({ error: 'Failed to fetch consents' });
  }
});

// POST /api/privacy/consent — Grant or record a consent choice
router.post('/consent', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { purpose, granted, policyVersion } = req.body;
    const validPurposes = ['MARKETING_PROMOTIONS', 'MARKETING_SMS', 'MARKETING_EMAIL', 'ANALYTICS_OPTIONAL'];
    if (!validPurposes.includes(purpose)) {
      res.status(400).json({ error: `Invalid consent purpose. Must be one of: ${validPurposes.join(', ')}` });
      return;
    }

    const activePolicy = await PrivacyService.getActivePolicy();
    await PrivacyService.recordConsent({
      userId: uid,
      purpose,
      granted: Boolean(granted),
      policyVersion: policyVersion || activePolicy.version,
      source: 'CUSTOMER_APP',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: `Consent for ${purpose} successfully updated.` });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to record consent:', error);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// POST /api/privacy/consent/withdraw — Withdraw optional consent
router.post('/consent/withdraw', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { purpose } = req.body;
    const validPurposes = ['MARKETING_PROMOTIONS', 'MARKETING_SMS', 'MARKETING_EMAIL', 'ANALYTICS_OPTIONAL'];
    if (!validPurposes.includes(purpose)) {
      res.status(400).json({ error: `Invalid consent purpose. Must be one of: ${validPurposes.join(', ')}` });
      return;
    }

    await PrivacyService.withdrawConsent(uid, purpose, req.ip);
    res.json({ success: true, message: `Consent for ${purpose} withdrawn successfully. Food ordering remains fully functional.` });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to withdraw consent:', error);
    res.status(500).json({ error: 'Failed to withdraw consent' });
  }
});

// POST /api/privacy/data-access-request — Generate and retrieve structured personal data export
router.post('/data-access-request', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const exportData = await PrivacyService.generateDataExport(uid);
    res.json({
      success: true,
      message: 'Personal data archive compiled successfully under DPDP Right to Access.',
      data: exportData
    });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Data access request failed:', error);
    res.status(500).json({ error: 'Failed to process data access request' });
  }
});

// POST /api/privacy/correction-request — Self-service customer data correction
router.post('/correction-request', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await PrivacyService.correctUserData(uid, req.body);
    res.json({
      success: true,
      message: 'Information updated successfully in compliance with DPDP Right to Correction.',
      updatedFields: result.updatedFields
    });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Data correction failed:', error);
    res.status(400).json({ error: error.message || 'Failed to update personal data' });
  }
});

// POST /api/privacy/deletion-request — Request account erasure with 30-day grace period
router.post('/deletion-request', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { email, reason, downloadDataRequested } = req.body;
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email address is required to verify identity.' });
      return;
    }

    const result = await PrivacyService.requestAccountDeletion({
      uid,
      email,
      reason: reason || 'Customer requested deletion via Privacy Center',
      downloadDataRequested: Boolean(downloadDataRequested),
      ipAddress: req.ip
    });

    res.json({
      success: true,
      message: 'Account erasure request accepted. In compliance with statutory tax retention laws, tax invoices are pseudonymized rather than destroyed.',
      requestId: result.requestId,
      gracePeriodEnd: result.gracePeriodEnd,
      activeOrdersCount: result.activeOrdersCount
    });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Deletion request failed:', error);
    res.status(500).json({ error: error.message || 'Failed to submit deletion request' });
  }
});

// POST /api/privacy/grievance — Submit a formal privacy complaint
router.post('/grievance', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { category, description, customerName, customerContact, orderId } = req.body;
    if (!category || !description) {
      res.status(400).json({ error: 'Grievance category and description are required.' });
      return;
    }

    const result = await PrivacyService.submitGrievance({
      uid,
      customerName: customerName || req.user?.email || 'Customer',
      customerContact: customerContact || req.user?.phone_number || req.user?.email || 'Not provided',
      category,
      description,
      orderId
    });

    res.json({
      success: true,
      message: 'Privacy grievance ticket registered. Our Grievance Redressal Officer will respond within the statutory SLA.',
      ticketId: result.ticketId,
      slaDeadline: result.slaDeadline
    });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Grievance submission failed:', error);
    res.status(500).json({ error: 'Failed to submit privacy grievance' });
  }
});

// GET /api/privacy/grievances — List user's submitted grievances
router.get('/grievances', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const grievances = await PrivacyService.getUserGrievances(uid);
    res.json({ success: true, grievances });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch user grievances:', error);
    res.status(500).json({ error: 'Failed to fetch grievances' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. OWNER / ADMINISTRATOR GOVERNANCE ENDPOINTS
// ────────────────────────────────────────────────────────────────────────────

// Require Owner/Admin roles for platform governance controls
const requireAdmin = requireRole(['owner', 'admin', 'platform_owner']);

// POST /api/privacy/admin/policy — Publish updated privacy notice version
router.post('/admin/policy', verifyToken, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { version, title, effectiveDate, summary, content } = req.body;
    if (!version || !title || !content) {
      res.status(400).json({ error: 'Missing required policy fields (version, title, content)' });
      return;
    }

    await PrivacyService.publishPolicyVersion({
      version,
      title,
      effectiveDate: effectiveDate || new Date().toISOString().slice(0, 10),
      summary: summary || '',
      content,
      publishedBy: req.user!.uid,
      status: 'active'
    }, req.user!.uid);

    res.json({ success: true, message: `Privacy policy version ${version} published successfully.` });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to publish policy version:', error);
    res.status(500).json({ error: 'Failed to publish policy version' });
  }
});

// GET /api/privacy/admin/grievances — List all grievances across platform
router.get('/admin/grievances', verifyToken, requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const snap = await adminDb
      .collection('privacy_grievances')
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const grievances = snap.docs.map(d => d.data());
    res.json({ success: true, grievances });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Admin failed to fetch grievances:', error);
    res.status(500).json({ error: 'Failed to fetch grievances' });
  }
});

// PATCH /api/privacy/admin/grievances/:ticketId — Update grievance resolution state
router.patch('/admin/grievances/:ticketId', verifyToken, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { ticketId } = req.params;
    const { status, resolutionNotes } = req.body;

    await PrivacyService.resolveGrievance({
      ticketId,
      status,
      resolutionNotes: resolutionNotes || 'Resolved by Grievance Redressal Team',
      assignedOfficer: req.user!.email || req.user!.uid
    });

    res.json({ success: true, message: `Grievance ticket ${ticketId} updated.` });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to resolve grievance:', error);
    res.status(500).json({ error: 'Failed to update grievance' });
  }
});

// GET /api/privacy/admin/processors — Retrieve third-party processor registry
router.get('/admin/processors', verifyToken, requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const processors = await PrivacyService.getProcessors();
    res.json({ success: true, processors });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch processors:', error);
    res.status(500).json({ error: 'Failed to fetch processors' });
  }
});

// GET /api/privacy/admin/retention — Retrieve retention policy configuration
router.get('/admin/retention', verifyToken, requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const retention = await PrivacyService.getRetentionPolicies();
    res.json({ success: true, retention });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch retention policies:', error);
    res.status(500).json({ error: 'Failed to fetch retention policies' });
  }
});

// GET /api/privacy/admin/incidents — Retrieve security incident records
router.get('/admin/incidents', verifyToken, requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const incidents = await PrivacyService.getSecurityIncidents();
    res.json({ success: true, incidents });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch incidents:', error);
    res.status(500).json({ error: 'Failed to fetch security incidents' });
  }
});

// POST /api/privacy/admin/incidents — Record a new security incident
router.post('/admin/incidents', verifyToken, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      title,
      severity,
      status,
      description,
      affectedSystems,
      affectedDataCategories,
      estimatedAffectedUsers,
      containmentActions,
      regulatoryNotificationRequired,
      regulatoryNotificationSent,
      postMortemNotes
    } = req.body;

    const incidentId = await PrivacyService.recordSecurityIncident({
      title,
      severity: severity || 'MEDIUM',
      status: status || 'DETECTED',
      description,
      affectedSystems: affectedSystems || [],
      affectedDataCategories: affectedDataCategories || [],
      estimatedAffectedUsers: Number(estimatedAffectedUsers) || 0,
      containmentActions: containmentActions || '',
      regulatoryNotificationRequired: Boolean(regulatoryNotificationRequired),
      regulatoryNotificationSent: Boolean(regulatoryNotificationSent),
      postMortemNotes,
      loggedBy: req.user!.email || req.user!.uid
    });

    res.json({ success: true, incidentId, message: 'Security incident logged successfully.' });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to record incident:', error);
    res.status(500).json({ error: 'Failed to record security incident' });
  }
});

// GET /api/privacy/admin/audit-logs — Retrieve privacy audit trail
router.get('/admin/audit-logs', verifyToken, requireAdmin, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const logs = await PrivacyService.getAuditLogs(100);
    res.json({ success: true, logs });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to fetch privacy audit logs:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// POST /api/privacy/admin/execute-erasure/:uid — Admin execution of account erasure
router.post('/admin/execute-erasure/:uid', verifyToken, requireAdmin, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const targetUid = req.params.uid;
    await PrivacyService.executeAccountErasure(targetUid, req.user!.email || req.user!.uid);
    res.json({ success: true, message: `Account ${targetUid} erased and historical records anonymized.` });
  } catch (error: any) {
    console.error('[PrivacyRoutes] Failed to execute account erasure:', error);
    res.status(500).json({ error: 'Failed to execute account erasure' });
  }
});

export default router;
