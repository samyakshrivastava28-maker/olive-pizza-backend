import { Router, Response } from 'express';
import crypto from 'crypto';
import { query } from '../lib/db.js';
import { verifyToken, requireRole, AuthRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Encryption helper for sensitive banking account numbers
const ENCRYPTION_KEY = process.env.BANK_ENCRYPTION_KEY || crypto.createHash('sha256').update(process.env.JWT_SECRET || 'olive-pizza-bank-secret-key-32b').digest();
const IV_LENGTH = 16;

function encryptAccountNumber(accountNumber: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(accountNumber, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function maskAccountNumber(accountNumber: string): string {
  const clean = accountNumber.replace(/\s+/g, '');
  if (clean.length <= 4) return '••••' + clean;
  return '•'.repeat(Math.max(4, clean.length - 4)) + clean.slice(-4);
}

// GET /api/finance/beneficiaries - List verified / pending bank accounts (Owner or scoped Franchise)
router.get('/beneficiaries', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const isOwner = user.allowedApps?.includes('OWNER') || user.role === 'owner' || user.role === 'platform_owner';
    const franchiseId = req.query.franchiseId as string || user.franchiseId;

    let sql = `
      SELECT 
        id,
        entity_type,
        entity_id,
        beneficiary_name,
        account_number_masked,
        ifsc_code,
        bank_name,
        branch_name,
        account_type,
        upi_vpa,
        verification_status,
        rejection_reason,
        verified_at,
        is_active,
        created_at,
        updated_at
      FROM bank_beneficiaries
    `;
    const params: any[] = [];

    if (!isOwner) {
      if (!user.franchiseId) {
        res.status(403).json({ error: 'Forbidden: No franchise scope assigned' });
        return;
      }
      sql += ' WHERE entity_id = $1';
      params.push(user.franchiseId);
    } else if (franchiseId) {
      sql += ' WHERE entity_id = $1';
      params.push(franchiseId);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query(sql, params).catch(() => ({ rows: [] }));
    res.json({ beneficiaries: result.rows });
  } catch (err: any) {
    console.error('[Finance] Error fetching beneficiaries:', err);
    res.status(500).json({ error: 'Failed to retrieve bank beneficiaries' });
  }
});

// POST /api/finance/beneficiaries - Register or update bank account details
router.post('/beneficiaries', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const {
      entityType,
      entityId,
      beneficiaryName,
      accountNumber,
      ifscCode,
      bankName,
      branchName,
      accountType,
      upiVpa
    } = req.body;

    if (!entityType || !entityId || !beneficiaryName || !accountNumber || !ifscCode) {
      res.status(400).json({ error: 'Missing required bank details: entityType, entityId, beneficiaryName, accountNumber, and ifscCode are mandatory.' });
      return;
    }

    const isOwner = user.allowedApps?.includes('OWNER') || user.role === 'owner' || user.role === 'platform_owner';
    if (!isOwner && user.franchiseId !== entityId) {
      res.status(403).json({ error: 'Forbidden: You can only register bank details for your assigned franchise.' });
      return;
    }

    const cleanAccount = String(accountNumber).trim();
    const cleanIfsc = String(ifscCode).toUpperCase().trim();
    if (cleanAccount.length < 8 || cleanAccount.length > 20) {
      res.status(400).json({ error: 'Invalid account number length.' });
      return;
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
      res.status(400).json({ error: 'Invalid IFSC code format (expected 11-character Indian Financial System Code).' });
      return;
    }

    const beneficiaryId = `ben_${entityType.toLowerCase()}_${entityId.toLowerCase()}`;
    const encryptedAccount = encryptAccountNumber(cleanAccount);
    const maskedAccount = maskAccountNumber(cleanAccount);

    // Initial status: Owner automatically VERIFIED, others PENDING_VERIFICATION
    const initialStatus = isOwner ? 'VERIFIED' : 'PENDING_VERIFICATION';
    const verifiedAt = isOwner ? new Date().toISOString() : null;
    const verifiedBy = isOwner ? user.email : null;

    const upsertSql = `
      INSERT INTO bank_beneficiaries (
        id,
        entity_type,
        entity_id,
        beneficiary_name,
        account_number_encrypted,
        account_number_masked,
        ifsc_code,
        bank_name,
        branch_name,
        account_type,
        upi_vpa,
        verification_status,
        verified_at,
        verified_by,
        is_active,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        beneficiary_name = EXCLUDED.beneficiary_name,
        account_number_encrypted = EXCLUDED.account_number_encrypted,
        account_number_masked = EXCLUDED.account_number_masked,
        ifsc_code = EXCLUDED.ifsc_code,
        bank_name = EXCLUDED.bank_name,
        branch_name = EXCLUDED.branch_name,
        account_type = EXCLUDED.account_type,
        upi_vpa = EXCLUDED.upi_vpa,
        verification_status = EXCLUDED.verification_status,
        verified_at = EXCLUDED.verified_at,
        verified_by = EXCLUDED.verified_by,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, entity_type, entity_id, beneficiary_name, account_number_masked, ifsc_code, verification_status;
    `;

    const result = await query(upsertSql, [
      beneficiaryId,
      entityType,
      entityId,
      beneficiaryName,
      encryptedAccount,
      maskedAccount,
      cleanIfsc,
      bankName || null,
      branchName || null,
      accountType || 'CURRENT',
      upiVpa || null,
      initialStatus,
      verifiedAt,
      verifiedBy
    ]);

    // Record bank audit log
    await query(`
      INSERT INTO bank_audit_log (beneficiary_id, action, performed_by, ip_address, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      beneficiaryId,
      'REGISTERED',
      user.email || user.uid,
      req.ip || '127.0.0.1',
      JSON.stringify({ entityType, entityId, ifscCode: cleanIfsc, status: initialStatus })
    ]).catch(() => {});

    res.json({
      success: true,
      message: isOwner ? 'Bank beneficiary verified and registered.' : 'Bank beneficiary submitted for Owner verification.',
      beneficiary: result.rows[0]
    });
  } catch (err: any) {
    console.error('[Finance] Error registering beneficiary:', err);
    res.status(500).json({ error: 'Failed to register bank beneficiary' });
  }
});

// PATCH /api/finance/beneficiaries/:id/verify - Owner verifies or rejects bank account
router.patch('/beneficiaries/:id/verify', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const beneficiaryId = req.params.id;
    const { status, rejectionReason } = req.body;

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      res.status(400).json({ error: 'Status must be VERIFIED or REJECTED' });
      return;
    }

    const updateSql = `
      UPDATE bank_beneficiaries
      SET
        verification_status = $1,
        rejection_reason = $2,
        verified_at = CASE WHEN $1 = 'VERIFIED' THEN CURRENT_TIMESTAMP ELSE NULL END,
        verified_by = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING id, entity_type, entity_id, beneficiary_name, account_number_masked, ifsc_code, verification_status;
    `;

    const result = await query(updateSql, [
      status,
      status === 'REJECTED' ? (rejectionReason || 'Details rejected by Store Owner') : null,
      user.email || user.uid,
      beneficiaryId
    ]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Beneficiary record not found.' });
      return;
    }

    await query(`
      INSERT INTO bank_audit_log (beneficiary_id, action, performed_by, ip_address, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      beneficiaryId,
      status,
      user.email || user.uid,
      req.ip || '127.0.0.1',
      JSON.stringify({ status, rejectionReason })
    ]).catch(() => {});

    res.json({
      success: true,
      message: `Beneficiary account ${status.toLowerCase()} successfully.`,
      beneficiary: result.rows[0]
    });
  } catch (err: any) {
    console.error('[Finance] Error verifying beneficiary:', err);
    res.status(500).json({ error: 'Failed to verify bank beneficiary' });
  }
});

// GET /api/finance/settlements - List settlement payout records
router.get('/settlements', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const isOwner = user.allowedApps?.includes('OWNER') || user.role === 'owner' || user.role === 'platform_owner';
    const franchiseId = req.query.franchiseId as string || user.franchiseId;

    let sql = `
      SELECT 
        s.id,
        s.settlement_reference,
        s.beneficiary_id,
        s.entity_type,
        s.entity_id,
        s.period_start,
        s.period_end,
        s.gross_sales_paise,
        s.platform_fee_paise,
        s.tax_collected_paise,
        s.net_payout_paise,
        s.currency,
        s.status,
        s.transaction_utr,
        s.settled_at,
        s.created_at,
        b.beneficiary_name,
        b.account_number_masked,
        b.ifsc_code,
        b.bank_name
      FROM payout_settlement_records s
      LEFT JOIN bank_beneficiaries b ON s.beneficiary_id = b.id
    `;
    const params: any[] = [];

    if (!isOwner) {
      if (!user.franchiseId) {
        res.status(403).json({ error: 'Forbidden: No franchise scope assigned' });
        return;
      }
      sql += ' WHERE s.entity_id = $1';
      params.push(user.franchiseId);
    } else if (franchiseId) {
      sql += ' WHERE s.entity_id = $1';
      params.push(franchiseId);
    }

    sql += ' ORDER BY s.period_end DESC, s.created_at DESC';

    const result = await query(sql, params).catch(() => ({ rows: [] }));
    res.json({ settlements: result.rows });
  } catch (err: any) {
    console.error('[Finance] Error fetching settlements:', err);
    res.status(500).json({ error: 'Failed to retrieve settlement records' });
  }
});

export default router;
