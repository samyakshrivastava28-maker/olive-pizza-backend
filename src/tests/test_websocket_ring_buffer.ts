import assert from 'assert';
import { webSocketServer } from '../services/websocket/WebSocketServer.js';

async function runTests() {
  console.log('=== RUNNING WEBSOCKET BRANCH RING BUFFER TESTS ===\n');

  const franchiseId = 'fra_rajnandgaon';
  const branch1 = 'branch_main';
  const branch2 = 'branch_gokul';

  // 1. TEST: Monotonic sequence numbering
  console.log('Test 1: Monotonic sequence incrementing');
  const ev1 = webSocketServer.recordBranchEvent(franchiseId, branch1, 'order.created', 'ord_1', { id: 'ord_1', amount: 500 });
  const ev2 = webSocketServer.recordBranchEvent(franchiseId, branch1, 'order.created', 'ord_2', { id: 'ord_2', amount: 750 });
  const ev3 = webSocketServer.recordBranchEvent(franchiseId, branch1, 'order.created', 'ord_3', { id: 'ord_3', amount: 1200 });

  assert.strictEqual(ev1.seq, 1);
  assert.strictEqual(ev2.seq, 2);
  assert.strictEqual(ev3.seq, 3);
  assert.strictEqual(ev1.eventId, 'ord_1');
  assert.strictEqual(ev2.eventId, 'ord_2');
  console.log('  -> PASS: Monotonic sequence numbers verified.\n');

  // 2. TEST: Branch isolation
  console.log('Test 2: Branch & Franchise isolation');
  const evB1 = webSocketServer.recordBranchEvent(franchiseId, branch2, 'order.created', 'ord_b1', { id: 'ord_b1', amount: 300 });
  assert.strictEqual(evB1.seq, 1, 'Branch 2 must start from sequence 1 independently of Branch 1');

  const missedBranch1 = webSocketServer.getMissedEvents(franchiseId, branch1, 0);
  const missedBranch2 = webSocketServer.getMissedEvents(franchiseId, branch2, 0);

  assert.strictEqual(missedBranch1.currentSeq, 3);
  assert.strictEqual(missedBranch1.missedEvents.length, 3);
  assert.strictEqual(missedBranch2.currentSeq, 1);
  assert.strictEqual(missedBranch2.missedEvents.length, 1);
  assert.strictEqual(missedBranch2.missedEvents[0].eventId, 'ord_b1');
  console.log('  -> PASS: Branch isolation verified.\n');

  // 3. TEST: Ring buffer retention limit (200 items)
  console.log('Test 3: Ring buffer retention limit (caps at 200 items)');
  // Branch 1 already has 3 events. Add 247 more events (total 250).
  for (let i = 4; i <= 250; i++) {
    webSocketServer.recordBranchEvent(franchiseId, branch1, 'order.created', `ord_${i}`, { id: `ord_${i}`, index: i });
  }

  const branch1State = webSocketServer.getMissedEvents(franchiseId, branch1, 0);
  assert.strictEqual(branch1State.currentSeq, 250, 'currentSeq must reach 250');
  assert.strictEqual(branch1State.missedEvents.length, 200, 'Buffer must cap at exactly 200 events');
  assert.strictEqual(branch1State.missedEvents[0].seq, 51, 'First event in 200-item ring buffer must be seq 51');
  assert.strictEqual(branch1State.missedEvents[199].seq, 250, 'Last event in ring buffer must be seq 250');
  console.log('  -> PASS: 200-event ring buffer slice verified.\n');

  // 4. TEST: Reconnection sync replay with known lastSequence
  console.log('Test 4: Reconnection sync replay with lastSequence');
  // Client reconnects claiming last received sequence was 245
  const replay245 = webSocketServer.getMissedEvents(franchiseId, branch1, 245);
  assert.strictEqual(replay245.currentSeq, 250);
  assert.strictEqual(replay245.missedEvents.length, 5, 'Must return exactly 5 missed events');
  assert.strictEqual(replay245.missedEvents[0].seq, 246);
  assert.strictEqual(replay245.missedEvents[4].seq, 250);

  // Client reconnects with already up-to-date sequence 250
  const replay250 = webSocketServer.getMissedEvents(franchiseId, branch1, 250);
  assert.strictEqual(replay250.missedEvents.length, 0, 'No missed events when client is up-to-date');
  console.log('  -> PASS: Reconnection sync replay verified.\n');

  console.log('ALL WEBSOCKET BRANCH RING BUFFER TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
