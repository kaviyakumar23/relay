// Deterministic, offset-based PII scrubber (F7). This is DEFENSE-IN-DEPTH, not the
// primary privacy guarantee: Relay's ledger is PII-free by construction (events carry
// only derived fields; beneficiary contact lives ONLY in the AES-GCM contact_vault and
// is never read by narration). So on real report inputs these detectors should find
// NOTHING — assertNoPii is the grep GATE that PROVES a generated report stayed clean.
// We still detect aggressively (adversarial inputs, a hand-typed coordinator note that
// leaks a number) so a leak can never reach a donor artifact.
//
// Ported from ../impactlens/src/redaction/detectors.js (offsets-only, zero-copy: the
// returned matches carry a type + char range, NEVER the matched substring) and hardened
// for India: the phone detector reuses the Indian-mobile shape from src/pipeline/contact.ts
// (bare 10-digit [6-9]\d{9}, +91 / 0091 / trunk-0 forms, 5-5 spaced/dashed variants).
//
// PURE: no I/O, no logging, no persistence. The caller slices verbatim spans only in
// memory if it ever needs them (it does not — scrubText emits one-way [REDACTED:TYPE]
// tokens with no de-redaction map, matching impactlens).

export type PiiType = 'phone' | 'name' | 'email' | 'address';

/** A half-open char range [start, end) plus its PII type. No matched text (zero-copy). */
export interface PiiSpan {
  start: number;
  end: number;
  type: PiiType;
}

/** A gate hit: the hard identifier type + offset only. `sample` is the literal marker
 * 'REDACTED' — never the matched PII (zero-copy, so the gate result is itself safe to log). */
export interface PiiHit {
  type: 'phone' | 'email';
  start: number;
  end: number;
  sample: 'REDACTED';
}

export interface PiiGateResult {
  ok: boolean;
  hits: PiiHit[];
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Pragmatic (not full RFC 5322): local@dotted-domain.tld, 2+ char TLD. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function detectEmails(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    if (m.index === undefined) continue;
    out.push({ type: 'email', start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phone — Indian-mobile aware
// ---------------------------------------------------------------------------

// A subscriber body is exactly 10 digits starting 6-9, optionally split 5-5 by a single
// space / dot / dash (the canonical Indian display, e.g. "98400 12345" — see contact.ts).
// An optional country/trunk prefix (+91, 0091, 091, or a lone trunk 0) may precede it.
// Digit boundaries on both sides stop us swallowing a fragment of a longer digit run.
const INDIAN_PHONE_RE = /(?<!\d)(?:\+?91[\s.-]?|0091[\s.-]?|091[\s.-]?|0)?[6-9]\d{4}[\s.-]?\d{5}(?!\d)/g;

function detectPhones(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const m of text.matchAll(INDIAN_PHONE_RE)) {
    if (m.index === undefined) continue;
    // Defensive re-check: the subscriber portion must be a valid 10-digit [6-9] mobile.
    const digits = m[0].replace(/\D+/g, '');
    const subscriber = digits.length > 10 ? digits.slice(digits.length - 10) : digits;
    if (!/^[6-9]\d{9}$/.test(subscriber)) continue;
    out.push({ type: 'phone', start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Address — leading house number + capitalized name + a street-type token
// ---------------------------------------------------------------------------

/** Street-type tokens (Indian + common). Lowercased; matched with an optional trailing
 * period. "Salai" is Tamil for road/avenue; "Nagar" is a very common locality suffix. */
const STREET_TYPES: ReadonlySet<string> = new Set([
  'st',
  'street',
  'rd',
  'road',
  'ave',
  'avenue',
  'ln',
  'lane',
  'salai',
  'nagar',
  'colony',
  'cross',
  'main',
  'layout',
  'extension',
  'block',
  'garden',
  'gardens',
  'puram',
]);

const ADDRESS_RE = /\b(\d{1,6}[A-Za-z]?)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+([A-Za-z]+)\.?/g;

function detectAddresses(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const m of text.matchAll(ADDRESS_RE)) {
    if (m.index === undefined) continue;
    const streetType = (m[3] ?? '').toLowerCase();
    if (!STREET_TYPES.has(streetType)) continue;
    out.push({ type: 'address', start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Name — conservative capitalized-bigram heuristic
// ---------------------------------------------------------------------------

// Words that pass the "two Capitalized words" shape but are NOT personal names: common
// English, Relay domain vocabulary, and — critically — every token of the seed gazetteer
// (seed/localities.json) so a place like "Anna Nagar" / "Besant Nagar" is never mistaken
// for a name. Lowercased lookup; if EITHER word of a bigram is a stopword we skip (we
// prefer a false negative on a name over redacting a place: names are lower-severity than
// phone/email, and the ledger is PII-free anyway).
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  // structural / common English
  'the',
  'this',
  'that',
  'these',
  'those',
  'we',
  'they',
  'our',
  'their',
  'his',
  'her',
  'a',
  'an',
  'and',
  'or',
  'but',
  'for',
  'with',
  'from',
  'into',
  'over',
  'under',
  'near',
  'at',
  'on',
  'in',
  'to',
  'of',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'note',
  'only',
  'said',
  'confirmed',
  'across',
  'per',
  'via',
  'no',
  'not',
  'all',
  'each',
  // days / months / periods
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'today',
  'yesterday',
  'week',
  'month',
  'quarter',
  'morning',
  'afternoon',
  'evening',
  'night',
  'period',
  // Relay product + domain vocabulary
  'relay',
  'sitrep',
  'report',
  'simulator',
  'need',
  'needs',
  'volunteer',
  'volunteers',
  'coordinator',
  'beneficiary',
  'donor',
  'ledger',
  'evidence',
  'source',
  'figures',
  'medical',
  'rescue',
  'food',
  'water',
  'shelter',
  'transport',
  'other',
  'critical',
  'high',
  'medium',
  'low',
  'severity',
  'status',
  'flags',
  'new',
  'triaged',
  'open',
  'matched',
  'match',
  'suggested',
  'claimed',
  'progress',
  'delivered',
  'unverified',
  'verified',
  'closed',
  'reopened',
  'cancelled',
  'expired',
  'duplicate',
  'review',
  'drift',
  'drifting',
  'risk',
  'triage',
  'intake',
  'dispatch',
  'people',
  'person',
  'family',
  'families',
  'household',
  'households',
  'meals',
  'served',
  'reached',
  'rescued',
  'pending',
  'total',
  'count',
  'assigned',
  'overdue',
  'due',
  // gazetteer tokens (seed/localities.json names + aliases) — place names, not people
  'velachery',
  'velacheri',
  'vellachery',
  'mrts',
  'taramani',
  'tharamani',
  'adyar',
  'adayar',
  'adyaru',
  'guindy',
  'gundy',
  'guindi',
  'saidapet',
  'saidapettai',
  'saithapet',
  't',
  'nagar',
  'thyagaraya',
  'tnagar',
  'mylapore',
  'mailapore',
  'mylai',
  'besant',
  'bessant',
  'besent',
  'elliots',
  'thiruvanmiyur',
  'tiruvanmiyur',
  'thiruvanmyur',
  'kotturpuram',
  'kottur',
  'puram',
  'koturpuram',
  'nungambakkam',
  'nungambakam',
  'nungabakkam',
  'egmore',
  'eghmore',
  'ezhumbur',
  'royapettah',
  'royapetta',
  'royapet',
  'triplicane',
  'thiruvallikeni',
  'tiruvallikeni',
  'chintadripet',
  'chinthadripet',
  'chindadripet',
  'kodambakkam',
  'kodambakam',
  'kodambakkm',
  'vadapalani',
  'vadapalny',
  'vadaplani',
  'ashok',
  'ashoknagar',
  'asok',
  'kk',
  'kalaignar',
  'karunanidhi',
  'ambattur',
  'ambatur',
  'ambathur',
  'anna',
  'annanagar',
  'nager',
  'perambur',
  'peramboor',
  'perambhur',
  'kolathur',
  'kolathoor',
  'kollathur',
  'villivakkam',
  'vilivakkam',
  'villivakam',
  'aminjikarai',
  'aminjikkarai',
  'aminchikarai',
  'choolaimedu',
  'chulaimedu',
  'choolaimed',
  'teynampet',
  'teynampettai',
  'thaynampet',
  'alwarpet',
  'alwar',
  'pet',
  'alwarpettai',
  'mandaveli',
  'mandavelli',
  'mandaiveli',
  'kottivakkam',
  'kotivakkam',
  'kottivakam',
  'palavakkam',
  'palavakam',
  'pallavakkam',
  'neelankarai',
  'nilankarai',
  'neelangarai',
  'injambakkam',
  'injambakam',
  'enjambakkam',
  'sholinganallur',
  'solinganallur',
  'cholinganallur',
  'perungudi',
  'perungdi',
  'perungudy',
  'pallikaranai',
  'pallikkaranai',
  'marsh',
  'palikaranai',
  'madipakkam',
  'madippakkam',
  'madipakam',
  'nanganallur',
  'nanganalur',
  'nangnallur',
  'chromepet',
  'chrompet',
  'chromepettai',
  'tambaram',
  'thambaram',
  'tambram',
  'chennai',
  'tamil',
  'nadu',
  'india',
]);

// Two Capitalized word tokens (letter runs starting uppercase; internal apostrophe/hyphen
// allowed for O'Brien / Mary-Jane) separated by a single space. A bigram — never a single
// sentence-initial capitalized word (far too noisy).
const NAME_BIGRAM_RE = /\b([A-Z][a-zA-Z'’-]+)[ ]([A-Z][a-zA-Z'’-]+)\b/g;

function detectNames(text: string): PiiSpan[] {
  const out: PiiSpan[] = [];
  for (const m of text.matchAll(NAME_BIGRAM_RE)) {
    if (m.index === undefined) continue;
    const w1 = (m[1] ?? '').toLowerCase();
    const w2 = (m[2] ?? '').toLowerCase();
    if (NAME_STOPWORDS.has(w1) || NAME_STOPWORDS.has(w2)) continue;
    out.push({ type: 'name', start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlap resolution
// ---------------------------------------------------------------------------

/** Sort by start ascending (widest first on ties) and greedily merge overlapping spans
 * into non-overlapping covering ranges, keeping the first-kept span's type. Guarantees
 * scrubText leaves no partial PII behind even when detectors overlap. */
function resolveSpans(spans: PiiSpan[]): PiiSpan[] {
  const usable = spans.filter((s) => s.end > s.start);
  if (usable.length === 0) return [];
  const sorted = [...usable].sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
  const out: PiiSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end; // extend the kept range; keep its type
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect every PII span in `text`, returned as non-overlapping ranges sorted by start.
 * Offsets + type only — never the matched text (zero-copy, R6/invariant #5).
 */
export function detectPii(text: string): PiiSpan[] {
  if (text.length === 0) return [];
  return resolveSpans([...detectEmails(text), ...detectPhones(text), ...detectAddresses(text), ...detectNames(text)]);
}

/**
 * Replace every detected PII span with a one-way `[REDACTED:TYPE]` token. There is no
 * de-redaction map (matches impactlens): once scrubbed, the original is gone. Pure.
 */
export function scrubText(text: string): string {
  const spans = detectPii(text);
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += text.slice(cursor, s.start);
    out += `[REDACTED:${s.type.toUpperCase()}]`;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * The F7 grep GATE. Scans for the HARD identifiers (phone + email — high precision, the
 * ones that must never survive) and returns ok:false if any remain. Used to hard-assert a
 * generated report is clean. The result carries type + offset only and the literal marker
 * 'REDACTED' — never the matched value — so the gate result is itself safe to log/return.
 *
 * On real report inputs this finds nothing (the ledger is PII-free); that's the point —
 * the gate PROVES it rather than assuming it.
 */
export function assertNoPii(text: string): PiiGateResult {
  const hits: PiiHit[] = [...detectPhones(text), ...detectEmails(text)]
    .map((s) => ({ type: s.type as 'phone' | 'email', start: s.start, end: s.end, sample: 'REDACTED' as const }))
    .sort((a, b) => a.start - b.start);
  return { ok: hits.length === 0, hits };
}
