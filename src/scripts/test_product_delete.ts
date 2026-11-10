import { adminDb as db } from '../config/firebase.js';

async function testProductLifecycle() {
  console.log('🍕 Testing Product Creation and Deletion via Admin Service...\n');

  const testProdId = `test_prod_${Date.now()}`;
  const testProduct = {
    id: testProdId,
    name: 'Temporary Test Pepperoni Pizza',
    productName: 'Temporary Test Pepperoni Pizza',
    description: 'Test pizza for deletion verification',
    category: 'Pizzas',
    price: 399,
    basePrice: 399,
    isVegetarian: false,
    isActive: true,
    isAvailable: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // 1. Create product in Firestore
  await db.collection('products').doc(testProdId).set(testProduct);
  console.log(`  ✅ Created test product with ID: ${testProdId}`);

  // 2. Also simulate a branch menu override
  const overrideKey = `main_branch_${testProdId}`;
  await db.collection('branch_menu_overrides').doc(overrideKey).set({
    branchId: 'main_branch',
    productId: testProdId,
    stockStatus: 'IN_STOCK',
    isEnabledForBranch: true
  });
  console.log(`  ✅ Created associated branch menu override: ${overrideKey}`);

  // 3. Verify existence
  let prodDoc = await db.collection('products').doc(testProdId).get();
  if (!prodDoc.exists) throw new Error('Product was not created!');

  // 4. Delete product and overrides (Simulating backend DELETE /api/menu/master-products/:id)
  await db.collection('products').doc(testProdId).delete();
  const overridesSnap = await db.collection('branch_menu_overrides')
    .where('productId', '==', testProdId)
    .get();
  
  const batch = db.batch();
  overridesSnap.docs.forEach(doc => batch.delete(doc.ref));
  if (!overridesSnap.empty) {
    await batch.commit();
  }

  // 5. Verify deletion
  prodDoc = await db.collection('products').doc(testProdId).get();
  const overrideDoc = await db.collection('branch_menu_overrides').doc(overrideKey).get();

  if (!prodDoc.exists && !overrideDoc.exists) {
    console.log(`  ✅ Product ${testProdId} and its branch overrides were deleted successfully!`);
    console.log('\n🎉 Product Deletion Test PASSED (100%)\n');
  } else {
    throw new Error('Product or override still exists after deletion!');
  }
}

testProductLifecycle().then(() => process.exit(0)).catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
