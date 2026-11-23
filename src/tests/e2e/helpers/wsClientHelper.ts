/**
 * E2E WebSocket Test Client Helper
 * Connects to /ws, handles in-band auth, branch registration, and event capture.
 */

import { WebSocket } from 'ws';

export class WsTestClient {
  private ws: WebSocket | null = null;
  public messages: any[] = [];
  private messageListeners: ((msg: any) => void)[] = [];

  constructor(private url: string) {}

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          this.messages.push(parsed);
          for (const listener of this.messageListeners) {
            listener(parsed);
          }
        } catch {}
      });

      this.ws.on('error', (err) => {
        reject(err);
      });
    });
  }

  public send(payload: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(JSON.stringify(payload));
  }

  public async authenticate(token: string): Promise<any> {
    const authPromise = this.waitForMessage((m) => m.type === 'auth_success' || m.type === 'auth_error');
    this.send({ type: 'auth', token });
    return authPromise;
  }

  public async registerBranch(branchId: string, franchiseId?: string): Promise<any> {
    const regPromise = this.waitForMessage(
      (m) => m.type === 'register_branch_success' || m.type === 'error'
    );
    this.send({ type: 'register_branch', branchId, franchiseId });
    return regPromise;
  }

  public async waitForMessage(predicate: (msg: any) => boolean, timeoutMs: number = 5000): Promise<any> {
    // Check if message was already received
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);

      const listener = (msg: any) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          const idx = this.messageListeners.indexOf(listener);
          if (idx !== -1) this.messageListeners.splice(idx, 1);
          resolve(msg);
        }
      };

      this.messageListeners.push(listener);
    });
  }

  public close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
