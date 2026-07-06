import { createHmac } from 'node:crypto';

// Privacy-preserving BLIND INDEX for beneficiary contacts (CLAUDE.md invariant #5).
// contactHash maps a normalized phone number to a keyed one-way digest: the SAME
// number always yields the SAME hash (so two needs from the same caller collide),
// but the hash is NOT reversible to the number — HMAC-SHA256 is a PRF, and without
// the key you cannot even brute-force the 10-digit space offline. This lets the
// dedupe engine match on contact WITHOUT the plaintext ever leaving the vault, so a
// hash may safely live on the (non-PII) needs row and in an index.
//
// PURE: no I/O, no logging. The caller derives digits (via normalizeContact) and
// passes them here; the raw number is never persisted or logged.

// Fixed dev salt so hermetic runs (no CONTACT_VAULT_KEY) are deterministic. In
// production the integrator passes the real key (config.contactVaultKey). The salt
// only has to be stable and non-empty — it is a domain separator, not a secret in
// the hermetic path. 64 hex chars → a 256-bit key when hex-decoded.
const DEV_SALT = 'a3f1c09b7e2d4856a3f1c09b7e2d4856a3f1c09b7e2d4856a3f1c09b7e2d4856';

/**
 * Keyed blind index of a phone number. `digits` is normalized to a bare digit string
 * first, so '+91 98400 05678' and '9840005678' hash identically. `keyHex` defaults to
 * a fixed dev salt; pass the vault key in production. A 64-hex key is decoded to raw
 * bytes (matching the vault key format); any other key material is used as UTF-8.
 */
export function contactHash(digits: string, keyHex?: string): string {
  const material = keyHex !== undefined && keyHex.length > 0 ? keyHex : DEV_SALT;
  const key = /^[0-9a-fA-F]{64}$/.test(material) ? Buffer.from(material, 'hex') : Buffer.from(material, 'utf8');
  const normalized = digits.replace(/\D+/g, '');
  return createHmac('sha256', key).update(normalized, 'utf8').digest('hex');
}
