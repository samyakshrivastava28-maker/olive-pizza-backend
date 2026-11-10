import { adminDb } from '../../config/firebase.js';
import { FranchiseScopeService } from '../franchise/FranchiseScopeService.js';

export interface InventoryItem {
  id?: string;
  name: string;
  category: 'dairy' | 'flour_dough' | 'sauces_seasonings' | 'toppings_produce' | 'packaging' | 'beverages_mix' | 'other';
  unit: 'kg' | 'g' | 'L' | 'ml' | 'pcs' | 'boxes';
  currentQuantity: number;
  minThreshold: number;
  costPerUnit?: number;
  supplierName?: string;
  supplierPhone?: string;
  notes?: string;
  isActive: boolean;
  branchId: string;
  franchiseId: string;
  organizationId: string;
  lastUpdatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface StockAdjustment {
  id?: string;
  itemId: string;
  itemName: string;
  branchId: string;
  franchiseId: string;
  adjustmentType: 'RESTOCK' | 'USAGE' | 'WASTAGE' | 'AUDIT_CORRECTION';
  quantityChanged: number;
  previousQuantity: number;
  newQuantity: number;
  reason?: string;
  performedBy: string;
  timestamp: string;
}

export class InventoryService {
  static async listItems(branchId: string): Promise<InventoryItem[]> {
    try {
      const snap = await adminDb
        .collection('inventory_items')
        .where('branchId', '==', branchId)
        .where('isActive', '==', true)
        .get();

      if (snap.empty) {
        return await this.seedDefaultInventory(branchId);
      }

      return snap.docs.map((doc: any) => ({
        id: doc.id,
        ...doc.data(),
      })) as InventoryItem[];
    } catch (err: any) {
      console.error('[InventoryService] Error listing items:', err.message);
      return [];
    }
  }

  static async createItem(item: InventoryItem, actorUid: string): Promise<InventoryItem> {
    const now = new Date().toISOString();
    const payload: InventoryItem = {
      ...item,
      currentQuantity: Number(item.currentQuantity) || 0,
      minThreshold: Number(item.minThreshold) || 10,
      isActive: item.isActive !== false,
      branchId: item.branchId || FranchiseScopeService.DEFAULT_BRANCH_ID,
      franchiseId: item.franchiseId || FranchiseScopeService.DEFAULT_FRANCHISE_ID,
      organizationId: item.organizationId || FranchiseScopeService.DEFAULT_ORG_ID,
      lastUpdatedBy: actorUid,
      createdAt: now,
      updatedAt: now,
    };

    const ref = await adminDb.collection('inventory_items').add(payload);
    payload.id = ref.id;

    if (payload.currentQuantity <= payload.minThreshold) {
      await this.triggerLowStockAlert(payload);
    }

    return payload;
  }

  static async adjustStock(params: {
    itemId: string;
    branchId: string;
    franchiseId?: string;
    adjustmentType: 'RESTOCK' | 'USAGE' | 'WASTAGE' | 'AUDIT_CORRECTION';
    quantityChanged: number;
    reason?: string;
    performedBy: string;
  }): Promise<{ success: boolean; item?: InventoryItem; isLowStock: boolean }> {
    const itemRef = adminDb.collection('inventory_items').doc(params.itemId);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      throw new Error(`Inventory item ${params.itemId} not found`);
    }

    const currentData = itemDoc.data() as InventoryItem;
    if (currentData.branchId !== params.branchId) {
      throw new Error('Branch scope mismatch');
    }

    const previousQty = Number(currentData.currentQuantity || 0);
    const newQty = Math.max(0, Number((previousQty + params.quantityChanged).toFixed(2)));
    const now = new Date().toISOString();

    await itemRef.update({
      currentQuantity: newQty,
      lastUpdatedBy: params.performedBy,
      updatedAt: now,
    });

    const adjustmentLog: StockAdjustment = {
      itemId: params.itemId,
      itemName: currentData.name,
      branchId: params.branchId,
      franchiseId: currentData.franchiseId || params.franchiseId || FranchiseScopeService.DEFAULT_FRANCHISE_ID,
      adjustmentType: params.adjustmentType,
      quantityChanged: params.quantityChanged,
      previousQuantity: previousQty,
      newQuantity: newQty,
      reason: params.reason || '',
      performedBy: params.performedBy,
      timestamp: now,
    };

    await adminDb.collection('inventory_adjustments').add(adjustmentLog);

    const updatedItem: InventoryItem = {
      ...currentData,
      id: itemDoc.id,
      currentQuantity: newQty,
      updatedAt: now,
    };

    const isLowStock = newQty <= updatedItem.minThreshold;
    if (isLowStock) {
      await this.triggerLowStockAlert(updatedItem);
    }

    return {
      success: true,
      item: updatedItem,
      isLowStock,
    };
  }

  static async getLowStockAlerts(filters: { branchId?: string; franchiseId?: string }): Promise<any[]> {
    try {
      let query: any = adminDb.collection('inventory_alerts').orderBy('timestamp', 'desc').limit(50);
      if (filters.branchId && filters.branchId !== 'all') {
        query = query.where('branchId', '==', filters.branchId);
      } else if (filters.franchiseId && filters.franchiseId !== 'all') {
        query = query.where('franchiseId', '==', filters.franchiseId);
      }

      const snap = await query.get();
      return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    } catch (err: any) {
      console.warn('[InventoryService] Warning fetching alerts:', err.message);
      return [];
    }
  }

  private static async triggerLowStockAlert(item: InventoryItem): Promise<void> {
    try {
      const now = new Date().toISOString();
      const alertPayload = {
        itemId: item.id,
        itemName: item.name,
        category: item.category,
        unit: item.unit,
        currentQuantity: item.currentQuantity,
        minThreshold: item.minThreshold,
        branchId: item.branchId,
        franchiseId: item.franchiseId,
        organizationId: item.organizationId,
        status: 'UNRESOLVED',
        timestamp: now,
        message: `⚠️ LOW STOCK ALERT: ${item.name} is down to ${item.currentQuantity} ${item.unit} (Threshold: ${item.minThreshold} ${item.unit}). Please restock immediately.`,
      };

      await adminDb.collection('inventory_alerts').add(alertPayload);

      await adminDb.collection('notifications').add({
        title: `Low Stock: ${item.name}`,
        body: alertPayload.message,
        type: 'INVENTORY_LOW_STOCK',
        targetBranchId: item.branchId,
        targetFranchiseId: item.franchiseId,
        isRead: false,
        createdAt: now,
      });

      console.log(`[InventoryService] Dispatched Low Stock Alert for ${item.name} at branch ${item.branchId}`);
    } catch (err: any) {
      console.error('[InventoryService] Error dispatching low stock alert:', err.message);
    }
  }

  private static async seedDefaultInventory(branchId: string): Promise<InventoryItem[]> {
    const now = new Date().toISOString();
    const defaults: Omit<InventoryItem, 'id'>[] = [
      {
        name: 'Mozzarella Cheese (Diced)',
        category: 'dairy',
        unit: 'kg',
        currentQuantity: 35,
        minThreshold: 10,
        costPerUnit: 420,
        supplierName: 'Amul Dairy Foodservice',
        supplierPhone: '+91 98271 22334',
        isActive: true,
        branchId,
        franchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
        organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Fine Pizza Flour (00 Grade)',
        category: 'flour_dough',
        unit: 'kg',
        currentQuantity: 80,
        minThreshold: 25,
        costPerUnit: 45,
        supplierName: 'Pilsbury Mills',
        isActive: true,
        branchId,
        franchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
        organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Italian Herb Pizza Sauce',
        category: 'sauces_seasonings',
        unit: 'kg',
        currentQuantity: 20,
        minThreshold: 8,
        costPerUnit: 180,
        supplierName: 'Dr. Oetker Foodservice',
        isActive: true,
        branchId,
        franchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
        organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Sliced Black Olives',
        category: 'toppings_produce',
        unit: 'kg',
        currentQuantity: 12,
        minThreshold: 4,
        costPerUnit: 350,
        supplierName: 'Figaro Agro',
        isActive: true,
        branchId,
        franchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
        organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: '10" Corrugated Pizza Boxes',
        category: 'packaging',
        unit: 'boxes',
        currentQuantity: 250,
        minThreshold: 60,
        costPerUnit: 9.5,
        supplierName: 'Shri Packaging Industries',
        isActive: true,
        branchId,
        franchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
        organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      },
    ];

    const seededItems: InventoryItem[] = [];
    for (const item of defaults) {
      const ref = await adminDb.collection('inventory_items').add(item);
      seededItems.push({ id: ref.id, ...item });
    }

    return seededItems;
  }
}
