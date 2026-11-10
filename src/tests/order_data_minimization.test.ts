import assert from 'assert';
import { OrderProjectionService } from '../services/order/OrderProjectionService.js';

console.log('--- RUNNING ORDER FIELD-LEVEL DATA MINIMIZATION TESTS ---');

const mockCanonicalOrder = {
  id: 'ord_canon_987654',
  orderNumber: 'OP-9876',
  dailyOrderNumber: 42,
  permanentBillNo: 1042,
  billNumber: '#1042',
  userId: 'usr_customer_secret_123',
  customerName: 'Aarav Patel',
  customerEmail: 'aarav.patel.private@example.com',
  userEmail: 'aarav.patel.private@example.com',
  contactPhone: '+91 98765 43210',
  phone: '+91 98765 43210',
  branchId: 'main_branch',
  branchName: 'Olive Pizza — Rajnandgaon HQ',
  franchiseId: 'fra_primary',
  orderSource: 'ONLINE_APP',
  deliveryType: 'delivery',
  fulfillmentType: 'delivery',
  deliveryAddress: {
    addressLine: 'Flat 402, Royal Palms, Dongargaon Road',
    city: 'Rajnandgaon',
    landmark: 'Near Saraswati School',
    lat: 21.0965,
    lng: 81.0345
  },
  items: [
    {
      menuItemId: 'item_pizza_01',
      name: 'Farm Fresh Deluxe',
      price: 399,
      quantity: 2,
      size: 'Medium',
      crust: 'Cheese Burst',
      costPrice: 120,
      addons: [{ name: 'Extra Jalapenos', price: 35 }],
      notes: 'Less spicy please'
    }
  ],
  subtotal: 798,
  discountAmount: 50,
  couponCode: 'WELCOME50',
  packagingCharge: 30,
  deliveryFee: 40,
  taxes: 40.9,
  cgst: 20.45,
  sgst: 20.45,
  totalAmount: 858.9,
  finalTotal: 858.9,
  profitMargin: 420.5,
  paymentMethod: 'UPI',
  paymentStatus: 'PAID',
  paymentGatewayRef: 'pay_rzp_live_secret_reference_token',
  gatewaySecretToken: 'sec_live_abcdef123456789',
  status: 'out_for_delivery',
  deliveryPartnerId: 'rider_sharma_55',
  deliveryPartnerName: 'Ramesh Sharma',
  deliveryPartnerPhone: '+91 91799 00001',
  deliveryInstructions: 'Ring doorbell twice and leave on doorstep',
  internalKitchenNotes: 'VIP customer, ensure hot crust',
  kitchenAuditLogs: [
    { action: 'dough_prepared', staffId: 'chef_01', timestamp: '2026-09-08T18:00:00.000Z' }
  ],
  createdAt: '2026-09-08T18:30:00.000Z',
  updatedAt: '2026-09-08T18:45:00.000Z'
};

// ============================================================================
// TEST 1: DELIVERY RIDER DATA MINIMIZATION
// ============================================================================
console.log('\n[Test 1] Delivery Rider Data Minimization:');
const riderProjected = OrderProjectionService.projectForDeliveryRider(mockCanonicalOrder, mockCanonicalOrder.id);

assert.strictEqual(riderProjected.id, 'ord_canon_987654');
assert.strictEqual(riderProjected.orderNumber, 'OP-9876');
assert.strictEqual(riderProjected.customerName, 'Aarav Patel');
assert.strictEqual(riderProjected.contactPhone, '+91 98765 43210');
assert.strictEqual(riderProjected.totalAmount, 858.9);
assert.strictEqual(riderProjected.paymentStatus, 'PAID');
assert.strictEqual(riderProjected.paymentMethod, 'UPI');
assert.strictEqual(riderProjected.deliveryInstructions, 'Ring doorbell twice and leave on doorstep');
assert.strictEqual(riderProjected.items.length, 1);
assert.strictEqual(riderProjected.items[0].name, 'Farm Fresh Deluxe');
assert.strictEqual(riderProjected.items[0].quantity, 2);

const riderObj = riderProjected as any;
assert.strictEqual(riderObj.customerEmail, undefined, 'Rider MUST NOT receive customer email');
assert.strictEqual(riderObj.userEmail, undefined, 'Rider MUST NOT receive user email');
assert.strictEqual(riderObj.userId, undefined, 'Rider MUST NOT receive private customer UID');
assert.strictEqual(riderObj.profitMargin, undefined, 'Rider MUST NOT receive restaurant profit margin');
assert.strictEqual(riderObj.paymentGatewayRef, undefined, 'Rider MUST NOT receive payment gateway ref');
assert.strictEqual(riderObj.gatewaySecretToken, undefined, 'Rider MUST NOT receive gateway secret tokens');
assert.strictEqual(riderObj.internalKitchenNotes, undefined, 'Rider MUST NOT receive internal kitchen notes');
assert.strictEqual(riderObj.kitchenAuditLogs, undefined, 'Rider MUST NOT receive kitchen audit logs');
assert.strictEqual(riderProjected.items[0].costPrice, undefined, 'Rider MUST NOT receive item cost price');
console.log('✓ PASS: Delivery Rider receives strictly operational delivery fields and zero sensitive customer/financial data.');

// ============================================================================
// TEST 2: RESTAURANT MANAGER DATA MINIMIZATION
// ============================================================================
console.log('\n[Test 2] Restaurant Manager Data Minimization:');
const managerProjected = OrderProjectionService.projectForRestaurantManager(mockCanonicalOrder, mockCanonicalOrder.id);

assert.strictEqual(managerProjected.id, 'ord_canon_987654');
assert.strictEqual(managerProjected.branchId, 'main_branch');
assert.strictEqual(managerProjected.items[0].notes, 'Less spicy please');
assert.strictEqual(managerProjected.riderAssignment.deliveryPartnerId, 'rider_sharma_55');

const mgrObj = managerProjected as any;
assert.strictEqual(mgrObj.gatewaySecretToken, undefined, 'Manager MUST NOT receive payment gateway secret tokens');
assert.strictEqual(mgrObj.profitMargin, undefined, 'Manager MUST NOT receive franchise-wide owner profit margins');
console.log('✓ PASS: Restaurant Manager receives branch-scoped operational & preparation details.');

// ============================================================================
// TEST 3: POS BILLING DATA MINIMIZATION
// ============================================================================
console.log('\n[Test 3] POS Data Minimization:');
const posProjected = OrderProjectionService.projectForPOS(mockCanonicalOrder, mockCanonicalOrder.id);

assert.strictEqual(posProjected.billNumber, '#1042');
assert.strictEqual(posProjected.permanentBillNo, 1042);
assert.strictEqual(posProjected.taxes, 40.9);
assert.strictEqual(posProjected.totalAmount, 858.9);
assert.strictEqual(posProjected.paymentMethod, 'UPI');

const posObj = posProjected as any;
assert.strictEqual(posObj.customerEmail, undefined, 'POS MUST NOT receive private customer email');
assert.strictEqual(posObj.userId, undefined, 'POS MUST NOT receive private customer UID');
assert.strictEqual(posObj.profitMargin, undefined, 'POS MUST NOT receive profit margins');
assert.strictEqual(posObj.gatewaySecretToken, undefined, 'POS MUST NOT receive gateway secrets');
console.log('✓ PASS: POS receives terminal billing fields with sensitive customer/financial details stripped.');

// ============================================================================
// TEST 4: CUSTOMER DATA MINIMIZATION & STRICT ISOLATION
// ============================================================================
console.log('\n[Test 4] Customer Data Minimization & Isolation:');
const customerAuthorized = OrderProjectionService.projectForCustomer(
  mockCanonicalOrder,
  'usr_customer_secret_123',
  mockCanonicalOrder.id
);
assert.notStrictEqual(customerAuthorized, null, 'Authorized customer MUST receive their own order projection');
assert.strictEqual(customerAuthorized?.id, 'ord_canon_987654');
assert.strictEqual(customerAuthorized?.status, 'out_for_delivery');
assert.strictEqual(customerAuthorized?.deliveryPartner?.phone, '+91 91799 00001');

const custObj = customerAuthorized as any;
assert.strictEqual(custObj.profitMargin, undefined, 'Customer MUST NOT see profit margins');
assert.strictEqual(custObj.kitchenAuditLogs, undefined, 'Customer MUST NOT see kitchen audit logs');
assert.strictEqual(custObj.internalKitchenNotes, undefined, 'Customer MUST NOT see internal staff notes');

const orderPreparing = { ...mockCanonicalOrder, status: 'preparing' };
const custPreparing = OrderProjectionService.projectForCustomer(
  orderPreparing,
  'usr_customer_secret_123',
  orderPreparing.id
);
assert.strictEqual(custPreparing?.deliveryPartner, null, 'Rider contact MUST be hidden when order is not out for delivery');

const customerUnauthorized = OrderProjectionService.projectForCustomer(
  mockCanonicalOrder,
  'usr_unauthorized_attacker_999',
  mockCanonicalOrder.id
);
assert.strictEqual(customerUnauthorized, null, 'Unauthorized customer MUST receive null (0 data exposure)');
console.log('✓ PASS: Customer projection strictly enforces identity ownership and masks intermediate staff details.');

// ============================================================================
// TEST 5: FRANCHISE SCOPED MINIMIZATION
// ============================================================================
console.log('\n[Test 5] Franchise Scoped Minimization:');
const franchiseProjected = OrderProjectionService.projectForFranchiseManager(mockCanonicalOrder, mockCanonicalOrder.id);
assert.strictEqual(franchiseProjected.franchiseId, 'fra_primary');
const franObj = franchiseProjected as any;
assert.strictEqual(franObj.gatewaySecretToken, undefined, 'Franchise MUST NOT see gateway secret keys');
console.log('✓ PASS: Franchise Manager receives branch-filtered operational data.');

// ============================================================================
// TEST 6: DYNAMIC ROLE-BASED DISPATCHER
// ============================================================================
console.log('\n[Test 6] Dynamic Role-based Dispatcher (projectByRole):');
const riderRoleResult = OrderProjectionService.projectByRole(mockCanonicalOrder, { uid: 'rider_sharma_55', role: 'delivery_partner' });
assert.strictEqual((riderRoleResult as any).customerEmail, undefined);
assert.strictEqual(riderRoleResult.customerName, 'Aarav Patel');

const posRoleResult = OrderProjectionService.projectByRole(mockCanonicalOrder, { uid: 'cashier_01', role: 'cashier' });
assert.strictEqual(posRoleResult.billNumber, '#1042');

const customerRoleResult = OrderProjectionService.projectByRole(mockCanonicalOrder, { uid: 'usr_customer_secret_123', role: 'customer' });
assert.strictEqual(customerRoleResult.id, 'ord_canon_987654');

const unauthorizedCustResult = OrderProjectionService.projectByRole(mockCanonicalOrder, { uid: 'unauthorized_cust', role: 'customer' });
assert.strictEqual(unauthorizedCustResult, null);
console.log('✓ PASS: Role-based dispatcher correctly enforces field-level minimization per role.');

console.log('\n===============================================================');
console.log('ALL FIELD-LEVEL DATA MINIMIZATION SECURITY TESTS PASSED (6/6)');
console.log('===============================================================\n');
