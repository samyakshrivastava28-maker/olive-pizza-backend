import { adminDb } from '../../config/firebase.js';
import { query } from '../../lib/db.js';
import { redisService } from '../redis/RedisService.js';
import { webSocketServer } from '../websocket/WebSocketServer.js';
import { AuthoritativePricingResolver } from './AuthoritativePricingResolver.js';

export interface SyncFranchisePriceParams {
  branchId: string;
  productId: string;
  franchiseId?: string;
  customPrice?: number;
  isAvailable?: boolean;
  isEnabled?: boolean;
  updatedBy: string;
  additionalOverrides?: {
    allowedSizes?: any[];
    allowedCrusts?: any[];
    allowedAddons?: any[];
    channelAvailability?: Record<string, boolean>;
    stockStatus?: string;
  };
}

export class FranchisePricingSyncService {
  /**
   * Resolves franchiseId for a given branchId
   */
  public static async resolveFranchiseId(branchId: string, explicitFranchiseId?: string): Promise<string> {
    if (explicitFranchiseId) return explicitFranchiseId;

    try {
      const branchDoc = await adminDb.collection('branches').doc(branchId).get();
      if (branchDoc.exists && branchDoc.data()?.franchiseId) {
        return branchDoc.data()!.franchiseId;
      }
      const fraDoc = await adminDb.collection('franchises').doc(branchId).get();
      if (fraDoc.exists) {
        return fraDoc.id;
      }
    } catch (e: any) {
      console.warn('[FranchisePricingSync] Could not resolve franchiseId from Firestore:', e?.message);
    }

    return branchId;
  }

  /**
   * Atomically persist to PostgreSQL franchise_prices (UPSERT with version increment)
   * AND sync to Firestore branch_menu_overrides doc `${branchId}_${productId}`.
   * Invalidate Redis cache and broadcast WebSocket event.
   */
  public static async syncPrice(params: SyncFranchisePriceParams): Promise<{
    success: boolean;
    branchId: string;
    franchiseId: string;
    productId: string;
    customPrice: number;
    sellingPrice: number;
    isAvailable: boolean;
    version: number;
    updatedAt: string;
  }> {
    const { branchId, productId, updatedBy, additionalOverrides } = params;
    const franchiseId = await this.resolveFranchiseId(branchId, params.franchiseId);

    // 1. Determine effective selling_price and is_available
    let sellingPrice = params.customPrice !== undefined && params.customPrice !== null ? Number(params.customPrice) : undefined;
    let isAvailable = params.isAvailable !== undefined 
      ? Boolean(params.isAvailable) 
      : (params.isEnabled !== undefined ? Boolean(params.isEnabled) : undefined);

    // If either price or availability was not provided, look up existing values or master product
    let existingPrice: number | undefined;
    let existingAvailable = true;

    try {
      const existingPg = await query(
        'SELECT selling_price, is_available FROM franchise_prices WHERE franchise_id = $1 AND branch_id = $2 AND product_id = $3',
        [franchiseId, branchId, productId]
      );
      if (existingPg.rows.length > 0) {
        existingPrice = Number(existingPg.rows[0].selling_price);
        existingAvailable = Boolean(existingPg.rows[0].is_available);
      }
    } catch (pgLookupErr: any) {
      console.warn('[FranchisePricingSync] Postgres existing lookup warning:', pgLookupErr?.message);
    }

    if (sellingPrice === undefined) {
      if (existingPrice !== undefined && !isNaN(existingPrice)) {
        sellingPrice = existingPrice;
      } else {
        // Query master product basePrice in Firestore
        const pDoc = await adminDb.collection('products').doc(productId).get();
        if (!pDoc.exists) {
          throw new Error(`Master product "${productId}" not found. Cannot configure franchise price for non-existent product.`);
        }
        const pData = pDoc.data()!;
        const masterBase = Number(pData.basePrice || pData.price || pData.offerPrice || 0);
        if (masterBase <= 0) {
          throw new Error(`Master product "${productId}" does not have an authoritative price configured.`);
        }
        sellingPrice = masterBase;
        if (isAvailable === undefined) {
          isAvailable = pData.isActive !== false && pData.isAvailable !== false;
        }
      }
    }

    if (isAvailable === undefined) {
      isAvailable = existingAvailable;
    }

    const rowId = `${branchId}_${productId}`;
    const nowIso = new Date().toISOString();
    let version = 1;

    // 2. Persist to PostgreSQL franchise_prices (UPSERT with version increment)
    try {
      const upsertSql = `
        INSERT INTO franchise_prices (
          id, franchise_id, branch_id, product_id, selling_price, is_available, version, updated_by, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, CURRENT_TIMESTAMP)
        ON CONFLICT (franchise_id, branch_id, product_id)
        DO UPDATE SET
          selling_price = EXCLUDED.selling_price,
          is_available = EXCLUDED.is_available,
          version = franchise_prices.version + 1,
          updated_by = EXCLUDED.updated_by,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      const res = await query(upsertSql, [
        rowId,
        franchiseId,
        branchId,
        productId,
        sellingPrice,
        isAvailable,
        updatedBy || 'franchise_manager'
      ]);

      if (res.rows.length > 0) {
        version = Number(res.rows[0].version) || 1;
        sellingPrice = Number(res.rows[0].selling_price);
        isAvailable = Boolean(res.rows[0].is_available);
      }
    } catch (pgError: any) {
      console.error('[FranchisePricingSync] PostgreSQL upsert error:', pgError.message);
      throw new Error(`Failed to commit franchise price override to canonical PostgreSQL database: ${pgError.message}`);
    }

    // 3. Sync to Firestore branch_menu_overrides doc `${branchId}_${productId}`
    const docKey = `${branchId}_${productId}`;
    const firestoreOverride: any = {
      branchId,
      franchiseId,
      productId,
      customPrice: sellingPrice,
      sellingPrice,
      price: sellingPrice,
      isEnabledForBranch: isAvailable,
      isAvailable,
      version,
      updatedAt: nowIso,
      updatedBy: updatedBy || 'franchise_manager'
    };

    if (additionalOverrides) {
      if (additionalOverrides.allowedSizes !== undefined) firestoreOverride.allowedSizes = additionalOverrides.allowedSizes;
      if (additionalOverrides.allowedCrusts !== undefined) firestoreOverride.allowedCrusts = additionalOverrides.allowedCrusts;
      if (additionalOverrides.allowedAddons !== undefined) firestoreOverride.allowedAddons = additionalOverrides.allowedAddons;
      if (additionalOverrides.channelAvailability !== undefined) firestoreOverride.channelAvailability = additionalOverrides.channelAvailability;
      if (additionalOverrides.stockStatus !== undefined) firestoreOverride.stockStatus = additionalOverrides.stockStatus;
    }

    await adminDb.collection('branch_menu_overrides').doc(docKey).set(firestoreOverride, { merge: true });

    // 4. Invalidate Redis cache and in-memory AuthoritativePricingResolver cache
    try {
      AuthoritativePricingResolver.clearCache(branchId);
      await redisService.delByPattern(`cache:menu:branch:${branchId}:*`);
      await redisService.invalidateMenu(branchId);
    } catch (redisErr: any) {
      console.warn('[FranchisePricingSync] Cache invalidation warning:', redisErr?.message);
    }

    // 5. Broadcast WebSocket event `branch_menu.updated` with the updated price and version
    try {
      webSocketServer.broadcastToAll({
        type: 'branch_menu.updated',
        data: {
          branchId,
          franchiseId,
          productId,
          customPrice: sellingPrice,
          sellingPrice,
          isAvailable,
          isEnabledForBranch: isAvailable,
          version,
          timestamp: nowIso
        }
      });
    } catch (wsErr: any) {
      console.warn('[FranchisePricingSync] WebSocket broadcast warning:', wsErr?.message);
    }

    return {
      success: true,
      branchId,
      franchiseId,
      productId,
      customPrice: sellingPrice,
      sellingPrice,
      isAvailable,
      version,
      updatedAt: nowIso
    };
  }

  /**
   * Fetch all PostgreSQL franchise prices for a given branch
   */
  public static async getBranchPricesMap(branchId: string): Promise<Map<string, { sellingPrice: number; isAvailable: boolean; version: number }>> {
    const map = new Map<string, { sellingPrice: number; isAvailable: boolean; version: number }>();
    try {
      const res = await query(
        'SELECT product_id, selling_price, is_available, version FROM franchise_prices WHERE branch_id = $1',
        [branchId]
      );
      for (const row of res.rows) {
        map.set(row.product_id, {
          sellingPrice: Number(row.selling_price),
          isAvailable: Boolean(row.is_available),
          version: Number(row.version) || 1
        });
      }
    } catch (e: any) {
      console.warn(`[FranchisePricingSync] Error loading franchise prices for branch ${branchId}:`, e?.message);
    }
    return map;
  }
}
