import { adminDb as db } from '../../config/firebase.js';
import { ABTest } from '../../types/websiteConfig.types.js';

export class ABTestingService {
  static async listTests(): Promise<ABTest[]> {
    try {
      const snap = await db.collection('ab_tests').orderBy('startAt', 'desc').get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() } as ABTest));
    } catch (e) {
      return [];
    }
  }

  static async saveTest(test: Partial<ABTest>): Promise<ABTest> {
    const id = test.id || `test_${Date.now()}`;
    const docRef = db.collection('ab_tests').doc(id);
    const data = {
      ...test,
      id,
      status: test.status || 'draft',
      traffic: test.traffic ?? 50,
      startAt: test.startAt || new Date().toISOString(),
    };
    await docRef.set(data);
    return data as ABTest;
  }

  static async applyWinner(testId: string, winner: 'A' | 'B', userId: string): Promise<boolean> {
    const testDoc = await db.collection('ab_tests').doc(testId).get();
    if (!testDoc.exists) throw new Error('A/B Test not found');

    const test = testDoc.data() as ABTest;
    const winningConfig = winner === 'A' ? test.variants.A.sectionConfig : test.variants.B.sectionConfig;

    // Update test status
    await db.collection('ab_tests').doc(testId).update({
      status: 'completed',
      winner,
      completedAt: new Date().toISOString(),
      completedBy: userId,
    });

    return true;
  }
}
