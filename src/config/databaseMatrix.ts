/**
 * 🍕 Olive Pizza Multi-Database Responsibility Matrix & Entity Ownership Table
 * 
 * Defines authoritative primary data stores, secondary representations, read/write paths,
 * and retention policies across the entire Olive Pizza ecosystem.
 */

export interface EntityDataPolicy {
  entity: string;
  primaryDatabase: 'FIRESTORE' | 'STANDARD_POSTGRES' | 'SUPABASE_POSTGRES' | 'GOOGLE_SHEETS' | 'CLOUDFLARE_R2' | 'LOOKER_STUDIO';
  secondaryRepresentation?: string;
  reason: string;
  readPath: string;
  writePath: string;
  retentionRequirement: string;
  atomicityModel: 'ACID_TRANSACTION' | 'DOCUMENT_ATOMIC' | 'IDEMPOTENT_UPSERT' | 'EPHEMERAL_5MIN' | 'IMMUTABLE_LOG';
}

export const DATABASE_RESPONSIBILITY_MATRIX: Record<string, EntityDataPolicy> = {
  // ─── 1. Core Business Entities (Primary: Firestore) ──────────────────────────
  CustomerProfile: {
    entity: 'CustomerProfile',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'None (Zero PII in operational caches)',
    reason: 'Hierarchical document data, real-time client sync, profile addresses and auth metadata',
    readPath: 'Firestore collection("users").doc(userId)',
    writePath: 'Firestore collection("users").doc(userId).set()',
    retentionRequirement: 'Permanent until GDPR deletion request (30-day grace)',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },
  ProductCatalog: {
    entity: 'ProductCatalog',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'In-memory backend LRU cache (TTL: 60s)',
    reason: 'Dynamic menu, crust/size variants, custom toppings, image CDN links, real-time availability toggles',
    readPath: 'Firestore collection("products") & collection("menu_items")',
    writePath: 'Firestore collection("products").doc(id).set()',
    retentionRequirement: 'Permanent active catalog',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },
  CouponsAndOffers: {
    entity: 'CouponsAndOffers',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'None',
    reason: 'Marketing rules, usage limits, branch-level applicability, dynamic percentage discounts',
    readPath: 'Firestore collection("coupons").where("isActive", "==", true)',
    writePath: 'Firestore collection("coupons").doc(code).update()',
    retentionRequirement: 'Active validity window + 1 year historical audit',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },
  OrderStatusAndLifecycle: {
    entity: 'OrderStatusAndLifecycle',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'Standard PostgreSQL order reference + Google Sheets monthly line item',
    reason: 'Real-time WebSocket/Snapshot listener across Customer, Kitchen, Manager, and Rider surfaces',
    readPath: 'Firestore collection("orders").doc(orderId)',
    writePath: 'Firestore collection("orders").doc(orderId).update()',
    retentionRequirement: 'Active order lifecycle + 1 year operational retention',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },
  FranchiseAndBranchHierarchy: {
    entity: 'FranchiseAndBranchHierarchy',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'Standard PostgreSQL franchise_id / branch_id foreign key scope references',
    reason: 'Multi-tenant organization tree (Organization -> Franchise -> Branch -> Staff -> Terminals)',
    readPath: 'Firestore collection("franchises") & collection("branches")',
    writePath: 'Firestore collection("franchises").doc(id).set()',
    retentionRequirement: 'Permanent business infrastructure',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },
  HomePageCMSConfig: {
    entity: 'HomePageCMSConfig',
    primaryDatabase: 'FIRESTORE',
    secondaryRepresentation: 'None',
    reason: 'Visual SDUI layout components, promotional hero banners, category capsules',
    readPath: 'Firestore collection("homepage_configs").doc("current")',
    writePath: 'Firestore collection("homepage_configs").doc("current").set()',
    retentionRequirement: 'Versioned templates + active published document',
    atomicityModel: 'DOCUMENT_ATOMIC',
  },

  // ─── 2. Transactional / Financial Entities (Primary: Standard PostgreSQL) ───
  PaymentTransaction: {
    entity: 'PaymentTransaction',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'Firestore order payment summary (method, status, amount)',
    reason: 'Strict financial ACID transactions, provider reference verification, webhook replay guards',
    readPath: 'PostgreSQL SELECT * FROM payments WHERE id = $1',
    writePath: 'PostgreSQL INSERT INTO payments / UPDATE payments',
    retentionRequirement: '7 years statutory financial ledger requirement',
    atomicityModel: 'ACID_TRANSACTION',
  },
  RefundRecord: {
    entity: 'RefundRecord',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'Firestore order refund status flag',
    reason: 'Financial reconciliation, gateway refund IDs, audit logs, reversal amounts',
    readPath: 'PostgreSQL SELECT * FROM refunds WHERE order_id = $1',
    writePath: 'PostgreSQL INSERT INTO refunds',
    retentionRequirement: '7 years statutory financial ledger requirement',
    atomicityModel: 'ACID_TRANSACTION',
  },
  POSShiftReconciliation: {
    entity: 'POSShiftReconciliation',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'Google Sheets "POS & Cashier Summary" monthly tab',
    reason: 'Physical counter cash float tracking, cash in/out adjustments, terminal variance calculation',
    readPath: 'PostgreSQL SELECT * FROM pos_shifts WHERE terminal_id = $1 AND status = \'OPEN\'',
    writePath: 'PostgreSQL INSERT / UPDATE pos_shifts',
    retentionRequirement: '3 years cashier audit history',
    atomicityModel: 'ACID_TRANSACTION',
  },
  IdempotencyLock: {
    entity: 'IdempotencyLock',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'Double-order prevention, duplicate payment webhook protection, atomic mutex acquisition',
    readPath: 'PostgreSQL SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()',
    writePath: 'PostgreSQL INSERT INTO idempotency_keys ON CONFLICT DO NOTHING',
    retentionRequirement: '24 hours rolling TTL (auto-purged)',
    atomicityModel: 'ACID_TRANSACTION',
  },
  OrderConcurrencyLock: {
    entity: 'OrderConcurrencyLock',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'Pessimistic lock preventing concurrent status transition or double rider assignment',
    readPath: 'PostgreSQL SELECT * FROM order_locks WHERE order_id = $1',
    writePath: 'PostgreSQL INSERT INTO order_locks / DELETE FROM order_locks',
    retentionRequirement: 'Short-lived mutex (released immediately or 60s timeout)',
    atomicityModel: 'ACID_TRANSACTION',
  },
  TransactionalEmailQueue: {
    entity: 'TransactionalEmailQueue',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'Async background email sending with retry count, SMTP status, and dead letter logging',
    readPath: 'PostgreSQL SELECT * FROM email_queue WHERE status = \'PENDING\' LIMIT 50',
    writePath: 'PostgreSQL INSERT INTO email_queue',
    retentionRequirement: '30 days rolling retention',
    atomicityModel: 'ACID_TRANSACTION',
  },
  NotificationQueue: {
    entity: 'NotificationQueue',
    primaryDatabase: 'STANDARD_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'FCM push notification dispatcher with LISTEN/NOTIFY instant wakeup and priority queueing',
    readPath: 'PostgreSQL SELECT * FROM notification_queue WHERE status = \'PENDING\'',
    writePath: 'PostgreSQL INSERT INTO notification_queue',
    retentionRequirement: '7 days rolling retention (DataRetentionJob)',
    atomicityModel: 'ACID_TRANSACTION',
  },

  // ─── 3. High-Frequency Live Navigation (Primary: Supabase PostgreSQL) ────────
  LiveRiderLocation: {
    entity: 'LiveRiderLocation',
    primaryDatabase: 'SUPABASE_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'Current active GPS coordinates per delivery partner for real-time customer 3D map tracking',
    readPath: 'Supabase Realtime channel or supabaseNav.from("delivery_locations").select("*")',
    writePath: 'supabaseNav.from("delivery_locations").upsert({ ... }, { onConflict: "delivery_partner_id" })',
    retentionRequirement: 'Overwritten continuously while active; cleared on order completion',
    atomicityModel: 'IDEMPOTENT_UPSERT',
  },
  EphemeralGPSTelemetry: {
    entity: 'EphemeralGPSTelemetry',
    primaryDatabase: 'SUPABASE_POSTGRES',
    secondaryRepresentation: 'None',
    reason: 'High-frequency GPS breadcrumbs during active transit (heading, speed, route coordinates)',
    readPath: 'Supabase SELECT * FROM navigation_points WHERE session_id = $1',
    writePath: 'Supabase INSERT INTO navigation_points',
    retentionRequirement: 'STRICT 5 MINUTES RETENTION (DataRetentionJob purges records older than 5m)',
    atomicityModel: 'EPHEMERAL_5MIN',
  },

  // ─── 4. Monthly Accounting & Reporting (Primary: Google Sheets) ──────────────
  MonthlyAccountingWorkbook: {
    entity: 'MonthlyAccountingWorkbook',
    primaryDatabase: 'GOOGLE_SHEETS',
    secondaryRepresentation: 'Cloudflare R2 immutable monthly archive export',
    reason: '13-tab monthly CA & management workbook per franchise with 26-column standardized billing ledger',
    readPath: 'Google Sheets API spreadsheets.values.get',
    writePath: 'Asynchronous SheetsSyncWorker with idempotent row upsert on Order ID',
    retentionRequirement: 'Permanent monthly tax record',
    atomicityModel: 'IDEMPOTENT_UPSERT',
  },

  // ─── 5. Business Analytics & BI (Primary: Looker Studio) ─────────────────────
  ExecutiveAnalytics: {
    entity: 'ExecutiveAnalytics',
    primaryDatabase: 'LOOKER_STUDIO',
    secondaryRepresentation: 'Google Sheets data feed / Cloudflare R2 CSV extracts',
    reason: 'Visual multi-branch revenue KPIs, channel share distributions, menu popularity matrices',
    readPath: 'Looker Studio Dashboard connectors',
    writePath: 'Read-only downstream consumption from Sheets / R2 data connectors',
    retentionRequirement: 'Dynamic reporting over historical monthly archives',
    atomicityModel: 'IMMUTABLE_LOG',
  },
};

export function getAuthoritativeStore(entityName: string): string {
  const policy = DATABASE_RESPONSIBILITY_MATRIX[entityName];
  if (!policy) {
    throw new Error(`[DatabaseMatrix] Unknown entity "${entityName}". All entities must be registered in Database Matrix.`);
  }
  return policy.primaryDatabase;
}
