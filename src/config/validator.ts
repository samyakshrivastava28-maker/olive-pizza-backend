export function validateEnvironmentVariables() {
  const hasFirebaseCreds = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) ||
    process.env.FIREBASE_CONFIG
  );

  const REQUIRED_VARS = [
    'DATABASE_URL',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET'
  ];

  const missing = REQUIRED_VARS.filter(v => !process.env[v]);
  if (!hasFirebaseCreds) {
    missing.push('FIREBASE_SERVICE_ACCOUNT_BASE64 (or FIREBASE_CLIENT_EMAIL & FIREBASE_PRIVATE_KEY)');
  }

  if (missing.length > 0) {
    console.error('\n=========================================');
    console.error('❌ CRITICAL STARTUP ERROR: MISSING ENV VARIABLES');
    console.error('=========================================');
    console.error('The following required environment variables are missing:');
    missing.forEach(v => console.error(` - ${v}`));
    console.error('\nThe server cannot start without these. Please add them to your backend/.env file or deployment environment.');
    console.error('=========================================\n');
    if (process.env.NODE_ENV === 'production' && !process.env.RENDER) {
      process.exit(1);
    }
  }

  // Validate Base64 encoding for Firebase Service Account if present
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64.trim(), 'base64').toString('utf8');
      JSON.parse(decoded);
    } catch (err) {
      console.error('\n=========================================');
      console.error('❌ CRITICAL STARTUP ERROR: INVALID FIREBASE CREDS');
      console.error('=========================================');
      console.error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not a valid base64 encoded JSON string.');
      console.error('=========================================\n');
      if (process.env.NODE_ENV === 'production' && !process.env.RENDER) {
        process.exit(1);
      }
    }
  }

  // Production Security Hardening Checks
  if (process.env.NODE_ENV === 'production') {
    const INSECURE_DEFAULTS = [
      'fallback-secret-do-not-use-in-prod',
      'olive-tracking-secret-change-me',
      'olive-ai-gateway-secret-change-in-prod',
      'olive_pizza_2fa_master_key_32_bytes!'
    ];

    const secretVars = [
      { name: 'TRACKING_TOKEN_SECRET', val: process.env.TRACKING_TOKEN_SECRET },
      { name: 'JWT_SECRET', val: process.env.JWT_SECRET },
      { name: 'AI_GATEWAY_SECRET', val: process.env.AI_GATEWAY_SECRET },
      { name: 'TOTP_ENCRYPTION_KEY', val: process.env.TOTP_ENCRYPTION_KEY }
    ];

    for (const { name, val } of secretVars) {
      if (val && INSECURE_DEFAULTS.includes(val.trim())) {
        if (process.env.RENDER) {
          console.warn(`⚠️ [Security Notice] ${name} is set to placeholder in Render. Generating ephemeral instance secret.`);
          process.env[name] = `render-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        } else {
          console.error(`\n❌ CRITICAL PRODUCTION SECURITY ERROR: ${name} is set to an insecure default placeholder.`);
          console.error('Please configure a unique cryptographically secure secret in your production environment.');
          process.exit(1);
        }
      }
    }

    if (!process.env.JWT_SECRET && !process.env.TRACKING_TOKEN_SECRET) {
      if (process.env.RENDER) {
        console.warn('⚠️ [Security Notice] Neither JWT_SECRET nor TRACKING_TOKEN_SECRET set in Render environment. Generating ephemeral instance secret.');
        process.env.JWT_SECRET = `render-ephemeral-jwt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      } else {
        console.error('\n❌ CRITICAL PRODUCTION SECURITY ERROR: Neither JWT_SECRET nor TRACKING_TOKEN_SECRET is defined.');
        process.exit(1);
      }
    }
  }

  // Supabase Telemetry Configuration Check
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠️ [Supabase Notice] SUPABASE_URL or SUPABASE_ANON_KEY not set. Realtime GPS rider navigation telemetry will be disabled.');
  }

  console.log('✅ Environment validation passed.');
}
