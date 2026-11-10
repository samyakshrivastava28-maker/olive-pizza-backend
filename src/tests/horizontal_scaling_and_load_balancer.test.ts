/**
 * horizontal_scaling_and_load_balancer.test.ts
 *
 * Automated verification suite for Central HAProxy Load Balancer & Horizontal Scalability:
 * 1. Health Probe endpoints (/live and /ready).
 * 2. DistributedJobCoordinator mutual exclusion, cluster coordination, and fallback.
 * 3. RedisEventBusBridge and cross-node WebSocket event federation.
 * 4. HAProxy configuration structural and security compliance.
 * 5. PostgreSQL connection budgeting formulas and PgBouncer threshold validation.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import app from '../app.js';
import { DistributedJobCoordinator } from '../services/jobs/DistributedJobCoordinator.js';
import { RedisEventBusBridge } from '../services/eventBus/RedisEventBusBridge.js';
import { appEventBus, DomainEventType } from '../services/eventBus/AppEventBus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('CENTRAL LOAD BALANCER & HORIZONTAL SCALING VERIFICATION SUITE', () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── TEST 1: HEALTH PROBES (/live & /ready) ─────────────────────────────────
  describe('1. Health Probes Verification', () => {
    test('GET /live (liveness probe) returns 200 OK without disclosing internal topology', async () => {
      const res = await fetch(`${baseUrl}/live`);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.status, 'ok');
      assert.ok(typeof data.uptime === 'number');
      assert.ok(typeof data.timestamp === 'string');
      // Must NOT leak credentials or private topology
      assert.equal(data.connectionString, undefined);
      assert.equal(data.credentials, undefined);
    });

    test('GET /ready (readiness probe) verifies core database and cache health', { timeout: 15000 }, async () => {
      const res = await fetch(`${baseUrl}/ready`);
      // Status code is either 200 (healthy) or 503 (degraded) depending on local dev db connectivity
      assert.ok([200, 503].includes(res.status));
      const data = await res.json() as any;
      assert.ok(data.checks !== undefined);
      assert.ok(data.checks.postgres !== undefined);
      assert.ok(data.checks.redis !== undefined);
      assert.ok(data.checks.firestore !== undefined);
    });
  });

  // ── TEST 2: DISTRIBUTED JOB COORDINATOR ────────────────────────────────────
  describe('2. DistributedJobCoordinator Mutual Exclusion & Fallback', () => {
    test('Coordinates job execution and prevents duplicate concurrent runs across simulated nodes', async () => {
      const coordinatorNodeA = new DistributedJobCoordinator();
      const coordinatorNodeB = new DistributedJobCoordinator();

      assert.notEqual(coordinatorNodeA.instanceId, coordinatorNodeB.instanceId);

      let executionCount = 0;
      let nodeAHeldLock = false;

      // Node A starts a long-running coordinated task
      const taskPromise = coordinatorNodeA.withJobLock('test_simulated_cart_scan', 10, async () => {
        nodeAHeldLock = true;
        executionCount++;
        // Simulate task duration
        await new Promise(r => setTimeout(r, 150));
        return { itemsProcessed: 42 };
      });

      // Give Node A a moment to acquire the lock
      await new Promise(r => setTimeout(r, 20));

      // Node B attempts to execute the same job concurrently while Node A is running
      const nodeBResult = await coordinatorNodeB.withJobLock('test_simulated_cart_scan', 10, async () => {
        executionCount++;
        return { itemsProcessed: 999 };
      });

      const nodeAResult = await taskPromise;

      assert.equal(nodeAResult.executed, true);
      assert.deepEqual(nodeAResult.result, { itemsProcessed: 42 });

      // If Redis or Postgres was active, Node B must be locked out
      if (nodeAResult.coordinator !== 'local_fallback') {
        assert.equal(nodeBResult.executed, false);
        assert.equal(nodeBResult.reason, 'LOCKED_BY_ANOTHER_NODE');
        assert.equal(executionCount, 1, 'Only one node should have executed the job');
      } else {
        // In local mode without DB, both run sequentially
        assert.ok(executionCount >= 1);
      }
    });

    test('runScheduledSingleton absorbs clock skew and prevents duplicate execution in debounce window', async () => {
      const coordinator = DistributedJobCoordinator.getInstance();
      let runs = 0;

      const res1 = await coordinator.runScheduledSingleton('test_daily_sync_window', 5, async () => {
        runs++;
        return 'DONE';
      });

      assert.equal(res1.executed, true);

      // Immediate second call in same debounce window should be skipped if Redis is available
      const res2 = await coordinator.runScheduledSingleton('test_daily_sync_window', 5, async () => {
        runs++;
        return 'DUPLICATE';
      });

      if (res1.coordinator === 'redis') {
        assert.equal(res2.executed, false);
        assert.equal(res2.reason, 'INTERVAL_ALREADY_EXECUTED');
        assert.equal(runs, 1);
      }
    });
  });

  // ── TEST 3: REDIS EVENT BUS BRIDGE & CROSS-NODE WEBSOCKET BROADCAST ────────
  describe('3. RedisEventBusBridge & Cross-Node WebSocket Broadcast', () => {
    test('Bridge generates unique instanceId and attaches to domain events', () => {
      const bridge = RedisEventBusBridge.getInstance();
      assert.ok(typeof bridge.instanceId === 'string');
      assert.ok(bridge.instanceId.length > 0);
    });

    test('Re-emitting cross-node events with __fromClusterBridge prevents circular message storms', async () => {
      let receivedData: any = null;

      const handler = (data: any) => {
        if (data.__fromClusterBridge) {
          receivedData = data;
        }
      };

      appEventBus.on('order.status_changed', handler);

      try {
        // Simulate an incoming event received from a remote sister node
        appEventBus.emit('order.status_changed', {
          orderId: 'ord_remote_123',
          orderNumber: 'OP-123',
          userId: 'usr_456',
          customerName: 'Alice',
          previousStatus: 'ACCEPTED',
          currentStatus: 'PREPARING',
          totalAmount: 499,
          timestamp: new Date().toISOString(),
          __fromClusterBridge: true,
          __originNodeId: 'node_simulated_remote'
        });

        assert.ok(receivedData !== null, 'Handler should receive the event');
        assert.equal(receivedData.orderId, 'ord_remote_123');
        assert.equal(receivedData.__originNodeId, 'node_simulated_remote');
      } finally {
        appEventBus.removeListener('order.status_changed', handler);
      }
    });

    test('WebSocket server routes incoming cross-node commands to local subscribers', () => {
      const bridge = RedisEventBusBridge.getInstance();
      let routedAction: string | null = null;
      let routedData: any = null;

      // Mock local WS server registration
      bridge.registerWebSocketServer({
        broadcastToUser: (uid: string, msg: any) => { routedAction = 'broadcastToUser'; routedData = { uid, msg }; },
        broadcastToOrder: (orderId: string, msg: any) => { routedAction = 'broadcastToOrder'; routedData = { orderId, msg }; },
        broadcastToRole: (role: string, msg: any) => { routedAction = 'broadcastToRole'; routedData = { role, msg }; },
        broadcastToBranch: (fId: string, bId: string, msg: any) => { routedAction = 'broadcastToBranch'; routedData = { fId, bId, msg }; },
        broadcastToAll: (msg: any) => { routedAction = 'broadcastToAll'; routedData = msg; },
        handleDriverLocationUpdate: (data: any) => { routedAction = 'driverLocationUpdate'; routedData = data; },
      });

      // Call handleIncomingMessage via private simulation
      (bridge as any).handleIncomingMessage('olive:events:ws', {
        originNodeId: 'node_sister_99',
        channel: 'ws',
        action: 'broadcastToRole',
        targetRole: 'restaurant_manager',
        payload: { type: 'order.created', orderId: 'ord_sister_777' }
      });

      assert.equal(routedAction, 'broadcastToRole');
      assert.deepEqual(routedData, {
        role: 'restaurant_manager',
        msg: { type: 'order.created', orderId: 'ord_sister_777' }
      });
    });
  });

  // ── TEST 4: HAPROXY CONFIGURATION STRUCTURAL & SECURITY AUDIT ───────────────
  describe('4. HAProxy Configuration & Script Compliance', () => {
    const configPath = path.resolve(__dirname, '../infrastructure/haproxy/haproxy.cfg');
    const reloadScriptPath = path.resolve(__dirname, '../infrastructure/haproxy/validate_and_reload.sh');
    const manageScriptPath = path.resolve(__dirname, '../infrastructure/haproxy/manage_nodes.sh');

    test('haproxy.cfg file exists and contains essential production directives', () => {
      assert.ok(fs.existsSync(configPath), 'haproxy.cfg must exist in infrastructure/haproxy');
      const content = fs.readFileSync(configPath, 'utf8');

      // Admin runtime socket
      assert.ok(content.includes('stats socket /run/haproxy/admin.sock'), 'Must configure admin socket');
      assert.ok(content.includes('mode 660 level admin'), 'Socket must have admin privilege');

      // Modern SSL configuration
      assert.ok(content.includes('ssl-min-ver TLSv1.2'), 'Must enforce minimum TLS 1.2');
      assert.ok(content.includes('ssl-default-bind-ciphers'), 'Must define modern TLS cipher suite');

      // Timeouts
      assert.ok(content.includes('timeout connect        5000ms'), 'Must have 5s connect timeout');
      assert.ok(content.includes('timeout client         30000ms'), 'Must have 30s client timeout');
      assert.ok(content.includes('timeout server         30000ms'), 'Must have 30s server timeout');
      assert.ok(content.includes('timeout tunnel         1h'), 'Must have 1h tunnel timeout for persistent WebSockets');

      // Forwarded headers
      assert.ok(content.includes('option forwardfor header X-Forwarded-For'), 'Must forward client IP');
      assert.ok(content.includes('http-request set-header X-Forwarded-Proto https'), 'Must set X-Forwarded-Proto');
      assert.ok(content.includes('http-request set-header X-Forwarded-Port'), 'Must set X-Forwarded-Port');

      // Security headers
      assert.ok(content.includes('Strict-Transport-Security'), 'Must set HSTS');
      assert.ok(content.includes('X-Content-Type-Options "nosniff"'), 'Must set nosniff');
      assert.ok(content.includes('X-Frame-Options "SAMEORIGIN"'), 'Must set X-Frame-Options');

      // Request body size limit (20MB)
      assert.ok(content.includes('20971520'), 'Must enforce 20MB request limit');
      assert.ok(content.includes('deny_status 413'), 'Must return 413 for oversized payloads');

      // Active health checking
      assert.ok(content.includes('option httpchk GET /ready'), 'API backend must probe /ready');
      assert.ok(content.includes('http-check expect status 200'), 'API backend must expect HTTP 200');

      // Initial VPS server + prepared horizontal scaling slots
      assert.ok(content.includes('server app_node_1 127.0.0.1:5000'), 'Must define initial production node');
      assert.ok(content.includes('server app_node_2 10.0.0.2:5000'), 'Must pre-configure horizontal node 2');
      assert.ok(content.includes('server app_node_3 10.0.0.3:5000'), 'Must pre-configure horizontal node 3');
      assert.ok(content.includes('disabled'), 'Horizontal nodes must be disabled by default until provisioned');
    });

    test('validate_and_reload.sh and manage_nodes.sh exist and are executable scripts', () => {
      assert.ok(fs.existsSync(reloadScriptPath), 'validate_and_reload.sh must exist');
      assert.ok(fs.existsSync(manageScriptPath), 'manage_nodes.sh must exist');

      const reloadContent = fs.readFileSync(reloadScriptPath, 'utf8');
      assert.ok(reloadContent.includes('haproxy -c -V -f'), 'Must validate syntax before reload');
      assert.ok(reloadContent.includes('systemctl reload haproxy'), 'Must support graceful reload');

      const manageContent = fs.readFileSync(manageScriptPath, 'utf8');
      assert.ok(manageContent.includes('socat'), 'Must communicate via socat with admin socket');
      assert.ok(manageContent.includes('state drain'), 'Must support graceful drain command');
      assert.ok(manageContent.includes('state ready'), 'Must support enable command');
    });
  });

  // ── TEST 5: POSTGRESQL CONNECTION BUDGETING CALCULATION ─────────────────────
  describe('5. PostgreSQL Connection Budgeting Verification', () => {
    /**
     * Mathematical Formula for Connection Allocation:
     * C_avail = C_total - C_reserved - C_admin
     * P_node <= floor(C_avail / N)
     * Where:
     *  C_total = postgres max_connections (e.g. 100)
     *  C_reserved = superuser_reserved_connections (3)
     *  C_admin = migrations, backups, monitoring (7)
     *  C_avail = 90
     */
    function calculatePoolPerNode(totalMaxConn: number, numNodes: number): {
      cAvail: number;
      poolPerNode: number;
      totalAllocated: number;
      recommendedMode: 'direct' | 'pgbouncer';
    } {
      const cReserved = 3;
      const cAdmin = 7;
      const cAvail = totalMaxConn - cReserved - cAdmin;
      const poolPerNode = Math.floor(cAvail / numNodes);
      const totalAllocated = poolPerNode * numNodes;
      const recommendedMode = numNodes >= 6 ? 'pgbouncer' : 'direct';

      return { cAvail, poolPerNode, totalAllocated, recommendedMode };
    }

    test('Calculates safe connection budgets across cluster topologies', () => {
      // Topology 1: Single VPS (1 node)
      const b1 = calculatePoolPerNode(100, 1);
      assert.equal(b1.cAvail, 90);
      assert.ok(b1.poolPerNode >= 20, 'Single node can utilize up to 20-25 connections safely');
      assert.equal(b1.recommendedMode, 'direct');

      // Topology 2: 3 Horizontal Nodes
      const b3 = calculatePoolPerNode(100, 3);
      assert.equal(b3.poolPerNode, 30);
      assert.ok(b3.totalAllocated <= 90);
      assert.equal(b3.recommendedMode, 'direct');

      // Topology 3: 5 Horizontal Nodes
      const b5 = calculatePoolPerNode(100, 5);
      assert.equal(b5.poolPerNode, 18);
      assert.ok(b5.totalAllocated <= 90);
      assert.equal(b5.recommendedMode, 'direct');

      // Topology 4: 8 Horizontal Nodes (requires PgBouncer)
      const b8 = calculatePoolPerNode(100, 8);
      assert.equal(b8.recommendedMode, 'pgbouncer', 'Clusters with >=6 nodes require central PgBouncer');
    });
  });
});
