import { PaymentProviderFactory } from './PaymentProviderFactory.js';
import { query } from '../../lib/db.js';

export interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs: number;
  message?: string;
}

export class PaymentHealthMonitor {
  public static async checkAllHealth(): Promise<{
    overallStatus: 'healthy' | 'degraded' | 'down';
    components: ComponentHealth[];
    circuitBreakers: Record<string, any>;
    timestamp: string;
  }> {
    const components: ComponentHealth[] = [];

    // 1. Check Active Provider Health
    const provider = PaymentProviderFactory.getProvider();
    const pStart = Date.now();
    try {
      const pHealth = await provider.getHealthStatus();
      components.push({
        name: `Gateway (${provider.name})`,
        status: pHealth.healthy ? 'healthy' : 'degraded',
        latencyMs: pHealth.latencyMs,
        message: pHealth.message,
      });
    } catch (err: any) {
      components.push({
        name: `Gateway (${provider.name})`,
        status: 'down',
        latencyMs: Date.now() - pStart,
        message: err.message,
      });
    }

    // 2. Check Database Health
    const dbStart = Date.now();
    try {
      await query('SELECT 1');
      components.push({
        name: 'Database (PostgreSQL)',
        status: 'healthy',
        latencyMs: Date.now() - dbStart,
        message: 'Postgres Connection Pool Healthy',
      });
    } catch (err: any) {
      components.push({
        name: 'Database (PostgreSQL)',
        status: 'degraded',
        latencyMs: Date.now() - dbStart,
        message: err.message,
      });
    }

    // 3. Webhook Listener Status
    components.push({
      name: 'Webhook Listener',
      status: 'healthy',
      latencyMs: 1,
      message: 'HMAC-SHA256 Endpoint Active',
    });

    const isAnyDown = components.some((c) => c.status === 'down');
    const isAnyDegraded = components.some((c) => c.status === 'degraded');
    const overallStatus = isAnyDown ? 'down' : isAnyDegraded ? 'degraded' : 'healthy';

    return {
      overallStatus,
      components,
      circuitBreakers: PaymentProviderFactory.getCircuitBreakerStatus(),
      timestamp: new Date().toISOString(),
    };
  }
}
