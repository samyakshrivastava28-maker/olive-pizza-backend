import { buildSchema, graphql, GraphQLError, parse } from 'graphql';
import { adminDb } from '../config/firebase.js';
import { query } from '../lib/db.js';

export const schema = buildSchema(`
  enum EntityType {
    FRANCHISE
    BRANCH
    SYSTEM
  }

  enum IncidentSeverity {
    CRITICAL
    HIGH
    MEDIUM
    INFORMATIONAL
  }

  enum IncidentStatus {
    OPEN
    ACKNOWLEDGED
    IN_PROGRESS
    RESOLVED
  }

  type IncidentReport {
    id: ID!
    title: String!
    description: String!
    severity: IncidentSeverity!
    status: IncidentStatus!
    entityType: EntityType!
    entityId: String!
    detectedAt: String!
    durationMinutes: Int
    affectedCount: Int
    latestUpdate: String
    resolvedAt: String
    resolvedBy: String
    actionUrl: String
  }

  type FranchisePerformance {
    franchiseId: ID!
    name: String!
    city: String!
    state: String!
    status: String!
    branchesCount: Int!
    totalOrders: Int!
    grossSalesPaise: Float!
    netSalesPaise: Float!
    totalSalesInr: Float!
    averageOrderValueInr: Float!
    cancellationRatePercent: Float!
    completionRatePercent: Float!
    activeRidersCount: Int!
    activeOrdersCount: Int!
    unreadAlertsCount: Int!
    lastOrderAt: String
  }

  type CommandCenterSummary {
    totalFranchises: Int!
    activeFranchises: Int!
    totalOrdersToday: Int!
    totalRevenueTodayInr: Float!
    totalOrders: Int!
    totalRevenueInr: Float!
    period: String!
    topEarningFranchise: FranchisePerformance
    highestVolumeFranchise: FranchisePerformance
    bestCompletionFranchise: FranchisePerformance
    criticalIncidentsCount: Int!
    unreadAlertsTotal: Int!
  }

  type Query {
    commandCenterSummary(period: String): CommandCenterSummary!
    topFranchises(period: String, limit: Int): [FranchisePerformance!]!
    criticalIncidents(franchiseId: String, status: IncidentStatus): [IncidentReport!]!
    franchisesList(status: String, search: String): [FranchisePerformance!]!
    franchiseWorkspace(franchiseId: ID!): FranchisePerformance
  }

  type Mutation {
    acknowledgeIncident(id: ID!): IncidentReport!
    resolveIncident(id: ID!, resolutionNote: String): IncidentReport!
  }
`);

/**
 * Builds the SQL date period filter expression for PostgreSQL timestamptz in Asia/Kolkata timezone
 */
export function getPeriodFilterClause(period?: string, columnPrefix: string = 'o.'): string {
  const col = `${columnPrefix}created_at`;
  const kolkataMidnightToday = `(DATE_TRUNC('day', NOW() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
  const kolkataMidnightYesterday = `(DATE_TRUNC('day', (NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day') AT TIME ZONE 'Asia/Kolkata')`;

  switch ((period || 'today').toLowerCase()) {
    case 'today':
      return `${col} >= ${kolkataMidnightToday}`;
    case 'yesterday':
      return `${col} >= ${kolkataMidnightYesterday} AND ${col} < ${kolkataMidnightToday}`;
    case '7d':
    case 'week':
      return `${col} >= (NOW() - INTERVAL '7 days')`;
    case '30d':
    case 'month':
      return `${col} >= (NOW() - INTERVAL '30 days')`;
    case 'all':
      return '1=1';
    default:
      return `${col} >= ${kolkataMidnightToday}`;
  }
}

/**
 * Fetch and aggregate franchise telemetry with CTEs to eliminate cartesian multiplication
 */
export async function fetchFranchiseTelemetry(period?: string, franchiseFilterId?: string): Promise<any[]> {
  const correlationId = `ft_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let fSnap: any, bSnap: any, riderSnap: any, notifSnap: any;

  const fastFirestore = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 1500))
    ]).catch(() => fallback);
  };

  try {
    [fSnap, bSnap, riderSnap, notifSnap] = await Promise.all([
      fastFirestore(adminDb.collection('franchise_entities').get(), { docs: [] } as any),
      fastFirestore(adminDb.collection('franchises').get(), { docs: [] } as any),
      fastFirestore(adminDb.collection('delivery_partners').get(), { docs: [] } as any),
      fastFirestore(adminDb.collection('notifications').where('isRead', '==', false).get(), { docs: [] } as any)
    ]);
  } catch (err: any) {
    console.warn(`[GraphQL][${correlationId}] Firestore metadata notice, falling back to PostgreSQL:`, err?.message);
    fSnap = { docs: [] };
    bSnap = { docs: [] };
    riderSnap = { docs: [] };
    notifSnap = { docs: [] };
  }

  const fDocs = (fSnap?.docs || []).map((d: any) => ({ id: d.id, ...(d.data() || {}) }));
  const bDocs = (bSnap?.docs || []).map((d: any) => ({ id: d.id, ...(d.data() || {}) }));
  const riderDocs = (riderSnap?.docs || []).map((d: any) => ({ id: d.id, ...(d.data() || {}) }));
  const unreadNotifs = (notifSnap?.docs || []).map((d: any) => ({ id: d.id, ...(d.data() || {}) }));

  // Deduplicate and assemble unique franchise list
  const franchiseMap = new Map<string, any>();
  if (fDocs.length === 0 && bDocs.length === 0) {
    franchiseMap.set('fra_rajnandgaon', {
      id: 'fra_rajnandgaon',
      name: 'Olive Pizza — Rajnandgaon HQ',
      city: 'Rajnandgaon',
      state: 'Chhattisgarh',
      status: 'ACTIVE'
    });
  }
  for (const f of fDocs) {
    franchiseMap.set(f.id, f);
  }
  for (const b of bDocs) {
    const fid = b.franchiseId || (b.id === 'fra_primary' ? 'fra_rajnandgaon' : b.id);
    if (!franchiseMap.has(fid)) {
      franchiseMap.set(fid, {
        id: fid,
        name: b.name || `Olive Pizza ${b.city || 'Franchise'}`,
        city: b.city || 'Rajnandgaon',
        state: b.region || b.state || 'Chhattisgarh',
        status: b.status || (b.isActive !== false ? 'ACTIVE' : 'SUSPENDED')
      });
    }
  }



  // 2. Fetch order metrics from canonical_orders using CTEs
  const periodClause = getPeriodFilterClause(period, 'o.');
  const sql = `
    WITH scoped_orders AS (
      SELECT 
        o.id,
        o.franchise_id,
        o.branch_id,
        o.total_amount,
        o.refund_amount,
        o.order_status,
        o.payment_status,
        o.created_at
      FROM canonical_orders o
      WHERE ${periodClause}
    )
    SELECT
      COALESCE(NULLIF(franchise_id, ''), 'fra_primary') AS franchise_id,
      COUNT(id)::int AS total_orders,
      COALESCE(SUM(total_amount), 0)::float AS gross_sales_inr,
      COALESCE(SUM(total_amount - COALESCE(refund_amount, 0)) FILTER (WHERE order_status NOT IN ('CANCELLED', 'REJECTED', 'FAILED') AND payment_status != 'FAILED'), 0)::float AS net_sales_inr,
      COALESCE(COUNT(id) FILTER (WHERE order_status IN ('CANCELLED', 'REJECTED', 'FAILED')), 0)::int AS cancelled_orders,
      COALESCE(COUNT(id) FILTER (WHERE order_status IN ('DELIVERED', 'COMPLETED')), 0)::int AS delivered_orders,
      COALESCE(COUNT(id) FILTER (WHERE order_status IN ('PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY')), 0)::int AS active_orders,
      MAX(created_at) AS last_order_at
    FROM scoped_orders
    GROUP BY COALESCE(NULLIF(franchise_id, ''), 'fra_primary');
  `;

  let orderStatsRows: any[] = [];
  try {
    const orderStatsRes = await query(sql);
    orderStatsRows = orderStatsRes.rows || [];
    for (const r of orderStatsRows) {
      const fid = r.franchise_id;
      if (fid && fid !== 'fra_primary' && !franchiseMap.has(fid)) {
        franchiseMap.set(fid, {
          id: fid,
          name: `Olive Pizza (${fid})`,
          city: 'Rajnandgaon',
          state: 'Chhattisgarh',
          status: 'ACTIVE'
        });
      }
    }
  } catch (err: any) {
    console.error(`[GraphQL][${correlationId}] PostgreSQL order aggregation failure:`, err);
    throw new GraphQLError(`Telemetry order statistics unavailable [ref: ${correlationId}]`, {
      extensions: { code: 'DATABASE_ERROR', correlationId }
    });
  }

  // Map and assemble performance object per franchise
  const franchiseDocs = Array.from(franchiseMap.values());
  return franchiseDocs
    .filter(f => !franchiseFilterId || f.id === franchiseFilterId || (franchiseFilterId === 'fra_rajnandgaon' && (f.id === 'fra_primary' || f.id === 'fra_rajnandgaon')))
    .map(f => {
      const fId = f.id;
      // Associate branches
      const assignedBranches = bDocs.filter(b => b.franchiseId === fId || (fId === 'fra_rajnandgaon' && (b.id === 'main_branch' || b.franchiseId === 'fra_primary')));
      const branchIds = assignedBranches.map(b => b.id);
      if (branchIds.length === 0) branchIds.push('main_branch');

      // Associate riders
      const activeRiders = riderDocs.filter(r => (r.franchiseId === fId || branchIds.includes(r.branchId)) && (r.isOnline === true || r.status === 'online'));

      // Aggregate order metrics matching franchise ID or primary HQ alias
      const orderStats = orderStatsRows.filter(r => r.franchise_id === fId || (fId === 'fra_rajnandgaon' && r.franchise_id === 'fra_primary'));
      const totalOrders = orderStats.reduce((acc, r) => acc + Number(r.total_orders || 0), 0);
      const grossSalesInr = Number(orderStats.reduce((acc, r) => acc + Number(r.gross_sales_inr || 0), 0).toFixed(2));
      const netSalesInr = Number(orderStats.reduce((acc, r) => acc + Number(r.net_sales_inr || 0), 0).toFixed(2));
      const cancelledOrders = orderStats.reduce((acc, r) => acc + Number(r.cancelled_orders || 0), 0);
      const deliveredOrders = orderStats.reduce((acc, r) => acc + Number(r.delivered_orders || 0), 0);
      const activeOrdersCount = orderStats.reduce((acc, r) => acc + Number(r.active_orders || 0), 0);

      const cancellationRatePercent = totalOrders > 0
        ? Number(((cancelledOrders / totalOrders) * 100).toFixed(2))
        : 0;

      const completionRatePercent = totalOrders > 0
        ? Number(((deliveredOrders / totalOrders) * 100).toFixed(2))
        : 0;

      const aov = totalOrders > 0 ? Number((grossSalesInr / totalOrders).toFixed(2)) : 0;

      // Find latest order date
      let lastOrderAt: string | null = null;
      for (const r of orderStats) {
        if (r.last_order_at) {
          const dStr = new Date(r.last_order_at).toISOString();
          if (!lastOrderAt || dStr > lastOrderAt) lastOrderAt = dStr;
        }
      }

      // Unread alerts count
      const franchiseUnread = unreadNotifs.filter((n: any) => n.franchiseId === fId || branchIds.includes(n.branchId));
      const unreadAlertsCount = franchiseUnread.length;

      return {
        franchiseId: fId,
        name: f.name || 'Olive Pizza Franchise',
        city: f.city || 'Rajnandgaon',
        state: f.region || f.state || 'Chhattisgarh',
        status: f.status || (f.isActive !== false ? 'ACTIVE' : 'SUSPENDED'),
        branchesCount: Math.max(assignedBranches.length, 1),
        totalOrders,
        grossSalesPaise: Math.round(grossSalesInr * 100),
        netSalesPaise: Math.round(netSalesInr * 100),
        totalSalesInr: grossSalesInr,
        averageOrderValueInr: aov,
        cancellationRatePercent,
        completionRatePercent,
        activeRidersCount: activeRiders.length,
        activeOrdersCount,
        unreadAlertsCount,
        lastOrderAt
      };
    });
}

export const rootResolver = {
  commandCenterSummary: async ({ period }: { period?: string }, context: any) => {
    if (!context?.isOwner) {
      throw new GraphQLError('Forbidden: Command Center access is restricted to authorized platform owners.', {
        extensions: { code: 'FORBIDDEN' }
      });
    }

    const normPeriod = (period || 'today').toLowerCase();
    const franchises = await fetchFranchiseTelemetry(normPeriod);

    const sortedBySales = [...franchises].sort((a, b) => b.totalSalesInr - a.totalSalesInr);
    const sortedByVolume = [...franchises].sort((a, b) => b.totalOrders - a.totalOrders);
    
    // Calculate bestCompletionFranchise based on actual completionRatePercent
    const eligibleForCompletion = franchises.filter(f => f.totalOrders > 0);
    eligibleForCompletion.sort((a, b) => {
      if (b.completionRatePercent !== a.completionRatePercent) {
        return b.completionRatePercent - a.completionRatePercent;
      }
      return b.totalOrders - a.totalOrders;
    });
    const bestCompletionFranchise = eligibleForCompletion[0] || null;

    const totalRevenueInr = Number(franchises.reduce((acc, f) => acc + f.totalSalesInr, 0).toFixed(2));
    const totalOrders = franchises.reduce((acc, f) => acc + f.totalOrders, 0);

    const fastFs = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 1000))
      ]).catch(() => fallback);
    };

    // Count open/critical incidents
    const incSnap = await fastFs(
      adminDb.collection('system_incidents').where('severity', 'in', ['CRITICAL', 'HIGH']).get(),
      { docs: [] } as any
    );
    const openIncidents = (incSnap.docs || []).filter((d: any) => {
      const data = d.data();
      return data.status === 'OPEN' || data.status === 'ACKNOWLEDGED';
    });

    // Count unread alerts from notifications collection
    const notifSnap = await fastFs(
      adminDb.collection('notifications').where('isRead', '==', false).get(),
      { docs: [] } as any
    );
    const unreadAlertsTotal = (notifSnap.docs || []).length;

    return {
      totalFranchises: franchises.length,
      activeFranchises: franchises.filter(f => f.status === 'ACTIVE').length,
      totalOrdersToday: totalOrders,
      totalRevenueTodayInr: totalRevenueInr,
      totalOrders,
      totalRevenueInr,
      period: normPeriod,
      topEarningFranchise: sortedBySales[0] || null,
      highestVolumeFranchise: sortedByVolume[0] || null,
      bestCompletionFranchise,
      criticalIncidentsCount: openIncidents.length,
      unreadAlertsTotal: unreadAlertsTotal || openIncidents.length
    };
  },

  topFranchises: async ({ period, limit = 5 }: { period?: string; limit?: number }, context: any) => {
    if (!context?.isOwner) {
      throw new GraphQLError('Forbidden: Unauthorized', { extensions: { code: 'FORBIDDEN' } });
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 50);
    const franchises = await fetchFranchiseTelemetry(period);
    return franchises
      .sort((a, b) => b.totalSalesInr - a.totalSalesInr)
      .slice(0, safeLimit);
  },

  criticalIncidents: async ({ franchiseId, status }: { franchiseId?: string; status?: string }, context: any) => {
    if (!context?.user) {
      throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } });
    }

    let targetFranchise = franchiseId;
    // Strict scope check: non-owners can only query their own assigned franchise
    if (!context.isOwner) {
      const callerFranchise = context.user.franchiseId;
      if (!callerFranchise) {
        throw new GraphQLError('Forbidden: Missing franchise scope', { extensions: { code: 'FORBIDDEN' } });
      }
      if (targetFranchise && targetFranchise !== callerFranchise) {
        throw new GraphQLError('Forbidden: Cross-franchise incident access denied', { extensions: { code: 'FORBIDDEN' } });
      }
      targetFranchise = callerFranchise;
    }

    let incidentQuery: any = adminDb.collection('system_incidents');
    if (targetFranchise) {
      incidentQuery = incidentQuery.where('entityId', '==', targetFranchise);
    }
    if (status) {
      incidentQuery = incidentQuery.where('status', '==', status);
    }

    const snapshot = await incidentQuery
      .limit(50)
      .get()
      .catch((err: any) => {
        console.error('[GraphQL] Failed to query system_incidents:', err);
        throw new GraphQLError('Failed to retrieve system incidents', { extensions: { code: 'DATABASE_ERROR' } });
      });

    return (snapshot?.docs || []).map((d: any) => ({
      id: d.id,
      ...d.data()
    }));
  },

  franchisesList: async ({ status, search }: { status?: string; search?: string }, context: any) => {
    if (!context?.user) {
      throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } });
    }

    let callerFranchise: string | undefined = undefined;
    if (!context.isOwner) {
      callerFranchise = context.user.franchiseId;
      if (!callerFranchise) {
        throw new GraphQLError('Forbidden: Missing franchise scope', { extensions: { code: 'FORBIDDEN' } });
      }
    }

    let franchises = await fetchFranchiseTelemetry('all', callerFranchise);

    if (status && status !== 'all') {
      franchises = franchises.filter(f => f.status.toUpperCase() === status.toUpperCase());
    }

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      franchises = franchises.filter(f =>
        f.name.toLowerCase().includes(q) ||
        f.city.toLowerCase().includes(q) ||
        f.franchiseId.toLowerCase().includes(q)
      );
    }

    return franchises.sort((a, b) => b.totalSalesInr - a.totalSalesInr);
  },

  franchiseWorkspace: async ({ franchiseId }: { franchiseId: string }, context: any) => {
    if (!context?.user) {
      throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } });
    }
    if (!context.isOwner && (!context.user.franchiseId || context.user.franchiseId !== franchiseId)) {
      throw new GraphQLError('Forbidden: Cross-franchise access denied', { extensions: { code: 'FORBIDDEN' } });
    }

    const franchises = await fetchFranchiseTelemetry('all', franchiseId);
    return franchises[0] || null;
  },

  acknowledgeIncident: async ({ id }: { id: string }, context: any) => {
    if (!context?.user) {
      throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } });
    }

    const docRef = adminDb.collection('system_incidents').doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new GraphQLError(`Incident with id '${id}' not found`, { extensions: { code: 'NOT_FOUND' } });
    }

    const incData = snap.data() || {};
    if (incData.entityType === 'SYSTEM' || !incData.entityId || !incData.entityId.startsWith('fra_')) {
      if (!context.isOwner) {
        throw new GraphQLError('Forbidden: Only platform owners can acknowledge platform-level incidents', {
          extensions: { code: 'FORBIDDEN' }
        });
      }
    } else if (!context.isOwner && incData.entityId !== context.user.franchiseId) {
      throw new GraphQLError('Forbidden: Cross-franchise incident update denied', {
        extensions: { code: 'FORBIDDEN' }
      });
    }

    const now = new Date().toISOString();
    await docRef.set({
      status: 'ACKNOWLEDGED',
      acknowledgedBy: context.user?.email || (context.isOwner ? 'platform_owner' : context.user?.uid),
      acknowledgedAt: now,
      updatedAt: now
    }, { merge: true });

    const updatedSnap = await docRef.get();
    return { id, ...updatedSnap.data() };
  },

  resolveIncident: async ({ id, resolutionNote }: { id: string; resolutionNote?: string }, context: any) => {
    if (!context?.user) {
      throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } });
    }

    const docRef = adminDb.collection('system_incidents').doc(id);
    const snap = await docRef.get();
    if (!snap.exists) {
      throw new GraphQLError(`Incident with id '${id}' not found`, { extensions: { code: 'NOT_FOUND' } });
    }

    const incData = snap.data() || {};
    if (incData.entityType === 'SYSTEM' || !incData.entityId || !incData.entityId.startsWith('fra_')) {
      if (!context.isOwner) {
        throw new GraphQLError('Forbidden: Only platform owners can resolve platform-level incidents', {
          extensions: { code: 'FORBIDDEN' }
        });
      }
    } else if (!context.isOwner && incData.entityId !== context.user.franchiseId) {
      throw new GraphQLError('Forbidden: Cross-franchise incident update denied', {
        extensions: { code: 'FORBIDDEN' }
      });
    }

    const now = new Date().toISOString();
    await docRef.set({
      status: 'RESOLVED',
      resolvedBy: context.user?.email || (context.isOwner ? 'platform_owner' : context.user?.uid),
      resolvedAt: now,
      resolutionNote: resolutionNote || 'Resolved via Command Center',
      updatedAt: now
    }, { merge: true });

    const updatedSnap = await docRef.get();
    return { id, ...updatedSnap.data() };
  }
};

export function computeQueryDepth(source: string): number {
  try {
    const document = parse(source);
    let maxDepth = 0;

    function walk(node: any, currentDepth: number) {
      if (!node) return;
      if (currentDepth > maxDepth) maxDepth = currentDepth;
      if (node.selectionSet && Array.isArray(node.selectionSet.selections)) {
        for (const sel of node.selectionSet.selections) {
          if (sel.kind === 'Field') {
            walk(sel, currentDepth + 1);
          } else if (sel.kind === 'InlineFragment' || sel.kind === 'FragmentSpread') {
            walk(sel, currentDepth);
          }
        }
      }
    }

    for (const def of document.definitions) {
      if (def.kind === 'OperationDefinition') {
        walk(def, 0);
      }
    }
    return maxDepth;
  } catch {
    return 1;
  }
}

export async function executeGraphQL(source: string, variableValues?: any, context?: any) {
  const depth = computeQueryDepth(source);
  if (depth > 6) {
    return {
      errors: [
        new GraphQLError(`GraphQL query depth of ${depth} exceeds maximum allowed depth of 6.`, {
          extensions: { code: 'QUERY_DEPTH_LIMIT_EXCEEDED', maxDepth: 6, actualDepth: depth }
        })
      ]
    };
  }

  const timeoutPromise = new Promise<{ errors: GraphQLError[] }>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new GraphQLError('GraphQL query execution timed out (limit: 10s)', {
        extensions: { code: 'EXECUTION_TIMEOUT' }
      }));
    }, 10000);
    if (timer.unref) timer.unref();
  });

  const execPromise = graphql({
    schema,
    source,
    rootValue: rootResolver,
    contextValue: context,
    variableValues
  });

  return await Promise.race([execPromise, timeoutPromise]);
}

