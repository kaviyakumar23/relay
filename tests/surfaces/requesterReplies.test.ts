import { describe, expect, it } from 'vitest';
import {
  buildRequesterReply,
  type RequesterReplyContext,
  type RequesterReplyKind,
} from '../../src/surfaces/requesterReplies';

// Moonshot #4: Relay replies in the REQUESTER's own thread, in their language, as the
// need progresses. These tests pin the honesty + PII contract: bilingual only when 'ta'
// is present, every kind renders, only the volunteer's FIRST name + the public id appear,
// and volunteerName / etaMinutes are optional. Pure builder — no Slack, no store.

const KINDS: RequesterReplyKind[] = ['assigned', 'en_route', 'delivered', 'verified'];

/** Any character in the Tamil Unicode block (U+0B80–U+0BFF). */
const TAMIL = /[஀-௿]/;

const ctx = (over: Partial<RequesterReplyContext> = {}): RequesterReplyContext => ({
  languages: ['ta', 'en'],
  volunteerName: 'Anitha Kumar',
  etaMinutes: 12,
  publicId: 'N-0007',
  ...over,
});

describe('buildRequesterReply — language matching', () => {
  it("leads with a Tamil line AND an English line when languages include 'ta'", () => {
    for (const kind of KINDS) {
      const { text } = buildRequesterReply(kind, ctx({ languages: ['ta', 'en'] }));
      expect(TAMIL.test(text), `expected Tamil in ${kind}`).toBe(true);
      // English is always present too (bilingual, never Tamil-only).
      expect(/[A-Za-z]/.test(text), `expected English in ${kind}`).toBe(true);
      // Tamil leads: the first Tamil char comes before the first ASCII-letter run of the body.
      const firstTamil = text.search(TAMIL);
      const firstLatin = text.search(/[A-Za-z]/);
      expect(firstTamil).toBeGreaterThanOrEqual(0);
      expect(firstTamil).toBeLessThan(firstLatin);
    }
  });

  it('renders English-only (no Tamil script) when languages do not include ta', () => {
    for (const kind of KINDS) {
      const { text } = buildRequesterReply(kind, ctx({ languages: ['en'] }));
      expect(TAMIL.test(text), `unexpected Tamil in en-only ${kind}`).toBe(false);
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('treats an empty languages list as English-only', () => {
    const { text } = buildRequesterReply('assigned', ctx({ languages: [] }));
    expect(TAMIL.test(text)).toBe(false);
    expect(text).toContain('Help is on the way');
  });
});

describe('buildRequesterReply — each kind renders', () => {
  it('produces distinct, non-empty text carrying the public id for every kind', () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const { text } = buildRequesterReply(kind, ctx());
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).toContain('N-0007');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
      seen.add(text);
    }
    expect(seen.size).toBe(KINDS.length); // no two kinds collapse to the same reply
  });

  it('matches the reference wording for the anchor kinds', () => {
    const en = (kind: RequesterReplyKind) => buildRequesterReply(kind, ctx({ languages: ['en'] })).text;
    expect(en('assigned')).toContain('Anitha is heading to you');
    expect(en('delivered')).toContain('Your request has been delivered');
    expect(buildRequesterReply('delivered', ctx()).text).toContain('உதவி வழங்கப்பட்டது ✅');
  });
});

describe('buildRequesterReply — en_route ETA', () => {
  it('includes a whole-minute ETA when one is reported', () => {
    const { text } = buildRequesterReply('en_route', ctx({ languages: ['en'], etaMinutes: 8 }));
    expect(text).toContain('8 minutes');
  });

  it('singularises one minute', () => {
    const { text } = buildRequesterReply('en_route', ctx({ languages: ['en'], etaMinutes: 1 }));
    expect(text).toContain('1 minute');
    expect(text).not.toContain('1 minutes');
  });

  it('rounds a fractional ETA to whole minutes', () => {
    const { text } = buildRequesterReply('en_route', ctx({ languages: ['en'], etaMinutes: 6.6 }));
    expect(text).toContain('7 minutes');
    expect(text).not.toContain('6.6');
  });

  it('omits the ETA cleanly when it is null / missing / non-positive', () => {
    for (const eta of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { text } = buildRequesterReply('en_route', ctx({ languages: ['en'], etaMinutes: eta }));
      expect(text).toContain('On the way');
      expect(text).not.toContain('minute');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
      expect(text).not.toContain('Infinity');
    }
  });
});

describe('buildRequesterReply — PII discipline', () => {
  it('shows only the volunteer FIRST name, never the surname', () => {
    const { text } = buildRequesterReply('assigned', ctx({ languages: ['en'], volunteerName: 'Anitha Kumar' }));
    expect(text).toContain('Anitha');
    expect(text).not.toContain('Kumar');
  });

  it('never leaks contact details or beneficiary content (only first name + public id)', () => {
    const { text } = buildRequesterReply('assigned', ctx());
    // No phone-length digit runs (the only digits allowed are the public id + ETA, both short).
    expect(text).not.toMatch(/\d{7,}/);
    expect(text.toLowerCase()).not.toContain('phone');
    expect(text.toLowerCase()).not.toContain('address');
  });

  it('neutralises mrkdwn control characters in the volunteer name', () => {
    const { text } = buildRequesterReply('assigned', ctx({ languages: ['en'], volunteerName: '<@U123>Evil <b>' }));
    // First token '<@U123>Evil' is escaped; no raw angle brackets survive to inject a mention/link.
    expect(text).not.toContain('<@U123>');
    expect(text).toContain('&lt;@U123&gt;Evil');
  });
});

describe('buildRequesterReply — volunteerName optional', () => {
  it("falls back to 'a volunteer' in English when no name is given", () => {
    for (const eta of [undefined, null]) {
      const { text } = buildRequesterReply(
        'assigned',
        ctx({ languages: ['en'], volunteerName: undefined, etaMinutes: eta }),
      );
      expect(text).toContain('a volunteer');
      expect(text).not.toContain('undefined');
    }
  });

  it('falls back to a Tamil volunteer word in bilingual replies', () => {
    const { text } = buildRequesterReply('assigned', ctx({ languages: ['ta'], volunteerName: undefined }));
    expect(text).toContain('ஒரு தன்னார்வலர்');
    expect(text).toContain('a volunteer');
  });

  it('ignores a whitespace-only name and falls back', () => {
    const { text } = buildRequesterReply(
      'en_route',
      ctx({ languages: ['en'], volunteerName: '   ', etaMinutes: null }),
    );
    expect(text).toContain('a volunteer');
  });
});
