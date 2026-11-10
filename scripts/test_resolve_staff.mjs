import { notificationEngine } from '../src/services/notification/NotificationEngine.js';

async function main() {
  console.log('Testing resolveBranchStaff...');
  const uids = await notificationEngine.resolveBranchStaff('main_branch', 'fra_rajnandgaon');
  console.log('Resolved UIDs for main_branch, fra_rajnandgaon:', uids);

  const uids2 = await notificationEngine.resolveBranchStaff('main_branch');
  console.log('Resolved UIDs for main_branch (no franchise):', uids2);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
