/**
 * CanonicalOrderService.ts — Authoritative PostgreSQL Order, Billing & Search Service
 * 
 * CORE ARCHITECTURAL INVARIANTS:
 * 1. RELATIONAL SOURCE OF TRUTH: Orders, Item Snapshots, and Financial Bills are
 *    atomically committed to PostgreSQL (`canonical_orders`, `canonical_order_items`, `canonical_bills`).
 * 2. PERMANENT BILL NUMBER: Generated via PostgreSQL sequence `permanent_bill_seq`.
 * 3. DAILY ORDER NUMBER: Atomically allocated per calendar day in IST.
 * 4. IMMUTABLE HISTORICAL SNAPSHOTS: Item names, sizes, crusts, and line prices are preserved permanently.
 * 5. DETERMINISTIC SEARCH: 100% indexed parameterized SQL queries. Zero AI, zero fake data.
 */

import crypto from 'crypto';
import { query, withTransaction } from '../../config/postgres.js';
import { BillingNumberService } from './BillingNumberService.js';
import { adminDb } from '../../config/firebase.js';
import { billingRepository } from '../../repositories/billing.repository.js';
import { appEventBus } from '../eventBus/AppEventBus.js';
import { POSService } from './POSService.js';
import { AuthoritativePricingResolver } from '../menu/AuthoritativePricingResolver.js';

export interface CreateOrderParams {
  id?: string;
  orderSource: string;
  orderType?: string;
  deliveryType?: string;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
  tableNumber?: string;
  items: Array<{
    menuItemId?: string;
    name: string;
    price: number;
    quantity: number;
    size?: string;
    crust?: string;
    addons?: any[];
  }>;
  subtotal: number;
  discountAmount?: number;
  couponCode?: string;
  taxAmount?: number;
  cgst?: number;
  sgst?: number;
  deliveryFee?: number;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus?: string;
  orderStatus?: string;
  franchiseId?: string;
  branchId?: string;
  cashierId?: string;
  cashierName?: string;
  terminalId?: string;
  notes?: string;
}

export interface SearchOrderFilters {
  permanentBillNo?: number;
  dailyOrderNo?: number;
  orderId?: string;
  customerPhone?: string;
  customerName?: string;
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  paymentMethod?: string;
  paymentStatus?: string;
  orderStatus?: string;
  orderSource?: string;
  orderType?: string;
  itemName?: string;
  branchId?: string;
  franchiseId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Exact paise integer conversion avoiding floating point rounding errors.
 */
export function parseAmountToPaise(val: any): bigint {
  if (val === null || val === undefined || val === '') return 0n;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0n;
    const isNeg = val < 0;
    const absVal = Math.abs(val);
    const fixed = absVal.toFixed(2);
    const [whole, frac = ''] = fixed.split('.');
    const paddedFrac = frac.padEnd(2, '0').slice(0, 2);
    const bi = BigInt(whole + paddedFrac);
    return isNeg ? -bi : bi;
  }
  let s = String(val).trim().replace(/,/g, '');
  if (!s) return 0n;
  const isNeg = s.startsWith('-');
  if (isNeg) s = s.slice(1);
  const parts = s.split('.');
  const whole = parts[0] || '0';
  const frac = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  try {
    const bi = BigInt(whole + frac);
    return isNeg ? -bi : bi;
  } catch {
    return 0n;
  }
}

export class CanonicalOrderService {
  /**
   * Deterministically computes a SHA-256 fingerprint for order idempotency.
   * Server-side authoritative: caller-provided fingerprints are always recomputed.
   * Mutable fields (like paymentStatus) are strictly excluded from identity.
   */
  public static computeOrderFingerprint(params: any): string {
    const normalizeAddons = (addons: any[]): any[] => {
      if (!Array.isArray(addons)) return [];
      return addons.map(a => ({
        id: String(a.id || a.addonId || a.name || '').trim().toLowerCase(),
        name: String(a.name || '').trim(),
        pricePaise: Number(parseAmountToPaise(a.price || a.unitPrice || 0))
      })).sort((a, b) => a.id.localeCompare(b.id));
    };

    const normalizeItems = (items: any[]): any[] => {
      if (!Array.isArray(items)) return [];
      return items.map((it: any) => ({
        id: String(it.menuItemId || it.id || it.productId || '').trim(),
        name: String(it.name || '').trim(),
        size: String(it.size || 'regular').trim().toLowerCase(),
        crust: String(it.crust || 'normal').trim().toLowerCase(),
        variant: String(it.variant || '').trim().toLowerCase(),
        quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
        unitPricePaise: Number(parseAmountToPaise(it.unitPrice || it.price || 0)),
        addons: normalizeAddons(it.addons)
      })).sort((a, b) => [a.id, a.size, a.crust].join('\0').localeCompare([b.id, b.size, b.crust].join('\0')));
    };

    const canonicalPayload = {
      orderId: String(params.id || '').trim(),
      franchiseId: String(params.franchiseId || '').trim(),
      branchId: String(params.branchId || '').trim(),
      customerPhone: String(params.customerPhone || '').trim(),
      customerId: String(params.customerId || params.userId || '').trim(),
      currency: 'INR',
      orderType: String(params.orderType || params.deliveryType || 'delivery').trim().toLowerCase(),
      paymentMethod: String(params.paymentMethod || 'COD').trim().toUpperCase(),
      // paymentStatus is excluded from fingerprint because it is mutable across order lifecycle
      subtotalPaise: Number(parseAmountToPaise(params.subtotal || params.totalAmount || 0)),
      discountPaise: Number(parseAmountToPaise(params.discountAmount || params.discount || 0)),
      taxPaise: Number(parseAmountToPaise(params.taxAmount || params.tax || 0)),
      cgstPaise: Number(parseAmountToPaise(params.cgst || 0)),
      sgstPaise: Number(parseAmountToPaise(params.sgst || 0)),
      deliveryFeePaise: Number(parseAmountToPaise(params.deliveryFee || 0)),
      totalAmountPaise: Number(parseAmountToPaise(params.totalAmount || 0)),
      items: normalizeItems(params.items)
    };

    return crypto.createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
  }
  /**
   * Atomically commits a new order, immutable line items, and financial bill to PostgreSQL.
   */
  public static async createCanonicalOrder(params: CreateOrderParams) {
    const orderId = params.id || crypto.randomUUID();

    // STRICT GUARD AGAINST FAKE / SYNTHETIC / TEST ORDERS
    const incomingId = (params.id || '').toString().trim().toLowerCase();
    const customerName = (params.customerName || '').toString().trim().toLowerCase();
    const orderSource = (params.orderSource || '').toString().trim().toUpperCase();
    const isSynthetic = 
      incomingId.startsWith('test_') ||
      incomingId.startsWith('mock_') ||
      incomingId.startsWith('synthetic_') ||
      incomingId.startsWith('dummy_') ||
      incomingId.startsWith('online_test_') ||
      incomingId.startsWith('ord_test_') ||
      /^(test|mock|synthetic|dummy|fake|archival test|idempotency test)/i.test(customerName) ||
      ['TEST', 'MOCK', 'SYNTHETIC'].includes(orderSource) ||
      (params as any).isTest === true ||
      (params as any).isMock === true;

    if (isSynthetic) {
      const isProduction = process.env.NODE_ENV === 'production';
      const isAllowedMockTest = 
        !isProduction && 
        process.env.NODE_ENV === 'test' && 
        process.env.ALLOW_SYNTHETIC_ORDERS === 'true' && 
        Boolean(process.env.FIRESTORE_EMULATOR_HOST);

      if (!isAllowedMockTest) {
        throw new Error(`[CanonicalOrderService] Synthetic/mock/test orders are strictly forbidden from canonical database commit (ID: ${params.id || 'none'}).`);
      }
    }

    const requestFingerprint = this.computeOrderFingerprint({ ...params, id: orderId });

    // 0. Idempotent check: if order with this ID already exists in canonical PostgreSQL ledger, return existing details
    if (params.id) {
      try {
        const existing = await query(
          `SELECT id, permanent_bill_no, daily_order_no, order_date, order_time, total_amount, payment_status, order_status, request_fingerprint 
           FROM canonical_orders 
           WHERE id = $1 LIMIT 1`,
          [orderId]
        );
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          const existingFingerprint = row.request_fingerprint;
          const existingPaise = parseAmountToPaise(row.total_amount);
          const incomingPaise = parseAmountToPaise(params.totalAmount);

          if (existingFingerprint) {
            if (existingFingerprint !== requestFingerprint) {
              const conflictErr: any = new Error(`[CanonicalOrderService] Idempotency conflict: Order ${orderId} was previously committed with a different request fingerprint.`);
              conflictErr.code = 'IDEMPOTENCY_CONFLICT';
              conflictErr.statusCode = 409;
              throw conflictErr;
            }
          } else if (incomingPaise > 0n && existingPaise !== incomingPaise) {
            const conflictErr: any = new Error(`[CanonicalOrderService] Idempotency conflict: Order ${orderId} was previously committed with total ${row.total_amount} (${existingPaise} paise), but received conflicting payload with total ${params.totalAmount} (${incomingPaise} paise).`);
            conflictErr.code = 'IDEMPOTENCY_CONFLICT';
            conflictErr.statusCode = 409;
            throw conflictErr;
          }
          console.log(`[CanonicalOrderService] Idempotent retry detected for existing order ${orderId} (Bill: #${row.permanent_bill_no}). Returning existing record.`);
          return {
            id: row.id,
            permanentBillNo: Number(row.permanent_bill_no),
            dailyOrderNo: Number(row.daily_order_no),
            orderDate: row.order_date,
            orderTime: row.order_time,
            totalAmount: Number(row.total_amount),
            paymentStatus: row.payment_status,
            orderStatus: row.order_status,
            isDuplicate: true
          };
        }
      } catch (checkErr: any) {
        if (checkErr.code === 'IDEMPOTENCY_CONFLICT' || checkErr.statusCode === 409) {
          throw checkErr;
        }
        console.warn(`[CanonicalOrderService] Idempotency pre-check notice for ${orderId}:`, checkErr.message);
      }
    }

    // 1. Allocate continuous Permanent Bill No. and Daily Order No. scoped to franchise and branch
    const nums = await BillingNumberService.allocateNumbers(
      new Date(),
      params.franchiseId || 'fra_primary',
      params.branchId || 'main_branch'
    );
    const { permanentBillNo, dailyOrderNo, orderDate, orderTime } = nums;

    // 1.1 Process and verify line items authoritatively from catalog
    const processedItems: Array<{
      menuItemId: string | null;
      name: string;
      size: string;
      crust: string;
      quantity: number;
      unitPrice: number;
      addons: any[];
      lineTotal: number;
    }> = [];

    let computedSubtotal = 0;
    for (const item of (params.items || [])) {
      const qty = Math.max(1, Math.min(100, Math.floor(Number(item.quantity) || 1)));
      let unitPrice = 0;
      let itemName = item.name || 'Menu Item';
      const formattedAddons: any[] = item.addons || [];

      // Server/catalog price > Client price: Always resolve authoritative catalog price or branch override
      const itemId = item.menuItemId || (item as any).id;
      if (itemId) {
        if (params.branchId) {
          const authPrice = await AuthoritativePricingResolver.resolveItemPrice({
            branchId: params.branchId,
            franchiseId: params.franchiseId,
            productId: itemId,
            size: item.size,
            crust: item.crust,
            addons: item.addons
          });
          unitPrice = authPrice.unitPrice;
          itemName = authPrice.productName;
        } else {
          try {
            const catItem = await POSService.getCatalogItem(itemId);
            if (catItem) {
              itemName = catItem.productName || catItem.name || itemName;
              const selectedSize = (item.size || '').toLowerCase();
              if (selectedSize && catItem.sizes && catItem.sizes[selectedSize]?.price) {
                unitPrice = Number(catItem.sizes[selectedSize].price);
              } else if (selectedSize && Array.isArray(catItem.variants)) {
                const v = catItem.variants.find((vr: any) => (vr.name || vr.size || '').toLowerCase() === selectedSize);
                if (v && v.price) {
                  unitPrice = Number(v.price);
                }
              }
              if (!unitPrice || unitPrice <= 0) {
                unitPrice = Number(catItem.offerPrice || catItem.basePrice || catItem.price || 0);
              }

              // Authoritative Addon Pricing
              if (Array.isArray(item.addons) && item.addons.length > 0 && Array.isArray(catItem.addons)) {
                for (const a of item.addons) {
                  const rawAddon: any = a;
                  if (!rawAddon) continue;
                  const authoritativeAddon = catItem.addons.find(
                    (ca: any) =>
                      ca.id === rawAddon.id ||
                      ca.name === rawAddon.name ||
                      ca.id === rawAddon ||
                      ca.name === rawAddon
                  );
                  if (authoritativeAddon && authoritativeAddon.price != null) {
                    unitPrice += Math.max(0, Number(authoritativeAddon.price));
                  }
                }
              }
            }
          } catch (catErr) {
            console.warn('[CanonicalOrderService] Catalog lookup warning:', catErr);
          }
        }
      }

      if (unitPrice <= 0) {
        throw new Error(`Item "${itemId || itemName}" does not have an authoritative catalog price configured. Client prices are strictly rejected.`);
      }

      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
      computedSubtotal += lineTotal;
      processedItems.push({
        menuItemId: itemId || null,
        name: itemName,
        size: item.size || 'Regular',
        crust: item.crust || 'Normal',
        quantity: qty,
        unitPrice,
        addons: formattedAddons,
        lineTotal
      });
    }

    if (computedSubtotal <= 0) {
      throw new Error('Order subtotal could not be calculated from authoritative catalog items.');
    }

    const subtotal = parseFloat(computedSubtotal.toFixed(2));
    const discountAmount = Math.min(subtotal, Math.max(0, Number(params.discountAmount) || 0));
    const taxableBase = Math.max(0, subtotal - discountAmount);
    const taxAmount = parseFloat((taxableBase * 0.05).toFixed(2)); // Authoritative 5% GST
    const cgst = parseFloat((taxAmount / 2).toFixed(2));
    const sgst = parseFloat((taxAmount - cgst).toFixed(2));
    const deliveryFee = Math.max(0, Number(params.deliveryFee) || 0);
    const totalAmount = parseFloat((taxableBase + taxAmount + deliveryFee).toFixed(2));

    const paymentMethod = (params.paymentMethod || 'CASH').toUpperCase();
    const paymentStatus = (params.paymentStatus || (paymentMethod === 'COD' ? 'PENDING' : 'PAID')).toUpperCase();
    const resolvedOrderType = params.orderType || params.deliveryType || (params.orderSource === 'POS_DINE_IN' ? 'dine_in' : (params.orderSource === 'POS_TAKEAWAY' ? 'pickup' : 'delivery'));
    const orderStatus = params.orderStatus || (params.orderSource === 'ONLINE' ? 'PLACED' : (resolvedOrderType === 'dine_in' ? 'PREPARING' : 'ACCEPTED'));

    const franchiseId = params.franchiseId || 'fra_primary';
    const branchId = params.branchId || 'main_branch';
    const cashierName = params.cashierName || (params.orderSource === 'ONLINE' ? 'Online Customer App' : 'Cashier');

    // 2. Execute atomic PostgreSQL transaction for Order, Line Items, and Bill (Authoritative Canonical Ledger)
    let existingOrderReturn: any = null;
    try {
      await withTransaction(async (client) => {
        // Concurrency Lock: Check if canonical_orders row already exists
        const lockRes = await client.query(
          `SELECT id, permanent_bill_no, daily_order_no, order_date, order_time, total_amount, payment_status, order_status, request_fingerprint 
           FROM canonical_orders 
           WHERE id = $1 FOR UPDATE`,
          [orderId]
        );

        if (lockRes.rows.length > 0) {
          const row = lockRes.rows[0];
          const existingFingerprint = row.request_fingerprint;
          const existingPaise = parseAmountToPaise(row.total_amount);
          const incomingPaise = parseAmountToPaise(params.totalAmount);

          if (existingFingerprint && existingFingerprint !== requestFingerprint) {
            const conflictErr: any = new Error(`[CanonicalOrderService] Idempotency conflict: Order ${orderId} was previously committed with a different request fingerprint.`);
            conflictErr.code = 'IDEMPOTENCY_CONFLICT';
            conflictErr.statusCode = 409;
            throw conflictErr;
          } else if (incomingPaise > 0n && existingPaise !== incomingPaise) {
            const conflictErr: any = new Error(`[CanonicalOrderService] Idempotency conflict: Order ${orderId} was previously committed with total ${row.total_amount} (${existingPaise} paise), but received conflicting payload with total ${params.totalAmount} (${incomingPaise} paise).`);
            conflictErr.code = 'IDEMPOTENCY_CONFLICT';
            conflictErr.statusCode = 409;
            throw conflictErr;
          }

          existingOrderReturn = {
            id: row.id,
            permanentBillNo: Number(row.permanent_bill_no),
            dailyOrderNo: Number(row.daily_order_no),
            orderDate: row.order_date,
            orderTime: row.order_time,
            totalAmount: Number(row.total_amount),
            paymentStatus: row.payment_status,
            orderStatus: row.order_status,
            isDuplicate: true
          };
          return;
        }

        // 2.1 Insert canonical order (Immutable conflict safety: ON CONFLICT DO NOTHING)
        await client.query(`
          INSERT INTO canonical_orders (
            id, permanent_bill_no, daily_order_no, order_date, order_time,
            order_source, order_type, order_status, payment_method, payment_status,
            customer_name, customer_phone, delivery_address, table_number,
            subtotal, discount_amount, coupon_code, tax_amount, cgst, sgst,
            delivery_fee, total_amount, franchise_id, branch_id, cashier_id,
            cashier_name, terminal_id, notes, request_fingerprint
          ) VALUES (
            $1, $2, $3, $4::date, $5::time,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25,
            $26, $27, $28, $29
          ) ON CONFLICT (id) DO NOTHING;
        `, [
          orderId, permanentBillNo, dailyOrderNo, orderDate, orderTime,
          params.orderSource, resolvedOrderType, orderStatus, paymentMethod, paymentStatus,
          params.customerName || 'Walk-in Customer', params.customerPhone || 'N/A',
          params.deliveryAddress || null, params.tableNumber || null,
          subtotal, discountAmount, params.couponCode || null, taxAmount, cgst, sgst,
          deliveryFee, totalAmount, franchiseId, branchId, params.cashierId || null,
          cashierName, params.terminalId || 'POS-TERM-01', params.notes || '', requestFingerprint
        ]);

        // 2.2 Insert immutable line items with deterministic line item IDs
        for (let idx = 0; idx < processedItems.length; idx++) {
          const item = processedItems[idx];
          const lineItemId = `${orderId}_item_${idx + 1}`;
          await client.query(`
            INSERT INTO canonical_order_items (
              id, order_id, menu_item_id, item_name, size_variant,
              crust, quantity, unit_price, addons_json, line_total
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, $7, $8, $9::jsonb, $10
            ) ON CONFLICT (id) DO NOTHING;
          `, [
            lineItemId, orderId, item.menuItemId || null, item.name, item.size || 'Regular',
            item.crust || 'Normal', item.quantity, item.unitPrice, JSON.stringify(item.addons || []), item.lineTotal
          ]);
        }

        // 2.3 Insert canonical financial bill (enforcing exactly 1 bill per order via order_id unique constraint)
        const billId = `bill_${orderId}`;
        await client.query(`
          INSERT INTO canonical_bills (
            id, permanent_bill_no, order_id, bill_date, subtotal,
            discount, tax, net_amount, payment_method, payment_status
          ) VALUES (
            $1, $2, $3, $4::date, $5,
            $6, $7, $8, $9, $10
          ) ON CONFLICT (order_id) DO NOTHING;
        `, [
          billId, permanentBillNo, orderId, orderDate, subtotal,
          discountAmount, taxAmount, totalAmount, paymentMethod, paymentStatus
        ]);

        // 2.4 Insert canonical payment record
        const paymentId = 'pay_' + orderId;
        await client.query(`
          INSERT INTO payments (
            id, order_id, user_id, provider, amount, currency, status, payment_method
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
          ) ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            amount = EXCLUDED.amount,
            updated_at = NOW();
        `, [
          paymentId, orderId, params.customerPhone || 'customer', paymentMethod, totalAmount, 'INR',
          paymentStatus === 'PAID' ? 'PAYMENT_CAPTURED' : 'PENDING', paymentMethod
        ]);

        // 2.5 Insert record into order_idempotency_records
        const idempotencyKey = (params as any).idempotencyKey || (`ord_idem_${orderId}`);
        const responsePayload = {
          id: orderId,
          permanentBillNo,
          dailyOrderNo,
          orderDate,
          orderTime,
          totalAmount,
          paymentStatus,
          orderStatus
        };
        await client.query(`
          INSERT INTO order_idempotency_records (
            idempotency_key, request_fingerprint, order_id, franchise_id, branch_id, status, response_payload
          ) VALUES (
            $1, $2, $3, $4, $5, 'COMMITTED', $6::jsonb
          ) ON CONFLICT (idempotency_key) DO UPDATE SET
            status = 'COMMITTED',
            response_payload = EXCLUDED.response_payload,
            request_fingerprint = EXCLUDED.request_fingerprint;
        `, [
          idempotencyKey, requestFingerprint, orderId, franchiseId, branchId, JSON.stringify(responsePayload)
        ]);

        // 2.5 Update customer total_orders and total_spent in app_users
        if (params.customerPhone && params.customerPhone !== 'N/A') {
          const custId = `cust_${params.customerPhone.replace(/[^0-9]/g, '')}`;
          await client.query(`
            INSERT INTO app_users (
              id, phone, name, role, status, is_active, total_orders, total_spent, updated_at
            ) VALUES (
              $1, $2, $3, 'customer', 'APPROVED', true, 1, $4, NOW()
            ) ON CONFLICT (id) DO UPDATE SET
              total_orders = COALESCE(app_users.total_orders, 0) + 1,
              total_spent = COALESCE(app_users.total_spent, 0) + EXCLUDED.total_spent,
              name = CASE WHEN app_users.name = 'Olive Customer' AND EXCLUDED.name != 'Walk-in Customer' THEN EXCLUDED.name ELSE app_users.name END,
              updated_at = NOW();
          `, [
            custId,
            params.customerPhone,
            params.customerName || 'Walk-in Customer',
            totalAmount
          ]);
        }
      });
    } catch (txError: any) {
      console.error('[CanonicalOrderService] Transaction FAILED with error:', txError.message || txError);
      throw txError;
    }

    if (existingOrderReturn) {
      return existingOrderReturn;
    }

    // Post-commit: Reconcile any provisional dispatch intent for this order
    import('../delivery/ProvisionalDispatchService.js').then(({ ProvisionalDispatchService }) => {
      ProvisionalDispatchService.reconcileProvisionalDispatch(orderId).catch(err => {
        console.warn(`[CanonicalOrderService] Post-commit provisional reconciliation notice for ${orderId}:`, err.message);
      });
    }).catch(() => {});

    // 2.4 Authoritative Firestore Billing Record Persistence
    try {
      const billSource: 'ONLINE' | 'POS' = params.orderSource.startsWith('POS') ? 'POS' : 'ONLINE';
      await billingRepository.saveBill({
        permanentBillNumber: permanentBillNo,
        billFormattedNumber: `#${permanentBillNo}`,
        orderId,
        source: billSource,
        franchiseId,
        branchId,
        terminalId: params.terminalId || (billSource === 'POS' ? 'POS-TERM-01' : 'ONLINE-APP'),
        totalAmount,
        paymentMethod,
        paymentStatus,
        createdAt: new Date().toISOString()
      });

      // Emit canonical domain event: bill.generated
      appEventBus.emitTyped('bill.generated', {
        billNumber: permanentBillNo,
        billFormattedNumber: `#${permanentBillNo}`,
        orderId,
        source: billSource,
        franchiseId,
        branchId,
        terminalId: params.terminalId || (billSource === 'POS' ? 'POS-TERM-01' : 'ONLINE-APP'),
        totalAmount,
        paymentMethod,
        timestamp: new Date().toISOString()
      });

      // Emit canonical domain event: payment.received if payment is settled
      if (paymentStatus === 'PAID') {
        appEventBus.emitTyped('payment.received', {
          paymentId: `pay_${orderId.slice(0, 8)}`,
          orderId,
          permanentBillNo,
          amount: totalAmount,
          currency: 'INR',
          paymentMethod,
          paymentStatus: 'PAID',
          franchiseId,
          branchId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (billingRepoErr: any) {
      console.warn('[BillingRepository] Save bill warning:', billingRepoErr?.message || billingRepoErr);
    }

    // 3. Authoritative Firestore order persistence (maintains instant mobile/client notifications)
    if (isSynthetic && !process.env.FIRESTORE_EMULATOR_HOST) {
      console.warn(`[CanonicalOrderService] Bypassed live Firestore order persistence for synthetic order ${orderId}.`);
    } else {
      try {
        await adminDb.collection('orders').doc(orderId).set({
        id: orderId,
        permanentBillNo,
        billNumber: `#${permanentBillNo}`,
        dailyOrderNumber: dailyOrderNo,
        orderNumber: `#${dailyOrderNo}`,
        orderDateLocal: orderDate,
        orderTimeLocal: orderTime,
        orderSource: params.orderSource,
        orderType: params.orderType,
        customerName: params.customerName || 'Walk-in Customer',
        contactPhone: params.customerPhone || 'N/A',
        items: params.items,
        subtotal,
        discountAmount,
        couponCode: params.couponCode || null,
        taxes: taxAmount,
        cgst,
        sgst,
        deliveryFee,
        totalAmount,
        finalTotal: totalAmount,
        status: orderStatus,
        paymentMethod,
        paymentStatus,
        franchiseId,
        branchId,
        cashierName,
        terminalId: params.terminalId || 'POS-TERM-01',
        tableNumber: params.tableNumber || null,
        deliveryAddress: params.deliveryAddress ? { addressLine: params.deliveryAddress } : null,
        createdAt: new Date(),
        updatedAt: new Date()
      }, { merge: true });
    } catch (e: any) {
      console.warn('[CanonicalOrder] Firestore mirror warning:', e.message);
    }
  }

    return {
      id: orderId,
      orderId,
      permanentBillNo,
      dailyOrderNo,
      orderDate,
      orderTime,
      totalAmount,
      orderStatus,
      paymentStatus
    };
  }

  /**
   * SECTION 11: Deterministic PostgreSQL Bill & Order Search.
   */
  public static async searchCanonicalOrders(filters: SearchOrderFilters) {
    const conditions: string[] = [];
    const values: any[] = [];

    if (filters.permanentBillNo) {
      values.push(filters.permanentBillNo);
      conditions.push(`o.permanent_bill_no = $${values.length}`);
    }

    if (filters.dailyOrderNo) {
      values.push(filters.dailyOrderNo);
      conditions.push(`o.daily_order_no = $${values.length}`);
    }

    if (filters.orderId) {
      values.push(`%${filters.orderId}%`);
      conditions.push(`o.id ILIKE $${values.length}`);
    }

    if (filters.customerPhone) {
      values.push(`%${filters.customerPhone.trim()}%`);
      conditions.push(`o.customer_phone ILIKE $${values.length}`);
    }

    if (filters.customerName) {
      values.push(`%${filters.customerName.trim()}%`);
      conditions.push(`o.customer_name ILIKE $${values.length}`);
    }

    if (filters.startDate) {
      values.push(filters.startDate);
      conditions.push(`o.order_date >= $${values.length}`);
    }

    if (filters.endDate) {
      values.push(filters.endDate);
      conditions.push(`o.order_date <= $${values.length}`);
    }

    if (filters.minAmount !== undefined) {
      values.push(filters.minAmount);
      conditions.push(`o.total_amount >= $${values.length}`);
    }

    if (filters.maxAmount !== undefined) {
      values.push(filters.maxAmount);
      conditions.push(`o.total_amount <= $${values.length}`);
    }

    if (filters.paymentMethod) {
      values.push(filters.paymentMethod.toUpperCase());
      conditions.push(`UPPER(o.payment_method) = $${values.length}`);
    }

    if (filters.paymentStatus) {
      values.push(filters.paymentStatus.toUpperCase());
      conditions.push(`UPPER(o.payment_status) = $${values.length}`);
    }

    if (filters.orderStatus) {
      values.push(filters.orderStatus.toUpperCase());
      conditions.push(`UPPER(o.order_status) = $${values.length}`);
    }

    if (filters.orderSource) {
      values.push(filters.orderSource.toUpperCase());
      conditions.push(`UPPER(o.order_source) = $${values.length}`);
    }

    if (filters.orderType) {
      values.push(filters.orderType.toLowerCase());
      conditions.push(`LOWER(o.order_type) = $${values.length}`);
    }

    if (filters.branchId) {
      values.push(filters.branchId);
      conditions.push(`o.branch_id = $${values.length}`);
    }

    if (filters.franchiseId) {
      values.push(filters.franchiseId);
      conditions.push(`o.franchise_id = $${values.length}`);
    }

    if (filters.itemName) {
      values.push(`%${filters.itemName.trim()}%`);
      conditions.push(`EXISTS (
        SELECT 1 FROM canonical_order_items i
        WHERE i.order_id = o.id AND i.item_name ILIKE $${values.length}
      )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(100, Math.max(1, filters.limit || 50));
    const offset = Math.max(0, filters.offset || 0);

    values.push(limit);
    const limitIdx = values.length;
    values.push(offset);
    const offsetIdx = values.length;

    const sql = `
      SELECT
        o.id,
        o.permanent_bill_no,
        o.daily_order_no,
        TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
        TO_CHAR(o.order_time, 'HH24:MI:SS') AS order_time,
        o.order_source,
        o.order_type,
        o.order_status,
        o.payment_method,
        o.payment_status,
        o.customer_name,
        o.customer_phone,
        o.delivery_address,
        o.table_number,
        o.subtotal,
        o.discount_amount,
        o.coupon_code,
        o.tax_amount,
        o.delivery_fee,
        o.total_amount,
        o.franchise_id,
        o.branch_id,
        o.cashier_name,
        o.terminal_id,
        o.cancellation_reason,
        o.refund_amount,
        COALESCE(
          json_agg(
            json_build_object(
              'id', i.id,
              'menuItemId', i.menu_item_id,
              'name', i.item_name,
              'size', i.size_variant,
              'crust', i.crust,
              'quantity', i.quantity,
              'unitPrice', i.unit_price,
              'lineTotal', i.line_total,
              'addons', i.addons_json
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM canonical_orders o
      LEFT JOIN canonical_order_items i ON o.id = i.order_id
      ${whereClause}
      GROUP BY o.id
      ORDER BY o.permanent_bill_no DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await query(sql, values);

    return res.rows.map(r => ({
      id: r.id,
      permanentBillNo: parseInt(r.permanent_bill_no, 10),
      dailyOrderNo: parseInt(r.daily_order_no, 10),
      orderDate: r.order_date,
      orderTime: r.order_time,
      orderSource: r.order_source,
      orderType: r.order_type,
      orderStatus: r.order_status,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      deliveryAddress: r.delivery_address,
      tableNumber: r.table_number,
      subtotal: parseFloat(r.subtotal),
      discountAmount: parseFloat(r.discount_amount),
      couponCode: r.coupon_code,
      taxAmount: parseFloat(r.tax_amount),
      deliveryFee: parseFloat(r.delivery_fee),
      totalAmount: parseFloat(r.total_amount),
      franchiseId: r.franchise_id,
      branchId: r.branch_id,
      cashierName: r.cashier_name,
      terminalId: r.terminal_id,
      cancellationReason: r.cancellation_reason,
      refundAmount: parseFloat(r.refund_amount || '0'),
      items: r.items
    }));
  }

  /**
   * SECTION 18: Auditable Cancellation & Refund.
   */
  public static async cancelOrRefundOrder(params: {
    orderId: string;
    reason: string;
    refundAmount?: number;
    cancelledBy: string;
  }) {
    const { orderId, reason, refundAmount = 0, cancelledBy } = params;
    const now = new Date();

    return await withTransaction(async (client) => {
      // 1. Fetch current order
      const fetchRes = await client.query(`
        SELECT id, permanent_bill_no, total_amount, order_status FROM canonical_orders WHERE id = $1 FOR UPDATE;
      `, [orderId]);

      if (fetchRes.rows.length === 0) {
        throw new Error('Order not found in canonical records');
      }

      const order = fetchRes.rows[0];
      const actualRefund = refundAmount > 0 ? refundAmount : parseFloat(order.total_amount);

      // 2. Update canonical order
      await client.query(`
        UPDATE canonical_orders
        SET order_status = 'CANCELLED',
            payment_status = 'REFUNDED',
            cancellation_reason = $2,
            cancelled_at = $3,
            refund_amount = $4,
            updated_at = $3
        WHERE id = $1;
      `, [orderId, reason, now, actualRefund]);

      // 3. Update canonical bill
      await client.query(`
        UPDATE canonical_bills
        SET is_cancelled = TRUE,
            cancelled_at = $2,
            cancellation_reason = $3,
            payment_status = 'REFUNDED'
        WHERE order_id = $1;
      `, [orderId, now, reason]);

      // 4. Update Firestore mirror
      await adminDb.collection('orders').doc(orderId).update({
        status: 'cancelled',
        paymentStatus: 'REFUNDED',
        cancellationReason: reason,
        cancelledAt: now.toISOString(),
        refundAmount: actualRefund,
        updatedAt: now
      }).catch(() => {});

      return {
        success: true,
        orderId,
        permanentBillNo: parseInt(order.permanent_bill_no, 10),
        refundAmount: actualRefund
      };
    });
  }

  /**
   * SECTION 5 & 21: Live Online Orders stream for POS.
   */
  public static async getLiveOnlineOrders(branchId: string = 'main_branch') {
    const today = BillingNumberService.getLocalDateString();
    const sql = `
      SELECT
        o.id,
        o.permanent_bill_no,
        o.daily_order_no,
        TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
        TO_CHAR(o.order_time, 'HH24:MI:SS') AS order_time,
        o.order_source,
        o.order_type,
        o.order_status,
        o.payment_method,
        o.payment_status,
        o.customer_name,
        o.customer_phone,
        o.delivery_address,
        o.subtotal,
        o.discount_amount,
        o.total_amount,
        COALESCE(
          json_agg(
            json_build_object(
              'name', i.item_name,
              'size', i.size_variant,
              'quantity', i.quantity,
              'unitPrice', i.unit_price,
              'lineTotal', i.line_total
            )
          ) FILTER (WHERE i.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM canonical_orders o
      LEFT JOIN canonical_order_items i ON o.id = i.order_id
      WHERE (o.branch_id = $1 OR o.franchise_id = $1 OR $1 = 'main_branch' OR $1 = '' OR $1 IS NULL)
        AND o.order_source IN ('ONLINE', 'CUSTOMER_APP', 'ONLINE_APP')
        AND o.order_date >= ($2::date - INTERVAL '1 day')
        AND o.order_status IN ('PLACED', 'pending_acceptance', 'ACCEPTED', 'PREPARING', 'READY', 'READY_FOR_PICKUP')
      GROUP BY o.id
      ORDER BY o.permanent_bill_no DESC;
    `;

    const res = await query(sql, [branchId, today]);
    return res.rows.map(r => ({
      id: r.id,
      permanentBillNo: parseInt(r.permanent_bill_no, 10),
      dailyOrderNo: parseInt(r.daily_order_no, 10),
      orderDate: r.order_date,
      orderTime: r.order_time,
      orderSource: r.order_source,
      orderType: r.order_type,
      orderStatus: r.order_status,
      paymentMethod: r.payment_method,
      paymentStatus: r.payment_status,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      deliveryAddress: r.delivery_address,
      subtotal: parseFloat(r.subtotal),
      discountAmount: parseFloat(r.discount_amount),
      totalAmount: parseFloat(r.total_amount),
      items: r.items
    }));
  }
}
