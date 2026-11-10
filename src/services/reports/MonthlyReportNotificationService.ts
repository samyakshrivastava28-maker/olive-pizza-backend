/**
 * MonthlyReportNotificationService.ts
 *
 * Authoritative Server-Side Role + Scope Based Monthly Report Notification System.
 *
 * Absolute Privacy & Security Rules:
 * - CUSTOMER: NEVER receives monthly sales reports, POS reports, franchise reports, or restaurant financial reports.
 * - DELIVERY: NEVER receives monthly sales reports, POS reports, franchise reports, or restaurant financial reports.
 * - OWNER: Receives overall Olive Pizza monthly reports and authorized franchise reports.
 * - FRANCHISE MANAGEMENT: Receives ONLY their assigned franchise report. NEVER another franchise's report.
 * - RESTAURANT MANAGEMENT / POS: Receives ONLY their assigned restaurant/franchise report. NEVER another franchise's report.
 *
 * ZERO TRUST: Frontend-supplied roles are NEVER trusted. All permissions are evaluated server-side.
 */

import { adminDb as db } from '../../config/firebase.js';
import { pgPool } from '../../config/postgres.js';
import { notificationEngine } from '../notification/NotificationEngine.js';

export type ReportScopeLevel = 'GLOBAL' | 'FRANCHISE' | 'RESTAURANT';

export interface ReportScope {
  level: ReportScopeLevel;
  franchiseId?: string | null;
  restaurantId?: string | null; // branchId (e.g. 'main_branch')
  periodMonth: string;         // e.g. 'September'
  periodYear: number;          // e.g. 2026
}

export interface ReportNotificationPayload {
  reportKey: string;
  pdfUrl?: string;
  grossSales?: number;
  totalOrders?: number;
}

export interface UserAuthorizationProfile {
  uid: string;
  email?: string;
  role: string;
  franchiseId?: string | null;
  branchId?: string | null;
  branchIds?: string[];
  isActive?: boolean;
}

const AUTHORIZED_OWNER_EMAILS = [
  'olivepizzarjn@gmail.com',
  'webhub2811@gmail.com',
  'olivepizzamaker@gmail.com'
];

const FORBIDDEN_ROLES = new Set(['customer', 'delivery', 'delivery_partner', 'rider']);
const OWNER_ROLES = new Set(['owner', 'admin', 'developer', 'platform_owner']);
const FRANCHISE_ROLES = new Set(['franchise_owner', 'franchise_manager']);
const RESTAURANT_STAFF_ROLES = new Set(['restaurant_manager', 'manager', 'cashier', 'staff', 'kitchen_staff']);

export class MonthlyReportNotificationService {
  /**
   * Evaluates whether a user is authorized to access or receive a report of the given scope.
   * Pure deterministic authorization logic with zero frontend trust.
   */
  public static isUserAuthorizedForReport(
    user: UserAuthorizationProfile,
    scope: ReportScope
  ): { authorized: boolean; reason?: string } {
    const userRole = (user.role || '').toLowerCase().trim();
    const userEmail = (user.email || '').toLowerCase().trim();

    // 0. Active Account Check
    if (user.isActive === false) {
      return {
        authorized: false,
        reason: 'Access Denied: Account is deactivated or revoked in system database.'
      };
    }

    // 1. HARD SECURITY GUARD: Customers and Delivery personnel are unconditionally blocked
    if (FORBIDDEN_ROLES.has(userRole) || userRole === 'customer') {
      return {
        authorized: false,
        reason: `Access Denied: Role '${userRole}' is strictly forbidden from accessing internal business reports.`
      };
    }

    // 2. Platform Owners / Master Admins have global access
    if (AUTHORIZED_OWNER_EMAILS.includes(userEmail)) {
      if (OWNER_ROLES.has(userRole)) {
        return { authorized: true };
      }
    }

    if (OWNER_ROLES.has(userRole)) {
      return { authorized: true };
    }

    // 3. GLOBAL Scope Reports: Strictly restricted to Owners / Admins
    if (scope.level === 'GLOBAL') {
      return {
        authorized: false,
        reason: 'Access Denied: Global executive reports are strictly restricted to platform owners.'
      };
    }

    // 4. FRANCHISE Scope Reports: Target franchise is required
    if (scope.level === 'FRANCHISE') {
      if (!scope.franchiseId) {
        return { authorized: false, reason: 'Invalid report: Missing franchise identifier.' };
      }

      // Check if user belongs to this franchise
      const userFranchiseId = user.franchiseId || '';
      if (userFranchiseId !== scope.franchiseId) {
        return {
          authorized: false,
          reason: `Access Denied: Cross-franchise access rejected. User belongs to '${userFranchiseId}', requested '${scope.franchiseId}'.`
        };
      }

      // Allowed if franchise owner/manager, restaurant manager, or staff within this franchise
      if (FRANCHISE_ROLES.has(userRole) || RESTAURANT_STAFF_ROLES.has(userRole)) {
        return { authorized: true };
      }

      return { authorized: false, reason: `Role '${userRole}' is not authorized for franchise reports.` };
    }

    // 5. RESTAURANT Scope Reports: Target franchise AND restaurantId (branchId)
    if (scope.level === 'RESTAURANT') {
      const targetFranchise = scope.franchiseId || '';
      const targetBranch = scope.restaurantId || '';

      // Cross-franchise check
      if (targetFranchise && user.franchiseId && user.franchiseId !== targetFranchise) {
        return {
          authorized: false,
          reason: `Access Denied: Cross-franchise access rejected for restaurant report.`
        };
      }

      // Franchise Managers oversee all restaurants in their franchise
      if (FRANCHISE_ROLES.has(userRole) && (!targetFranchise || user.franchiseId === targetFranchise)) {
        return { authorized: true };
      }

      // Restaurant Managers and POS users must match branchId
      if (RESTAURANT_STAFF_ROLES.has(userRole)) {
        const matchesSingleBranch = user.branchId === targetBranch;
        const matchesMultiBranch = Array.isArray(user.branchIds) && user.branchIds.includes(targetBranch);

        if (matchesSingleBranch || matchesMultiBranch) {
          return { authorized: true };
        }

        return {
          authorized: false,
          reason: `Access Denied: User is assigned to branch '${user.branchId}', requested report for '${targetBranch}'.`
        };
      }

      return { authorized: false, reason: `Role '${userRole}' is not authorized for restaurant reports.` };
    }

    return { authorized: false, reason: 'Access Denied: Unrecognized report scope.' };
  }

  /**
   * Queries and resolves all authorized recipient user profiles from trusted databases.
   */
  public static async queryAuthorizedRecipients(scope: ReportScope): Promise<UserAuthorizationProfile[]> {
    const candidateProfiles: UserAuthorizationProfile[] = [];
    const seenUids = new Set<string>();

    // 1. Fetch from Firestore users collection
    try {
      const allowedQueryRoles = [
        'owner', 'admin', 'developer', 'platform_owner',
        'franchise_owner', 'franchise_manager',
        'restaurant_manager', 'manager', 'cashier', 'staff'
      ];

      for (const role of allowedQueryRoles) {
        const snap = await db.collection('users').where('role', '==', role).get();
        snap.docs.forEach(d => {
          if (!seenUids.has(d.id)) {
            seenUids.add(d.id);
            const data = d.data();
            candidateProfiles.push({
              uid: d.id,
              email: data.email,
              role: data.role || role,
              franchiseId: data.franchiseId || null,
              branchId: data.branchId || null,
              branchIds: data.branchIds || [],
              isActive: data.isActive !== false
            });
          }
        });
      }
    } catch (err: any) {
      console.warn('[MonthlyReportNotificationService] Firestore user query notice:', err.message);
    }

    // 2. Fetch from PostgreSQL users table where available
    try {
      const pgRes = await pgPool.query(`
        SELECT firebase_uid as uid, email, role, franchise_id, branch_id, is_active
        FROM users
        WHERE role NOT IN ('customer', 'delivery', 'delivery_partner')
          AND is_active = TRUE
      `).catch(() => ({ rows: [] }));

      pgRes.rows.forEach((r: any) => {
        if (r.uid && !seenUids.has(r.uid)) {
          seenUids.add(r.uid);
          candidateProfiles.push({
            uid: r.uid,
            email: r.email,
            role: r.role,
            franchiseId: r.franchise_id || null,
            branchId: r.branch_id || null,
            isActive: r.is_active !== false
          });
        }
      });
    } catch (err: any) {
      // Ignore if table/columns don't exist
    }

    // 3. Filter candidates strictly through server-side authorization check
    const authorizedProfiles = candidateProfiles.filter(profile => {
      if (profile.isActive === false) return false;
      const { authorized } = this.isUserAuthorizedForReport(profile, scope);
      return authorized;
    });

    console.log(
      `[MonthlyReportNotificationService] Resolved ${authorizedProfiles.length} authorized recipients for ` +
      `scope=${scope.level} (franchise=${scope.franchiseId || 'NONE'}, restaurant=${scope.restaurantId || 'NONE'})`
    );

    return authorizedProfiles;
  }

  /**
   * Dispatches tailored, leak-proof monthly report push notifications to authorized recipients.
   */
  public static async dispatchMonthlyReportNotification(
    scope: ReportScope,
    payload: ReportNotificationPayload,
    options?: { skipOwners?: boolean }
  ): Promise<{ recipientCount: number; recipientUids: string[] }> {
    const recipients = await this.queryAuthorizedRecipients(scope);
    if (recipients.length === 0) {
      console.warn('[MonthlyReportNotificationService] No authorized recipients found for report dispatch.');
      return { recipientCount: 0, recipientUids: [] };
    }

    const periodStr = `${scope.periodMonth} ${scope.periodYear}`;

    const ownerRecipients: string[] = [];
    const franchiseRecipients: string[] = [];
    const restaurantPosRecipients: string[] = [];

    recipients.forEach(r => {
      const role = (r.role || '').toLowerCase();
      const email = (r.email || '').toLowerCase();
      if (AUTHORIZED_OWNER_EMAILS.includes(email) || OWNER_ROLES.has(role)) {
        if (!options?.skipOwners) {
          ownerRecipients.push(r.uid);
        }
      } else if (FRANCHISE_ROLES.has(role)) {
        franchiseRecipients.push(r.uid);
      } else {
        restaurantPosRecipients.push(r.uid);
      }
    });

    // 1. Send to Owners (if not skipped for consolidated executive dispatch)
    if (ownerRecipients.length > 0) {
      await notificationEngine.sendBulk(ownerRecipients, {
        notification: {
          title: `Olive Pizza Monthly Report Ready`,
          body: `Olive Pizza monthly report for ${periodStr} is ready.`
        },
        data: {
          category: 'monthly_report',
          scopeLevel: scope.level,
          franchiseId: scope.franchiseId || '',
          restaurantId: scope.restaurantId || '',
          periodMonth: scope.periodMonth,
          periodYear: String(scope.periodYear),
          reportKey: payload.reportKey,
          pdfUrl: payload.pdfUrl || '',
          url: '/reports'
        }
      }, {
        category: 'monthly_report',
        targetApp: 'owner',
        priority: 'high',
        tag: `monthly_report_${payload.reportKey}_owner`
      }).catch(err => console.error('[MonthlyReportNotificationService] Owner dispatch error:', err));
    }

    // 2. Send to Franchise Managers (Leak-proof)
    if (franchiseRecipients.length > 0) {
      await notificationEngine.sendBulk(franchiseRecipients, {
        notification: {
          title: `Franchise Monthly Report Ready`,
          body: `Your franchise monthly report for ${periodStr} is ready.`
        },
        data: {
          category: 'monthly_report',
          scopeLevel: scope.level,
          franchiseId: scope.franchiseId || '',
          periodMonth: scope.periodMonth,
          periodYear: String(scope.periodYear),
          reportKey: payload.reportKey,
          pdfUrl: payload.pdfUrl || '',
          url: '/reports'
        }
      }, {
        category: 'monthly_report',
        targetApp: 'franchise',
        priority: 'high',
        tag: `monthly_report_${payload.reportKey}_franchise`
      }).catch(err => console.error('[MonthlyReportNotificationService] Franchise dispatch error:', err));
    }

    // 3. Send to Restaurant Managers / POS Users (Leak-proof)
    if (restaurantPosRecipients.length > 0) {
      await notificationEngine.sendBulk(restaurantPosRecipients, {
        notification: {
          title: `Store Monthly Report Ready`,
          body: `Your restaurant monthly report for ${periodStr} is ready.`
        },
        data: {
          category: 'monthly_report',
          scopeLevel: scope.level,
          franchiseId: scope.franchiseId || '',
          restaurantId: scope.restaurantId || '',
          periodMonth: scope.periodMonth,
          periodYear: String(scope.periodYear),
          reportKey: payload.reportKey,
          pdfUrl: payload.pdfUrl || '',
          url: '/reports'
        }
      }, {
        category: 'monthly_report',
        priority: 'high',
        tag: `monthly_report_${payload.reportKey}_store`
      }).catch(err => console.error('[MonthlyReportNotificationService] Store/POS dispatch error:', err));
    }

    const allUids = recipients.map(r => r.uid);
    return {
      recipientCount: allUids.length,
      recipientUids: allUids
    };
  }

  /**
   * Dispatches EXACTLY ONE consolidated executive monthly report notification to owners.
   * Idempotent tag ensures owners never receive duplicate pushes.
   */
  public static async dispatchExecutiveOwnerNotification(params: {
    monthName: string;
    year: number;
    totalRevenue: number;
    totalOrders: number;
    pdfUrl?: string;
  }): Promise<{ sent: boolean; recipientCount: number }> {
    const { monthName, year, totalRevenue, totalOrders, pdfUrl } = params;
    const globalScope: ReportScope = {
      level: 'GLOBAL',
      periodMonth: monthName,
      periodYear: year,
    };
    const recipients = await this.queryAuthorizedRecipients(globalScope);
    const ownerRecipients = recipients
      .filter(r => {
        const role = (r.role || '').toLowerCase();
        const email = (r.email || '').toLowerCase();
        return AUTHORIZED_OWNER_EMAILS.includes(email) || OWNER_ROLES.has(role);
      })
      .map(r => r.uid);

    if (ownerRecipients.length === 0) {
      console.warn('[MonthlyReportNotificationService] No owners found for executive notification.');
      return { sent: false, recipientCount: 0 };
    }

    const periodStr = `${monthName} ${year}`;
    const tag = `monthly_report_executive_${year}_${monthName.toLowerCase()}`;

    await notificationEngine.sendBulk(ownerRecipients, {
      notification: {
        title: `Olive Pizza Executive Report — ${periodStr}`,
        body: `Monthly report ready: ₹${totalRevenue.toLocaleString('en-IN')} revenue across ${totalOrders} orders.`
      },
      data: {
        category: 'monthly_report',
        scopeLevel: 'GLOBAL',
        periodMonth: monthName,
        periodYear: String(year),
        reportKey: `executive_${year}_${monthName.toLowerCase()}`,
        pdfUrl: pdfUrl || '',
        url: '/reports'
      }
    }, {
      category: 'monthly_report',
      targetApp: 'owner',
      priority: 'high',
      tag
    }).catch(err => console.error('[MonthlyReportNotificationService] Executive owner dispatch error:', err));

    return { sent: true, recipientCount: ownerRecipients.length };
  }
}
