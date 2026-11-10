import { queueEmail } from '../email.service.js';
import { buildOrderStatusEmail } from '../emailTemplates.service.js';
import { InvoiceEngine } from './InvoiceEngine.js';

export interface PaymentEventPayload {
  eventType: 'PAYMENT_SUCCESS' | 'PAYMENT_FAILED' | 'REFUND_COMPLETED' | 'COD_ORDER_PLACED';
  paymentId: string;
  orderId: string;
  userId: string;
  userEmail?: string;
  userPhone?: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  items: any[];
  deliveryAddress?: string;
  timestamp: string;
}

export class PaymentEventQueue {
  private static queue: PaymentEventPayload[] = [];
  private static isProcessing = false;

  public static enqueue(event: PaymentEventPayload): void {
    console.log(`[PaymentEventQueue] Enqueued event ${event.eventType} for Order #${event.orderId.slice(0, 6)}`);
    this.queue.push(event);
    setImmediate(() => this.processNext());
  }

  private static async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const event = this.queue.shift();
    if (!event) {
      this.isProcessing = false;
      return;
    }

    try {
      await Promise.all([
        this.runEmailWorker(event),
        this.runInvoiceWorker(event),
        this.runAnalyticsWorker(event),
      ]);
    } catch (err: any) {
      console.error('[PaymentEventQueue] Error processing event:', err.message);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  private static async runEmailWorker(event: PaymentEventPayload): Promise<void> {
    try {
      if (event.userEmail && event.eventType === 'PAYMENT_SUCCESS') {
        const html = buildOrderStatusEmail({
          customerName: 'Gourmet Customer',
          subject: `Payment Confirmed — Olive Pizza Order #${event.orderId.slice(0, 6).toUpperCase()}`,
          stage: 'pending',
          orderId: event.orderId,
          data: {
            orderNumber: event.orderId.slice(0, 6).toUpperCase(),
            totalAmount: String(event.amount),
            eta: '30-40 mins',
          },
        });

        const subject = `Payment Confirmed — Olive Pizza Order #${event.orderId.slice(0, 6).toUpperCase()}`;
        await queueEmail(event.userEmail, subject, html, 'transactional');
      }
    } catch (err: any) {
      console.warn('[PaymentEventQueue] Email worker error:', err.message);
    }
  }

  private static async runInvoiceWorker(event: PaymentEventPayload): Promise<void> {
    try {
      if (event.eventType === 'PAYMENT_SUCCESS' || event.eventType === 'COD_ORDER_PLACED') {
        await InvoiceEngine.generateInvoiceHtml({
          orderId: event.orderId,
          paymentId: event.paymentId,
          customerName: 'Customer',
          customerPhone: event.userPhone || '',
          customerAddress: event.deliveryAddress || '',
          items: event.items,
          totalAmount: event.amount,
          paymentMethod: event.paymentMethod,
          createdAt: event.timestamp,
        });
      }
    } catch (err: any) {
      console.warn('[PaymentEventQueue] Invoice worker error:', err.message);
    }
  }

  private static async runAnalyticsWorker(event: PaymentEventPayload): Promise<void> {
    console.log(`[PaymentEventQueue] Analytics recorded for Payment #${event.paymentId.slice(0, 8)}: ₹${event.amount}`);
  }
}
