/**
 * RiderOnboardingService.ts — Restaurant/Franchise Manager Request & Owner Approval Architecture
 *
 * Implements approved Gate 1 Business Rules:
 * - BR-01: Restaurant/Franchise Managers submit onboarding requests; Platform Owner approves and activates.
 * - BR-05: PostgreSQL is the sole authoritative source of truth.
 * - BR-11: Deterministic identity linking (app_users + delivery_partners).
 */

import crypto from 'crypto';
import { pgPool, query, getClient } from '../../config/postgres.js';
import { OutboxPublisherService } from '../outbox/OutboxPublisherService.js';

export interface SubmitOnboardingParams {
  requestedByUid: string;
  requestedByRole: string;
  branchId: string;
  franchiseId: string;
  riderName: string;
  phone: string;
  email?: string;
  vehicleType?: string;
  vehicleNumber?: string;
}

export interface ReviewOnboardingParams {
  requestId: string;
  reviewerUid: string;
  reviewerRole: string;
  action: 'APPROVE' | 'REJECT';
  notes?: string;
}

export class RiderOnboardingService {
  /**
   * Submits a rider onboarding request by Branch or Franchise Manager.
   */
  public static async submitRequest(params: SubmitOnboardingParams): Promise<{
    success: boolean;
    requestId: string;
    status: string;
    message: string;
  }> {
    const {
      requestedByUid,
      requestedByRole,
      branchId,
      franchiseId,
      riderName,
      phone,
      email,
      vehicleType = 'Motorcycle',
      vehicleNumber
    } = params;

    if (!riderName || riderName.trim().length < 2) {
      const err: any = new Error('A valid rider name is required');
      err.statusCode = 400;
      throw err;
    }
    if (!phone || phone.trim().length < 8) {
      const err: any = new Error('A valid contact phone number is required');
      err.statusCode = 400;
      throw err;
    }

    const requestId = `onb_${crypto.randomUUID().slice(0, 10)}`;

    await query(
      `INSERT INTO rider_onboarding_requests (
         id, requested_by_uid, requested_by_role, branch_id, franchise_id,
         rider_name, phone, email, vehicle_type, vehicle_number, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING_APPROVAL', NOW())`,
      [
        requestId,
        requestedByUid,
        requestedByRole,
        branchId,
        franchiseId,
        riderName.trim(),
        phone.trim(),
        email ? email.trim() : null,
        vehicleType,
        vehicleNumber ? vehicleNumber.trim() : null
      ]
    );

    // Record outbox notification event
    await OutboxPublisherService.recordEvent(
      pgPool,
      'RIDER_ONBOARDING',
      requestId,
      'ONBOARDING_REQUESTED',
      {
        orderId: requestId,
        currentStatus: 'PENDING_APPROVAL',
        branchId,
        franchiseId,
        actorUid: requestedByUid,
        actorRole: requestedByRole,
        timestamp: new Date().toISOString(),
        metadata: { riderName, phone }
      }
    );

    return {
      success: true,
      requestId,
      status: 'PENDING_APPROVAL',
      message: 'Rider onboarding request submitted successfully. Awaiting platform owner approval.'
    };
  }

  /**
   * Lists onboarding requests with appropriate role-based scoping.
   */
  public static async listRequests(filter: {
    branchId?: string;
    franchiseId?: string;
    status?: string;
    userRole: string;
  }): Promise<any[]> {
    let sql = `SELECT * FROM rider_onboarding_requests WHERE 1=1`;
    const params: any[] = [];

    if (filter.status && filter.status !== 'ALL') {
      params.push(filter.status);
      sql += ` AND status = $${params.length}`;
    }

    // Role-based boundary enforcement
    if (['restaurant_manager', 'cashier'].includes(filter.userRole) && filter.branchId) {
      params.push(filter.branchId);
      sql += ` AND branch_id = $${params.length}`;
    } else if (['franchise_manager', 'franchise_owner'].includes(filter.userRole) && filter.franchiseId) {
      params.push(filter.franchiseId);
      sql += ` AND franchise_id = $${params.length}`;
    }

    sql += ` ORDER BY created_at DESC LIMIT 100`;
    const res = await query(sql, params);
    return res.rows;
  }

  /**
   * Reviews and activates an onboarding request (Owner/Developer/Admin only).
   */
  public static async reviewRequest(params: ReviewOnboardingParams): Promise<{
    success: boolean;
    requestId: string;
    status: string;
    userId?: string;
    partnerId?: string;
    message: string;
  }> {
    const { requestId, reviewerUid, reviewerRole, action } = params;

    const allowedRoles = ['owner', 'developer', 'admin'];
    if (!allowedRoles.includes(reviewerRole.toLowerCase())) {
      const err: any = new Error('Forbidden: Only platform owner or administrator can approve and activate riders');
      err.statusCode = 403;
      err.code = 'FORBIDDEN_REVIEW';
      throw err;
    }

    const reqRes = await query(
      `SELECT * FROM rider_onboarding_requests WHERE id = $1`,
      [requestId]
    );

    if (reqRes.rows.length === 0) {
      const err: any = new Error(`Onboarding request ${requestId} not found`);
      err.statusCode = 404;
      throw err;
    }

    const req = reqRes.rows[0];
    if (req.status !== 'PENDING_APPROVAL') {
      const err: any = new Error(`Onboarding request is already ${req.status}`);
      err.statusCode = 400;
      throw err;
    }

    if (action === 'REJECT') {
      await query(
        `UPDATE rider_onboarding_requests 
         SET status = 'REJECTED', reviewed_by_uid = $1, reviewed_at = NOW() 
         WHERE id = $2`,
        [reviewerUid, requestId]
      );

      return {
        success: true,
        requestId,
        status: 'REJECTED',
        message: 'Rider onboarding request has been rejected.'
      };
    }

    // APPROVAL WORKFLOW
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const userId = `usr_rdr_${crypto.randomUUID().slice(0, 8)}`;
      const partnerId = `dp_${crypto.randomUUID().slice(0, 8)}`;

      // 1. Create canonical app_users record
      await client.query(
        `INSERT INTO app_users (
           id, name, phone, email, role, status, franchise_id, branch_id,
           allowed_apps, is_active, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'delivery_partner', 'APPROVED', $5, $6, '["DELIVERY"]'::jsonb, true, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           role = 'delivery_partner',
           status = 'APPROVED',
           allowed_apps = '["DELIVERY"]'::jsonb,
           is_active = true,
           updated_at = NOW()`,
        [userId, req.rider_name, req.phone, req.email || null, req.franchise_id, req.branch_id]
      );

      // 2. Create linked delivery_partners record
      await client.query(
        `INSERT INTO delivery_partners (
           id, user_id, name, phone, email, franchise_id, branch_id,
           vehicle_type, vehicle_number, status, is_online, total_deliveries, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'AVAILABLE', false, 0, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           user_id = $2,
           status = 'AVAILABLE',
           updated_at = NOW()`,
        [
          partnerId,
          userId,
          req.rider_name,
          req.phone,
          req.email || null,
          req.franchise_id,
          req.branch_id,
          req.vehicle_type || 'Motorcycle',
          req.vehicle_number || null
        ]
      );

      // 3. Mark request APPROVED
      await client.query(
        `UPDATE rider_onboarding_requests 
         SET status = 'APPROVED', reviewed_by_uid = $1, reviewed_at = NOW() 
         WHERE id = $2`,
        [reviewerUid, requestId]
      );

      // 4. Record transactional outbox event
      await OutboxPublisherService.recordEvent(
        client,
        'DELIVERY_PARTNER',
        partnerId,
        'RIDER_ONBOARDED',
        {
          orderId: requestId,
          currentStatus: 'APPROVED',
          branchId: req.branch_id,
          franchiseId: req.franchise_id,
          deliveryPartnerId: partnerId,
          actorUid: reviewerUid,
          actorRole: 'owner',
          timestamp: new Date().toISOString(),
          metadata: { userId, name: req.rider_name, phone: req.phone }
        }
      );

      await client.query('COMMIT');

      return {
        success: true,
        requestId,
        status: 'APPROVED',
        userId,
        partnerId,
        message: `Rider ${req.rider_name} approved and activated with deterministic identity.`
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
