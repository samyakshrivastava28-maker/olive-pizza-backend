import { adminDb } from '../config/firebase.js';

export interface IOrderRepository {
  findById(id: string): Promise<any | null>;
  create(id: string, data: any): Promise<void>;
  update(id: string, data: any): Promise<void>;
  findByBranch(branchId: string, limitCount?: number): Promise<any[]>;
  findByUser(userId: string, limitCount?: number): Promise<any[]>;
  findActiveByUserId(userId: string): Promise<any | null>;
}

export class FirestoreOrderRepository implements IOrderRepository {
  private collection = adminDb.collection('orders');

  async findById(id: string): Promise<any | null> {
    const doc = await this.collection.doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }

  async create(id: string, data: any): Promise<void> {
    await this.collection.doc(id).set(data);
  }

  async update(id: string, data: any): Promise<void> {
    await this.collection.doc(id).update(data);
  }

  async findByBranch(branchId: string, limitCount: number = 50): Promise<any[]> {
    let q: any = this.collection;
    if (branchId !== 'all') {
      q = q.where('branchId', '==', branchId);
    }
    const snap = await q.orderBy('createdAt', 'desc').limit(limitCount).get().catch(async () => {
      let fallbackQ: any = this.collection;
      if (branchId !== 'all') {
        fallbackQ = fallbackQ.where('branchId', '==', branchId);
      }
      return await fallbackQ.limit(limitCount).get();
    });
    return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  }

  async findByUser(userId: string, limitCount: number = 50): Promise<any[]> {
    const snap = await this.collection
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limitCount)
      .get()
      .catch(async () => {
        return await this.collection.where('userId', '==', userId).limit(limitCount).get();
      });
    return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
  }

  async findActiveByUserId(userId: string): Promise<any | null> {
    const snap = await this.collection.where('userId', '==', userId).get();
    const activeDoc = snap.docs.find((d: any) => {
      const data = d.data();
      const status = (data.status || '').toLowerCase();
      return !['delivered', 'cancelled', 'rejected', 'failed'].includes(status);
    });
    if (!activeDoc) return null;
    return { id: activeDoc.id, ...activeDoc.data() };
  }
}

export const orderRepository: IOrderRepository = new FirestoreOrderRepository();
