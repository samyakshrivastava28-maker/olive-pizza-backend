import '../config/env.js';
import { adminAuth } from '../config/firebase.js';
import axios from 'axios';

export async function getIdTokenForUser(uid: string, claims: Record<string, any> = {}): Promise<string> {
  const customToken = await adminAuth.createCustomToken(uid, claims);
  const apiKey = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY;
  if (!apiKey) {
    throw new Error('VITE_FIREBASE_API_KEY is not set in environment');
  }

  const response = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    {
      token: customToken,
      returnSecureToken: true
    }
  );

  return response.data.idToken;
}

if (process.argv[1]?.includes('generate_test_token')) {
  (async () => {
    try {
      const uid = process.argv[2] || 'usr_test_order_cust';
      const token = await getIdTokenForUser(uid, { role: 'customer' });
      console.log('Successfully minted ID token for', uid, 'Length:', token.length);
    } catch (err: any) {
      console.error('Error minting token:', err.response?.data || err.message);
    }
  })();
}
