import express, { Request, Response } from 'express';
import { adminDb, adminAuth } from '../config/firebase.js';
import { phoneVerificationService } from '../services/phone-verification/PhoneVerificationService.js';
import { authLimiter } from '../config/security.config.js';
import { DevOtpBypassService } from '../services/phone-verification/DevOtpBypassService.js';
import { veriphoneService } from '../services/phone-verification/VeriphoneService.js';

const router = express.Router();
const truecaller = phoneVerificationService.getTruecallerProvider();

// Authentication Middleware with fallback to body/header UID
const authenticateUser = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  let userUid = req.body?.userId || (req.headers['x-user-uid'] as string);

  if (token) {
    try {
      const decoded = await adminAuth.verifyIdToken(token, false);
      (req as any).user = decoded;
      return next();
    } catch (error) {
      console.warn('[PhoneVerification] Token verification fallback:', error);
    }
  }

  (req as any).user = { uid: userUid || `anon_${Date.now()}` };
  next();
};

// Public/Semi-public Web Session Management for Truecaller
router.post('/truecaller/session', authLimiter, authenticateUser, async (req: Request, res: Response) => {
  try {
    const { expectedPhone } = req.body;
    const uid = (req as any).user?.uid;

    if (!truecaller.isConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'TRUECALLER_CONFIG_MISSING',
        error: 'Truecaller verification is not configured for this environment.'
      });
    }

    if (expectedPhone && typeof expectedPhone === 'string') {
      const digits = expectedPhone.replace(/\D/g, '');
      if (digits.length < 10) {
        return res.status(400).json({
          success: false,
          code: 'TRUECALLER_REQUEST_INVALID',
          error: 'Invalid phone number format provided.'
        });
      }
    }

    const session = await truecaller.createWebSession(expectedPhone, uid);
    return res.json({
      success: true,
      requestId: session.requestId,
      deepLink: session.deepLink,
      bridgeUrl: session.bridgeUrl,
      expiresAt: session.expiresAt
    });
  } catch (error: any) {
    console.error('[PhoneVerification] Create Truecaller session error:', error);
    return res.status(500).json({
      success: false,
      code: 'TRUECALLER_SESSION_CREATE_FAILED',
      error: 'Failed to create Truecaller verification session.'
    });
  }
});

// Mobile QR Bridge: When any smartphone camera scans the desktop QR code,
// this webpage opens and immediately triggers the Truecaller deep link.
router.get(['/truecaller/bridge', '/bridge'], async (req: Request, res: Response) => {
  const requestId = (req.query?.requestId as string)?.trim();
  if (!requestId) {
    return res.status(400).send('<h3>Invalid Request: Missing verification requestId.</h3>');
  }

  const session = await truecaller.getWebSession(requestId);
  if (!session) {
    return res.status(404).send('<h3>Session Expired: Please generate a new QR code on Olive Pizza.</h3>');
  }

  const deepLink = session.deepLink || `truecallersdk://truesdk/web_verify?type=btmsheet&requestNonce=${requestId}&partnerKey=${encodeURIComponent(truecaller.getClientId())}&partnerName=Olive%20Pizza&lang=en&title=Verify%20Number`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify with Truecaller — Olive Pizza</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; text-align: center; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 20px; padding: 32px 24px; max-width: 420px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .logo { width: 64px; height: 64px; margin-bottom: 16px; border-radius: 16px; }
    h1 { font-size: 22px; font-weight: 800; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px; }
    .btn { display: block; width: 100%; background: #0087ff; color: #fff; font-weight: 700; font-size: 16px; padding: 14px 20px; border-radius: 12px; text-decoration: none; border: none; cursor: pointer; transition: background 0.2s; box-shadow: 0 4px 14px rgba(0,135,255,0.4); margin-bottom: 12px; }
    .btn:hover { background: #0070d6; }
    .btn-secondary { background: #334155; color: #cbd5e1; box-shadow: none; }
    .status-box { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; background: rgba(51,65,85,0.5); }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 1s ease-in-out infinite; vertical-align: middle; margin-right: 8px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .verified-badge { color: #10b981; font-weight: 700; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 44px; margin-bottom: 12px;">🍕</div>
    <h1>Olive Pizza Verification</h1>
    <p>Opening Truecaller to verify your mobile number securely...</p>

    <a id="tcLink" href="${deepLink}" class="btn">
      Open Truecaller App
    </a>

    <div class="status-box" id="statusBox">
      <span class="spinner" id="spinner"></span>
      <span id="statusText">Waiting for verification...</span>
      <span class="verified-badge" id="verifiedText">✅ Verified! You can return to your computer.</span>
    </div>
  </div>

  <script>
    const deepLink = ${JSON.stringify(deepLink)};
    const requestId = ${JSON.stringify(requestId)};

    // Auto-trigger deep link intent
    try {
      window.location.href = deepLink;
    } catch (e) {}

    // Poll status every 1.5s
    const pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/phone/truecaller/session/' + requestId);
        const data = await res.json();
        if (data.status === 'VERIFIED') {
          clearInterval(pollTimer);
          document.getElementById('spinner').style.display = 'none';
          document.getElementById('statusText').style.display = 'none';
          document.getElementById('verifiedText').style.display = 'inline';
          document.getElementById('tcLink').style.background = '#10b981';
          document.getElementById('tcLink').textContent = '✅ Verified Successfully';
        }
      } catch (err) {}
    }, 1500);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

router.get('/truecaller/session/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    if (!requestId || requestId.length < 8) {
      return res.status(400).json({
        success: false,
        code: 'TRUECALLER_REQUEST_INVALID',
        error: 'Invalid requestId parameter.'
      });
    }

    const session = await truecaller.getWebSession(requestId);
    if (!session) {
      return res.status(404).json({
        success: false,
        code: 'TRUECALLER_SESSION_EXPIRED',
        error: 'Verification session not found or expired.'
      });
    }
    const customToken = session.status === 'VERIFIED' ? session.customToken : undefined;
    return res.json({
      success: true,
      status: session.status,
      phone: session.phone,
      error: session.error,
      name: session.name,
      country: session.country,
      customToken,
      userId: session.userId
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      code: 'TRUECALLER_PROVIDER_UNAVAILABLE',
      error: 'Failed to query Truecaller session.'
    });
  }
});

// Probe / Health verification endpoint for Truecaller Developer Portal
router.get(['/truecaller/callback', '/callback', '/'], (_req: Request, res: Response) => {
  return res.json({
    success: true,
    message: 'Truecaller webhook callback endpoint is active and listening.'
  });
});

// Webhook callback called by Truecaller cloud when user completes web verification on mobile
const handleTruecallerWebhook = async (req: Request, res: Response) => {
  try {
    const requestId = (
      req.body?.requestId ||
      req.body?.requestNonce ||
      req.query?.requestId ||
      req.query?.requestNonce ||
      req.params?.requestId
    )?.toString().trim();

    const accessToken = (
      req.body?.accessToken ||
      req.body?.access_token ||
      req.query?.accessToken ||
      req.query?.access_token
    )?.toString().trim();

    const rawEndpoint = (
      req.body?.endpoint ||
      req.body?.profileEndpoint ||
      req.query?.endpoint ||
      req.query?.profileEndpoint
    )?.toString().trim();

    const endpoint = rawEndpoint || 'https://profile4-noneu.truecaller.com/v1/default';
    const payload = req.body?.payload || req.query?.payload;
    const signature = req.body?.signature || req.query?.signature;

    console.log(`[Truecaller Webhook] Received callback for requestId: ${requestId}, endpoint: ${endpoint}, hasToken: ${Boolean(accessToken)}, hasPayload: ${Boolean(payload)}`);

    if (!requestId) {
      console.warn('[Truecaller Webhook] Rejected: Missing requestId / requestNonce in callback payload:', req.body);
      return res.status(400).json({ success: false, error: 'Missing requestId or requestNonce parameter in callback.' });
    }

    if (!accessToken && (!payload || !signature)) {
      console.warn('[Truecaller Webhook] Rejected: Missing profile or crypto payload:', req.body);
      return res.status(400).json({
        success: false,
        error: 'Missing required callback fields (expected accessToken or payload+signature).'
      });
    }

    const payloadOrOptions = accessToken ? { accessToken, endpoint } : payload;
    const result = await truecaller.handleWebCallback(requestId, payloadOrOptions, signature);
    console.log(`[Truecaller Webhook] Processed callback for ${requestId}: success=${result.success}`);
    return res.json(result);
  } catch (error: any) {
    console.error('[Truecaller Webhook] Exception processing callback:', error);
    return res.status(500).json({ success: false, error: error.message || 'Callback verification failed.' });
  }
};

router.post(['/truecaller/callback', '/callback', '/'], handleTruecallerWebhook);

// Development OTP Bypass Status endpoint (Publicly checkable by dev frontend)
router.get('/dev-status', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    ...DevOtpBypassService.getStatus()
  });
});

router.use(authenticateUser);

router.post('/send-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { phoneNumber } = req.body;
    const uid = (req as any).user?.uid || req.body?.userId || 'anonymous';
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    const result = await phoneVerificationService.sendOtp(phoneNumber, uid, clientIp);
    if (!result.success) {
      return res.status(400).json(result);
    }

    const isBypass = DevOtpBypassService.isDevOtpBypassActive();
    return res.json({
      ...result,
      devOtpBypass: isBypass,
      message: isBypass
        ? '⚡ DEV OTP BYPASS ACTIVE: You may enter any code to verify.'
        : result.message
    });
  } catch (error: any) {
    console.error('[PhoneVerification] send-otp error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error while sending OTP.' });
  }
});

router.post('/verify-otp', authLimiter, async (req: Request, res: Response) => {
  try {
    const { phoneNumber, otp, pinId } = req.body;
    // Derive UID strictly from authenticated session to prevent unauthenticated account takeover
    const uid = (req as any).user?.uid;

    if (!phoneNumber || !otp) {
      return res.status(400).json({ success: false, error: 'Phone number and OTP code are required.' });
    }

    const result = await phoneVerificationService.verifyOtp(phoneNumber, otp, uid || 'anonymous', pinId);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    if (result.success && uid && !uid.startsWith('anon_')) {
      try {
        const userRef = adminDb.collection('users').doc(uid);
        await userRef.set({
          phone: result.phone,
          phoneVerified: true,
          verificationMethod: result.provider || 'firebase',
          verifiedAt: result.verifiedAt || Date.now(),
          phoneSetupCompleted: true
        }, { merge: true });
        
        const identityRef = adminDb.collection('customer_identities').doc(result.phone!);
        await identityRef.set({
          primaryUid: uid,
          verifiedAt: Date.now()
        }, { merge: true });

        // Enrich with Veriphone intelligence in background
        if (veriphoneService.isConfigured() && result.phone) {
          veriphoneService.verifyNumber(result.phone).then(async (intel) => {
            if (intel && intel.status === 'success') {
              await userRef.set({
                phoneIntelligence: {
                  phone_valid: intel.phone_valid,
                  phone_type: intel.phone_type || null,
                  carrier: intel.carrier || null,
                  country: intel.country || null,
                  country_code: intel.country_code || null,
                  region: intel.phone_region || null,
                  international_format: intel.international_number || null,
                  verifiedAt: Date.now()
                }
              }, { merge: true }).catch(() => {});

              await adminDb.collection('phone_intelligence').doc(result.phone!).set({
                ...intel,
                primaryUid: uid,
                verifiedAt: Date.now()
              }, { merge: true }).catch(() => {});
            }
          }).catch((e) => {
            console.warn('[PhoneVerification] Background Veriphone lookup error:', e.message);
          });
        }
      } catch (e: any) {
        console.warn('[PhoneVerification] Firestore update warning:', e.message);
      }
    }

    return res.json(result);
  } catch (error: any) {
    console.error('[PhoneVerification] verify-otp error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error while verifying OTP.' });
  }
});

// Direct Firebase Phone Auth ID Token Synchronization
router.post('/firebase-sync', authLimiter, async (req: Request, res: Response) => {
  try {
    const { idToken, name } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, error: 'Firebase ID Token is required.' });
    }

    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;
    const phone = decoded.phone_number;

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Token does not contain a verified phone number.' });
    }

    const now = Date.now();
    const userRef = adminDb.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const existing = userSnap.data() || {};

    await userRef.set({
      uid,
      phone,
      phoneVerified: true,
      verificationMethod: 'firebase',
      verifiedAt: now,
      phoneSetupCompleted: true,
      name: existing.name || name || 'Customer',
      email: existing.email || decoded.email || null,
      role: existing.role || 'customer',
      updatedAt: now
    }, { merge: true });

    await adminDb.collection('customer_identities').doc(phone).set({
      primaryUid: uid,
      verifiedAt: now
    }, { merge: true });

    return res.json({
      success: true,
      user: {
        uid,
        phone,
        name: existing.name || name || 'Customer',
        email: existing.email || decoded.email || null,
        phoneVerified: true,
        phoneSetupCompleted: true
      }
    });
  } catch (error: any) {
    console.error('[PhoneVerification] firebase-sync error:', error);
    return res.status(401).json({ success: false, error: 'Failed to verify Firebase authentication token.' });
  }
});

router.post('/truecaller', authLimiter, async (req: Request, res: Response) => {
  const { payload, signature, signatureAlgorithm, expectedPhone, requestId } = req.body;
  const uid = (req as any).user?.uid;
  
  try {
    const verifyInput = payload ? (typeof payload === 'string' && signature ? { payload, signature, signatureAlgorithm } : payload) : { requestId };
    const result = await truecaller.verifyProfile(verifyInput, uid, expectedPhone);
    
    if (!result.success || !result.phone) {
      return res.status(400).json(result);
    }

    // Resolve or provision account
    let targetUid = uid && !uid.startsWith('anon_') ? uid : null;
    if (!targetUid) {
      try {
        const userRecord = await adminAuth.getUserByPhoneNumber(result.phone);
        targetUid = userRecord.uid;
      } catch (err: any) {
        if (err.code === 'auth/user-not-found') {
          const newUser = await adminAuth.createUser({
            phoneNumber: result.phone,
            displayName: (result as any).name || 'Customer'
          });
          targetUid = newUser.uid;
        } else {
          throw err;
        }
      }
    }

    // Preserve existing claims/roles without demoting privileged users
    const existing = await adminAuth.getUser(targetUid);
    const existingClaims = (existing.customClaims || {}) as Record<string, any>;
    if (!existingClaims.role) {
      await adminAuth.setCustomUserClaims(targetUid, { ...existingClaims, role: 'customer' });
    }

    const customToken = await adminAuth.createCustomToken(targetUid);

    const userRef = adminDb.collection('users').doc(targetUid);
    await userRef.set({
      phone: result.phone,
      phoneVerified: true,
      verificationMethod: 'truecaller',
      verifiedAt: Date.now(),
      truecallerName: (result as any).name || null,
      truecallerCountry: (result as any).country || 'IN',
      phoneSetupCompleted: true,
      role: existingClaims.role || 'customer',
      updatedAt: new Date().toISOString()
    }, { merge: true });

    const identityRef = adminDb.collection('customer_identities').doc(result.phone);
    await identityRef.set({
      primaryUid: targetUid,
      verifiedAt: Date.now()
    }, { merge: true });

    return res.json({
      ...result,
      customToken,
      uid: targetUid
    });
  } catch (e: any) {
    console.error('[PhoneVerification] Truecaller endpoint exception:', e);
    return res.status(500).json({ success: false, error: e.message || 'Truecaller verification failed.' });
  }
});

export const handlePhoneSignin = async (req: Request, res: Response) => {
  const { method, phoneNumber, otp, pinId, requestId, payload, signature } = req.body;

  try {
    let verifiedPhone: string | null = null;
    let verifiedName: string | null = null;

    if (method === 'sms') {
      if (!phoneNumber || !otp || typeof otp !== 'string' || !otp.trim()) {
        return res.status(400).json({ success: false, error: 'Phone number and OTP code are required.' });
      }
      const verifyRes = await phoneVerificationService.verifyOtp(phoneNumber, otp.trim(), 'phone_signin', pinId);
      if (!verifyRes.success || !verifyRes.phone) {
        return res.status(400).json({ success: false, error: verifyRes.error || 'Invalid OTP code.' });
      }
      verifiedPhone = verifyRes.phone;
    } else if (method === 'truecaller') {
      const verifyInput = payload ? (typeof payload === 'string' && signature ? { payload, signature } : payload) : { requestId };
      const tcRes = await truecaller.verifyProfile(verifyInput, 'phone_signin');
      if (!tcRes.success || !tcRes.phone) {
        return res.status(400).json({ success: false, error: tcRes.error || 'Truecaller verification failed.' });
      }
      verifiedPhone = tcRes.phone;
      verifiedName = (tcRes as any).name || null;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid verification method specified.' });
    }

    // Resolve or provision account
    let uid: string | null = null;
    let userData: any = null;
    let isNewUser = false;

    // 1. Check customer_identities
    const identSnap = await adminDb.collection('customer_identities').doc(verifiedPhone).get();
    if (identSnap.exists) {
      uid = identSnap.data()?.primaryUid || null;
    }

    // 2. Check users collection by phone
    if (!uid) {
      const userSnap = await adminDb.collection('users')
        .where('phone', '==', verifiedPhone)
        .limit(1)
        .get();
      if (!userSnap.empty) {
        uid = userSnap.docs[0].id;
        userData = userSnap.docs[0].data();
      }
    } else {
      const userDoc = await adminDb.collection('users').doc(uid).get();
      if (userDoc.exists) {
        userData = userDoc.data();
      }
    }

    // 3. If account does not exist, provision clean customer account
    if (!uid) {
      isNewUser = true;
      try {
        const createdFirebaseUser = await adminAuth.createUser({
          phoneNumber: verifiedPhone,
          displayName: verifiedName || 'Customer',
        });
        uid = createdFirebaseUser.uid;
      } catch (authErr: any) {
        if (authErr.code === 'auth/phone-number-already-exists') {
          const existing = await adminAuth.getUserByPhoneNumber(verifiedPhone);
          uid = existing.uid;
        } else {
          uid = 'cust_' + Buffer.from(verifiedPhone).toString('hex').slice(0, 20);
        }
      }

      await adminAuth.setCustomUserClaims(uid, { role: 'customer' }).catch(() => {});

      userData = {
        firebase_uid: uid,
        phone: verifiedPhone,
        phoneVerified: true,
        phoneSetupCompleted: true,
        role: 'customer',
        name: verifiedName || 'Customer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        verificationMethod: method,
      };

      await adminDb.collection('users').doc(uid).set(userData, { merge: true });
    } else {
      await adminDb.collection('users').doc(uid).set({
        phone: verifiedPhone,
        phoneVerified: true,
        phoneSetupCompleted: true,
        updatedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      }, { merge: true });
    }

    // Enrich and persist phone intelligence in background without blocking login
    if (veriphoneService.isConfigured()) {
      veriphoneService.verifyNumber(verifiedPhone).then(async (intel) => {
        if (intel && intel.status === 'success') {
          await adminDb.collection('users').doc(uid).set({
            phoneIntelligence: {
              phone_valid: intel.phone_valid,
              phone_type: intel.phone_type || null,
              carrier: intel.carrier || null,
              country: intel.country || null,
              country_code: intel.country_code || null,
              region: intel.phone_region || null,
              international_format: intel.international_number || null,
              verifiedAt: Date.now()
            }
          }, { merge: true }).catch(() => {});

          await adminDb.collection('phone_intelligence').doc(verifiedPhone).set({
            ...intel,
            primaryUid: uid,
            verifiedAt: Date.now()
          }, { merge: true }).catch(() => {});
        }
      }).catch((e) => {
        console.warn('[PhoneVerification] Background Veriphone lookup error:', e.message);
      });
    }

    // Update customer_identities
    await adminDb.collection('customer_identities').doc(verifiedPhone).set({
      primaryUid: uid,
      verifiedAt: Date.now(),
    }, { merge: true });

    // Generate custom token for client-side Firebase Auth sign-in
    const customToken = await adminAuth.createCustomToken(uid, { role: userData?.role || 'customer' });

    return res.json({
      success: true,
      customToken,
      user: {
        uid,
        phone: verifiedPhone,
        name: userData?.name || verifiedName || 'Customer',
        email: userData?.email || null,
        role: userData?.role || 'customer',
        phoneVerified: true,
      },
      isNewUser,
    });
  } catch (err: any) {
    console.error('[PhoneVerification] signin error:', err);
    return res.status(500).json({ success: false, error: 'Sign in with phone failed. Please try again.' });
  }
};

router.post('/signin', authLimiter, handlePhoneSignin);

// Veriphone Phone Number Validation & Intelligence Endpoint
router.post('/intel-verify', authLimiter, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;
    if (!phone || typeof phone !== 'string' || phone.trim().length < 8) {
      return res.status(400).json({
        success: false,
        error: 'A valid phone number is required.'
      });
    }

    const intel = await veriphoneService.verifyNumber(phone);

    // Save/enrich intelligence to Firestore if valid
    const cleanPhone = intel.e164 || phone.trim();
    if (intel.status === 'success' && intel.phone_valid) {
      await adminDb.collection('phone_intelligence').doc(cleanPhone).set({
        phone: cleanPhone,
        phone_valid: intel.phone_valid,
        phone_type: intel.phone_type || null,
        phone_region: intel.phone_region || null,
        country: intel.country || null,
        country_code: intel.country_code || null,
        carrier: intel.carrier || null,
        international_number: intel.international_number || null,
        local_number: intel.local_number || null,
        timezone: intel.timezone || [],
        verifiedAt: Date.now()
      }, { merge: true }).catch((err) => {
        console.warn('[PhoneVerification] Failed to cache phone intelligence:', err.message);
      });
    }

    return res.json({
      success: true,
      valid: intel.phone_valid,
      data: intel
    });
  } catch (error: any) {
    console.error('[PhoneVerification] Veriphone verification error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Phone intelligence verification failed.'
    });
  }
});

router.get('/status', async (_req: Request, res: Response) => {
  const health = await phoneVerificationService.getHealthStatus();
  res.json({
    success: true,
    service: 'Firebase Auth, Truecaller & Veriphone Verification Service',
    devOtpBypass: DevOtpBypassService.isDevOtpBypassActive(),
    veriphoneConfigured: veriphoneService.isConfigured(),
    firebase: health.firebase,
    truecaller: health.truecaller
  });
});

export default router;
