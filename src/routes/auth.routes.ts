import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { RecaptchaEnterpriseServiceClient } from '@google-cloud/recaptcha-enterprise';
import { authLimiter } from '../config/security.config.js';

const router = Router();
let client: RecaptchaEnterpriseServiceClient | null = null;
try {
  client = new RecaptchaEnterpriseServiceClient();
} catch (e) {
  console.warn("Could not initialize Recaptcha client:", e);
}

router.post('/verify-recaptcha', async (req: Request, res: Response) => {
  try {
    const { token, action } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: 'Token missing' });
      return;
    }

    if (!client) {
      res.status(503).json({ success: false, error: 'recaptcha_service_unavailable' });
      return;
    }

    const projectID = process.env.GOOGLE_CLOUD_PROJECT_ID || 'olive-pizza-08';
    const recaptchaKey = process.env.RECAPTCHA_SITE_KEY || '6LdqyDctAAAAABn8isXOdDe-0roVqILKuAdIl_x-';
    
    const projectPath = client.projectPath(projectID);

    const request = {
      assessment: {
        event: {
          token: token,
          siteKey: recaptchaKey,
        },
      },
      parent: projectPath,
    };

    const [response] = await client.createAssessment(request);

    if (!response.tokenProperties?.valid) {
      console.warn(`[reCAPTCHA] Assessment failed: invalidReason=${response.tokenProperties?.invalidReason}`);
      res.status(400).json({ success: false, error: response.tokenProperties?.invalidReason || 'invalid_token' });
      return;
    }

    if (action && response.tokenProperties.action !== action) {
      console.warn(`[reCAPTCHA] Action mismatch: expected=${action} got=${response.tokenProperties.action}`);
      res.status(400).json({ success: false, error: 'action_mismatch' });
      return;
    }

    const score = response.riskAnalysis?.score ?? 0;
    console.log(`[reCAPTCHA] Verification succeeded, score=${score}`);
    res.json({ success: true, score });
  } catch (error: any) {
    console.error('[reCAPTCHA] Assessment error:', error.message);
    res.status(500).json({ success: false, error: 'recaptcha_assessment_failed' });
  }
});


import { verifyToken, requireRole, AuthRequest, logSecurityEventServer } from '../middleware/auth.middleware.js';
import { FranchiseScopeService } from '../services/franchise/FranchiseScopeService.js';
import { FranchiseAccessService } from '../services/franchise/FranchiseAccessService.js';
import { TOTPService } from '../services/auth/TOTPService.js';
import { adminDb, adminAuth } from '../config/firebase.js';
import { EmailVerificationService } from '../services/auth/EmailVerificationService.js';
import { LoginRateLimiterService } from '../services/auth/LoginRateLimiterService.js';
import { PosAccountService } from '../services/auth/PosAccountService.js';
import { PosPinService } from '../services/auth/PosPinService.js';
import { PasswordResetWorkflowService } from '../services/auth/PasswordResetWorkflowService.js';
import { AuthAuditService } from '../services/auth/AuthAuditService.js';

// ============================================================================
// AUTHORIZE OPERATIONAL APP HANDSHAKE (POS, RESTAURANT_MANAGER, FRANCHISE_MANAGER, DELIVERY)
// Enforces strict Owner-Controlled Allowlist across all 4 operational apps
// ============================================================================
router.post('/authorize-app', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user || !user.uid) {
      res.status(401).json({ authorized: false, reason: 'Authentication required' });
      return;
    }

    const { targetApp, terminalId, requestedBranchId } = req.body;
    const validApps = ['POS', 'RESTAURANT_MANAGER', 'FRANCHISE_MANAGER', 'DELIVERY', 'OWNER', 'CUSTOMER'];
    if (!targetApp || !validApps.includes(targetApp)) {
      res.status(400).json({ authorized: false, reason: `Invalid targetApp. Must be one of: ${validApps.join(', ')}` });
      return;
    }

    const rawDeviceId = (req.headers['x-device-id'] || req.headers['x-installation-id'] || req.body?.deviceId || req.body?.device_id || '') as string;
    const userAgent = (req.headers['user-agent'] || '') as string;
    const userIdentifier = (user.email || user.uid || '').toLowerCase().trim();
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();

    const isOwnerAccount = user.role === 'owner' || 
                           user.role === 'platform_owner' ||
                           (user as any)?.isOwnerMode === true ||
                           (user as any)?.isGlobalOwner === true ||
                           (user as any)?.admin === true;

    // ── 1. Server-Enforced Login Rate Limiter (Protection against brute-force) ──
    if (targetApp !== 'CUSTOMER' && !isOwnerAccount) {
      try {
        const rateStatus = await LoginRateLimiterService.checkLimit(userIdentifier, clientIp, rawDeviceId, userAgent);
        if (!rateStatus.allowed) {
          res.setHeader('Retry-After', String(rateStatus.retryAfterSeconds));
          res.status(429).json({
            success: false,
            authorized: false,
            code: 'AUTH_RATE_LIMITED',
            message: rateStatus.message || 'Too many login attempts from this device. Please try again later.',
            reason: rateStatus.message || 'Too many login attempts from this device. Please try again later.',
            retryAfter: rateStatus.retryAfterSeconds,
            retryAfterSeconds: rateStatus.retryAfterSeconds
          });
          return;
        }
      } catch (limiterErr: any) {
        console.warn('[AuthorizeApp] Rate limiter check notice:', limiterErr.message);
      }
    }

    const resolution = await FranchiseAccessService.resolveAuthorization({
      uid: user.uid,
      email: user.email,
      phoneNumber: user.phone_number,
      emailVerified: user.email_verified,
      targetApp,
      requestedBranchId,
      terminalId
    });

    if (!resolution.authorized) {
      if (targetApp !== 'CUSTOMER') {
        void LoginRateLimiterService.recordAttempt(userIdentifier, clientIp, rawDeviceId, userAgent).catch(() => 0);
      }
      void AuthAuditService.logEvent({
        eventType: 'APP_AUTHORIZE_DENIED',
        userId: user.uid,
        identifier: user.email,
        appTarget: targetApp,
        status: 'BLOCKED',
        metadata: { reason: resolution.reason, code: resolution.code }
      }).catch(() => {});

      const statusCode = resolution.code === 'DATABASE_UNAVAILABLE' ? 503 : 403;
      res.status(statusCode).json({
        authorized: false,
        app: targetApp,
        email: user.email,
        code: resolution.code,
        reason: resolution.reason || 'This account is not authorized to use this Olive Pizza application.'
      });
      return;
    }

    if (targetApp !== 'CUSTOMER') {
      void LoginRateLimiterService.recordSuccess(userIdentifier, clientIp, rawDeviceId, userAgent).catch(() => {});
    }
    void AuthAuditService.logEvent({
      eventType: 'APP_AUTHORIZE_SUCCESS',
      userId: user.uid,
      identifier: user.email,
      appTarget: targetApp,
      status: 'SUCCESS'
    }).catch(() => {});

    res.json({
      authorized: true,
      app: targetApp,
      requiresPin: resolution.requiresPin || false,
      isProfileComplete: resolution.isProfileComplete !== false,
      user: resolution.user
    });
  } catch (error: any) {
    console.error('[AuthorizeApp] Error:', error);
    res.status(500).json({ authorized: false, reason: error.message || 'Authorization check failed' });
  }
});


// POST /api/auth/context-session - Owner Authorized Context Switching for Standalone Apps
router.post('/context-session', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const isGlobalOwner = FranchiseScopeService.isGlobalOwner(user.email, user.role);
    if (!isGlobalOwner) {
      res.status(403).json({ error: 'Forbidden. Only platform Global Owner can create scoped management contexts.' });
      return;
    }

    const { targetFranchiseId, targetBranchId, targetBranchName } = req.body;
    const requestedTarget = (req.body.targetApp || req.body.context || 'franchise_management').toLowerCase();

    if (requestedTarget === 'customer') {
      res.status(403).json({ error: 'Forbidden: Owner accounts cannot generate context sessions for customer accounts.' });
      return;
    }

    const effectiveFranchiseId = targetFranchiseId || 'fra_rajnandgaon';
    const effectiveBranchId = targetBranchId || 'main_branch';

    const targetApp = req.body.targetApp || req.body.context || 'franchise_management';

    const tokenPayload = {
      ownerUid: user.uid,
      ownerEmail: user.email,
      targetApp,
      targetFranchiseId: effectiveFranchiseId,
      targetBranchId: effectiveBranchId,
      targetBranchName: targetBranchName || `Branch ${effectiveBranchId}`,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() // 8 hour session
    };

    const secret = process.env.JWT_SECRET || process.env.TRACKING_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ error: 'Server security configuration missing: signing secret is required.' });
      return;
    }

    const payloadB64 = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
    const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
    const sessionKey = `${payloadB64}.${signature}`;

    const franchiseBaseUrl = process.env.FRANCHISE_URL || 'https://franchise.olivepizza.in';
    const managerBaseUrl = process.env.MANAGER_URL || 'https://manager.olivepizza.in';
    const posBaseUrl = process.env.POS_URL || 'https://pos.olivepizza.in';
    const deliveryBaseUrl = process.env.DELIVERY_URL || 'https://delivery.olivepizza.in';

    let targetUrl = managerBaseUrl;
    if (requestedTarget === 'franchise' || requestedTarget === 'franchise_management') {
      targetUrl = `${franchiseBaseUrl}?context=${sessionKey}&franchiseId=${encodeURIComponent(tokenPayload.targetFranchiseId)}`;
    } else if (requestedTarget === 'pos') {
      targetUrl = `${posBaseUrl}?context=${sessionKey}&branchId=${encodeURIComponent(tokenPayload.targetBranchId)}&franchiseId=${encodeURIComponent(tokenPayload.targetFranchiseId)}`;
    } else if (requestedTarget === 'delivery' || requestedTarget === 'delivery_rider' || requestedTarget === 'delivery_partner') {
      targetUrl = `${deliveryBaseUrl}?context=${sessionKey}&branchId=${encodeURIComponent(tokenPayload.targetBranchId)}`;
    } else {
      targetUrl = `${managerBaseUrl}?context=${sessionKey}&branchId=${encodeURIComponent(tokenPayload.targetBranchId)}&branchName=${encodeURIComponent(tokenPayload.targetBranchName)}`;
    }

    res.json({
      success: true,
      sessionKey,
      targetUrl,
      context: tokenPayload
    });
  } catch (error: any) {
    console.error('[Auth] Error generating context session:', error);
    res.status(500).json({ error: error?.message || 'Failed to generate context session' });
  }
});

// POST /api/auth/verify-context-session - Cryptographically verify scoped context token
router.post('/verify-context-session', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionKey } = req.body;
    if (!sessionKey || typeof sessionKey !== 'string') {
      res.status(400).json({ valid: false, error: 'sessionKey is required' });
      return;
    }

    const secret = process.env.JWT_SECRET || process.env.TRACKING_TOKEN_SECRET || process.env.SESSION_SECRET;
    if (!secret) {
      res.status(500).json({ valid: false, error: 'Server security configuration missing: secret is required.' });
      return;
    }

    const parts = sessionKey.split('.');
    if (parts.length !== 2) {
      res.status(401).json({ valid: false, error: 'Invalid sessionKey format: signature missing.' });
      return;
    }

    const [payloadB64, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      res.status(401).json({ valid: false, error: 'Invalid sessionKey signature.' });
      return;
    }

    const decodedStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(decodedStr);

    if (!payload.expiresAt || new Date(payload.expiresAt).getTime() < Date.now()) {
      res.status(401).json({ valid: false, error: 'Context session has expired.' });
      return;
    }

    res.json({
      valid: true,
      context: payload
    });
  } catch (error: any) {
    console.error('[Auth] Error verifying context session:', error);
    res.status(500).json({ valid: false, error: error?.message || 'Verification failed' });
  }
});

// ============================================================================
// 2FA / MFA (RFC 6238 TOTP Authenticator Engine for Owner & Staff)
// ============================================================================

// GET /api/auth/2fa/status - Query 2FA status for authenticated user
router.get('/2fa/status', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const snap = await adminDb.collection('user_2fa').doc(uid).get();
    const data = snap.exists ? snap.data() : null;
    res.json({
      success: true,
      enabled: Boolean(data?.enabled),
      enrolledAt: data?.enrolledAt || null,
      backupCodesRemaining: (data?.backupCodes || []).length
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/auth/2fa/enroll - Begin 2FA enrollment (Generates Secret + OtpAuth URI + Backup Codes)
router.post('/2fa/enroll', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const secret = TOTPService.generateSecret();
    const otpAuthUri = TOTPService.generateOtpAuthUri(secret, user.email || 'owner@olivepizza.in');
    const backupCodes = TOTPService.generateBackupCodes(8);
    const encryptedSecret = TOTPService.encryptSecret(secret);

    // Save pending enrollment in Firestore
    await adminDb.collection('user_2fa').doc(user.uid).set({
      encryptedSecret,
      backupCodes,
      enabled: false,
      pendingEnrollment: true,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    res.json({
      success: true,
      secret, // Sent once during enrollment for manual entry in Google Authenticator / Authy
      otpAuthUri,
      backupCodes
    });
  } catch (error: any) {
    console.error('[Auth 2FA] Enroll error:', error);
    res.status(500).json({ success: false, error: 'Failed to initiate 2FA enrollment' });
  }
});

// POST /api/auth/2fa/verify - Verify first code to activate 2FA
router.post('/2fa/verify', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    const { code } = req.body;
    if (!user || !code) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }

    const docRef = adminDb.collection('user_2fa').doc(user.uid);
    const snap = await docRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: '2FA enrollment not found' });
      return;
    }

    const data = snap.data()!;
    const decryptedSecret = TOTPService.decryptSecret(data.encryptedSecret);
    const isValid = TOTPService.verifyTOTP(decryptedSecret, code);

    if (!isValid) {
      res.status(400).json({ success: false, error: 'Invalid 6-digit verification code. Ensure your device clock is synchronized.' });
      return;
    }

    await docRef.update({
      enabled: true,
      pendingEnrollment: false,
      enrolledAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Two-factor authentication successfully enabled'
    });
  } catch (error: any) {
    console.error('[Auth 2FA] Verification error:', error);
    res.status(500).json({ success: false, error: 'Failed to verify 2FA' });
  }
});

// POST /api/auth/2fa/validate-session - Validate TOTP code or backup code during login session
router.post('/2fa/validate-session', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    const { code, isBackupCode } = req.body;
    if (!user || !code) {
      res.status(400).json({ error: 'Code is required' });
      return;
    }

    const docRef = adminDb.collection('user_2fa').doc(user.uid);
    const snap = await docRef.get();
    if (!snap.exists || !snap.data()?.enabled) {
      res.json({ success: true, required: false, message: '2FA not enabled on this account' });
      return;
    }

    if (isBackupCode) {
      const backupValid = await TOTPService.verifyAndBurnBackupCode(user.uid, code);
      if (!backupValid) {
        res.status(400).json({ success: false, error: 'Invalid or already consumed backup recovery code' });
        return;
      }
      res.json({ success: true, message: 'Authenticated via backup recovery code' });
      return;
    }

    const data = snap.data()!;
    const decryptedSecret = TOTPService.decryptSecret(data.encryptedSecret);
    const isValid = TOTPService.verifyTOTP(decryptedSecret, code);

    if (!isValid) {
      res.status(400).json({ success: false, error: 'Invalid 6-digit authentication code' });
      return;
    }

    await docRef.update({ lastVerifiedAt: new Date().toISOString() });

    res.json({
      success: true,
      message: '2FA session validated successfully'
    });
  } catch (error: any) {
    console.error('[Auth 2FA] Session validation error:', error);
    res.status(500).json({ success: false, error: 'Failed to validate 2FA session' });
  }
});

// POST /api/auth/2fa/disable - Disable 2FA with current code confirmation
router.post('/2fa/disable', verifyToken, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    const { code } = req.body;
    if (!user || !code) {
      res.status(400).json({ error: 'Current 2FA code is required to disable' });
      return;
    }

    const docRef = adminDb.collection('user_2fa').doc(user.uid);
    const snap = await docRef.get();
    if (!snap.exists || !snap.data()?.enabled) {
      res.json({ success: true, message: '2FA already disabled' });
      return;
    }

    const data = snap.data()!;
    const decryptedSecret = TOTPService.decryptSecret(data.encryptedSecret);
    const isValid = TOTPService.verifyTOTP(decryptedSecret, code);

    if (!isValid) {
      res.status(400).json({ success: false, error: 'Invalid authentication code' });
      return;
    }

    await docRef.delete();
    res.json({ success: true, message: '2FA disabled successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
  }
});

// ============================================================================
// UNIVERSAL 4-DIGIT EMAIL VERIFICATION (5-MIN EXPIRY, SHA-256 HASH AT REST)
// ============================================================================

// POST /api/auth/email/send-code
router.post('/email/send-code', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email address is required' });
      return;
    }
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();
    const result = await EmailVerificationService.sendVerificationCode(email, clientIp);

    if (!result.success) {
      const status = result.retryAfterSeconds ? 429 : 400;
      res.status(status).json(result);
      return;
    }

    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error sending verification code:', err);
    res.status(500).json({ success: false, message: 'Failed to dispatch verification code' });
  }
});

// POST /api/auth/email/verify-code
router.post('/email/verify-code', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      res.status(400).json({ success: false, message: 'Email and 4-digit verification code are required' });
      return;
    }
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();
    const result = await EmailVerificationService.verifyCode(email, code, clientIp);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error verifying code:', err);
    res.status(500).json({ success: false, message: 'Failed to verify code' });
  }
});

// POST /api/auth/email/signin - Customer sign in & token issuance with verified 4-digit code
router.post('/email/signin', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, code, name } = req.body;
    if (!email || !code) {
      res.status(400).json({ success: false, message: 'Email and 4-digit verification code are required' });
      return;
    }
    const cleanEmail = email.toLowerCase().trim();
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();

    // 1. Verify 4-digit OTP
    const verifyResult = await EmailVerificationService.verifyCode(cleanEmail, String(code).trim(), clientIp);
    if (!verifyResult.success) {
      res.status(400).json(verifyResult);
      return;
    }

    // 2. Resolve or create Firebase Auth user
    let uid: string | null = null;
    let isNewUser = false;
    let userData: any = null;

    try {
      const userRecord = await adminAuth.getUserByEmail(cleanEmail);
      uid = userRecord.uid;
      if (!userRecord.emailVerified) {
        await adminAuth.updateUser(uid, { emailVerified: true }).catch(() => {});
      }
    } catch (authErr: any) {
      if (authErr.code === 'auth/user-not-found') {
        const newUser = await adminAuth.createUser({
          email: cleanEmail,
          emailVerified: true,
          displayName: name || cleanEmail.split('@')[0],
        });
        uid = newUser.uid;
        isNewUser = true;
      } else {
        console.error('[AuthRoutes] Firebase getUserByEmail error:', authErr);
        throw authErr;
      }
    }

    // 3. Set custom user claims for role
    await adminAuth.setCustomUserClaims(uid, { role: 'customer' }).catch((e) => {
      console.warn('[AuthRoutes] Failed setting custom claims:', e.message);
    });

    // 4. Resolve or create Firestore users document
    const userRef = adminDb.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      userData = userDoc.data();
      await userRef.set({
        email: cleanEmail,
        emailVerified: true,
        lastLoginAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } else {
      isNewUser = true;
      userData = {
        firebase_uid: uid,
        email: cleanEmail,
        emailVerified: true,
        role: 'customer',
        name: name || cleanEmail.split('@')[0] || 'Customer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        verificationMethod: 'email_otp',
      };
      await userRef.set(userData);
    }

    // 5. Generate custom token for client-side Firebase Auth sign-in
    const customToken = await adminAuth.createCustomToken(uid, { role: 'customer' });

    res.json({
      success: true,
      customToken,
      user: {
        uid,
        email: cleanEmail,
        name: userData?.name || name || cleanEmail.split('@')[0],
        phone: userData?.phone || null,
        phoneVerified: Boolean(userData?.phoneVerified),
        role: 'customer',
      },
      isNewUser,
    });
  } catch (err: any) {
    console.error('[AuthRoutes] Error in email signin:', err);
    res.status(500).json({ success: false, message: 'Failed to complete sign in. Please try again.' });
  }
});

// ============================================================================
// CUSTOMER ONBOARDING: LINK EMAIL (OPTIONAL STEP 4)
// Supports: Manual 4-Digit OTP Verification OR Google Account ID Token Link OR Skip
// ============================================================================
router.post('/customer/link-email', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const { email, code, googleIdToken, skip } = req.body;
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();

    // 1. If customer chooses to skip
    if (skip === true) {
      await adminDb.collection('users').doc(uid).set({
        emailSkipped: true,
        emailSkippedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      res.json({
        success: true,
        skipped: true,
        message: 'Email linking skipped successfully',
      });
      return;
    }

    let verifiedEmail: string | null = null;
    let provider = 'email_otp';

    // 2. Google Verified Token
    if (googleIdToken) {
      try {
        const decoded = await adminAuth.verifyIdToken(googleIdToken);
        if (!decoded.email) {
          res.status(400).json({ success: false, message: 'No email found in Google credential' });
          return;
        }
        verifiedEmail = decoded.email.toLowerCase().trim();
        provider = 'google.com';
      } catch (tokenErr: any) {
        console.error('[AuthRoutes] Invalid Google ID token for link-email:', tokenErr);
        res.status(400).json({ success: false, message: 'Invalid Google authentication token' });
        return;
      }
    } else if (email && code) {
      // 3. Manual 4-digit OTP verification
      const cleanEmail = String(email).toLowerCase().trim();
      const verifyResult = await EmailVerificationService.verifyCode(cleanEmail, String(code).trim(), clientIp);
      if (!verifyResult.success) {
        res.status(400).json(verifyResult);
        return;
      }
      verifiedEmail = cleanEmail;
      provider = 'email_otp';
    } else {
      res.status(400).json({
        success: false,
        message: 'Provide either email + 4-digit code, a valid googleIdToken, or skip: true',
      });
      return;
    }

    // 4. Update Firestore user document
    const userRef = adminDb.collection('users').doc(uid);
    await userRef.set({
      email: verifiedEmail,
      emailVerified: true,
      emailLinkedAt: new Date().toISOString(),
      emailProvider: provider,
      emailSkipped: false,
      updatedAt: new Date().toISOString(),
      role: 'customer', // strictly enforce customer role
    }, { merge: true });

    // 5. Update Firebase Auth user profile if possible (graceful fallback if email already linked to another auth account)
    try {
      await adminAuth.updateUser(uid, {
        email: verifiedEmail,
        emailVerified: true,
      });
    } catch (firebaseAuthErr: any) {
      console.warn('[AuthRoutes] Notice: could not update Firebase Auth user record directly (may already exist):', firebaseAuthErr.message);
      // Still consider success since Firestore profile is updated and verified
    }

    res.json({
      success: true,
      email: verifiedEmail,
      emailVerified: true,
      provider,
      message: 'Email linked and verified successfully',
    });
  } catch (err: any) {
    console.error('[AuthRoutes] Error in /customer/link-email:', err);
    res.status(500).json({ success: false, message: 'Failed to link email. Please try again.' });
  }
});

// ============================================================================
// POS 4-DIGIT OPERATIONAL PIN MANAGEMENT & UNLOCK
// ============================================================================

// GET /api/auth/pos/pin/status - Check whether PIN is configured and lock status
router.get('/pos/pin/status', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    const status = await PosPinService.checkPinStatus(uid);
    res.json({ success: true, ...status });
  } catch (err: any) {
    console.error('[AuthRoutes] Error checking POS PIN status:', err);
    res.status(500).json({ success: false, message: 'Failed to query PIN status' });
  }
});

// POST /api/auth/pos/pin/setup - Setup 4-digit PIN for first-time POS user
router.post('/pos/pin/setup', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const { pin } = req.body;
    if (!uid) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    const result = await PosPinService.setupPin(uid, pin);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error setting POS PIN:', err);
    res.status(500).json({ success: false, message: 'Failed to configure PIN' });
  }
});

// POST /api/auth/pos/pin/verify - Verify 4-digit PIN on app unlock / restart
router.post('/pos/pin/verify', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const uid = req.user?.uid;
    const { pin } = req.body;
    if (!uid) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    const clientIp = (req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0] || '127.0.0.1').trim();
    const result = await PosPinService.verifyPin(uid, pin, clientIp);

    if (!result.success) {
      const status = result.locked ? 423 : 400; // 423 Locked
      res.status(status).json(result);
      return;
    }

    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error verifying POS PIN:', err);
    res.status(500).json({ success: false, message: 'Failed to verify PIN' });
  }
});

// ============================================================================
// OWNER-CONTROLLED POS PASSWORD RESET WORKFLOW
// ============================================================================

// POST /api/auth/password-reset/request - POS operator submits reset request
router.post('/password-reset/request', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, appTarget = 'POS' } = req.body;
    if (!email) {
      res.status(400).json({ success: false, message: 'Email is required' });
      return;
    }
    const result = await PasswordResetWorkflowService.requestReset(email, appTarget);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error requesting password reset:', err);
    res.status(500).json({ success: false, message: 'Failed to submit password reset request' });
  }
});

// GET /api/auth/password-reset/pending - Owner lists pending reset requests
router.get('/password-reset/pending', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const requests = await PasswordResetWorkflowService.listPendingRequests();
    res.json({ success: true, requests });
  } catch (err: any) {
    console.error('[AuthRoutes] Error listing pending reset requests:', err);
    res.status(500).json({ success: false, message: 'Failed to list reset requests' });
  }
});

// POST /api/auth/password-reset/send-email - Owner approves and triggers Firebase password reset email
router.post('/password-reset/send-email', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      res.status(400).json({ success: false, message: 'Request ID is required' });
      return;
    }
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PasswordResetWorkflowService.sendResetEmail(requestId, ownerEmail);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error sending reset email:', err);
    res.status(500).json({ success: false, message: 'Failed to send reset email' });
  }
});

// POST /api/auth/password-reset/reject - Owner rejects reset request
router.post('/password-reset/reject', verifyToken, requireRole(['owner', 'admin', 'developer', 'platform_owner']), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { requestId, reason } = req.body;
    if (!requestId) {
      res.status(400).json({ success: false, message: 'Request ID is required' });
      return;
    }
    const ownerEmail = req.user?.email || 'owner@olivepizza.in';
    const result = await PasswordResetWorkflowService.rejectReset(requestId, ownerEmail, reason);
    if (!result.success) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('[AuthRoutes] Error rejecting reset request:', err);
    res.status(500).json({ success: false, message: 'Failed to reject reset request' });
  }
});

// ============================================================================
// DESKTOP APP AUTHENTICATION BRIDGE (System Browser Loopback Gateway)
// ============================================================================
router.get('/desktop-login', async (req: Request, res: Response): Promise<void> => {
  const desktopCallback = String(req.query.desktop_callback || '');
  const appTarget = String(req.query.app || 'POS').toUpperCase();

  // Validate loopback IP callback safety
  const isLoopbackCallback = desktopCallback.startsWith('http://127.0.0.1:') || desktopCallback.startsWith('http://localhost:');
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Olive Pizza — Desktop App Authentication</title>
  <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0B0F17;
      color: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: #131B2B;
      border: 1px solid #1E293B;
      border-radius: 24px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .logo {
      font-size: 48px;
      margin-bottom: 12px;
      display: inline-block;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #FFFFFF;
    }
    p {
      font-size: 14px;
      color: #94A3B8;
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .btn {
      width: 100%;
      padding: 14px 20px;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .btn-google {
      background: #FFFFFF;
      color: #0F172A;
      box-shadow: 0 4px 12px rgba(255, 255, 255, 0.1);
    }
    .btn-google:hover {
      background: #F1F5F9;
      transform: translateY(-1px);
    }
    .status {
      margin-top: 20px;
      font-size: 13px;
      color: #38BDF8;
      display: none;
    }
    .error {
      margin-top: 20px;
      font-size: 13px;
      color: #F87171;
      display: none;
      word-break: break-word;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      background: rgba(249, 115, 22, 0.1);
      color: #FB923C;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 16px;
      border: 1px solid rgba(249, 115, 22, 0.2);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🍕</div>
    <div><span class="badge">Desktop Authentication • ${appTarget}</span></div>
    <h1>Sign in to Olive Pizza</h1>
    <p>Authenticate securely using your system browser. Upon successful sign-in, your desktop app will activate automatically.</p>

    <button id="googleBtn" class="btn btn-google" onclick="handleGoogleSignIn()">
      <svg width="18" height="18" viewBox="0 0 18 18">
        <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z"/>
        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
        <path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707 0-.59.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.347 2.825.957 4.039l3.007-2.332z"/>
        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/>
      </svg>
      Continue with Google
    </button>

    <div id="statusMsg" class="status">Authenticating & transferring session to desktop app...</div>
    <div id="errorMsg" class="error"></div>
  </div>

  <script>
    const firebaseConfig = {
      apiKey: "${process.env.VITE_FIREBASE_API_KEY || 'AIzaSyAqkcY-WQrW3WoZWRrv8oo7MTAI_nVrLw4'}",
      authDomain: "olive-pizza-08.firebaseapp.com",
      projectId: "olive-pizza-08",
      storageBucket: "olive-pizza-08.firebasestorage.app",
      messagingSenderId: "1017239455106",
      appId: "1:1017239455106:web:0607d00669decfd9007b9b"
    };

    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const desktopCallback = "${desktopCallback}";

    async function handleGoogleSignIn() {
      const btn = document.getElementById('googleBtn');
      const status = document.getElementById('statusMsg');
      const errEl = document.getElementById('errorMsg');
      btn.disabled = true;
      btn.style.opacity = '0.6';
      status.style.display = 'block';
      errEl.style.display = 'none';

      try {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const result = await auth.signInWithPopup(provider);
        const user = result.user;
        const idToken = await user.getIdToken();

        // Exchange for desktop custom token and authorize
        const resp = await fetch('/api/auth/desktop-login/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            appTarget: "${appTarget}",
            uid: user.uid,
            email: user.email
          })
        });

        const data = await resp.json();
        if (!data.success) {
          throw new Error(data.message || 'Authorization failed for desktop terminal.');
        }

        status.innerText = '✓ Success! Returning to desktop application...';
        status.style.color = '#4ADE80';

        if (desktopCallback && ("${isLoopbackCallback}" === "true")) {
          const redirectUrl = new URL(desktopCallback);
          redirectUrl.searchParams.set('customToken', data.customToken);
          redirectUrl.searchParams.set('idToken', idToken);
          redirectUrl.searchParams.set('email', user.email || '');
          window.location.href = redirectUrl.toString();
        } else {
          status.innerText = '✓ Authenticated! Please return to your Olive Pizza desktop app.';
        }
      } catch (err) {
        console.error('Desktop auth error:', err);
        btn.disabled = false;
        btn.style.opacity = '1';
        status.style.display = 'none';
        errEl.innerText = err.message || 'Authentication failed. Please try again.';
        errEl.style.display = 'block';

        if (desktopCallback && ("${isLoopbackCallback}" === "true")) {
          try {
            const redirectUrl = new URL(desktopCallback);
            redirectUrl.searchParams.set('error', err.message || 'Auth failed');
            window.location.href = redirectUrl.toString();
          } catch (_) {}
        }
      }
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

router.post('/desktop-login/complete', async (req: Request, res: Response): Promise<void> => {
  try {
    const { idToken, appTarget, uid, email } = req.body;
    if (!idToken) {
      res.status(400).json({ success: false, message: 'Identity token is required' });
      return;
    }

    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (err: any) {
      if (err.code === 'auth/id-token-revoked' || err.message?.includes('revoked')) {
        res.status(403).json({ success: false, authorized: false, code: 'ACCOUNT_REVOKED', message: 'Forbidden: Account has been revoked' });
        return;
      }
      try {
        decoded = await adminAuth.verifyIdToken(idToken, false);
      } catch (innerErr: any) {
        res.status(401).json({ success: false, message: 'Invalid identity token signature' });
        return;
      }
    }
    const targetUid = decoded.uid;
    const targetEmail = (decoded.email || email || '').toLowerCase().trim();

    // Verify operational permissions with FranchiseAccessService
    const resolution = await FranchiseAccessService.resolveAuthorization({
      uid: targetUid,
      email: targetEmail,
      phoneNumber: decoded.phone_number,
      emailVerified: decoded.email_verified,
      targetApp: appTarget || 'POS'
    });

    if (!resolution.authorized) {
      res.status(403).json({
        success: false,
        authorized: false,
        code: resolution.code,
        message: resolution.reason || 'This account is not authorized for this desktop application.'
      });
      return;
    }

    // Generate authenticated Custom Token for desktop client session
    const customToken = await adminAuth.createCustomToken(targetUid, {
      role: resolution.user?.role || 'staff',
      targetApp: appTarget || 'POS'
    });

    res.json({
      success: true,
      customToken,
      user: resolution.user
    });
  } catch (err: any) {
    console.error('[AuthRoutes] Desktop auth completion error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to complete desktop authentication' });
  }
});

import { handlePhoneSignin } from './phoneVerification.routes.js';
router.post('/signin', authLimiter, handlePhoneSignin);

export default router;
