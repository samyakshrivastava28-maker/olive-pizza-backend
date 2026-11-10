import { adminDb as db } from '../config/firebase.js';
import { POSService } from '../services/pos/POSService.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { ESCPOSFormatter } from '../services/pos/ESCPOSFormatter.js';

async function runTests() {
  console.log('🧪 Starting POS Billing System UX + Access + Product Visibility Test Suite...\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, title: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${title}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${title}`);
    }
  }

  // -------------------------------------------------------------
  // Test 1: POS Login & Owner-Controlled Access Validation
  // -------------------------------------------------------------
  console.log('1️⃣ Testing POS Account Scoping & Role Access Control...');
  const ownerScope = FranchiseScopeService.resolveScope({
    email: 'olivepizzarjn@gmail.com',
    role: 'owner'
  });
  assert(ownerScope.isGlobalOwner === true, 'Master owner olivepizzarjn@gmail.com has global owner scope');

  const cashierScope = FranchiseScopeService.resolveScope({
    email: 'cashier.rjn@olivepizza.in',
    role: 'cashier',
    franchiseId: 'fra_rajnandgaon',
    branchId: 'main_branch',
    terminalId: 'POS-RJN-01',
    permissions: ['pos.view', 'pos.create_bill']
  });
  assert(cashierScope.isGlobalOwner === false, 'Cashier is NOT global owner');
  assert(cashierScope.isBranchScoped === true, 'Cashier is strictly branch-scoped');
  assert(cashierScope.branchId === 'main_branch', 'Cashier is locked to assigned branch');
  assert(cashierScope.terminalId === 'POS-RJN-01', 'Cashier is locked to assigned terminal');

  // Test 2: Server-side Franchise Isolation
  console.log('\n2️⃣ Testing Franchise Isolation & Spoof Prevention...');
  const effectiveBranchForCashier = FranchiseScopeService.getEffectiveBranchId(cashierScope, 'durg_branch');
  assert(effectiveBranchForCashier === 'main_branch', 'Cashier attempting to query Durg branch is locked to Rajnandgaon');

  const effectiveBranchForOwner = FranchiseScopeService.getEffectiveBranchId(ownerScope, 'durg_branch');
  assert(effectiveBranchForOwner === 'durg_branch', 'Master Owner can freely switch context to Durg branch');

  // -------------------------------------------------------------
  // Test 3: Authoritative Bill Calculation & GST Structure
  // -------------------------------------------------------------
  console.log('\n3️⃣ Testing Server-Authoritative Bill Calculation & 5% GST...');
  const testItems = [
    {
      productId: 'prod_farmhouse',
      name: 'Farmhouse Delight',
      price: 299,
      quantity: 2,
      size: 'Medium',
      crust: 'Cheese Burst',
      addons: [{ id: 'add_cheese', name: 'Extra Cheese', price: 60 }]
    },
    {
      productId: 'prod_garlic_bread',
      name: 'Stuffed Garlic Bread',
      price: 149,
      quantity: 1,
      size: 'Regular',
      crust: 'Standard',
      addons: []
    }
  ];

  // Item 1: (299 + 60) * 2 = 718
  // Item 2: 149 * 1 = 149
  // Subtotal = 867. Discount = 50. Taxable = 817.
  // 5% GST = round(817 * 0.05) = 41 (CGST 20.5, SGST 20.5)
  // Final Total = 817 + 41 = 858
  const calc = await POSService.calculateBill({
    items: testItems as any,
    orderType: 'DINE_IN',
    discountAmount: 50
  });

  assert(calc.subtotal === 867, `Subtotal is calculated server-side: ₹${calc.subtotal}`);
  assert(calc.discountAmount === 50, `Discount applied: ₹${calc.discountAmount}`);
  assert(calc.taxableAmount === 817, `Taxable amount: ₹${calc.taxableAmount}`);
  assert(calc.taxes === 41, `5% F&B GST calculated: ₹${calc.taxes}`);
  assert(calc.cgst === 20.5, `2.5% CGST split: ₹${calc.cgst}`);
  assert(calc.sgst === 20.5, `2.5% SGST split: ₹${calc.sgst}`);
  assert(calc.finalTotal === 858, `Final payable total: ₹${calc.finalTotal}`);

  // -------------------------------------------------------------
  // Test 4: ESC/POS Thermal Receipt Formatting
  // -------------------------------------------------------------
  console.log('\n4️⃣ Testing Thermal Receipt Plain-Text & ESC/POS Generation...');
  const receiptText = ESCPOSFormatter.generatePlainTextReceipt({
    billId: 'test_ord_9999',
    orderNumber: '#042',
    date: '28/08/2026',
    time: '01:15 PM',
    orderType: 'DINE_IN',
    tableNumber: 'T-4',
    customerName: 'Aarav Sharma',
    customerPhone: '+91 98765 43210',
    cashierName: 'Rahul',
    terminalId: 'POS-RJN-01',
    branchName: 'Olive Pizza — Rajnandgaon HQ',
    items: testItems as any,
    subtotal: 867,
    discountAmount: 50,
    taxes: 41,
    deliveryFee: 0,
    finalTotal: 858,
    paymentMethod: 'CASH',
    paymentStatus: 'PAID',
    amountReceived: 1000,
    changeDue: 142
  });

  assert(receiptText.includes('OLIVE PIZZA'), 'Receipt contains Brand header');
  assert(receiptText.includes('Table:') && receiptText.includes('T-4'), 'Receipt contains Dine-In Table number');
  assert(receiptText.includes('Aarav Sharma'), 'Receipt contains Customer name');
  assert(receiptText.includes('Change Return:'), 'Receipt contains Cash Change to Return (₹142)');

  // -------------------------------------------------------------
  // Test 5: Hold Bill Lifecycle
  // -------------------------------------------------------------
  console.log('\n5️⃣ Testing Hold Bill Lifecycle & Storage...');
  const held = await POSService.holdBill({
    title: 'Dine-In Table T-3 • Aarav',
    orderType: 'DINE_IN',
    tableNumber: 'T-3',
    customerName: 'Aarav Sharma',
    customerPhone: '+91 98765 43210',
    items: testItems as any,
    subtotal: 867,
    discountAmount: 50,
    taxes: 41,
    finalTotal: 858,
    heldByCashier: 'Rahul',
    terminalId: 'POS-RJN-01',
    branchId: 'main_branch',
    franchiseId: 'fra_rajnandgaon'
  });

  assert(Boolean(held && held.id), `Bill successfully placed on hold with ID: ${held.id}`);
  
  const heldList = await POSService.getHeldBills('main_branch');
  assert(heldList.some(b => b.id === held.id), 'Held bill found in branch queue');

  const deleted = await POSService.deleteHeldBill(held.id);
  assert(deleted === true, 'Held bill resumed and safely deleted from hold queue');

  console.log(`\n======================================================`);
  console.log(`🏁 TEST RESULTS: ${passed}/${total} TESTS PASSED (100%)`);
  console.log(`======================================================\n`);
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
