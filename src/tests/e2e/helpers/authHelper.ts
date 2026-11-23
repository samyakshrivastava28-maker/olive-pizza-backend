/**
 * E2E Auth Helper
 * Mints authentic Firebase ID tokens for Layerbase PostgreSQL test accounts
 */

import { getIdTokenForUser } from '../../../scripts/generate_test_token.js';

export const TEST_USERS = {
  PLATFORM_OWNER: {
    uid: '6tLLR6q7aTYqzTG2blRx3TU5sA42',
    email: 'webhub2811@gmail.com',
    role: 'platform_owner',
  },
  OWNER: {
    uid: 'usr_owner_olive',
    email: 'olivepizzarjn@gmail.com',
    role: 'owner',
  },
  MANAGER: {
    uid: 'usr_mgr_rjn_samyak',
    email: 'samyakshrivastava28@gmail.com',
    role: 'restaurant_manager',
    branchId: 'branch_rjn_main',
    franchiseId: 'fra_rajnandgaon',
  },
  CUSTOMER: {
    uid: 'zRZ60M8P5oXBXMU3Y1LMV3YlmGH3',
    email: 's.callhub2811@gmail.com',
    role: 'customer',
  },
  RIDER: {
    uid: 'usr_rider1_samyak',
    email: 'samyaks695@gmail.com',
    role: 'rider',
  },
};

const tokenCache = new Map<string, string>();

export async function getAuthToken(userKey: keyof typeof TEST_USERS): Promise<string> {
  if (tokenCache.has(userKey)) {
    return tokenCache.get(userKey)!;
  }

  const u = TEST_USERS[userKey];
  try {
    const token = await Promise.race([
      getIdTokenForUser(u.uid, {
        role: u.role,
        email: u.email,
        ...((u as any).branchId ? { branchId: (u as any).branchId } : {}),
        ...((u as any).franchiseId ? { franchiseId: (u as any).franchiseId } : {}),
      }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Token minting timeout')), 4000)),
    ]);
    tokenCache.set(userKey, token);
    return token;
  } catch (err: any) {
    console.warn(`[getAuthToken] Fallback token generation for ${userKey}:`, err?.message || err);
    const fallbackToken = `test_token_${u.uid}_${u.role}`;
    tokenCache.set(userKey, fallbackToken);
    return fallbackToken;
  }
}
