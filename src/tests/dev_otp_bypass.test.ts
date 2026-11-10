import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DevOtpBypassService } from '../services/phone-verification/DevOtpBypassService.js';
import { FirebasePhoneVerificationProvider } from '../services/phone-verification/FirebasePhoneVerificationProvider.js';

describe('Development-Only OTP Bypass Test Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env before each test
    process.env = { ...originalEnv };
    delete process.env.DEV_OTP_BYPASS;
    delete process.env.VERCEL_ENV;
    delete process.env.ENVIRONMENT;
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('1. Security Guards & Environment Evaluation', () => {
    it('Should be DISABLED when DEV_OTP_BYPASS is not set or false', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.DEV_OTP_BYPASS;
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false);

      process.env.DEV_OTP_BYPASS = 'false';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false);

      process.env.DEV_OTP_BYPASS = '0';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false);
    });

    it('Should be ENABLED in development when DEV_OTP_BYPASS=true or 1', () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), true);

      process.env.DEV_OTP_BYPASS = '1';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), true);

      process.env.DEV_OTP_BYPASS = ' TRUE ';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), true);
    });

    it('FAIL-CLOSED: NEVER allows bypass when NODE_ENV is production, even if DEV_OTP_BYPASS=true', () => {
      process.env.NODE_ENV = 'production';
      process.env.DEV_OTP_BYPASS = 'true';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false, 'Must fail closed in production');
    });

    it('FAIL-CLOSED: Rejects bypass when VERCEL_ENV is production', () => {
      process.env.NODE_ENV = 'development';
      process.env.VERCEL_ENV = 'production';
      process.env.DEV_OTP_BYPASS = 'true';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false, 'Must fail closed when VERCEL_ENV is production');
    });

    it('FAIL-CLOSED: Rejects bypass when ENVIRONMENT or APP_ENV is production', () => {
      process.env.NODE_ENV = 'development';
      process.env.ENVIRONMENT = 'production';
      process.env.DEV_OTP_BYPASS = 'true';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false, 'Must fail closed when ENVIRONMENT is production');

      delete process.env.ENVIRONMENT;
      process.env.APP_ENV = 'production';
      assert.strictEqual(DevOtpBypassService.isDevOtpBypassActive(), false, 'Must fail closed when APP_ENV is production');
    });

    it('Provides diagnostic status reporting without leaking secrets', () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const status = DevOtpBypassService.getStatus();
      assert.strictEqual(status.devOtpBypass, true);
      assert.ok(status.message.includes('DEV OTP BYPASS ACTIVE'));

      process.env.DEV_OTP_BYPASS = 'false';
      const disabledStatus = DevOtpBypassService.getStatus();
      assert.strictEqual(disabledStatus.devOtpBypass, false);
      assert.ok(disabledStatus.message.includes('Production OTP Verification Active'));
    });
  });

  describe('2. Provider Verification Behavior', () => {
    it('Dev + Bypass Enabled: Any valid non-empty OTP succeeds without specific code requirement', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      const testPhone = '+919876543210';

      // Test with arbitrary OTP values
      const res1 = await provider.verifyOtp(testPhone, 'custom_otp_999', 'test_user_1');
      assert.strictEqual(res1.success, true);
      assert.strictEqual(res1.phone, testPhone);
      assert.strictEqual(res1.provider, 'dev_bypass');

      const res2 = await provider.verifyOtp(testPhone, '1', 'test_user_1');
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res2.provider, 'dev_bypass');

      const res3 = await provider.verifyOtp(testPhone, 'random-alphanumeric-test', 'test_user_1');
      assert.strictEqual(res3.success, true);
      assert.strictEqual(res3.provider, 'dev_bypass');
    });

    it('Dev + Bypass Disabled: Random OTP is rejected and normal verification is required', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'false';
      const provider = new FirebasePhoneVerificationProvider();

      const testPhone = '+919876543210';
      const res = await provider.verifyOtp(testPhone, 'any_otp_code', 'test_user_1');
      assert.strictEqual(res.success, false);
      assert.ok(res.error?.includes('verify the phone OTP using Firebase Phone Auth'));
    });

    it('Production + Bypass=true: Strict rejection (Bypass completely disabled)', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      const testPhone = '+919876543210';
      const res = await provider.verifyOtp(testPhone, 'any_otp_code', 'test_user_1');
      assert.strictEqual(res.success, false);
      assert.ok(res.error?.includes('verify the phone OTP using Firebase Phone Auth'));
    });

    it('Empty or whitespace OTP: STRICTLY REJECTED even with dev bypass active', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      const testPhone = '+919876543210';

      const resEmpty = await provider.verifyOtp(testPhone, '', 'test_user_1');
      assert.strictEqual(resEmpty.success, false);
      assert.strictEqual(resEmpty.error, 'OTP code cannot be empty.');

      const resWhitespace = await provider.verifyOtp(testPhone, '   ', 'test_user_1');
      assert.strictEqual(resWhitespace.success, false);
      assert.strictEqual(resWhitespace.error, 'OTP code cannot be empty.');
    });

    it('Invalid phone number: STRICTLY REJECTED even with dev bypass active', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      const resShort = await provider.verifyOtp('12345', 'valid_otp', 'test_user_1');
      assert.strictEqual(resShort.success, false);
      assert.ok(resShort.error?.includes('Invalid phone number format'));

      const resAlpha = await provider.verifyOtp('not-a-phone', 'valid_otp', 'test_user_1');
      assert.strictEqual(resAlpha.success, false);
      assert.ok(resAlpha.error?.includes('Invalid phone number format'));

      const resEmptyPhone = await provider.verifyOtp('', 'valid_otp', 'test_user_1');
      assert.strictEqual(resEmptyPhone.success, false);
      assert.ok(resEmptyPhone.error?.includes('Phone number is required'));
    });

    it('Preserves phone format normalization when verified', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      // 10 digits without prefix
      const res = await provider.verifyOtp('9876543210', 'any_code', 'test_user_1');
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.phone, '+919876543210');
    });
  });

  describe('3. Privacy & Security Rules Compliance', () => {
    it('Never logs OTP values during execution', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DEV_OTP_BYPASS = 'true';
      const provider = new FirebasePhoneVerificationProvider();

      const secretOtp = 'super_secret_otp_code_98765';
      const loggedMessages: string[] = [];

      const originalConsoleLog = console.log;
      const originalConsoleWarn = console.warn;
      const originalConsoleError = console.error;

      console.log = (...args) => loggedMessages.push(args.join(' '));
      console.warn = (...args) => loggedMessages.push(args.join(' '));
      console.error = (...args) => loggedMessages.push(args.join(' '));

      try {
        await provider.verifyOtp('+919876543210', secretOtp, 'test_user_1');
      } finally {
        console.log = originalConsoleLog;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
      }

      for (const msg of loggedMessages) {
        assert.ok(!msg.includes(secretOtp), `Logged message must NOT contain OTP: ${msg}`);
      }
    });
  });
});
