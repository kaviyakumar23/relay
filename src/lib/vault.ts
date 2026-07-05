import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Contact vault crypto (CLAUDE.md invariant 5). Beneficiary PII (phone numbers) lives
// ONLY here, encrypted with AES-256-GCM. Cards show a reveal button that writes an
// audit_log row; the plaintext never enters events, need rows, logs, or LLM inputs.
//
// Wire format of a vault blob:  iv (12 bytes) || authTag (16 bytes) || ciphertext.
// GCM authenticates iv+ciphertext, so any tampering fails decryption (auth error).

const IV_BYTES = 12; // 96-bit nonce, the recommended size for AES-GCM
const TAG_BYTES = 16; // 128-bit auth tag
const KEY_HEX_LEN = 64; // 32 bytes / 256-bit key, hex-encoded

/** Parse + validate the 64-hex-char key. Throws a clear error if missing/wrong length. */
function keyFromHex(keyHex: string): Buffer {
  if (typeof keyHex !== 'string' || keyHex.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      `contact vault key must be ${KEY_HEX_LEN} hex chars (a 256-bit key); got ${keyHex?.length ?? 0} chars`,
    );
  }
  return Buffer.from(keyHex, 'hex');
}

/** Encrypt a contact plaintext. Returns iv||authTag||ciphertext. */
export function encryptContact(plaintext: string, keyHex: string): Buffer {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Decrypt a vault blob produced by encryptContact. Throws on a wrong key or tampering. */
export function decryptContact(blob: Buffer, keyHex: string): string {
  const key = keyFromHex(keyHex);
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('contact vault blob too short (missing iv/authTag)');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Storage seam for encrypted contacts, keyed by needId. The production implementation is
 * Postgres-backed (a `contact_vault` table holding the blob) and is the integrator's job;
 * only the crypto above, this interface, and the in-memory impl below are provided here.
 */
export interface ContactVault {
  put(needId: string, plaintext: string): Promise<void>;
  get(needId: string): Promise<string | null>;
}

/** Hermetic, encrypted-at-rest in-memory vault for tests and `npm run demo`. */
export class InMemoryContactVault implements ContactVault {
  private readonly store = new Map<string, Buffer>();

  constructor(private readonly keyHex: string) {
    // Fail fast on a bad key at construction rather than on first put.
    keyFromHex(keyHex);
  }

  async put(needId: string, plaintext: string): Promise<void> {
    this.store.set(needId, encryptContact(plaintext, this.keyHex));
  }

  async get(needId: string): Promise<string | null> {
    const blob = this.store.get(needId);
    return blob === undefined ? null : decryptContact(blob, this.keyHex);
  }
}
