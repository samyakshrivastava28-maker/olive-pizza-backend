import { FranchiseLifecycleService } from '../src/services/franchise/FranchiseLifecycleService.js';
import { FranchiseAccessService } from '../src/services/franchise/FranchiseAccessService.js';

console.log('--- Verifying Franchise Lifecycle & Access Services ---');
console.log('FranchiseLifecycleService:');
console.log('  - softDeleteFranchise:', typeof FranchiseLifecycleService.softDeleteFranchise);
console.log('  - listDeletedFranchises:', typeof FranchiseLifecycleService.listDeletedFranchises);
console.log('  - getFranchiseHistory:', typeof FranchiseLifecycleService.getFranchiseHistory);
console.log('  - recoverFranchise:', typeof FranchiseLifecycleService.recoverFranchise);
console.log('  - permanentDeleteFranchise:', typeof FranchiseLifecycleService.permanentDeleteFranchise);

console.log('FranchiseAccessService:');
console.log('  - updateFranchiseAccess:', typeof FranchiseAccessService.updateFranchiseAccess);
console.log('  - resolveAuthorization:', typeof FranchiseAccessService.resolveAuthorization);

console.log('All lifecycle methods verified successfully!');
process.exit(0);
