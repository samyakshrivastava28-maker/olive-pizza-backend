import { adminDb } from '../../config/firebase.js';

export interface LoyaltyTransaction {
  id: string;
  userId: string;
  type: 'earned' | 'redeemed' | 'bonus' | 'refund';
  points: number;
  orderId?: string;
  description: string;
  createdAt: string;
}

export interface LoyaltySummary {
  balance: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  tierProgress: number;
  nextTier: string | null;
  pointsToNextTier: number;
  pointValueInRupees: number;
  transactions: LoyaltyTransaction[];
}

export class LoyaltyService {
  /**
   * Retrieves complete server-authoritative loyalty summary for a customer.
   */
  public static async getLoyaltySummary(userId: string): Promise<LoyaltySummary> {
    if (!userId) {
      throw new Error('User ID is required');
    }

    const userDoc = await adminDb.collection('users').doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    let balance = Number(userData?.loyaltyPoints || 0);

    const ledgerSnap = await adminDb.collection('loyalty_transactions')
      .where('userId', '==', userId)
      .limit(50)
      .get()
      .catch(() => ({ docs: [] } as any));

    const transactions: LoyaltyTransaction[] = ledgerSnap.docs.map((d: any) => ({
      id: d.id,
      ...d.data(),
    })).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    let lifetimeEarned = 0;
    let lifetimeRedeemed = 0;

    transactions.forEach((tx) => {
      if (tx.points > 0) {
        lifetimeEarned += tx.points;
      } else {
        lifetimeRedeemed += Math.abs(tx.points);
      }
    });

    if (transactions.length === 0 && balance === 0) {
      const ordersSnap = await adminDb.collection('orders')
        .where('userId', '==', userId)
        .where('status', '==', 'delivered')
        .limit(20)
        .get()
        .catch(() => ({ docs: [] } as any));

      if (!ordersSnap.empty) {
        let earnedFromOrders = 0;
        const batch = adminDb.batch();

        for (const oDoc of ordersSnap.docs) {
          const oData = oDoc.data();
          const total = Number(oData.totalAmount || 0);
          const pts = Math.max(1, Math.floor(total * 0.1));
          earnedFromOrders += pts;

          const txRef = adminDb.collection('loyalty_transactions').doc();
          const newTx: LoyaltyTransaction = {
            id: txRef.id,
            userId,
            type: 'earned',
            points: pts,
            orderId: oDoc.id,
            description: `Points earned from Order #${oData.dailyOrderNumber || oDoc.id.slice(-6).toUpperCase()}`,
            createdAt: oData.deliveredAt || oData.createdAt || new Date().toISOString(),
          };
          batch.set(txRef, newTx);
          transactions.push(newTx);
        }

        balance = earnedFromOrders;
        lifetimeEarned = earnedFromOrders;
        batch.set(adminDb.collection('users').doc(userId), { loyaltyPoints: balance }, { merge: true });
        await batch.commit().catch(() => {});
        transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }
    }

    if (lifetimeEarned < balance) {
      lifetimeEarned = balance;
    }

    let tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum' = 'Bronze';
    let nextTier: string | null = 'Silver';
    let pointsToNextTier = 200 - balance;
    let tierProgress = Math.min(100, Math.max(0, Math.round((balance / 200) * 100)));

    if (balance >= 1000) {
      tier = 'Platinum';
      nextTier = null;
      pointsToNextTier = 0;
      tierProgress = 100;
    } else if (balance >= 500) {
      tier = 'Gold';
      nextTier = 'Platinum';
      pointsToNextTier = 1000 - balance;
      tierProgress = Math.min(100, Math.round(((balance - 500) / 500) * 100));
    } else if (balance >= 200) {
      tier = 'Silver';
      nextTier = 'Gold';
      pointsToNextTier = 500 - balance;
      tierProgress = Math.min(100, Math.round(((balance - 200) / 300) * 100));
    }

    return {
      balance,
      lifetimeEarned,
      lifetimeRedeemed,
      tier,
      tierProgress,
      nextTier,
      pointsToNextTier: Math.max(0, pointsToNextTier),
      pointValueInRupees: 1,
      transactions,
    };
  }

  /**
   * Awards points when an order transitions to delivered.
   */
  public static async awardPointsForOrder(orderId: string, userId: string, totalAmount: number): Promise<number> {
    if (!userId || !orderId || totalAmount <= 0) return 0;

    const pointsToAward = Math.max(1, Math.floor(totalAmount * 0.1));
    const userRef = adminDb.collection('users').doc(userId);
    const txRef = adminDb.collection('loyalty_transactions').doc();

    await adminDb.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const current = userSnap.exists ? Number(userSnap.data()?.loyaltyPoints || 0) : 0;
      const updatedBalance = current + pointsToAward;

      t.set(userRef, { loyaltyPoints: updatedBalance }, { merge: true });

      const txRecord: LoyaltyTransaction = {
        id: txRef.id,
        userId,
        type: 'earned',
        points: pointsToAward,
        orderId,
        description: `Delivered order reward (+${pointsToAward} pts)`,
        createdAt: new Date().toISOString(),
      };
      t.set(txRef, txRecord);
    });

    console.log(`[LoyaltyService] Awarded ${pointsToAward} points to ${userId} for order ${orderId}`);
    return pointsToAward;
  }

  /**
   * Redeems loyalty points for an order discount.
   */
  public static async redeemPoints(userId: string, pointsToRedeem: number, orderId?: string): Promise<{ success: boolean; newBalance?: number; error?: string }> {
    if (!userId || pointsToRedeem <= 0) {
      return { success: false, error: 'Invalid redemption parameters' };
    }

    const userRef = adminDb.collection('users').doc(userId);
    const txRef = adminDb.collection('loyalty_transactions').doc();

    try {
      let finalBalance = 0;
      await adminDb.runTransaction(async (t) => {
        const userSnap = await t.get(userRef);
        const current = userSnap.exists ? Number(userSnap.data()?.loyaltyPoints || 0) : 0;

        if (current < pointsToRedeem) {
          throw new Error(`Insufficient points balance (${current} available, ${pointsToRedeem} requested)`);
        }

        finalBalance = current - pointsToRedeem;
        t.set(userRef, { loyaltyPoints: finalBalance }, { merge: true });

        const txRecord: LoyaltyTransaction = {
          id: txRef.id,
          userId,
          type: 'redeemed',
          points: -pointsToRedeem,
          orderId,
          description: `Redeemed for order discount (-${pointsToRedeem} pts)`,
          createdAt: new Date().toISOString(),
        };
        t.set(txRef, txRecord);
      });

      return { success: true, newBalance: finalBalance };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
