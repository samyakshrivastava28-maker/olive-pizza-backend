import { MonthlyReportGenerator } from './MonthlyReportGenerator.js';
import { adminDb as db } from '../../config/firebase.js';

export class MonthEndReportWorker {
  private static intervalTimer: NodeJS.Timeout | null = null;
  static startWorker() {
    if (this.intervalTimer) return;
    console.log('⏰ [MonthEndReportWorker] Starting Automated Month-End Report Worker...');
    this.intervalTimer = setInterval(() => {
      this.checkAndTriggerMonthEnd();
    }, 60 * 60 * 1000);
    this.checkAndTriggerMonthEnd();
  }
  static async checkAndTriggerMonthEnd() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const currentMonth = istTime.toLocaleString('default', { month: 'long' });
    const currentYear = istTime.getFullYear();
    const tomorrow = new Date(istTime);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isLastDay = tomorrow.getMonth() !== istTime.getMonth();
    if (isLastDay || istTime.getDate() === 1) {
      try {
        const branchSnap = await db.collection('franchises').get().catch(() => ({ docs: [] } as any));
        const targets = branchSnap.docs
          .filter((d: any) => d.data().isActive !== false)
          .map((d: any) => {
            const data = d.data();
            return {
              branchId: d.id,
              franchiseId: data.franchiseId || d.id
            };
          });

        for (const target of targets) {
          const reportKey = `${target.franchiseId}_${target.branchId}_${currentYear}_${currentMonth.toLowerCase()}`;
          const docSnap = await db.collection('monthly_reports').doc(reportKey).get();
          if (!docSnap.exists) {
            console.log(`[MonthEndReportWorker] Triggering automatic month-end report for ${reportKey}...`);
            await MonthlyReportGenerator.generateAndArchiveMonthlyReport({
              monthName: currentMonth,
              year: currentYear,
              franchiseId: target.franchiseId,
              branchId: target.branchId
            });
          }
        }
      } catch (err: any) {
        console.error('[MonthEndReportWorker] Error in month-end worker:', err.message);
      }
    }
  }
  static stopWorker() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}