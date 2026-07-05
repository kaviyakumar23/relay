import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptContact, encryptContact, InMemoryContactVault } from '../../src/lib/vault';

const KEY = randomBytes(32).toString('hex'); // 64 hex chars
const OTHER_KEY = randomBytes(32).toString('hex');

describe('encryptContact / decryptContact — round-trip', () => {
  it('recovers the exact plaintext', () => {
    const pt = '+91 98400 05678';
    expect(decryptContact(encryptContact(pt, KEY), KEY)).toBe(pt);
  });

  it('lays the blob out as iv(12) || authTag(16) || ciphertext and randomizes the iv', () => {
    const a = encryptContact('9840005678', KEY);
    const b = encryptContact('9840005678', KEY);
    expect(a.length).toBeGreaterThan(12 + 16); // has ciphertext beyond iv+tag
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false); // fresh iv each time
  });

  it('round-trips unicode', () => {
    const pt = 'contact: அய்யா 98400 05678';
    expect(decryptContact(encryptContact(pt, KEY), KEY)).toBe(pt);
  });
});

describe('decryptContact — authentication', () => {
  it('throws when the ciphertext is tampered', () => {
    const blob = encryptContact('9840005678', KEY);
    const last = blob.length - 1;
    blob.writeUInt8(blob.readUInt8(last) ^ 0xff, last); // flip a ciphertext byte
    expect(() => decryptContact(blob, KEY)).toThrow();
  });

  it('throws when the auth tag is tampered', () => {
    const blob = encryptContact('9840005678', KEY);
    blob.writeUInt8(blob.readUInt8(13) ^ 0xff, 13); // flip an auth-tag byte
    expect(() => decryptContact(blob, KEY)).toThrow();
  });

  it('throws when decrypted with the wrong key', () => {
    const blob = encryptContact('9840005678', KEY);
    expect(() => decryptContact(blob, OTHER_KEY)).toThrow();
  });

  it('throws on a truncated blob', () => {
    expect(() => decryptContact(Buffer.alloc(10), KEY)).toThrow(/too short/);
  });
});

describe('key validation', () => {
  it('throws a clear error on a missing key', () => {
    expect(() => encryptContact('x', '')).toThrow(/64 hex chars/);
  });

  it('throws on a wrong-length key', () => {
    expect(() => encryptContact('x', 'abcd')).toThrow(/64 hex chars/);
  });

  it('throws on a non-hex key of the right length', () => {
    expect(() => encryptContact('x', 'z'.repeat(64))).toThrow(/64 hex chars/);
  });
});

describe('InMemoryContactVault', () => {
  it('stores encrypted and returns decrypted plaintext by needId', async () => {
    const vault = new InMemoryContactVault(KEY);
    await vault.put('need_1', '+91 98400 05678');
    expect(await vault.get('need_1')).toBe('+91 98400 05678');
  });

  it('returns null for an unknown needId', async () => {
    const vault = new InMemoryContactVault(KEY);
    expect(await vault.get('missing')).toBeNull();
  });

  it('rejects construction with a bad key', () => {
    expect(() => new InMemoryContactVault('nope')).toThrow(/64 hex chars/);
  });
});
