import bcrypt from 'bcrypt';

/**
 * Franchise Manager PIN Service
 *
 * Uses bcrypt with 12 salt rounds for PIN hashing.
 * Supports lockout after MAX_ATTEMPTS failed verifications.
 *
 * PIN is a secondary operational security layer:
 * - Stored in Firestore franchise_users.pinHash (never plaintext)
 * - Verified server-side only — never client-side
 * - Never transmitted or logged after input
 */
export class FranchisePinService {
  private static readonly SALT_ROUNDS = 12;
  public static readonly MAX_ATTEMPTS = 5;
  public static readonly LOCKOUT_MINUTES = 30;

  public static readonly WEAK_PINS = new Set([
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '0123', '9876', '1212', '1122', '2211', '1357', '2468', '2580'
  ]);

  /**
   * Validates PIN format and strength. Throws if invalid or weak.
   */
  public static validatePin(pin: string): void {
    if (!pin || typeof pin !== 'string') {
      throw new Error('PIN must be a non-empty string');
    }
    const cleanPin = pin.trim();
    if (!/^\d{4,6}$/.test(cleanPin)) {
      throw new Error('PIN must be between 4 and 6 numeric digits');
    }
    if (this.WEAK_PINS.has(cleanPin)) {
      throw new Error('This PIN is too common or easily guessed. Please choose a more secure PIN.');
    }
    // Check all identical digits
    if (/^(\d)\1+$/.test(cleanPin)) {
      throw new Error('PIN cannot consist of repeating single digits.');
    }
  }

  /**
   * Hash a PIN using bcrypt with 12 salt rounds.
   * Always call this on the server — never hash client-side.
   */
  public static async hashPin(pin: string): Promise<string> {
    this.validatePin(pin);
    return bcrypt.hash(pin.trim(), this.SALT_ROUNDS);
  }

  /**
   * Verify a plain PIN against a stored bcrypt hash.
   * Returns true if match, false otherwise.
   */
  public static async verifyPin(pin: string, hash: string): Promise<boolean> {
    if (!pin || !hash) return false;
    try {
      return await bcrypt.compare(pin, hash);
    } catch {
      return false;
    }
  }

  /**
   * Check if a franchise manager account is currently locked out.
   */
  public static isAccountLocked(
    failedAttempts: number,
    lockedUntil: string | null | undefined
  ): boolean {
    if (!lockedUntil) return false;
    if (failedAttempts < this.MAX_ATTEMPTS) return false;
    const lockoutExpiry = new Date(lockedUntil).getTime();
    return Date.now() < lockoutExpiry;
  }

  /**
   * Calculate lockout expiry ISO timestamp.
   */
  public static getLockoutExpiry(): string {
    const expiry = new Date(Date.now() + this.LOCKOUT_MINUTES * 60 * 1000);
    return expiry.toISOString();
  }

  /**
   * Generate a cryptographically random 6-digit activation code.
   * Uses crypto.randomBytes — NOT Math.random().
   *
   * Range: 100000–999999 (always 6 digits, never starts with 0).
   */
  public static generateSecureActivationCode(): string {
    const { randomBytes } = require('crypto');
    let code: number;
    do {
      const buf = randomBytes(3);
      code = buf.readUIntBE(0, 3) % 900000 + 100000;
    } while (code < 100000 || code > 999999);
    return code.toString();
  }

  /**
   * Generate a cryptographically random terminal suffix (4 digits).
   * Used for terminal ID generation — NOT Math.random().
   */
  public static generateSecureTerminalSuffix(): string {
    const { randomBytes } = require('crypto');
    const buf = randomBytes(2);
    const suffix = buf.readUIntBE(0, 2) % 9000 + 1000;
    return suffix.toString();
  }
}
