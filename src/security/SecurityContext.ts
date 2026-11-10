/**
 * SecurityContext.ts — Canonical Security Types and Application Boundary Definitions
 * Olive Pizza Ecosystem (Customer, Owner, Restaurant Management, Delivery, POS/Kitchen, Franchise)
 */

export type AppTarget =
  | 'CUSTOMER_APP'
  | 'OWNER_APP'
  | 'RESTAURANT_MANAGER_APP'
  | 'DELIVERY_APP'
  | 'POS_APP'
  | 'KITCHEN_APP'
  | 'FRANCHISE_APP';

export type UserRole =
  | 'customer'
  | 'platform_owner'
  | 'owner'
  | 'franchise_owner'
  | 'restaurant_manager'
  | 'manager'
  | 'kitchen_staff'
  | 'delivery_partner'
  | 'delivery'
  | 'cashier'
  | 'pos_operator'
  | 'developer'
  | 'admin'
  | 'REVOKED';

export interface AuthenticatedSecurityUser {
  uid: string;
  email?: string;
  phone_number?: string;
  role: UserRole | string;
  organizationId: string;
  franchiseId: string;
  branchId: string;
  branchIds: string[];
  permissions: string[];
  terminalId?: string;
  isActive: boolean;
  isGlobalOwner: boolean;
  isFranchiseOwner: boolean;
  isBranchScoped: boolean;
}

export const AUTHORIZED_INTERNAL_EMAILS = [
  'olivepizzarjn@gmail.com',
  'webhub2811@gmail.com'
];

/**
 * Authoritative Application Permissions Matrix
 * Defines which roles are authorized to access each Olive Pizza application surface.
 */
export const APP_ROLE_PERMISSIONS: Record<AppTarget, string[]> = {
  CUSTOMER_APP: [
    'customer',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  OWNER_APP: [
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  RESTAURANT_MANAGER_APP: [
    'restaurant_manager',
    'manager',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  DELIVERY_APP: [
    'delivery_partner',
    'delivery',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  POS_APP: [
    'cashier',
    'pos_operator',
    'restaurant_manager',
    'manager',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  KITCHEN_APP: [
    'kitchen_staff',
    'restaurant_manager',
    'manager',
    'cashier',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ],
  FRANCHISE_APP: [
    'franchise_owner',
    'platform_owner',
    'owner',
    'developer',
    'admin'
  ]
};

export function isUserAuthorizedForApp(user: AuthenticatedSecurityUser, app: AppTarget): boolean {
  if (!user || !user.isActive) return false;
  if (user.isGlobalOwner) return true;

  const allowedRoles = APP_ROLE_PERMISSIONS[app] || [];
  const normalizedRole = (user.role || '').toLowerCase();

  return allowedRoles.includes(normalizedRole);
}
