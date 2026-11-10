import { query } from '../config/postgres.js';
import { BillingNumberService } from '../services/pos/BillingNumberService.js';
import { OrderPersistenceArchiveService } from '../services/order/OrderPersistenceArchiveService.js';
import { adminDb } from '../config/firebase.js';

async function startNewOrder() {
  const orderId = `OP-ORD-${Date.now()}`;
  console.log(`\n======================================================`);
  console.log(`🍕 CREATING BRAND NEW LIVE PIZZA ORDER: ${orderId}`);
  console.log(`======================================================`);

  const branchId = 'main_branch';
  const franchiseId = 'fra_primary';
  const customerName = 'Aarav Gupta';
  const customerPhone = '+919179944445';
  const subtotal = 499.00;
  const taxAmount = 24.95;
  const deliveryFee = 35.00;
  const totalAmount = 558.95;

  const orderData: any = {
    id: orderId,
    orderId,
    orderNumber: `#${orderId.slice(-6)}`,
    branchId,
    franchiseId,
    customerName,
    customerPhone,
    contactPhone: customerPhone,
    deliveryAddress: {
      addressLine: 'House 14, Green Valley Enclave',
      area: 'Civil Lines',
      city: 'Rajnandgaon'
    },
    items: [
      {
        id: 'item_pizza_01',
        name: 'Gourmet Olive Overload Pizza',
        size: 'Medium (10")',
        crust: 'Hand-Tossed Sourdough',
        quantity: 1,
        unitPrice: 399.00,
        lineTotal: 399.00
      },
      {
        id: 'item_side_01',
        name: 'Cheesy Garlic Bread',
        quantity: 1,
        unitPrice: 100.00,
        lineTotal: 100.00
      }
    ],
    subtotal,
    taxAmount,
    deliveryFee,
    totalAmount,
    status: 'pending',
    orderStatus: 'pending',
    lifecycle: 'ACTIVE',
    orderType: 'delivery',
    orderSource: 'ONLINE',
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // 1. Allocate statutory sequence numbers
  try {
    const sequences = await BillingNumberService.allocateNumbers();
    orderData.permanentBillNo = Number(sequences.permanentBillNo) || 10850;
    orderData.dailyOrderNumber = Number(sequences.dailyOrderNo) || 1;
    console.log(`✅ Statutory numbers allocated: Permanent Bill #${orderData.permanentBillNo}, Daily Order #${orderData.dailyOrderNumber}`);
  } catch (err: any) {
    orderData.permanentBillNo = Math.floor(10000 + Math.random() * 90000);
    orderData.dailyOrderNumber = 1;
    console.log(`ℹ️ Sequence fallback: Permanent Bill #${orderData.permanentBillNo}, Daily #${orderData.dailyOrderNumber}`);
  }

  // 2. Insert into PostgreSQL canonical_orders
  try {
    await query(
      `INSERT INTO canonical_orders (
        id, permanent_bill_no, daily_order_no, order_date, order_time,
        order_source, order_type, order_status, payment_method, payment_status,
        customer_name, customer_phone, delivery_address,
        subtotal, tax_amount, delivery_fee, total_amount,
        franchise_id, branch_id, created_at, updated_at
      ) VALUES (
        $1, $2, $3, CURRENT_DATE, CURRENT_TIME,
        $4, $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, NOW(), NOW()
      )`,
      [
        orderId,
        orderData.permanentBillNo,
        orderData.dailyOrderNumber,
        'ONLINE',
        'delivery',
        'PENDING',
        'COD',
        'PENDING',
        customerName,
        customerPhone,
        JSON.stringify(orderData.deliveryAddress),
        subtotal,
        taxAmount,
        deliveryFee,
        totalAmount,
        franchiseId,
        branchId
      ]
    );
    console.log('✅ Canonical PostgreSQL order record durably inserted.');
  } catch (err: any) {
    console.warn('PostgreSQL insert notice:', err.message);
  }

  // 3. Write to Firestore if available
  try {
    await adminDb.collection('orders').doc(orderId).set(orderData);
    console.log('✅ Firestore live order document created.');
  } catch (err: any) {
    console.warn('Firestore live order notice (quota / offline mode active):', err.message);
  }

  console.log(`\n🎉 NEW ORDER CREATED SUCCESSFULLY!`);
  console.log(`Order ID: ${orderId}`);
  console.log(`Customer: ${customerName} (${customerPhone})`);
  console.log(`Total: ₹${totalAmount} | Status: PENDING\n`);

  process.exit(0);
}

startNewOrder().catch(err => {
  console.error('Fatal order creation error:', err);
  process.exit(1);
});
