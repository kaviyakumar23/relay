import { describe, expect, it } from 'vitest';
import { normalizeContact } from '../../src/pipeline/contact';

describe('normalizeContact — Indian mobile formats', () => {
  it('normalizes a +91 country-coded, spaced number', () => {
    expect(normalizeContact('+91 98400 01234')).toEqual({ digits: '9840001234', display: '+91 98400 01234' });
  });

  it('normalizes a trunk-0 prefixed number', () => {
    expect(normalizeContact('098400 05678')).toEqual({ digits: '9840005678', display: '+91 98400 05678' });
  });

  it('normalizes a dashed number', () => {
    expect(normalizeContact('98400-05678')?.digits).toBe('9840005678');
  });

  it('normalizes a bare 10-digit mobile', () => {
    expect(normalizeContact('9840005678')?.digits).toBe('9840005678');
  });

  it('normalizes +91 with dashes and 0091 international prefix', () => {
    expect(normalizeContact('+91-98400-01234')?.digits).toBe('9840001234');
    expect(normalizeContact('0091 98400 01234')?.digits).toBe('9840001234');
  });

  it('collapses spacing variants of the same number to the same digits', () => {
    const a = normalizeContact('+91 98400 05678');
    const b = normalizeContact('98400-05678');
    expect(a?.digits).toBe(b?.digits);
  });
});

describe('normalizeContact — rejects non-phones', () => {
  it('returns null for null input', () => {
    expect(normalizeContact(null)).toBeNull();
  });

  it('returns null when there are no digits', () => {
    expect(normalizeContact('call me maybe')).toBeNull();
  });

  it('returns null for too-few digits', () => {
    expect(normalizeContact('12345')).toBeNull();
  });

  it('returns null for a 10-digit number that is not a valid mobile (leading 1-5)', () => {
    expect(normalizeContact('1234567890')).toBeNull();
    expect(normalizeContact('5000000000')).toBeNull();
  });

  it('returns null for an over-long digit string that is not a codeable number', () => {
    expect(normalizeContact('9840005678901234')).toBeNull();
  });
});
