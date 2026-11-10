import { PhoneVerificationProvider, OTPRequestResult, VerificationResult } from './PhoneVerificationProvider.js';
import { FirebasePhoneVerificationProvider } from './FirebasePhoneVerificationProvider.js';
import { TruecallerProvider } from './TruecallerProvider.js';

export class PhoneVerificationService {
  private static instance: PhoneVerificationService;
  private firebaseProvider: FirebasePhoneVerificationProvider;
  private truecallerProvider: TruecallerProvider;

  private constructor() {
    this.firebaseProvider = new FirebasePhoneVerificationProvider();
    this.truecallerProvider = new TruecallerProvider();
  }

  public static getInstance(): PhoneVerificationService {
    if (!PhoneVerificationService.instance) {
      PhoneVerificationService.instance = new PhoneVerificationService();
    }
    return PhoneVerificationService.instance;
  }

  public getFirebaseProvider(): FirebasePhoneVerificationProvider {
    return this.firebaseProvider;
  }

  public getTruecallerProvider(): TruecallerProvider {
    return this.truecallerProvider;
  }

  public async sendOtp(phone: string, userId: string, ipAddress?: string): Promise<OTPRequestResult> {
    return this.firebaseProvider.sendOtp(phone, userId, ipAddress);
  }

  public async verifyOtp(phone: string, code: string, userId: string, pinId?: string): Promise<VerificationResult> {
    return this.firebaseProvider.verifyOtp(phone, code, userId, pinId);
  }

  public async getHealthStatus(): Promise<{
    firebase: { ok: boolean; configured: boolean; latencyMs?: number; error?: string };
    truecaller: { ok: boolean; configured: boolean };
  }> {
    const firebaseHealth = await this.firebaseProvider.getHealthStatus();
    return {
      firebase: {
        ok: firebaseHealth.ok,
        configured: firebaseHealth.configured,
        latencyMs: firebaseHealth.latencyMs,
        error: firebaseHealth.error
      },
      truecaller: {
        ok: true,
        configured: Boolean(process.env.TRUECALLER_CLIENT_ID)
      }
    };
  }
}

export const phoneVerificationService = PhoneVerificationService.getInstance();
