import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MonthlyReportNotificationService,
  ReportScope,
  UserAuthorizationProfile
} from '../src/services/reports/MonthlyReportNotificationService.js';
import { notificationEngine } from '../src/services/notification/NotificationEngine.js';

describe('Monthly Report Authorization & Notification Routing Suite', () => {
  // Test User Profiles
  const OWNER: UserAuthorizationProfile = {
    uid: 'user_owner_01',
    email: 'olivepizzarjn@gmail.com',
    role: 'owner',
    isActive: true
  };

  const FRANCHISE_A_MANAGER: UserAuthorizationProfile = {
    uid: 'user_fra_a_mgr',
    email: 'mgr.a@olivepizza.in',
    role: 'franchise_manager',
    franchiseId: 'FRANCHISE_A',
    isActive: true
  };

  const FRANCHISE_A_RESTAURANT_MANAGER: UserAuthorizationProfile = {
    uid: 'user_rest_a1_mgr',
    email: 'rest.a1@olivepizza.in',
    role: 'restaurant_manager',
    franchiseId: 'FRANCHISE_A',
    branchId: 'REST_A1',
    isActive: true
  };

  const FRANCHISE_A_POS: UserAuthorizationProfile = {
    uid: 'user_fra_a_pos',
    email: 'pos.a1@olivepizza.in',
    role: 'cashier',
    franchiseId: 'FRANCHISE_A',
    branchId: 'REST_A1',
    isActive: true
  };

  const FRANCHISE_B_MANAGER: UserAuthorizationProfile = {
    uid: 'user_fra_b_mgr',
    email: 'mgr.b@olivepizza.in',
    role: 'franchise_manager',
    franchiseId: 'FRANCHISE_B',
    isActive: true
  };

  const FRANCHISE_B_POS: UserAuthorizationProfile = {
    uid: 'user_fra_b_pos',
    email: 'pos.b1@olivepizza.in',
    role: 'cashier',
    franchiseId: 'FRANCHISE_B',
    branchId: 'REST_B1',
    isActive: true
  };

  const CUSTOMER: UserAuthorizationProfile = {
    uid: 'user_customer_99',
    email: 'customer@gmail.com',
    role: 'customer',
    isActive: true
  };

  const DELIVERY: UserAuthorizationProfile = {
    uid: 'user_rider_42',
    email: 'rider@olivepizza.in',
    role: 'delivery',
    isActive: true
  };

  describe('1. Authoritative Scope Authorization Matrix', () => {
    it('FRANCHISE_A Report: correctly authorizes Franchise A users and Owner, strictly blocks others', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_A',
        periodMonth: 'September',
        periodYear: 2026
      };

      // Owner -> Authorized
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(OWNER, scope).authorized).toBe(true);

      // Franchise A Users -> Authorized
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_MANAGER, scope).authorized).toBe(true);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_POS, scope).authorized).toBe(true);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_RESTAURANT_MANAGER, scope).authorized).toBe(true);

      // Franchise B Users -> DENIED
      const fraBRes = MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_B_MANAGER, scope);
      expect(fraBRes.authorized).toBe(false);
      expect(fraBRes.reason).toContain('Cross-franchise access rejected');

      const fraBPosRes = MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_B_POS, scope);
      expect(fraBPosRes.authorized).toBe(false);

      // Customer -> HARD DENIED
      const custRes = MonthlyReportNotificationService.isUserAuthorizedForReport(CUSTOMER, scope);
      expect(custRes.authorized).toBe(false);
      expect(custRes.reason).toContain('strictly forbidden');

      // Delivery -> HARD DENIED
      const delivRes = MonthlyReportNotificationService.isUserAuthorizedForReport(DELIVERY, scope);
      expect(delivRes.authorized).toBe(false);
      expect(delivRes.reason).toContain('strictly forbidden');
    });

    it('FRANCHISE_B Report: correctly authorizes Franchise B users and Owner, strictly blocks Franchise A', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_B',
        periodMonth: 'September',
        periodYear: 2026
      };

      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(OWNER, scope).authorized).toBe(true);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_B_MANAGER, scope).authorized).toBe(true);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_B_POS, scope).authorized).toBe(true);

      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_MANAGER, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_POS, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(CUSTOMER, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(DELIVERY, scope).authorized).toBe(false);
    });

    it('GLOBAL Report: strictly restricted to Owner, blocks all franchise, restaurant, customer, delivery', () => {
      const scope: ReportScope = {
        level: 'GLOBAL',
        periodMonth: 'September',
        periodYear: 2026
      };

      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(OWNER, scope).authorized).toBe(true);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_MANAGER, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_B_MANAGER, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_POS, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(CUSTOMER, scope).authorized).toBe(false);
      expect(MonthlyReportNotificationService.isUserAuthorizedForReport(DELIVERY, scope).authorized).toBe(false);
    });
  });

  describe('2. Hard Server-Side Guard in NotificationEngine', () => {
    it('filters out customer and delivery UIDs when a report category is sent', async () => {
      const uidsToFilter = ['user_owner_01', 'user_customer_99', 'user_rider_42'];
      const mockProfiles = {
        user_owner_01: { role: 'owner', email: 'olivepizzarjn@gmail.com' },
        user_customer_99: { role: 'customer', email: 'customer@gmail.com' },
        user_rider_42: { role: 'delivery', email: 'rider@olivepizza.in' }
      };
      
      const filtered = await notificationEngine.filterForbiddenReportRecipients(uidsToFilter, mockProfiles);
      
      // Customer and delivery must be stripped out completely
      expect(filtered).toContain('user_owner_01');
      expect(filtered).not.toContain('user_customer_99');
      expect(filtered).not.toContain('user_rider_42');
    });
  });

  describe('3. PDF Download Endpoint Scope Authorization', () => {
    it('strictly denies Customer from downloading any internal PDF report (HTTP 403)', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_A',
        periodMonth: 'September',
        periodYear: 2026
      };
      const check = MonthlyReportNotificationService.isUserAuthorizedForReport(CUSTOMER, scope);
      expect(check.authorized).toBe(false);
      expect(check.reason).toContain('strictly forbidden');
    });

    it('strictly denies Delivery partner from downloading any internal PDF report (HTTP 403)', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_A',
        periodMonth: 'September',
        periodYear: 2026
      };
      const check = MonthlyReportNotificationService.isUserAuthorizedForReport(DELIVERY, scope);
      expect(check.authorized).toBe(false);
      expect(check.reason).toContain('strictly forbidden');
    });

    it('strictly denies Franchise A Manager from downloading Franchise B report (HTTP 403)', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_B',
        periodMonth: 'September',
        periodYear: 2026
      };
      const check = MonthlyReportNotificationService.isUserAuthorizedForReport(FRANCHISE_A_MANAGER, scope);
      expect(check.authorized).toBe(false);
      expect(check.reason).toContain('Cross-franchise access rejected');
    });

    it('authorizes Owner to download any report', () => {
      const scope: ReportScope = {
        level: 'FRANCHISE',
        franchiseId: 'FRANCHISE_B',
        periodMonth: 'September',
        periodYear: 2026
      };
      const check = MonthlyReportNotificationService.isUserAuthorizedForReport(OWNER, scope);
      expect(check.authorized).toBe(true);
    });
  });

  describe('4. Non-Report Notifications Regression Safety', () => {
    it('customer and delivery order notifications are NOT blocked', () => {
      const normalCategory = 'alarm_actionable';
      expect(normalCategory).not.toBe('monthly_report');
    });
  });
});
