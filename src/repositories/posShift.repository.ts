import { query, withTransaction } from '../config/postgres.js';

export interface POSShift {
  id: string;
  terminal_id: string;
  franchise_id: string;
  branch_id: string;
  cashier_id: string;
  cashier_name: string;
  status: 'OPEN' | 'CLOSED' | 'AUDITED';
  opened_at: Date;
  closed_at?: Date | null;
  opening_cash: number;
  cash_sales: number;
  digital_sales: number;
  cash_in: number;
  cash_out: number;
  expected_cash: number;
  actual_cash?: number | null;
  cash_difference: number;
  total_orders_count: number;
  notes?: string | null;
  created_at: Date;
  updated_at: Date;
}

export class POSShiftRepository {
  /**
   * Find the currently active/open shift for a given POS terminal
   */
  static async findActiveShiftByTerminal(terminalId: string): Promise<POSShift | null> {
    const res = await query<POSShift>(
      `SELECT * FROM pos_shifts WHERE terminal_id = $1 AND status = 'OPEN' ORDER BY opened_at DESC LIMIT 1`,
      [terminalId]
    );
    return res.rows[0] || null;
  }

  /**
   * Open a new cashier shift
   */
  static async openShift(params: {
    id: string;
    terminalId: string;
    franchiseId: string;
    branchId: string;
    cashierId: string;
    cashierName: string;
    openingCash: number;
    notes?: string;
  }): Promise<POSShift> {
    const res = await query<POSShift>(
      `INSERT INTO pos_shifts (
        id, terminal_id, franchise_id, branch_id, cashier_id, cashier_name,
        status, opened_at, opening_cash, expected_cash, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', NOW(), $7, $7, $8)
      RETURNING *`,
      [
        params.id,
        params.terminalId,
        params.franchiseId,
        params.branchId,
        params.cashierId,
        params.cashierName,
        params.openingCash,
        params.notes || null,
      ]
    );
    return res.rows[0];
  }

  /**
   * Increment sales in the active shift transactionally
   */
  static async recordSale(shiftId: string, cashAmount: number, digitalAmount: number): Promise<POSShift> {
    const res = await query<POSShift>(
      `UPDATE pos_shifts
       SET cash_sales = cash_sales + $2,
           digital_sales = digital_sales + $3,
           expected_cash = opening_cash + cash_sales + $2 + cash_in - cash_out,
           total_orders_count = total_orders_count + 1,
           updated_at = NOW()
       WHERE id = $1 AND status = 'OPEN'
       RETURNING *`,
      [shiftId, cashAmount, digitalAmount]
    );
    if (res.rows.length === 0) {
      throw new Error(`[POSShift] Active shift ${shiftId} not found or already closed.`);
    }
    return res.rows[0];
  }

  /**
   * Record manual Cash In or Cash Out adjustment
   */
  static async recordCashAdjustment(shiftId: string, type: 'CASH_IN' | 'CASH_OUT', amount: number, note: string): Promise<POSShift> {
    const isCashIn = type === 'CASH_IN';
    const res = await query<POSShift>(
      `UPDATE pos_shifts
       SET cash_in = cash_in + ${isCashIn ? '$2' : '0'},
           cash_out = cash_out + ${isCashIn ? '0' : '$2'},
           expected_cash = opening_cash + cash_sales + (cash_in + ${isCashIn ? '$2' : '0'}) - (cash_out + ${isCashIn ? '0' : '$2'}),
           notes = COALESCE(notes || E'\\n', '') || $3,
           updated_at = NOW()
       WHERE id = $1 AND status = 'OPEN'
       RETURNING *`,
      [shiftId, amount, `[${type}] ₹${amount.toFixed(2)}: ${note}`]
    );
    return res.rows[0];
  }

  /**
   * Close and reconcile shift
   */
  static async closeShift(shiftId: string, actualCash: number, closingNotes?: string): Promise<POSShift> {
    return withTransaction(async (client) => {
      const shiftRes = await client.query<POSShift>('SELECT * FROM pos_shifts WHERE id = $1 FOR UPDATE', [shiftId]);
      const shift = shiftRes.rows[0];
      if (!shift) throw new Error(`Shift ${shiftId} not found`);
      if (shift.status !== 'OPEN') throw new Error(`Shift ${shiftId} is already closed`);

      const expectedCash = Number(shift.opening_cash) + Number(shift.cash_sales) + Number(shift.cash_in) - Number(shift.cash_out);
      const cashDifference = actualCash - expectedCash;

      const res = await client.query<POSShift>(
        `UPDATE pos_shifts
         SET status = 'CLOSED',
             closed_at = NOW(),
             expected_cash = $2,
             actual_cash = $3,
             cash_difference = $4,
             notes = CASE WHEN $5::text IS NOT NULL THEN COALESCE(notes || E'\\n', '') || $5 ELSE notes END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [shiftId, expectedCash, actualCash, cashDifference, closingNotes ? `[Closing Notes] ${closingNotes}` : null]
      );
      return res.rows[0];
    });
  }
}