/**
 * PlatformConfigService — Dynamic Visual Configuration Engine
 *
 * Manages versioned platform configurations in PostgreSQL platform_configs:
 *  - Notification settings
 *  - Email settings
 *  - API settings & Rate limits
 *  - Dynamic Feature Flags
 *  - Branding & Colors
 *  - Business & Scheduler settings
 *
 * Every update is validated, versioned, and audited with 1-click rollback.
 */

import { pgPool } from '../../config/postgres.js';
import { DevAuditService } from './DevAuditService.js';

export interface ConfigItem {
  key: string;
  valueJson: any;
  category: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
  description?: string;
}

export class PlatformConfigService {
  private static tableInitialized = false;

  public static async initTable() {
    if (this.tableInitialized) return;
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS platform_configs (
          key VARCHAR(100) PRIMARY KEY,
          value_json JSONB NOT NULL,
          category VARCHAR(50) NOT NULL,
          version INTEGER DEFAULT 1,
          updated_by VARCHAR(255) NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS platform_config_history (
          id SERIAL PRIMARY KEY,
          config_key VARCHAR(100) NOT NULL,
          value_json JSONB NOT NULL,
          version INTEGER NOT NULL,
          updated_by VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_config_history_key ON platform_config_history(config_key);
      `);

      // Seed default configs if missing
      await this.seedDefaults();
      this.tableInitialized = true;
    } catch (err: any) {
      console.error('[PlatformConfigService] Failed to init tables:', err.message);
    }
  }

  private static async seedDefaults() {
    const defaults = [
      {
        key: 'feature_flags',
        category: 'flags',
        value: {
          aiAssistant: true,
          promotions: true,
          notifications: true,
          monthlyReports: true,
          deliveryTracking: true,
          maintenanceMode: false,
          betaFeatures: false,
          otpBypassMode: false
        },
        description: 'Dynamic Platform Feature Toggles'
      },
      {
        key: 'branding',
        category: 'branding',
        value: {
          brandName: 'Olive Pizza',
          tagline: 'Premium Pizza Delivery · Rajnandgaon',
          primaryColor: '#f97316',
          darkBgColor: '#0B0F14',
          logoUrl: 'https://res.cloudinary.com/dxmlvkff1/image/upload/v1782376898/olive-pizza/brand/logo.png'
        },
        description: 'Global Visual Identity & Theme'
      },
      {
        key: 'rate_limits',
        category: 'security',
        value: {
          apiMaxRequestsPerMin: 120,
          authMaxRequestsPerMin: 10,
          otpMaxRequestsPerMin: 3
        },
        description: 'API Throttle & Rate Limit Rules'
      },
      {
        key: 'scheduler_timings',
        category: 'cron',
        value: {
          monthlyReportDay: 1,
          monthlyReportTime: '00:05',
          tokenCleanupIntervalHours: 24,
          emailQueuePollingIntervalMs: 5000
        },
        description: 'Cron Job Schedule Parameters'
      }
    ];

    for (const item of defaults) {
      await pgPool.query(`
        INSERT INTO platform_configs (key, value_json, category, version, updated_by)
        VALUES ($1, $2, $3, 1, 'system')
        ON CONFLICT (key) DO NOTHING
      `, [item.key, JSON.stringify(item.value), item.category]);
    }
  }

  public static async getConfig<T = any>(key: string): Promise<T | null> {
    await this.initTable();
    try {
      const res = await pgPool.query(`SELECT value_json FROM platform_configs WHERE key = $1`, [key]);
      return res.rows[0]?.value_json || null;
    } catch {
      return null;
    }
  }

  public static async getAllConfigs(): Promise<ConfigItem[]> {
    await this.initTable();
    try {
      const res = await pgPool.query(`SELECT * FROM platform_configs ORDER BY category, key`);
      return res.rows.map(r => ({
        key: r.key,
        valueJson: r.value_json,
        category: r.category,
        version: r.version,
        updatedBy: r.updated_by,
        updatedAt: new Date(r.updated_at).toISOString()
      }));
    } catch (err: any) {
      console.error('[PlatformConfigService] Failed to fetch configs:', err.message);
      return [];
    }
  }

  public static async setConfig(key: string, valueJson: any, category: string, developerEmail: string, ipAddress?: string): Promise<{ success: boolean; version?: number; error?: string }> {
    await this.initTable();
    try {
      // Get existing before state
      const existing = await pgPool.query(`SELECT value_json, version FROM platform_configs WHERE key = $1`, [key]);
      const beforeState = existing.rows[0]?.value_json || null;
      const newVersion = (existing.rows[0]?.version || 0) + 1;

      // Archive history
      if (beforeState) {
        await pgPool.query(`
          INSERT INTO platform_config_history (config_key, value_json, version, updated_by)
          VALUES ($1, $2, $3, $4)
        `, [key, JSON.stringify(beforeState), existing.rows[0].version, developerEmail]);
      }

      // Upsert current
      await pgPool.query(`
        INSERT INTO platform_configs (key, value_json, category, version, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (key) DO UPDATE 
        SET value_json = EXCLUDED.value_json, category = EXCLUDED.category, 
            version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
      `, [key, JSON.stringify(valueJson), category, newVersion, developerEmail]);

      // Audit Log
      await DevAuditService.logAction({
        developerEmail,
        actionType: 'UPDATE_CONFIG',
        targetModule: `config:${key}`,
        beforeState,
        afterState: valueJson,
        ipAddress,
        status: 'SUCCESS'
      });

      return { success: true, version: newVersion };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public static async rollbackConfig(key: string, version: number, developerEmail: string): Promise<{ success: boolean; error?: string }> {
    await this.initTable();
    try {
      const history = await pgPool.query(`
        SELECT value_json FROM platform_config_history WHERE config_key = $1 AND version = $2
      `, [key, version]);

      if (history.rows.length === 0) {
        return { success: false, error: `Version ${version} not found in history for ${key}` };
      }

      const targetValue = history.rows[0].value_json;
      return await this.setConfig(key, targetValue, 'rollback', developerEmail);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  public static async deleteConfig(key: string, developerEmail: string): Promise<{ success: boolean; error?: string }> {
    await this.initTable();
    try {
      const existing = await pgPool.query(`SELECT value_json FROM platform_configs WHERE key = $1`, [key]);
      const beforeState = existing.rows[0]?.value_json || null;

      await pgPool.query(`DELETE FROM platform_configs WHERE key = $1`, [key]);

      await DevAuditService.logAction({
        developerEmail,
        actionType: 'DELETE_CONFIG',
        targetModule: `config:${key}`,
        beforeState,
        status: 'SUCCESS'
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
