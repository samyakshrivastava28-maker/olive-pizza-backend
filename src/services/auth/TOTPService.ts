import crypto from 'crypto';
import { adminDb } from '../../config/firebase.js';

/**
 * 🔐 Olive Pizza RFC 6238 TOTP Service
 * Provides standards-compliant TOTP generation, validation, AES-256-GCM encryption for stored secrets,
 * and emergency single-use backup recovery codes.
 */
export class TOTPService {
  private static readonly ENCRYPTION_KEY = (process.env.TOTP_ENCRYPTION_KEY || 'olive_pizza_2fa_master_key_32_bytes!').slice(0, 32);
  private static readonly STEP_SECONDS = 30;
  private static readonly DIGITS = 6;

  /**
   * Generates a random base32 encoded secret key (20 bytes / 160-bit entropy).
   */
  public static generateSecret(): string {
    const buffer = crypto.randomBytes(20);
    return this.base32Encode(buffer);
  }

  /**
   * Generates an otpauth:// URI for QR code generation in authenticator apps.
   */
  public static generateOtpAuthUri(secret: string, accountEmail: string, issuer: string = 'Olive Pizza'): string {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedAccount = encodeURIComponent(accountEmail);
    return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${this.DIGITS}&period=${this.STEP_SECONDS}`;
  }

  /**
   * Generates 8 random single-use backup recovery codes (format: XXXX-XXXX).
   */
  public static generateBackupCodes(count: number = 8): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      codes.push(`${part1}-${part2}`);
    }
    return codes;
  }

  /**
   * Generates current 6-digit TOTP code for a given timestamp.
   */
  public static generateTOTP(secret: string, timestampMs: number = Date.now()): string {
    const counter = Math.floor(timestampMs / 1000 / this.STEP_SECONDS);
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(counter), 0);

    const decodedSecret = this.base32Decode(secret);
    const hmac = crypto.createHmac('sha1', decodedSecret);
    hmac.update(buffer);
    const hash = hmac.digest();

    const offset = hash[hash.length - 1] & 0x0f;
    const binary = ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, this.DIGITS);
    return otp.toString().padStart(this.DIGITS, '0');
  }

  /**
   * Verifies a user-supplied 6-digit TOTP code with +/- 1 time-step clock drift allowance (90s window).
   */
  public static verifyTOTP(secret: string, userCode: string): boolean {
    if (!userCode || userCode.trim().length !== this.DIGITS) return false;
    const cleanCode = userCode.trim();
    const now = Date.now();

    for (let window = -1; window <= 1; window++) {
      const checkTime = now + (window * this.STEP_SECONDS * 1000);
      if (this.generateTOTP(secret, checkTime) === cleanCode) {
        return true;
      }
    }
    return false;
  }

  /**
   * Encrypts a TOTP secret using AES-256-GCM.
   */
  public static encryptSecret(plaintextSecret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.ENCRYPTION_KEY, 'utf-8'), iv);
    let encrypted = cipher.update(plaintextSecret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts a stored AES-256-GCM encrypted TOTP secret.
   */
  public static decryptSecret(encryptedPayload: string): string {
    const [ivHex, authTagHex, encryptedHex] = encryptedPayload.split(':');
    if (!ivHex || !authTagHex || !encryptedHex) throw new Error('Invalid encrypted TOTP payload');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.ENCRYPTION_KEY, 'utf-8'),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Verifies and burns a one-time backup recovery code for a user.
   */
  public static async verifyAndBurnBackupCode(uid: string, code: string): Promise<boolean> {
    const cleanCode = code.trim().toUpperCase();
    const docRef = adminDb.collection('user_2fa').doc(uid);
    const snap = await docRef.get();
    if (!snap.exists) return false;

    const data = snap.data()!;
    const codes: string[] = data.backupCodes || [];
    const index = codes.indexOf(cleanCode);
    if (index === -1) return false;

    // Burn code atomically
    codes.splice(index, 1);
    await docRef.update({
      backupCodes: codes,
      lastUsedAt: new Date().toISOString()
    });
    return true;
  }

  // ─── Base32 Encoding / Decoding Helpers ─────────────────────────────────────
  private static readonly RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  private static base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < buffer.length; i++) {
      value = (value << 8) | buffer[i];
      bits += 8;
      while (bits >= 5) {
        output += this.RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += this.RFC4648_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
  }

  private static base32Decode(str: string): Buffer {
    const cleanStr = str.replace(/=+$/, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (let i = 0; i < cleanStr.length; i++) {
      const idx = this.RFC4648_ALPHABET.indexOf(cleanStr[i]);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(output);
  }
}
