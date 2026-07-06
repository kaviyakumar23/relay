import { describe, expect, it } from 'vitest';
import { assertNoPii, detectPii, type PiiSpan, scrubText } from '../../src/narrate/redaction';

// Deterministic PII scrubber (F7). DEFENSE-IN-DEPTH: Relay's ledger is PII-free by
// construction, so on real report inputs these find nothing — the point of assertNoPii is
// to PROVE that. We test with adversarial inputs a leak would look like.

const typesOf = (spans: PiiSpan[]): string[] => spans.map((s) => s.type);

/** The single element of an array asserted to hold exactly one (keeps offsets typed). */
function only<T>(arr: T[]): T {
  const [head, ...rest] = arr;
  if (head === undefined || rest.length > 0) throw new Error(`expected exactly one, got ${arr.length}`);
  return head;
}

/** True iff spans are sorted by start and never overlap. */
function nonOverlappingSorted(spans: PiiSpan[]): boolean {
  let prevEnd = -1;
  for (const s of spans) {
    if (s.start < prevEnd) return false;
    prevEnd = s.end;
  }
  return true;
}

describe('detectPii', () => {
  it('catches a bare 10-digit Indian mobile ([6-9]\\d{9})', () => {
    const text = 'call the boat crew on 9840012345 asap';
    const phone = only(detectPii(text).filter((s) => s.type === 'phone'));
    expect(text.slice(phone.start, phone.end)).toBe('9840012345');
  });

  it('catches a +91 spaced form', () => {
    const text = 'reach me at +91 98400 12345 today';
    const phone = only(detectPii(text).filter((s) => s.type === 'phone'));
    expect(text.slice(phone.start, phone.end)).toBe('+91 98400 12345');
  });

  it('catches a dashed +91 form and a trunk-0 form', () => {
    expect(typesOf(detectPii('+91-98400-12345'))).toContain('phone');
    expect(typesOf(detectPii('09840012345'))).toContain('phone');
  });

  it('catches an email address', () => {
    const text = 'forward to priya.k@example.org please';
    const email = only(detectPii(text).filter((s) => s.type === 'email'));
    expect(text.slice(email.start, email.end)).toBe('priya.k@example.org');
  });

  it('catches a capitalized-bigram personal name', () => {
    const text = 'assigned to Priya Kumar for delivery';
    const name = only(detectPii(text).filter((s) => s.type === 'name'));
    expect(text.slice(name.start, name.end)).toBe('Priya Kumar');
  });

  it('does NOT flag a gazetteer place name or the product name as a personal name', () => {
    // "Relay Velachery" is a Capitalized bigram that WOULD match structurally — the
    // stopword list (product + gazetteer tokens) must suppress it.
    const spans = detectPii('Relay Velachery teams reached Anna Nagar and Besant Nagar');
    expect(typesOf(spans)).not.toContain('name');
  });

  it('does not flag ordinary derived report prose', () => {
    const spans = detectPii('24 needs verified across Chennai this week; 3 remain open');
    expect(spans).toHaveLength(0);
  });

  it('returns non-overlapping spans sorted by start for mixed PII', () => {
    const spans = detectPii('Priya Kumar +91 98400 12345 priya@x.org');
    expect(typesOf(spans)).toEqual(['name', 'phone', 'email']);
    expect(nonOverlappingSorted(spans)).toBe(true);
  });
});

describe('scrubText', () => {
  it('replaces each PII span with a one-way [REDACTED:TYPE] token', () => {
    const out = scrubText('Priya Kumar +91 98400 12345 priya@x.org');
    expect(out).toBe('[REDACTED:NAME] [REDACTED:PHONE] [REDACTED:EMAIL]');
    // the originals are gone (no de-redaction map)
    expect(out).not.toMatch(/\d/);
    expect(out).not.toContain('Priya');
    expect(out).not.toContain('@');
  });

  it('leaves clean text untouched', () => {
    const clean = '18 households reached in Velachery; all deliveries verified';
    expect(scrubText(clean)).toBe(clean);
  });
});

describe('assertNoPii (F7 gate)', () => {
  it('reports ok:false when a phone survives, with type + offset only (zero-copy)', () => {
    const res = assertNoPii('coordinator note: 9840012345 needs a callback');
    expect(res.ok).toBe(false);
    const hit = only(res.hits);
    expect(hit.type).toBe('phone');
    expect(hit.sample).toBe('REDACTED'); // never the actual digits
    expect(hit.end).toBeGreaterThan(hit.start);
    // the returned gate result carries NO copy of the matched value
    expect(JSON.stringify(res)).not.toContain('9840012345');
  });

  it('reports ok:false when an email survives', () => {
    const res = assertNoPii('ping donor@ngo.org for approval');
    expect(res.ok).toBe(false);
    expect(only(res.hits).type).toBe('email');
    expect(JSON.stringify(res)).not.toContain('donor@ngo.org');
  });

  it('reports ok:true on clean derived report text (proves the ledger stayed PII-free)', () => {
    const res = assertNoPii('42 needs across 9 localities; 31 verified, 8 in progress, 3 drifting');
    expect(res).toEqual({ ok: true, hits: [] });
  });
});
