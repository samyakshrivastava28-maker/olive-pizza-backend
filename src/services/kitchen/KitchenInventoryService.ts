import { adminDb as db } from '../../config/firebase.js';
import { notificationEngine } from '../notification/NotificationEngine.js';

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
export type InventoryCategory = 'raw_material' | 'packaging' | 'supplies' | 'beverage' | 'other';
export type StockUnit = 'kg' | 'g' | 'litre' | 'ml' | 'pieces' | 'packets' | 'boxes';

export interface InventoryItem {
  id?: string;
  name: string;
  category: InventoryCategory | string;
  unit: StockUnit | string;
  availableQuantity: number;
  minimumQuantity: number;
  description?: string;
  status: StockStatus;
  lastAlertStatus?: string | null;
  isArchived: boolean;
  organizationId?: string;
  franchiseId: string;
  branchId: string;
  createdBy: string;
  createdAt: any;
  updatedAt: any;
  lastUpdatedBy: string;
}

export interface StockHistoryRecord {
  id?: string;
  itemId: string;
  itemName: string;
  previousQuantity: number;
  newQuantity: number;
  change: number;
  changeType: 'add' | 'remove' | 'set' | 'edit';
  reason?: string;
  changedBy: string;
  changedByName?: string;
  timestamp: any;
  branchId: string;
  franchiseId: string;
}

export class KitchenInventoryService {
  /**
   * Authoritative calculation of stock status
   */
  public static calculateStatus(available: number, minimum: number): StockStatus {
    const avail = Number(available) || 0;
    const min = Number(minimum) || 0;

    if (avail <= 0) return 'OUT_OF_STOCK';
    if (avail <= min) return 'LOW_STOCK';
    return 'IN_STOCK';
  }

  /**
   * List active inventory items for a branch
   */
  public static async listItems(branchId: string, filter?: { category?: string; status?: string }): Promise<InventoryItem[]> {
    const branch = branchId || 'main_branch';
    const snapshot = await db.collection('branches').doc(branch).collection('inventory')
      .where('isArchived', '==', false)
      .get();

    let items: InventoryItem[] = [];
    snapshot.forEach((doc) => {
      items.push({ id: doc.id, ...doc.data() } as InventoryItem);
    });

    if (filter?.category && filter.category !== 'all') {
      items = items.filter(i => i.category === filter.category);
    }

    if (filter?.status && filter.status !== 'all') {
      items = items.filter(i => i.status === filter.status);
    }

    return items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  /**
   * Create a new inventory item
   */
  public static async createItem(
    data: {
      name: string;
      category: string;
      unit: string;
      availableQuantity: number;
      minimumQuantity: number;
      description?: string;
      franchiseId?: string;
      branchId?: string;
    },
    userId: string,
    userName?: string
  ): Promise<InventoryItem> {
    const branch = data.branchId || 'main_branch';
    const franchise = data.franchiseId || 'default_franchise';
    const available = Number(data.availableQuantity) || 0;
    const minimum = Number(data.minimumQuantity) || 0;
    const status = this.calculateStatus(available, minimum);

    const itemData: Omit<InventoryItem, 'id'> = {
      name: data.name.trim(),
      category: data.category,
      unit: data.unit,
      availableQuantity: available,
      minimumQuantity: minimum,
      description: data.description || '',
      status,
      lastAlertStatus: status === 'IN_STOCK' ? null : status,
      isArchived: false,
      franchiseId: franchise,
      branchId: branch,
      createdBy: userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: userId,
    };

    const docRef = await db.collection('branches').doc(branch).collection('inventory').add(itemData);
    const createdItem: InventoryItem = { id: docRef.id, ...itemData };

    // Record initial history
    await this.recordHistory({
      itemId: docRef.id,
      itemName: createdItem.name,
      previousQuantity: 0,
      newQuantity: available,
      change: available,
      changeType: 'set',
      reason: 'Initial item creation',
      changedBy: userId,
      changedByName: userName || 'Staff',
      timestamp: new Date().toISOString(),
      branchId: branch,
      franchiseId: franchise,
    });

    // Check alert on creation if created in low/out-of-stock state
    if (status !== 'IN_STOCK') {
      await this.triggerAlertIfNeeded(createdItem, status);
    }

    return createdItem;
  }

  /**
   * Adjust stock quantity (+ or -)
   */
  public static async adjustStock(
    itemId: string,
    delta: number,
    changeType: 'add' | 'remove' | 'set',
    reason: string,
    userId: string,
    userName?: string,
    branchId?: string,
    franchiseId?: string
  ): Promise<InventoryItem> {
    const branch = branchId || 'main_branch';
    const itemRef = db.collection('branches').doc(branch).collection('inventory').doc(itemId);
    const docSnap = await itemRef.get();

    if (!docSnap.exists) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    const current = docSnap.data() as InventoryItem;
    const prevQty = Number(current.availableQuantity) || 0;
    let newQty: number;

    if (changeType === 'set') {
      newQty = Math.max(0, Number(delta));
    } else if (changeType === 'add') {
      newQty = prevQty + Math.abs(Number(delta));
    } else {
      newQty = Math.max(0, prevQty - Math.abs(Number(delta)));
    }

    const actualDelta = newQty - prevQty;
    const newStatus = this.calculateStatus(newQty, current.minimumQuantity);

    const updatePayload: Partial<InventoryItem> = {
      availableQuantity: newQty,
      status: newStatus,
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: userId,
    };

    await itemRef.update(updatePayload);

    const updatedItem: InventoryItem = {
      ...current,
      ...updatePayload,
      id: itemId,
    };

    // Record stock history audit
    await this.recordHistory({
      itemId,
      itemName: current.name,
      previousQuantity: prevQty,
      newQuantity: newQty,
      change: actualDelta,
      changeType: changeType === 'set' ? 'set' : (actualDelta >= 0 ? 'add' : 'remove'),
      reason: reason || `Manual adjustment by ${userName || 'Staff'}`,
      changedBy: userId,
      changedByName: userName || 'Staff',
      timestamp: new Date().toISOString(),
      branchId: branch,
      franchiseId: franchiseId || current.franchiseId || 'default_franchise',
    });

    // Check if status changed and alert needed
    await this.triggerAlertIfNeeded(updatedItem, newStatus, current.lastAlertStatus || undefined);

    return updatedItem;
  }

  /**
   * Update item details (name, min quantity, category, etc.)
   */
  public static async updateItem(
    itemId: string,
    updates: Partial<InventoryItem>,
    userId: string,
    userName?: string,
    branchId?: string
  ): Promise<InventoryItem> {
    const branch = branchId || 'main_branch';
    const itemRef = db.collection('branches').doc(branch).collection('inventory').doc(itemId);
    const docSnap = await itemRef.get();

    if (!docSnap.exists) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    const current = docSnap.data() as InventoryItem;
    const newAvail = updates.availableQuantity !== undefined ? Number(updates.availableQuantity) : current.availableQuantity;
    const newMin = updates.minimumQuantity !== undefined ? Number(updates.minimumQuantity) : current.minimumQuantity;
    const newStatus = this.calculateStatus(newAvail, newMin);

    const payload: any = {
      ...updates,
      availableQuantity: newAvail,
      minimumQuantity: newMin,
      status: newStatus,
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: userId,
    };

    delete payload.id;
    await itemRef.update(payload);

    const updated: InventoryItem = { ...current, ...payload, id: itemId };

    if (updates.availableQuantity !== undefined && updates.availableQuantity !== current.availableQuantity) {
      await this.recordHistory({
        itemId,
        itemName: updated.name,
        previousQuantity: current.availableQuantity,
        newQuantity: newAvail,
        change: newAvail - current.availableQuantity,
        changeType: 'edit',
        reason: 'Item update edit',
        changedBy: userId,
        changedByName: userName || 'Staff',
        timestamp: new Date().toISOString(),
        branchId: branch,
        franchiseId: current.franchiseId,
      });
    }

    await this.triggerAlertIfNeeded(updated, newStatus, current.lastAlertStatus || undefined);

    return updated;
  }

  /**
   * Archive / Soft delete an item
   */
  public static async archiveItem(itemId: string, userId: string, branchId?: string): Promise<boolean> {
    const branch = branchId || 'main_branch';
    const itemRef = db.collection('branches').doc(branch).collection('inventory').doc(itemId);
    await itemRef.update({
      isArchived: true,
      updatedAt: new Date().toISOString(),
      lastUpdatedBy: userId,
    });
    return true;
  }

  /**
   * Retrieve stock history log
   */
  public static async getHistory(branchId: string, limitCount = 50): Promise<StockHistoryRecord[]> {
    const branch = branchId || 'main_branch';
    const snapshot = await db.collection('branches').doc(branch).collection('inventory_history')
      .orderBy('timestamp', 'desc')
      .limit(limitCount)
      .get();

    const history: StockHistoryRecord[] = [];
    snapshot.forEach((doc) => {
      history.push({ id: doc.id, ...doc.data() } as StockHistoryRecord);
    });

    return history;
  }

  /**
   * Record history entry in Firestore
   */
  private static async recordHistory(record: StockHistoryRecord): Promise<void> {
    try {
      await db.collection('branches').doc(record.branchId).collection('inventory_history').add(record);
    } catch (err) {
      console.warn('[KitchenInventoryService] Failed to record stock history:', err);
    }
  }

  /**
   * Deduplicated low-stock / out-of-stock alert trigger
   */
  private static async triggerAlertIfNeeded(
    item: InventoryItem,
    newStatus: StockStatus,
    previousAlertStatus?: string
  ): Promise<void> {
    // If status is IN_STOCK, clear alert status and return
    if (newStatus === 'IN_STOCK') {
      if (previousAlertStatus) {
        await db.collection('branches').doc(item.branchId).collection('inventory').doc(item.id!).update({
          lastAlertStatus: null,
        });
      }
      return;
    }

    // Deduplication check: do not re-send if alert for this status was already sent
    if (previousAlertStatus === newStatus) {
      return;
    }

    // Update lastAlertStatus on item doc to prevent spam
    await db.collection('branches').doc(item.branchId).collection('inventory').doc(item.id!).update({
      lastAlertStatus: newStatus,
    });

    try {
      let title: string;
      let body: string;

      if (newStatus === 'OUT_OF_STOCK') {
        title = `Out of Stock: ${item.name}`;
        body = `${item.name} is currently OUT OF STOCK at ${item.branchId}. Available: 0 ${item.unit}. Immediate replenishment required.`;
      } else {
        title = `Low Stock Alert: ${item.name}`;
        body = `${item.name} is running low. Available: ${item.availableQuantity} ${item.unit} (Minimum: ${item.minimumQuantity} ${item.unit}).`;
      }

      const ownerUids = await notificationEngine.resolveByRole('owner');
      if (ownerUids.length > 0) {
        await notificationEngine.sendBulk(
          ownerUids,
          {
            notification: {
              title,
              body,
            },
            data: {
              category: 'alert',
              tag: `inventory_${item.id}_${newStatus}`,
              url: '/kitchen',
              role: 'owner',
              priority: newStatus === 'OUT_OF_STOCK' ? 'critical' : 'high',
              sound: newStatus === 'OUT_OF_STOCK' ? 'system_alert' : 'soft_pop',
            },
          },
          {
            category: 'simple_informational',
            priority: newStatus === 'OUT_OF_STOCK' ? 'critical' : 'high',
            tag: `inventory_${item.id}_${newStatus}`,
          }
        );
      }

      console.log(`[KitchenInventoryService] Triggered ${newStatus} alert for ${item.name} at branch ${item.branchId}`);
    } catch (err) {
      console.warn('[KitchenInventoryService] Failed to dispatch stock notification:', err);
    }
  }
}