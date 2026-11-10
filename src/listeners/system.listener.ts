import os from 'os';
import { notificationService } from '../services/notification/notification.service.js';

export class SystemListener {
  static init() {
    this.monitorMemory();
    this.catchExceptions();
    
    // Notify startup
    notificationService.dispatch({
      type: 'system_startup',
      category: 'errors',
      title: 'Backend Server Started',
      details: `Node.js process initialized on ${os.hostname()}. Listening for events.`
    });

    console.log('💻 System Monitor initialized.');
  }

  private static monitorMemory() {
    // Check every 5 minutes
    setInterval(() => {
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const usedPercent = ((totalMem - freeMem) / totalMem) * 100;

      if (usedPercent > 90) {
        notificationService.dispatch({
          type: 'infrastructure_errors',
          category: 'errors',
          title: 'High Memory Usage Warning',
          details: `Memory usage is at ${usedPercent.toFixed(2)}% (${(freeMem / 1024 / 1024).toFixed(0)}MB free). Consider restarting or scaling the server.`
        });
      }
    }, 5 * 60 * 1000);
  }

  private static catchExceptions() {
    process.on('uncaughtException', (error) => {
      notificationService.dispatch({
        type: 'infrastructure_errors',
        category: 'errors',
        title: 'Uncaught Exception (Process Crash Risk)',
        details: `${error.name}: ${error.message}\n${error.stack}`
      });
      console.error('Uncaught Exception:', error);
    });

    process.on('unhandledRejection', (reason: any) => {
      notificationService.dispatch({
        type: 'infrastructure_errors',
        category: 'errors',
        title: 'Unhandled Promise Rejection',
        details: reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)
      });
      console.error('Unhandled Rejection:', reason);
    });
  }
}
