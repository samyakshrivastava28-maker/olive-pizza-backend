import { PaymentErrorCode } from './PaymentErrorHandler.js';

export interface RetryTask<T> {
  id: string;
  fn: () => Promise<T>;
  maxAttempts?: number;
  onRetry?: (attempt: number, delayMs: number, error: any) => void;
}

export class PaymentRetryEngine {
  private static BACKOFF_SCHEDULE_MS = [2000, 5000, 10000, 30000, 60000];

  public static isRetryable(code: PaymentErrorCode): boolean {
    const nonRetryable: PaymentErrorCode[] = [
      'PAYMENT_DECLINED',
      'INVALID_SIGNATURE',
      'VALIDATION_ERROR',
      'MAINTENANCE_MODE',
    ];
    return !nonRetryable.includes(code);
  }

  public static async executeWithRetry<T>(task: RetryTask<T>): Promise<T> {
    const maxAttempts = task.maxAttempts || 5;
    let attempt = 0;
    let lastError: any = null;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        return await task.fn();
      } catch (err: any) {
        lastError = err;
        if (attempt >= maxAttempts) break;

        const delay = this.BACKOFF_SCHEDULE_MS[attempt - 1] || 60000;
        console.warn(`[PaymentRetryEngine] Attempt ${attempt}/${maxAttempts} failed for task "${task.id}". Retrying in ${delay}ms... Error: ${err.message}`);

        if (task.onRetry) {
          task.onRetry(attempt, delay, err);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
