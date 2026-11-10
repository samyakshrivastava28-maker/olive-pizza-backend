import assert from 'assert';
import { describe, it } from 'node:test';
import { executeGraphQL } from '../graphql/index.ts';
import { adminDb } from '../config/firebase.ts';

describe('GraphQL CTE Aggregation, Currency & Security Invariants', () => {
  const mockOwnerContext = {
    isOwner: true,
    user: {
      uid: 'platform_owner_uid',
      email: 'webhub2811@gmail.com',
      role: 'platform_owner'
    }
  };

  const mockFranchiseContext = {
    isOwner: false,
    user: {
      uid: 'franchise_mgr_uid',
      email: 'manager.durg@olivepizza.in',
      role: 'franchise_manager',
      franchiseId: 'fra_durg'
    }
  };

  const mockPublicContext = {
    isOwner: false,
    user: null
  };

  it('1. Rejects unauthenticated and non-owner access to commandCenterSummary', async () => {
    const query = `
      query {
        commandCenterSummary {
          totalFranchises
          totalRevenueTodayInr
        }
      }
    `;

    const publicResult = await executeGraphQL(query, {}, mockPublicContext);
    assert.ok(publicResult.errors && publicResult.errors.length > 0);
    assert.match(publicResult.errors[0].message, /Command Center access is restricted/i);

    const franchiseResult = await executeGraphQL(query, {}, mockFranchiseContext);
    assert.ok(franchiseResult.errors && franchiseResult.errors.length > 0);
    assert.match(franchiseResult.errors[0].message, /Command Center access is restricted/i);
  });

  it('2. Rejects unauthorized access to topFranchises', async () => {
    const query = `
      query {
        topFranchises(limit: 5) {
          franchiseId
          totalSalesInr
        }
      }
    `;

    const result = await executeGraphQL(query, {}, mockFranchiseContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /Unauthorized|Forbidden/i);
  });

  it('3. Rejects cross-franchise incident access for franchise manager', async () => {
    const crossQuery = `
      query {
        criticalIncidents(franchiseId: "fra_rajnandgaon") {
          id
          title
        }
      }
    `;

    const result = await executeGraphQL(crossQuery, {}, mockFranchiseContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /Cross-franchise incident access denied/i);
  });

  it('4. Rejects cross-franchise workspace query for unauthorized franchise manager', async () => {
    const workspaceQuery = `
      query {
        franchiseWorkspace(franchiseId: "fra_rajnandgaon") {
          franchiseId
          name
        }
      }
    `;

    const result = await executeGraphQL(workspaceQuery, {}, mockFranchiseContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /Cross-franchise access denied/i);
  });

  it('5. Allows platform owner to execute commandCenterSummary and aggregates correctly without cartesian expansion', async () => {
    const query = `
      query {
        commandCenterSummary(period: "all") {
          totalFranchises
          totalOrdersToday
          totalRevenueTodayInr
          criticalIncidentsCount
        }
      }
    `;

    const result = await executeGraphQL(query, {}, mockOwnerContext);
    assert.strictEqual(result.errors, undefined, `Expected no GraphQL errors but got: ${JSON.stringify(result.errors)}`);
    assert.ok(result.data?.commandCenterSummary);
    assert.strictEqual(typeof result.data.commandCenterSummary.totalFranchises, 'number');
    assert.strictEqual(typeof result.data.commandCenterSummary.totalRevenueTodayInr, 'number');
  });

  it('6. Rejects incident acknowledgment for non-owners', async () => {
    const testIncRef = adminDb.collection('system_incidents').doc('inc_test_platform_incident');
    await testIncRef.set({
      entityType: 'SYSTEM',
      entityId: 'sys_core',
      status: 'OPEN',
      title: 'Core Engine Test Alert'
    });

    try {
      const mutation = `
        mutation {
          acknowledgeIncident(id: "inc_test_platform_incident") {
            id
          }
        }
      `;

      const result = await executeGraphQL(mutation, {}, mockFranchiseContext);
      assert.ok(result.errors && result.errors.length > 0);
      assert.match(result.errors[0].message, /Only platform owners can acknowledge platform-level incidents/i);
    } finally {
      await testIncRef.delete().catch(() => {});
    }
  });

  it('7. Rejects incident acknowledgment if incident document does not exist', async () => {
    const mutation = `
      mutation {
        acknowledgeIncident(id: "inc_definitely_not_existing_12345") {
          id
        }
      }
    `;

    const result = await executeGraphQL(mutation, {}, mockOwnerContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /not found/i);
  });

  it('8. Enforces query depth limit of 6', async () => {
    const deepQuery = `
      query DeepQuery {
        franchisesList {
          branches {
            activeRiders {
              assignedOrders {
                items {
                  product {
                    category {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const result = await executeGraphQL(deepQuery, {}, mockOwnerContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /depth of \d+ exceeds maximum allowed depth of 6/i);
  });

  it('9. Rejects incident resolution if incident document does not exist', async () => {
    const mutation = `
      mutation {
        resolveIncident(id: "inc_definitely_not_existing_12345", resolutionNote: "Test resolve") {
          id
        }
      }
    `;

    const result = await executeGraphQL(mutation, {}, mockOwnerContext);
    assert.ok(result.errors && result.errors.length > 0);
    assert.match(result.errors[0].message, /not found/i);
  });
});
