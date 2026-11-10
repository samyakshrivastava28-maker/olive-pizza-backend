import { adminDb } from '../config/firebase.js';
import { query, withTransaction } from '../config/postgres.js';

export interface PermanentBillRecord {
  permanentBillNumber: number;
  billFormattedNumber: string;
  orderId: string;
  source: 'ONLINE' | 'POS';
  franchiseId: string;
  branchId: string;
  terminalId?: string;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus: string;
  createdAt: string;
}

export interface IBillingRepository {
  allocateNextBillNumbers(date?: Date): Promise<{
    permanentBillNo: number;
    dailyOrderNo: number;
    orderDate: string;
    orderTime: string;
  }>;
  saveBill(record: PermanentBillRecord): Promise<void>;
  findByPermanentNumber(billNumber: number): Promise<PermanentBillRecord | null>;
  findByOrderId(orderId: string): Promise<PermanentBillRecord | null>;
  getCurrentSequenceStatus(): Promise<{
    lastPermanentBillNo: number;
    todayDailyCount: number;
    todayDate: string;
  }>;
}

export class FirestoreBillingRepository implements IBillingRepository {
  private static RESTAURANT_TIMEZONE = 'Asia/Kolkata';

  private getLocalDateString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FirestoreBillingRepository.RESTAURANT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  private getLocalTimeString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: FirestoreBillingRepository.RESTAURANT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  }

  /**
   * Atomically allocates the next Permanent Bill Number and Daily Order Number
   * using a Firestore atomic transaction against counter documents.
   * Guaranteed concurrency-safe with zero duplicate sequence numbers.
   */
  async allocateNextBillNumbers(date: Date = new Date()): Promise<{
    permanentBillNo: number;
    dailyOrderNo: number;
    orderDate: string;
    orderTime: string;
  }> {
    const orderDate = this.getLocalDateString(date);
    const orderTime = this.getLocalTimeString(date);

    const permCounterRef = adminDb.collection('counters').doc('permanent_billing');
    const dailyCounterRef = adminDb.collection('counters').doc('dailyOrders');

    const result = await adminDb.runTransaction(async (t) => {
      // 1. Permanent Bill Number (monotonic, never resets)
      const permSnap = await t.get(permCounterRef);
      const permData = permSnap.exists ? permSnap.data()! : { currentCount: 0 };
      const nextPermNo = (permData.currentCount as number) + 1;
      t.set(permCounterRef, {
        currentCount: nextPermNo,
        lastAllocatedAt: new Date().toISOString()
      }, { merge: true });

      // 2. Daily Order Number (resets daily at midnight IST)
      const dailySnap = await t.get(dailyCounterRef);
      const dailyData = dailySnap.exists ? dailySnap.data()! : { date: orderDate, count: 0 };
      const nextDailyNo = dailyData.date === orderDate ? (dailyData.count as number) + 1 : 1;
      t.set(dailyCounterRef, {
        date: orderDate,
        count: nextDailyNo,
        lastAllocatedAt: new Date().toISOString()
      }, { merge: true });

      return {
        permanentBillNo: nextPermNo,
        dailyOrderNo: nextDailyNo
      };
    });

    return {
      permanentBillNo: result.permanentBillNo,
      dailyOrderNo: result.dailyOrderNo,
      orderDate,
      orderTime
    };
  }

  async saveBill(record: PermanentBillRecord): Promise<void> {
    const billDocRef = adminDb.collection('bills').doc(`bill_${record.permanentBillNumber}`);
    await billDocRef.set({
      ...record,
      updatedAt: new Date().toISOString()
    });
  }

  async findByPermanentNumber(billNumber: number): Promise<PermanentBillRecord | null> {
    const doc = await adminDb.collection('bills').doc(`bill_${billNumber}`).get();
    if (!doc.exists) return null;
    return doc.data() as PermanentBillRecord;
  }

  async findByOrderId(orderId: string): Promise<PermanentBillRecord | null> {
    const snap = await adminDb.collection('bills').where('orderId', '==', orderId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as PermanentBillRecord;
  }

  async getCurrentSequenceStatus(): Promise<{
    lastPermanentBillNo: number;
    todayDailyCount: number;
    todayDate: string;
  }> {
    const today = this.getLocalDateString();
    const permSnap = await adminDb.collection('counters').doc('permanent_billing').get();
    const dailySnap = await adminDb.collection('counters').doc('dailyOrders').get();

    const permData = permSnap.exists ? permSnap.data()! : { currentCount: 0 };
    const dailyData = dailySnap.exists ? dailySnap.data()! : { date: today, count: 0 };

    return {
      lastPermanentBillNo: permData.currentCount || 0,
      todayDailyCount: dailyData.date === today ? (dailyData.count || 0) : 0,
      todayDate: today
    };
  }
}

export class InMemoryBillingRepository implements IBillingRepository {
  private static RESTAURANT_TIMEZONE = 'Asia/Kolkata';
  private permanentCount = 0;
  private dailyOrders: { date: string; count: number } = { date: '', count: 0 };
  private bills = new Map<number, PermanentBillRecord>();
  private lockPromise: Promise<void> = Promise.resolve();

  private getLocalDateString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: InMemoryBillingRepository.RESTAURANT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  private getLocalTimeString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: InMemoryBillingRepository.RESTAURANT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  }

  private async acquireLock(): Promise<() => void> {
    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const currentLock = this.lockPromise;
    this.lockPromise = currentLock.then(() => nextLock);
    await currentLock;
    return releaseLock;
  }

  async allocateNextBillNumbers(date: Date = new Date()): Promise<{
    permanentBillNo: number;
    dailyOrderNo: number;
    orderDate: string;
    orderTime: string;
  }> {
    const release = await this.acquireLock();
    try {
      const orderDate = this.getLocalDateString(date);
      const orderTime = this.getLocalTimeString(date);

      this.permanentCount += 1;
      const permanentBillNo = this.permanentCount;

      if (this.dailyOrders.date === orderDate) {
        this.dailyOrders.count += 1;
      } else {
        this.dailyOrders = { date: orderDate, count: 1 };
      }
      const dailyOrderNo = this.dailyOrders.count;

      return {
        permanentBillNo,
        dailyOrderNo,
        orderDate,
        orderTime
      };
    } finally {
      release();
    }
  }

  async saveBill(record: PermanentBillRecord): Promise<void> {
    const release = await this.acquireLock();
    try {
      this.bills.set(record.permanentBillNumber, { ...record });
    } finally {
      release();
    }
  }

  async findByPermanentNumber(billNumber: number): Promise<PermanentBillRecord | null> {
    return this.bills.get(billNumber) || null;
  }

  async findByOrderId(orderId: string): Promise<PermanentBillRecord | null> {
    for (const bill of this.bills.values()) {
      if (bill.orderId === orderId) return bill;
    }
    return null;
  }

  async getCurrentSequenceStatus(): Promise<{
    lastPermanentBillNo: number;
    todayDailyCount: number;
    todayDate: string;
  }> {
    const today = this.getLocalDateString();
    return {
      lastPermanentBillNo: this.permanentCount,
      todayDailyCount: this.dailyOrders.date === today ? this.dailyOrders.count : 0,
      todayDate: today
    };
  }
}

/**
 * PostgresBillingRepository — Primary Authoritative Bill Repository
 * All sequential allocation, persistent record queries, and counter states
 * are strictly sourced from PostgreSQL transactions and sequences.
 */
export class PostgresBillingRepository implements IBillingRepository {
  private static RESTAURANT_TIMEZONE = 'Asia/Kolkata';

  private getLocalDateString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: PostgresBillingRepository.RESTAURANT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  private getLocalTimeString(date: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: PostgresBillingRepository.RESTAURANT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  }

  /**
   * Atomically allocates the next Permanent Bill Number and Daily Order Number
   * directly from PostgreSQL sequence and atomic function.
   * Guaranteed concurrency-safe with zero duplicate sequence numbers.
   */
  async allocateNextBillNumbers(date: Date = new Date()): Promise<{
    permanentBillNo: number;
    dailyOrderNo: number;
    orderDate: string;
    orderTime: string;
  }> {
    const orderDate = this.getLocalDateString(date);
    const orderTime = this.getLocalTimeString(date);

    return await withTransaction(async (client) => {
      // 1. Permanent Bill Number from Postgres sequence
      const seqRes = await client.query(`SELECT nextval('permanent_bill_seq') AS bill_no;`);
      const permanentBillNo = parseInt(seqRes.rows[0].bill_no, 10);

      // 2. Daily Order Number from Postgres atomic function
      const dailyRes = await client.query(
        `SELECT get_next_daily_order_number($1::date) AS daily_no;`,
        [orderDate]
      );
      const dailyOrderNo = parseInt(dailyRes.rows[0].daily_no, 10);

      // Async Firestore projection mirror (non-blocking, never authoritative)
      adminDb.collection('counters').doc('permanent_billing').set({
        currentCount: permanentBillNo,
        lastAllocatedAt: new Date().toISOString()
      }, { merge: true }).catch(() => {});

      adminDb.collection('counters').doc('dailyOrders').set({
        date: orderDate,
        count: dailyOrderNo,
        lastAllocatedAt: new Date().toISOString()
      }, { merge: true }).catch(() => {});

      return {
        permanentBillNo,
        dailyOrderNo,
        orderDate,
        orderTime
      };
    });
  }

  async saveBill(record: PermanentBillRecord): Promise<void> {
    // 1. Authoritative PostgreSQL write with conflict diagnostic
    const res = await query(`
      INSERT INTO canonical_bills (
        id, permanent_bill_no, order_id, bill_date,
        subtotal, discount, tax, net_amount,
        payment_method, payment_status, created_at
      ) VALUES (
        $1, $2, $3, $4::date,
        $5, $6, $7, $8,
        $9, $10, $11::timestamptz
      )
      ON CONFLICT (permanent_bill_no) DO UPDATE SET
        payment_method = CASE
          WHEN canonical_bills.payment_status IN ('PAID', 'REFUNDED') THEN canonical_bills.payment_method
          ELSE EXCLUDED.payment_method
        END,
        payment_status = CASE
          WHEN canonical_bills.payment_status = 'PAID' AND EXCLUDED.payment_status IN ('PENDING', 'FAILED') THEN canonical_bills.payment_status
          WHEN canonical_bills.payment_status = 'REFUNDED' THEN canonical_bills.payment_status
          ELSE EXCLUDED.payment_status
        END
      WHERE canonical_bills.order_id = EXCLUDED.order_id
        AND canonical_bills.is_cancelled = FALSE
        AND canonical_bills.net_amount = EXCLUDED.net_amount
      RETURNING canonical_bills.id, canonical_bills.order_id, canonical_bills.payment_status;
    `, [
      `bill_${record.permanentBillNumber}`,
      record.permanentBillNumber,
      record.orderId,
      record.createdAt.split('T')[0] || new Date().toISOString().split('T')[0],
      record.totalAmount,
      0,
      0,
      record.totalAmount,
      record.paymentMethod,
      record.paymentStatus,
      record.createdAt
    ]);

    if (res.rowCount === 0) {
      // Diagnosing why the row was not inserted or updated:
      const check = await query(
        `SELECT order_id, net_amount, is_cancelled, payment_status FROM canonical_bills WHERE permanent_bill_no = $1`,
        [record.permanentBillNumber]
      );
      if (check.rows.length > 0) {
        const existing = check.rows[0];
        if (existing.order_id !== record.orderId) {
          throw new Error(`Conflict: Permanent bill number ${record.permanentBillNumber} is permanently assigned to order '${existing.order_id}'. Cannot be reused for order '${record.orderId}'.`);
        }
        if (existing.is_cancelled) {
          throw new Error(`Conflict: Permanent bill number ${record.permanentBillNumber} belongs to a cancelled bill and cannot be mutated.`);
        }
        if (Number(existing.net_amount) !== Number(record.totalAmount)) {
          throw new Error(`Conflict: Finalized bill ${record.permanentBillNumber} financial snapshot is immutable (existing net_amount=${existing.net_amount}, requested=${record.totalAmount}).`);
        }
      }
    }

    // 2. Non-blocking Firestore projection mirror
    const billDocRef = adminDb.collection('bills').doc(`bill_${record.permanentBillNumber}`);
    billDocRef.set({
      ...record,
      updatedAt: new Date().toISOString()
    }).catch(() => {});
  }

  async findByPermanentNumber(billNumber: number): Promise<PermanentBillRecord | null> {
    const res = await query(`
      SELECT b.*, o.franchise_id, o.branch_id, o.terminal_id, o.order_source
      FROM canonical_bills b
      LEFT JOIN canonical_orders o ON b.order_id = o.id
      WHERE b.permanent_bill_no = $1;
    `, [billNumber]);

    if (res.rows.length > 0) {
      const r = res.rows[0];
      return {
        permanentBillNumber: parseInt(r.permanent_bill_no, 10),
        billFormattedNumber: `BILL-${String(r.permanent_bill_no).padStart(6, '0')}`,
        orderId: r.order_id,
        source: (r.order_source || 'POS') as 'ONLINE' | 'POS',
        franchiseId: r.franchise_id || 'fra_primary',
        branchId: r.branch_id || 'main_branch',
        terminalId: r.terminal_id,
        totalAmount: parseFloat(r.net_amount),
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        createdAt: r.created_at?.toISOString() || new Date().toISOString()
      };
    }

    // Fallback to Firestore projection if historic bill was only in Firestore
    const doc = await adminDb.collection('bills').doc(`bill_${billNumber}`).get();
    if (!doc.exists) return null;
    return doc.data() as PermanentBillRecord;
  }

  async findByOrderId(orderId: string): Promise<PermanentBillRecord | null> {
    const res = await query(`
      SELECT b.*, o.franchise_id, o.branch_id, o.terminal_id, o.order_source
      FROM canonical_bills b
      LEFT JOIN canonical_orders o ON b.order_id = o.id
      WHERE b.order_id = $1;
    `, [orderId]);

    if (res.rows.length > 0) {
      const r = res.rows[0];
      return {
        permanentBillNumber: parseInt(r.permanent_bill_no, 10),
        billFormattedNumber: `BILL-${String(r.permanent_bill_no).padStart(6, '0')}`,
        orderId: r.order_id,
        source: (r.order_source || 'POS') as 'ONLINE' | 'POS',
        franchiseId: r.franchise_id || 'fra_primary',
        branchId: r.branch_id || 'main_branch',
        terminalId: r.terminal_id,
        totalAmount: parseFloat(r.net_amount),
        paymentMethod: r.payment_method,
        paymentStatus: r.payment_status,
        createdAt: r.created_at?.toISOString() || new Date().toISOString()
      };
    }

    const snap = await adminDb.collection('bills').where('orderId', '==', orderId).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data() as PermanentBillRecord;
  }

  async getCurrentSequenceStatus(): Promise<{
    lastPermanentBillNo: number;
    todayDailyCount: number;
    todayDate: string;
  }> {
    const today = this.getLocalDateString();
    const seqRes = await query(`SELECT last_value, is_called FROM permanent_bill_seq;`).catch(() => ({ rows: [] }));
    const dailyRes = await query(
      `SELECT current_number FROM daily_order_counters WHERE counter_date = $1;`,
      [today]
    ).catch(() => ({ rows: [] }));

    const lastVal = seqRes.rows[0] ? (seqRes.rows[0].is_called ? parseInt(seqRes.rows[0].last_value, 10) : 0) : 0;
    const dailyCount = dailyRes.rows[0] ? parseInt(dailyRes.rows[0].current_number, 10) : 0;

    return {
      lastPermanentBillNo: lastVal,
      todayDailyCount: dailyCount,
      todayDate: today
    };
  }
}

export const billingRepository: IBillingRepository = new PostgresBillingRepository();

