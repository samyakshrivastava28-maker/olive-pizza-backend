import { adminDb } from '../config/firebase.js';

const dummyMenu = [
  {
    name: "Margherita Classico",
    description: "Classic delight with 100% real mozzarella cheese and our signature tomato sauce.",
    category: "pizza",
    basePrice: 199,
    image: "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=800&q=80",
    isVegetarian: true,
    isAvailable: true,
  },
  {
    name: "Farmhouse Supreme",
    description: "A pizza that goes ballistic on veggies! Crisp capsicum, succulent mushrooms, fresh tomatoes and crunchy onions.",
    category: "pizza",
    basePrice: 399,
    image: "https://images.unsplash.com/photo-1590947132387-155cc02f3212?auto=format&fit=crop&w=800&q=80",
    isVegetarian: true,
    isAvailable: true,
  },
  {
    name: "Chicken Pepperoni",
    description: "Premium chicken pepperoni layered over our rich tomato sauce and mozzarella.",
    category: "pizza",
    basePrice: 499,
    image: "https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&w=800&q=80",
    isVegetarian: false,
    isAvailable: true,
  },
  {
    name: "Spicy Paneer Tikka",
    description: "Spicy paneer tikka chunks with red paprika and mint mayo drizzle.",
    category: "pizza",
    basePrice: 349,
    image: "https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=800&q=80",
    isVegetarian: true,
    isAvailable: true,
  }
];

async function seed() {
  console.log('Seeding menu items...');
  const batch = adminDb.batch();
  
  dummyMenu.forEach(item => {
    const docRef = adminDb.collection('menu').doc();
    batch.set(docRef, {
      ...item,
      createdAt: new Date().toISOString()
    });
  });

  await batch.commit();
  console.log('Successfully seeded menu items!');
  process.exit(0);
}

seed().catch(console.error);
