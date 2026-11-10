import { query } from '../../lib/db.js';

export interface FinancialReport {
  period: 'daily' | 'weekly' | 'monthly';
  totalRevenue: number;
  netSales: number;
  totalGst: number;
  totalDeliveryFees: number;
  totalRefunds: number;
  totalOrdersCount: number;
  codOrdersCount: number;
  onlineOrdersCount: number;
  estimatedGatewayFees: number;
  expectedSettlementAmount: number;
  generatedAt: string;
}

export class PaymentReportingService {
  public static async generateReport(period: 'daily' | 'weekly' | 'monthly'): Promise<FinancialReport> {
    const intervalMap = {
      daily: "INTERVAL '1 day'",
      weekly: "INTERVAL '7 days'",
      monthly: "INTERVAL '30 days'",
    };

    const interval = intervalMap[period];
    let totalRevenue = 0;
    let totalOrdersCount = 0;
    let codOrdersCount = 0;
    let onlineOrdersCount = 0;
    let totalRefunds = 0;

    try {
      const res = await query(`
        SELECT payment_method, status, amount
        FROM payments
        WHERE created_at > NOW() - ${interval}
      `);

      for (const row of res.rows) {
        const amt = Number(row.amount || 0);
        if (row.status === 'COMPLETED' || row.status === 'ORDER_CREATED' || row.status === 'PAYMENT_CAPTURED') {
          totalRevenue += amt;
          totalOrdersCount++;
          if (row.payment_method === 'cod') codOrdersCount++;
          else onlineOrdersCount++;
        } else if (row.status === 'REFUNDED') {
          totalRefunds += amt;
        }
      }
    } catch (err) {
      // Postgres table optional fallback
    }

    const netSales = Math.max(0, totalRevenue - totalRefunds);
    const totalGst = Math.round(netSales * 0.05); // 5% GST
    const estimatedGatewayFees = Math.round((onlineOrdersCount > 0 ? netSales * 0.02 : 0)); // 2% gateway charge estimation
    const expectedSettlementAmount = Math.max(0, netSales - estimatedGatewayFees);

    return {
      period,
      totalRevenue,
      netSales,
      totalGst,
      totalDeliveryFees: 0,
      totalRefunds,
      totalOrdersCount,
      codOrdersCount,
      onlineOrdersCount,
      estimatedGatewayFees,
      expectedSettlementAmount,
      generatedAt: new Date().toISOString(),
    };
  }

  public static exportReportCsv(report: FinancialReport): string {
    return [
      'Metric,Value',
      `Period,${report.period.toUpperCase()}`,
      `Generated At,${report.generatedAt}`,
      `Total Revenue,INR ${report.totalRevenue}`,
      `Net Sales,INR ${report.netSales}`,
      `GST Tax (5%),INR ${report.totalGst}`,
      `Total Refunds,INR ${report.totalRefunds}`,
      `Total Orders Count,${report.totalOrdersCount}`,
      `COD Orders Count,${report.codOrdersCount}`,
      `Online Orders Count,${report.onlineOrdersCount}`,
      `Estimated Gateway Charges (2%),INR ${report.estimatedGatewayFees}`,
      `Expected Net Settlement,INR ${report.expectedSettlementAmount}`,
    ].join('\n');
  }
}
