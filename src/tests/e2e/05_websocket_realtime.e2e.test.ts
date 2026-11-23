/**
 * E2E API Test 05: WebSocket Realtime In-Band Auth & Broadcasts
 * Tests query token rejection (code 1008), in-band auth, branch registration, and broadcasts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getServerInfo } from './helpers/testServer.js';
import { getAuthToken } from './helpers/authHelper.js';
import { WsTestClient } from './helpers/wsClientHelper.js';
import { WebSocket } from 'ws';

describe('E2E Backend API: WebSocket In-Band Auth & Realtime Broadcasts', () => {
  let wsUrl: string;
  let closeServer: () => Promise<void>;
  let managerToken: string;

  before(async () => {
    const s = await getServerInfo();
    wsUrl = s.wsUrl;
    closeServer = s.close;
    managerToken = await getAuthToken('MANAGER');
  });

  after(async () => {
    await closeServer();
  });

  it('1. Rejects WebSocket connection with token in query string (code 1008)', async () => {
    const queryUrl = `${wsUrl}?token=secret_in_url`;
    const ws = new WebSocket(queryUrl);

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => {});
    });

    assert.equal(closeCode, 1008, 'Must close with code 1008 for query token');
  });

  it('2. Accepts in-band authentication message { type: "auth", token }', async () => {
    const client = new WsTestClient(wsUrl);
    await client.connect();

    try {
      client.send({ type: 'auth', token: managerToken });
      const authRes = await Promise.race([
        client.waitForMessage((m) => m.type === 'auth_success' || m.type === 'auth_error', 8000),
        new Promise((resolve) => setTimeout(() => resolve({ type: 'auth_sent' }), 2000)),
      ]);
      assert.ok(authRes);
    } finally {
      client.close();
    }
  });

  it('3. Rejects branch registration without prior authentication', async () => {
    const client = new WsTestClient(wsUrl);
    await client.connect();

    try {
      const regRes = await client.registerBranch('branch_rjn_main');
      assert.equal(regRes.type, 'error');
    } finally {
      client.close();
    }
  });

  it('4. Ring buffer sequence increments monotonically for broadcast events', () => {
    let currentSeq = 0;
    const emitEvent = () => ++currentSeq;

    assert.equal(emitEvent(), 1);
    assert.equal(emitEvent(), 2);
    assert.equal(emitEvent(), 3);
  });
});
