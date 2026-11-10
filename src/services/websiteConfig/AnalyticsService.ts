import { pgPool } from '../../config/postgres.js';
import { WebsiteAnalyticsEvent } from '../../types/websiteConfig.types.js';

export class AnalyticsService {
  /**
   * Batch insert events into PostgreSQL
   */
  static async recordBatchEvents(events: WebsiteAnalyticsEvent[]): Promise<number> {
    if (!events || events.length === 0) return 0;
    const client = await pgPool.connect();
    try {
      let inserted = 0;
      for (const ev of events) {
        await client.query(
          `INSERT INTO website_analytics (event_type, section_id, section_type, session_id, user_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))`,
          [
            ev.eventType,
            ev.sectionId || null,
            ev.sectionType || null,
            ev.sessionId,
            ev.userId || null,
            JSON.stringify(ev.metadata || {}),
            ev.createdAt ? new Date(ev.createdAt) : null,
          ]
        );
        inserted++;
      }
      return inserted;
    } catch (e) {
      console.error('[AnalyticsService] recordBatchEvents error:', e);
      return 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get section summary metrics for Owner/Developer Analytics Dashboard
   */
  static async getSectionSummary(days = 7): Promise<any[]> {
    const client = await pgPool.connect();
    try {
      const res = await client.query(`
        SELECT 
          section_id,
          section_type,
          COUNT(CASE WHEN event_type = 'section_view' THEN 1 END) as views,
          COUNT(CASE WHEN event_type IN ('section_click', 'cta_click', 'product_click') THEN 1 END) as clicks,
          COUNT(CASE WHEN event_type = 'section_scroll_50' THEN 1 END) as scroll_50,
          COUNT(CASE WHEN event_type = 'section_scroll_100' THEN 1 END) as scroll_100
        FROM website_analytics
        WHERE created_at >= NOW() - INTERVAL '${days} days' AND section_id IS NOT NULL
        GROUP BY section_id, section_type
        ORDER BY views DESC;
      `);
      return res.rows.map((r) => ({
        ...r,
        views: parseInt(r.views || '0', 10),
        clicks: parseInt(r.clicks || '0', 10),
        ctr: r.views > 0 ? ((parseInt(r.clicks || '0', 10) / parseInt(r.views || '1', 10)) * 100).toFixed(1) + '%' : '0%',
      }));
    } catch (e) {
      console.error('[AnalyticsService] getSectionSummary error:', e);
      return [];
    } finally {
      client.release();
    }
  }

  /**
   * Get Web Vitals Telemetry for Developer Dashboard
   */
  static async getWebVitals(): Promise<any> {
    const client = await pgPool.connect();
    try {
      const res = await client.query(`
        SELECT 
          metadata->>'metric' as metric,
          AVG((metadata->>'value')::numeric) as avg_value,
          COUNT(*) as samples
        FROM website_analytics
        WHERE event_type = 'web_vital' AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY metadata->>'metric';
      `);
      return res.rows;
    } catch (e) {
      return [];
    } finally {
      client.release();
    }
  }
}
