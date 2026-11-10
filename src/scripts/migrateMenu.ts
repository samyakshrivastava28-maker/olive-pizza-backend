import { adminDb } from '../config/firebase.js';

export async function runMigration() {
  console.log('Starting migration from menu to products...');
  try {
    const menuSnapshot = await adminDb.collection('menu').get();
    console.log(`Found ${menuSnapshot.size} menu items.`);

    const batch = adminDb.batch();
    
    menuSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const newRef = adminDb.collection('products').doc(doc.id);
      
      // Ensure we map to the new schema correctly, though they are quite similar
      batch.set(newRef, {
        productId: doc.id,
        productName: data.name,
        imageUrl: data.image || data.imageUrl,
        cloudinaryPublicId: null, // Will be filled on new uploads
        description: data.description,
        category: data.category,
        basePrice: data.basePrice,
        isVegetarian: data.isVegetarian !== undefined ? data.isVegetarian : true,
        isActive: data.isAvailable !== undefined ? data.isAvailable : true, // Map isAvailable to isActive for products/ads standard
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    await batch.commit();
    console.log('Successfully migrated menu items to products collection!');
  } catch (error) {
    console.error('Migration failed:', error);
  }
}

// Allow running directly
if (process.argv[1] && process.argv[1].endsWith('migrateMenu.ts')) {
  runMigration().then(() => process.exit(0));
}
