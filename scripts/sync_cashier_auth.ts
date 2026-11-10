import '../src/config/validator.js';
import { adminAuth } from '../src/config/firebase.js';

async function main() {
  const email = 'cashier@olivepizza.in';
  const password = 'Cashier@1234';
  try {
    let user;
    try {
      user = await adminAuth.getUserByEmail(email);
      console.log('Existing Firebase user found:', user.uid);
      await adminAuth.updateUser(user.uid, { password });
      console.log('Updated password for:', email);
    } catch (e: any) {
      if (e.code === 'auth/user-not-found') {
        user = await adminAuth.createUser({
          email,
          password,
          displayName: 'Rajnandgaon Cashier',
          emailVerified: true
        });
        console.log('Created Firebase user:', user.uid);
      } else {
        throw e;
      }
    }
  } catch (err: any) {
    console.error('Error syncing auth account:', err.message);
  } finally {
    process.exit(0);
  }
}

main();
