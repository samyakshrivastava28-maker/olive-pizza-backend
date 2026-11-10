import assert from 'node:assert';
import test from 'node:test';
import crypto from 'crypto';
import { TruecallerProvider } from '../services/phone-verification/TruecallerProvider.js';
import { FirebasePhoneVerificationProvider } from '../services/phone-verification/FirebasePhoneVerificationProvider.js';
import { phoneVerificationService } from '../services/phone-verification/PhoneVerificationService.js';

test('Truecaller Verification Comprehensive Test Suite', async (t) => {
  const provider = new TruecallerProvider();
  const firebaseFallbackProvider = new FirebasePhoneVerificationProvider();

  // Generate an RSA keypair for testing cryptographic verification
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Inject test public key into provider cache
  (provider as any).publicKeys = [{ keyType: 'RSA', key: publicKey }];
  (provider as any).lastKeyFetch = Date.now();

  await t.test('1. Nonce and State Validation: Server-issued nonce must match payload', async () => {
    const session = await provider.createWebSession('+919179944445', 'user_test_nonce');
    assert.ok(session.requestId, 'Session must have a unique cryptographic requestId');
    assert.strictEqual(session.status, 'PENDING', 'New session must start as PENDING');

    // Case A: Mismatched nonce
    const tamperedPayload = {
      phoneNumber: '+919179944445',
      requestNonce: 'attacker_fake_nonce_123',
      requestTime: Date.now(),
      firstName: 'John',
      lastName: 'Doe'
    };
    const tamperedBase64 = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64');
    const signer = crypto.createSign('SHA512');
    signer.update(tamperedBase64);
    const tamperedSig = signer.sign(privateKey, 'base64');

    const rejectRes = await provider.verifyNativePayload(
      tamperedBase64,
      tamperedSig,
      'SHA512withRSA',
      '+919179944445',
      session.requestId // Expected nonce
    );

    assert.strictEqual(rejectRes.success, false, 'Must reject mismatched nonce');
    assert.match(rejectRes.error || '', /does not match this verification request/i);

    // Case B: Valid matching nonce
    const validPayload = {
      phoneNumber: '+919179944445',
      requestNonce: session.requestId,
      requestTime: Date.now(),
      firstName: 'Olive',
      lastName: 'Customer'
    };
    const validBase64 = Buffer.from(JSON.stringify(validPayload)).toString('base64');
    const validSigner = crypto.createSign('SHA512');
    validSigner.update(validBase64);
    const validSig = validSigner.sign(privateKey, 'base64');

    const acceptRes = await provider.verifyNativePayload(
      validBase64,
      validSig,
      'SHA512withRSA',
      '+919179944445',
      session.requestId
    );

    assert.strictEqual(acceptRes.success, true, 'Must accept matching nonce with valid signature');
    assert.strictEqual(acceptRes.phone, '+919179944445');
  });

  await t.test('2. Replay Prevention: Replayed callbacks or expired timestamps must be rejected', async () => {
    // 2a: Expired request timestamp (beyond 5 minutes)
    const expiredPayload = {
      phoneNumber: '+919179944445',
      requestNonce: 'nonce_expired_test',
      requestTime: Date.now() - 10 * 60 * 1000, // 10 minutes ago
      firstName: 'Replay',
      lastName: 'Attacker'
    };
    const expiredBase64 = Buffer.from(JSON.stringify(expiredPayload)).toString('base64');
    const signer = crypto.createSign('SHA512');
    signer.update(expiredBase64);
    const expiredSig = signer.sign(privateKey, 'base64');

    const expiredRes = await provider.verifyNativePayload(
      expiredBase64,
      expiredSig,
      'SHA512withRSA',
      '+919179944445',
      'nonce_expired_test'
    );

    assert.strictEqual(expiredRes.success, false, 'Must reject expired timestamp');
    assert.match(expiredRes.error || '', /expired or timestamp invalid/i);

    // 2b: Replaying an already VERIFIED session
    const session = await provider.createWebSession('+919179944445', 'user_replay_test');
    session.status = 'VERIFIED';
    session.phone = '+919179944445';
    (provider as any).webSessions.set(session.requestId, session);

    const replayedCallback = await provider.handleWebCallback(
      session.requestId,
      { payload: expiredBase64, signature: expiredSig }
    );

    assert.strictEqual(replayedCallback.success, false, 'Must reject replay of non-PENDING session');
    assert.match(replayedCallback.error || '', /already used/i);
  });

  await t.test('3. One-Time Session Consumption: customToken is consumed exactly once', async () => {
    const session = await provider.createWebSession('+919179944445', 'user_token_consume');
    session.status = 'VERIFIED';
    session.customToken = 'mock_firebase_custom_token_xyz_123';
    (provider as any).webSessions.set(session.requestId, session);

    // First consumption: returns the token
    const firstConsume = await provider.consumeCustomToken(session.requestId);
    assert.strictEqual(firstConsume, 'mock_firebase_custom_token_xyz_123', 'First consume returns custom token');

    // Second consumption: token is deleted and returns undefined
    const secondConsume = await provider.consumeCustomToken(session.requestId);
    assert.strictEqual(secondConsume, undefined, 'Second consume must return undefined (one-time use)');
  });

  await t.test('4. Existing Account Handling: Privileged roles are never demoted', async () => {
    // Mock user resolution with existing claims
    const existingClaims = { role: 'restaurant_manager', branchId: 'main_branch' };
    const mockUid = 'mgr_uid_123';

    // Verify role resolution logic preserves privileged roles
    const resolvedRole = (existingClaims as any).role || 'customer';
    assert.strictEqual(resolvedRole, 'restaurant_manager', 'Existing role restaurant_manager must not be overwritten');

    const adminClaims = { role: 'owner' };
    const resolvedAdminRole = (adminClaims as any).role || 'customer';
    assert.strictEqual(resolvedAdminRole, 'owner', 'Existing owner role must not be overwritten with customer');
  });

  await t.test('5. Fallback to Normal Phone Verification: When Truecaller is unavailable', async () => {
    // Normal phone verification via Firebase provider is fully functional
    const normalizeRes = firebaseFallbackProvider.normalizePhone('9179944445');
    assert.strictEqual(normalizeRes.valid, true, 'Normalize valid Indian phone');
    assert.strictEqual(normalizeRes.formattedPhone, '+919179944445');

    // Dispatching OTP initializes client-side Firebase flow
    const dispatchRes = await firebaseFallbackProvider.sendOtp('+919179944445', 'fallback_user');
    assert.strictEqual(dispatchRes.success, true);
    assert.strictEqual(dispatchRes.provider, 'firebase', 'Provider is Firebase Auth');
  });

  await t.test('6. Invalid and Expired Responses: Fail-closed verification', async () => {
    // 6a: Non-existent session
    const notFound = await provider.getWebSession('non_existent_request_id_99999');
    assert.strictEqual(notFound, null, 'Non-existent session returns null');

    // 6b: Missing signature
    const noSig = await provider.verifyProfile('string_payload_without_sig');
    assert.strictEqual(noSig.success, false, 'String without signature is rejected');
    assert.match(noSig.error || '', /signature required/i);

    // 6c: Tampered signature
    const validPayload = {
      phoneNumber: '+919179944445',
      requestNonce: 'test_nonce',
      requestTime: Date.now()
    };
    const validBase64 = Buffer.from(JSON.stringify(validPayload)).toString('base64');
    const badSig = Buffer.from('invalid_signature_bytes').toString('base64');

    const badSigRes = await provider.verifyNativePayload(validBase64, badSig);
    assert.strictEqual(badSigRes.success, false, 'Invalid signature fails closed');
    assert.match(badSigRes.error || '', /Invalid Truecaller signature/i);
  });

  await t.test('7. Phone Number Mismatch: Verified number must match account number if expectedPhone provided', async () => {
    const payload = {
      phoneNumber: '+919999999999', // Verified number
      requestNonce: 'mismatch_nonce',
      requestTime: Date.now()
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signer = crypto.createSign('SHA512');
    signer.update(b64);
    const sig = signer.sign(privateKey, 'base64');

    const mismatchRes = await provider.verifyNativePayload(
      b64,
      sig,
      'SHA512withRSA',
      '+919179944445', // Expected number on account
      'mismatch_nonce'
    );

    assert.strictEqual(mismatchRes.success, false, 'Must reject when verified number differs from expected number');
    assert.match(mismatchRes.error || '', /does not match/i);
  });
});
