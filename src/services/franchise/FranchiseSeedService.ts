import { adminDb } from '../../config/firebase.js';
import { FranchiseScopeService } from './FranchiseScopeService.js';

/**
 * FranchiseSeedService
 *
 * Idempotent bootstrap service that ensures the canonical organization,
 * franchise, and default branch documents exist in Firestore on startup.
 *
 * SAFETY: Uses { merge: true } everywhere — NEVER destructively overwrites
 * existing production data. Safe to call on every server restart.
 *
 * Migration compatibility:
 *   Pre-franchise orders and users that carry no organizationId/franchiseId/branchId
 *   are implicitly mapped to DEFAULT_ORG_ID / DEFAULT_FRANCHISE_ID / DEFAULT_BRANCH_ID
 *   via FranchiseScopeService.resolveScope(). No database migration is required
 *   for existing records — the default fallback handles backward compatibility.
 */
export class FranchiseSeedService {
  private static seeded = false;

  public static async seedDefaults(): Promise<void> {
    if (FranchiseSeedService.seeded) return;

    try {
      // 1. Seed organization document if not exists
      const orgRef = adminDb.collection('organizations').doc(FranchiseScopeService.DEFAULT_ORG_ID);
      const orgSnap = await orgRef.get();
      if (!orgSnap.exists) {
        await orgRef.set({
          id: FranchiseScopeService.DEFAULT_ORG_ID,
          name: 'Olive Pizza India',
          legalName: 'Olive Pizza Foodworks Private Limited',
          contactEmail: 'olivepizzarjn@gmail.com',
          contactPhone: '+91 91799 44445',
          currency: 'INR',
          country: 'IN',
          defaultFranchiseId: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
          seededAt: new Date().toISOString()
        });
      }

      // 2. Seed franchise-level metadata document if not exists
      const metaRef = adminDb.collection('franchise_metadata').doc(FranchiseScopeService.DEFAULT_FRANCHISE_ID);
      const metaSnap = await metaRef.get();
      if (!metaSnap.exists) {
        await metaRef.set({
          id: FranchiseScopeService.DEFAULT_FRANCHISE_ID,
          organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
          name: 'Olive Pizza — Rajnandgaon',
          code: 'OP-RJN-01',
          region: 'Chhattisgarh',
          contactEmail: 'olivepizzarjn@gmail.com',
          contactPhone: '+91 91799 44445',
          isActive: true,
          defaultBranchId: FranchiseScopeService.DEFAULT_BRANCH_ID,
          googleDriveBillingFolderId: null,
          seededAt: new Date().toISOString()
        });
      }

      // 3. Seed canonical branch documents (Only if not already present)
      const defaultBranches = [
        {
          id: 'main_branch',
          organizationId: FranchiseScopeService.DEFAULT_ORG_ID,
          franchiseId: 'fra_rajnandgaon',
          name: 'Olive Pizza — Rajnandgaon',
          code: 'OP-RJN-01',
          city: 'Rajnandgaon',
          state: 'Chhattisgarh',
          address: 'Dongargaon Rd, near Saraswati school, Gokul Nagar, Rajnandgaon, CG 491441',
          lat: 21.0810244,
          lng: 81.0123793,
          phone: '+91 91799 44445',
          email: 'olivepizzarjn@gmail.com',
          franchiseOwnerEmail: 'olivepizzarjn@gmail.com',
          restaurantManagerEmail: 'webhub2811@gmail.com',
          maxDeliveryRadiusKm: 15,
          openingTime: '12:00',
          closingTime: '23:59',
          isActive: true
        }
      ];

      for (const branch of defaultBranches) {
        const branchRef = adminDb.collection('franchises').doc(branch.id);
        const branchSnap = await branchRef.get();
        if (!branchSnap.exists) {
          await branchRef.set({ ...branch, seededAt: new Date().toISOString() });
        } else {
          // If branch exists, ensure franchiseId points to canonical fra_rajnandgaon without touching user fields
          const existingData = branchSnap.data();
          if (!existingData?.franchiseId || existingData.franchiseId === 'fra_primary') {
            await branchRef.set({ franchiseId: 'fra_rajnandgaon' }, { merge: true });
          }
        }
      }

      FranchiseSeedService.seeded = true;
      console.log('[FranchiseSeedService] Default organization, franchise, and branch verified.');
    } catch (err) {
      console.warn('[FranchiseSeedService] Warning: Failed to verify default franchise data:', err);
    }
  }
}
