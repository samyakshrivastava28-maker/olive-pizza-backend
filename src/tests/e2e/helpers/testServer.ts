/**
 * E2E Backend Test Server Helper
 * Connects to running backend on :5000 if active, otherwise launches an ephemeral
 * test server with express app and WebSocketServer attached.
 */

import http from 'http';
import express from 'express';
import apiApp, { corsMiddleware } from '../../../app.js';
import healthRoutes from '../../../routes/health.routes.js';
import { webSocketServer } from '../../../services/websocket/WebSocketServer.js';

let activeServer: http.Server | null = null;
let activeBaseUrl: string | null = null;
let activeWsUrl: string | null = null;

export async function getServerInfo(): Promise<{
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}> {
  if (activeBaseUrl && activeWsUrl) {
    return {
      baseUrl: activeBaseUrl,
      wsUrl: activeWsUrl,
      close: async () => {},
    };
  }

  // 1. Check if backend on port 5000 is already active
  try {
    const res = await fetch('http://127.0.0.1:5000/heartbeat', { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      activeBaseUrl = 'http://127.0.0.1:5000';
      activeWsUrl = 'ws://127.0.0.1:5000/ws';
      return {
        baseUrl: activeBaseUrl,
        wsUrl: activeWsUrl,
        close: async () => {},
      };
    }
  } catch {
    // Port 5000 not active, start in-process test server
  }

  // 2. Start in-process test server
  const testApp = express();
  testApp.use(corsMiddleware);
  testApp.use(healthRoutes);
  testApp.use('/api', apiApp);
  testApp.use(apiApp);

  const server = http.createServer(testApp);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      activeBaseUrl = `http://127.0.0.1:${addr.port}`;
      activeWsUrl = `ws://127.0.0.1:${addr.port}/ws`;
      try {
        webSocketServer.attach(server);
      } catch (e) {
        console.warn('[testServer] webSocketServer attach notice:', e);
      }
      activeServer = server;
      resolve();
    });
    server.on('error', reject);
  });

  return {
    baseUrl: activeBaseUrl!,
    wsUrl: activeWsUrl!,
    close: async () => {
      if (activeServer) {
        await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
        activeServer = null;
        activeBaseUrl = null;
        activeWsUrl = null;
      }
    },
  };
}
