/**
 * CryptoService — AES-256-GCM Encryption / Decryption
 *
 * Encrypts credentials before storage in PostgreSQL.
 * NEVER returns raw secrets over REST API.
 */
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM recommended 96 bits
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const rawKey = process.env.DEVOPS_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('DEVOPS_ENCRYPTION_KEY environment variable is not set. Generate a 64-char hex key and add it to .env');
  }

  // Accept either a 32-byte raw string or 64-char hex string
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // Derive a 32-byte key from the provided string using SHA-256
  return crypto.createHash('sha256').update(rawKey).digest();
}

export class CryptoService {
  /**
   * Encrypt a plaintext string using AES-256-GCM.
   * Returns a base64-encoded string: iv:authTag:ciphertext
   */
  static encrypt(plaintext: string): string {
    if (!plaintext) return '';

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final()
    ]);

    const authTag = cipher.getAuthTag();

    // Format: base64(iv):base64(authTag):base64(ciphertext)
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64')
    ].join(':');
  }

  /**
   * Decrypt an AES-256-GCM encrypted string.
   * Returns the original plaintext.
   */
  static decrypt(encryptedString: string): string {
    if (!encryptedString) return '';

    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const [ivB64, authTagB64, ciphertextB64] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Mask a secret for safe display in the UI.
   * Example: "sk-proj-abc123xyz" → "sk-proj-****xyz"
   */
  static mask(value: string): string {
    if (!value || value.length < 8) return '****';
    const prefix = value.slice(0, 6);
    const suffix = value.slice(-4);
    return `${prefix}****${suffix}`;
  }

  /**
   * Generate a cryptographically secure random 64-char hex key.
   * Use for DEVOPS_ENCRYPTION_KEY generation.
   */
  static generateKey(): string {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
  }
}
