import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contactHash } from '../../src/lib/contactHash';

const KEY_A = randomBytes(32).toString('hex');
const KEY_B = randomBytes(32).toString('hex');

describe('contactHash — blind index', () => {
  it('is deterministic: same number → same hash (default dev salt, no env)', () => {
    expect(contactHash('9840005678')).toBe(contactHash('9840005678'));
  });

  it('ignores separators in the digit string (space / dash / parens)', () => {
    const bare = contactHash('9840005678');
    expect(contactHash('98400 05678')).toBe(bare);
    expect(contactHash('98400-05678')).toBe(bare);
    expect(contactHash('(98400) 05678')).toBe(bare);
  });

  it('does not itself strip a country code — that is normalizeContact()`s job upstream', () => {
    // The integrator feeds normalizeContact(raw).digits (the bare 10-digit form); the
    // 12-digit '91…' string is a different key, by design (contactHash only de-noises).
    expect(contactHash('919840005678')).not.toBe(contactHash('9840005678'));
  });

  it('separates distinct numbers: different digits → different hashes', () => {
    expect(contactHash('9840005678')).not.toBe(contactHash('9840005679'));
  });

  it('is non-reversible: a fixed-width hex digest that never contains the input digits', () => {
    const digits = '9840005678';
    const h = contactHash(digits);
    expect(h).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex, one-way
    expect(h).not.toContain(digits);
  });

  it('is keyed: the same number under different keys yields different hashes', () => {
    expect(contactHash('9840005678', KEY_A)).not.toBe(contactHash('9840005678', KEY_B));
  });

  it('an explicit key diverges from the default dev salt', () => {
    expect(contactHash('9840005678', KEY_A)).not.toBe(contactHash('9840005678'));
  });

  it('treats an empty key as the default salt (hermetic determinism)', () => {
    expect(contactHash('9840005678', '')).toBe(contactHash('9840005678'));
  });

  it('accepts a 64-hex key and stays deterministic under it', () => {
    expect(contactHash('9840005678', KEY_A)).toBe(contactHash('98400 05678', KEY_A));
  });
});
