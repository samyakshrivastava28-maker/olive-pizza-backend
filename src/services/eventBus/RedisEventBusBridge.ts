/**
 * RedisEventBusBridge.ts — Cross-Node Realtime Federation Engine
 *
 * In a multi-node horizontal cluster behind HAProxy:
 * 1. An order created or updated on Node A must be dispatched to WebSocket clients on Node B.
 * 2. Driver GPS coordinates sent from a courier connected to Node B must stream to
 *    customers and owner fleet maps connected to Node A.
 * 3. Domain events emitted on Node A must trigger accounting/notification listeners on Node B.
 *
 * This bridge connects local EventEmitter (AppEventBus) and OliveWebSocketServer
 * across all cluster instances via Redis Pub/Sub channels:
 *  - olive:events:domain
 *  - olive:events:ws
 */

import { Redis } from 'ioredis';
import { appEventBus, DomainEventType } from './AppEventBus.js';
import { redisService } from '../redis/RedisService.js';
import crypto from 'crypto';

export interface InterNodeMessage {
  originNodeId: string;
  channel: 'domain' | 'ws';
  action?: string;
  eventType?: string;
  targetRole?: string;
  targetUserId?: string;
  targetOrderId?: string;
  franchiseId?: string;
  branchId?: string;
  payload: any;
  timestamp: string;
}

export class RedisEventBusBridge {
  private static instance: RedisEventBusBridge;
  public readonly instanceId: string;
  private subClient: Redis | null = null;
  private pubClient: Redis | null = null;
  private isBridged = false;
  private isConnecting = false;

  // Track remotely triggered events to prevent circular re-publishing
  private remoteEventIds = new Set<string>();

  private wsServerHandler?: {
    broadcastToUser: (uid: string, message: object, fromRemote?: boolean) => void;
    broadcastToOrder: (orderId: string, message: object, fromRemote?: boolean) => void;
    broadcastToRole: (role: string, message: object, fromRemote?: boolean) => void;
    broadcastToBranch: (franchiseId: string, branchId: string, message: any, fromRemote?: boolean) => void;
    broadcastToAll: (message: object, fromRemote?: boolean) => void;
    handleDriverLocationUpdate: (data: any, fromRemote?: boolean) => void;
  };

  constructor() {
    this.instanceId = process.env.APP_INSTANCE_ID || 
                      process.env.HOSTNAME || 
                      `node_${process.pid}_${Math.random().toString(36).substring(2, 8)}`;
  }

  public static getInstance(): RedisEventBusBridge {
    if (!RedisEventBusBridge.instance) {
      RedisEventBusBridge.instance = new RedisEventBusBridge();
    }
    return RedisEventBusBridge.instance;
  }

  /**
   * Registers the WebSocket server reference for delivering cross-node messages
   */
  public registerWebSocketServer(wsServer: any): void {
    this.wsServerHandler = wsServer;
  }

  /**
   * Initializes Redis Pub/Sub subscription and bridges local events to the cluster
   */
  public async init(): Promise<void> {
    if (this.isBridged || this.isConnecting) return;
    this.isConnecting = true;

    try {
      if (!redisService.isAvailable()) {
        const ready = await redisService.waitForReady(3000);
        if (!ready) {
          console.log(`[RedisEventBusBridge] Redis unavailable — operating in standalone mode on ${this.instanceId}`);
          this.isConnecting = false;
          return;
        }
      }

      const mainClient = redisService.getClient();
      if (!mainClient) {
        this.isConnecting = false;
        return;
      }

      this.pubClient = mainClient;
      this.subClient = mainClient.duplicate();

      await this.subClient.subscribe('olive:events:domain', 'olive:events:ws');
      this.isBridged = true;
      console.log(`[RedisEventBusBridge] ✅ Connected to Redis Pub/Sub cluster on ${this.instanceId}`);

      this.subClient.on('message', (channel: string, messageStr: string) => {
        try {
          const envelope: InterNodeMessage = JSON.parse(messageStr);
          // Ignore messages emitted by this instance
          if (envelope.originNodeId === this.instanceId) return;

          this.handleIncomingMessage(channel, envelope);
        } catch (err: any) {
          console.warn('[RedisEventBusBridge] Failed to parse Pub/Sub message:', err.message);
        }
      });

      this.subClient.on('error', (err: any) => {
        console.warn('[RedisEventBusBridge] Subscriber warning:', err.message);
      });

      // Attach local DomainEventBus hooks for broadcasting to sister nodes
      this.hookDomainEvents();
    } catch (err: any) {
      console.warn('[RedisEventBusBridge] Initialization error (safe fallback to local):', err.message);
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Listens to local domain events and broadcasts them across the cluster
   */
  private hookDomainEvents(): void {
    const allDomainEvents = Object.values(DomainEventType);
    for (const eventName of allDomainEvents) {
      appEventBus.on(eventName, (data: any) => {
        // If this event was received from another node, do not re-broadcast
        if (data?.__fromClusterBridge) return;

        this.publishDomainEvent(eventName, data);
      });
    }

    // Also hook order.status_changed
    appEventBus.on('order.status_changed', (data: any) => {
      if (data?.__fromClusterBridge) return;
      this.publishDomainEvent('order.status_changed', data);
    });
  }

  /**
   * Publishes a local domain event to all cluster nodes
   */
  public async publishDomainEvent(eventType: string, payload: any): Promise<void> {
    if (!this.pubClient || !this.isBridged) return;

    try {
      const envelope: InterNodeMessage = {
        originNodeId: this.instanceId,
        channel: 'domain',
        eventType,
        payload,
        timestamp: new Date().toISOString()
      };
      await this.pubClient.publish('olive:events:domain', JSON.stringify(envelope));
    } catch (err: any) {
      console.warn(`[RedisEventBusBridge] Error publishing domain event "${eventType}":`, err.message);
    }
  }

  /**
   * Publishes a WebSocket broadcast command to sister cluster nodes
   */
  public async publishWsBroadcast(action: string, details: Partial<InterNodeMessage>): Promise<void> {
    if (!this.pubClient || !this.isBridged) return;

    try {
      const envelope: InterNodeMessage = {
        originNodeId: this.instanceId,
        channel: 'ws',
        action,
        timestamp: new Date().toISOString(),
        ...details
      } as InterNodeMessage;

      await this.pubClient.publish('olive:events:ws', JSON.stringify(envelope));
    } catch (err: any) {
      console.warn(`[RedisEventBusBridge] Error publishing WS action "${action}":`, err.message);
    }
  }

  /**
   * Dispatches incoming cross-node messages to local listeners and WebSocket clients
   */
  private handleIncomingMessage(channel: string, envelope: InterNodeMessage): void {
    if (channel === 'olive:events:domain') {
      const eventType = envelope.eventType;
      if (!eventType) return;

      // Re-emit on local domain event bus with flag preventing circular echo
      const enrichedPayload = {
        ...envelope.payload,
        __fromClusterBridge: true,
        __originNodeId: envelope.originNodeId
      };
      appEventBus.emit(eventType, enrichedPayload);
      return;
    }

    if (channel === 'olive:events:ws' && this.wsServerHandler) {
      const action = envelope.action;
      switch (action) {
        case 'broadcastToUser':
          if (envelope.targetUserId) {
            this.wsServerHandler.broadcastToUser(envelope.targetUserId, envelope.payload, true);
          }
          break;

        case 'broadcastToOrder':
          if (envelope.targetOrderId) {
            this.wsServerHandler.broadcastToOrder(envelope.targetOrderId, envelope.payload, true);
          }
          break;

        case 'broadcastToRole':
          if (envelope.targetRole) {
            this.wsServerHandler.broadcastToRole(envelope.targetRole, envelope.payload, true);
          }
          break;

        case 'broadcastToBranch':
          if (envelope.franchiseId && envelope.branchId) {
            this.wsServerHandler.broadcastToBranch(envelope.franchiseId, envelope.branchId, envelope.payload, true);
          }
          break;

        case 'broadcastToAll':
          this.wsServerHandler.broadcastToAll(envelope.payload, true);
          break;

        case 'driverLocationUpdate':
          this.wsServerHandler.handleDriverLocationUpdate(envelope.payload, true);
          break;

        default:
          break;
      }
    }
  }

  public isClusterBridged(): boolean {
    return this.isBridged;
  }

  public async close(): Promise<void> {
    try {
      if (this.subClient) {
        await this.subClient.unsubscribe();
        await this.subClient.quit();
      }
    } catch {}
    this.isBridged = false;
  }
}

export const redisEventBusBridge = RedisEventBusBridge.getInstance();
