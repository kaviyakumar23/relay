import { describe, expect, it } from 'vitest';
import { resolveLocality } from '../../src/pipeline/geocode';

// Stable 1-based ids come from seed/localities.json array order: Velachery is entry 1,
// Besant Nagar entry 8, Thiruvanmiyur entry 9.
describe('resolveLocality — canonical name match', () => {
  it('resolves a canonical name to its 1-based id with no residual location text', () => {
    expect(resolveLocality('Velachery')).toEqual({ localityId: 1, locationText: null, matched: true });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveLocality('  VELACHERY  ')).toEqual({ localityId: 1, locationText: null, matched: true });
    expect(resolveLocality('besant   nagar')).toEqual({ localityId: 8, locationText: null, matched: true });
  });
});

describe('resolveLocality — alias match', () => {
  it('resolves aliases to the same id as their canonical name', () => {
    expect(resolveLocality('Velacheri').localityId).toBe(1); // alias of Velachery
    expect(resolveLocality('Elliots').localityId).toBe(8); // alias of Besant Nagar
    expect(resolveLocality('Tiruvanmiyur').localityId).toBe(9); // alias of Thiruvanmiyur
  });

  it('marks every alias hit as matched with null location text', () => {
    const r = resolveLocality('Tharamani'); // alias of Taramani
    expect(r.matched).toBe(true);
    expect(r.locationText).toBeNull();
  });
});

describe('resolveLocality — no match passes the guess through', () => {
  it('returns the original guess as location text on a miss', () => {
    expect(resolveLocality('Atlantis')).toEqual({ localityId: null, locationText: 'Atlantis', matched: false });
  });

  it('handles a null guess (nothing to resolve)', () => {
    expect(resolveLocality(null)).toEqual({ localityId: null, locationText: null, matched: false });
  });

  it('treats a blank guess as a miss and passes it through', () => {
    expect(resolveLocality('   ')).toEqual({ localityId: null, locationText: '   ', matched: false });
  });
});
