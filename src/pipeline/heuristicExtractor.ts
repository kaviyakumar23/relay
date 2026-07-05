import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { NeedDraft, NeedType, ProvenanceEntry, Severity } from '../llm/needDraft';
import { normalizeContact } from './contact';
import { floorSeverity, hasFloorKeyword } from './severityFloor';

// Deterministic, no-LLM intake extractor (BUILD-DOC §16.3). Two jobs:
//   1. Drive the `npm run eval` / `npm run demo` baseline with zero env.
//   2. Be what MockLlm returns in hermetic runs, so tests exercise the real pipeline
//      through the same NeedDraft boundary as the OpenAI/Anthropic providers.
// Self-contained: depends only on severityFloor + contact. It does NOT geocode — it
// emits locality_guess as a raw string (the gazetteer name it spotted); resolving that
// guess to an id is geocode.resolveLocality's job in a later pipeline stage.
//
// Provenance follows a simple, honest rule (§Appendix C): fields lifted verbatim by a
// regex (a named locality, an explicit count, a phone number) are 'stated'; fields
// derived from keyword reasoning (type, severity, a count inferred from "a couple") are
// 'inferred'; absent fields are 'unknown'.

// ── Gazetteer names (for locality guessing only) ────────────────────────────────
// Own, cached read of the seed so this module stays geocode-free. We only need the
// name/alias strings to spot a locality mention; we never resolve to an id here.
const SeedNameSchema = z.object({ name: z.string().min(1), aliases: z.array(z.string()) });

interface LocalityCandidate {
  key: string; // normalized name or alias to substring-scan for
  canonical: string; // the gazetteer's canonical name to emit as the guess
}

let cachedCandidates: LocalityCandidate[] | null = null;

function localityCandidates(): LocalityCandidate[] {
  if (cachedCandidates !== null) return cachedCandidates;
  const raw = readFileSync(new URL('../../seed/localities.json', import.meta.url), 'utf8');
  const entries = z.array(SeedNameSchema).parse(JSON.parse(raw));
  const candidates: LocalityCandidate[] = [];
  for (const entry of entries) {
    candidates.push({ key: normalize(entry.name), canonical: entry.name });
    for (const alias of entry.aliases) candidates.push({ key: normalize(alias), canonical: entry.name });
  }
  // Longest key first so a more specific multi-word name wins over a short alias.
  candidates.sort((a, b) => b.key.length - a.key.length);
  cachedCandidates = candidates;
  return candidates;
}

// ── Text helpers ────────────────────────────────────────────────────────────────
/** Lowercase, drop apostrophes ("can't" → "cant"), collapse whitespace. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim();
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// ── Need type ───────────────────────────────────────────────────────────────────
// Ordered rules — first match wins. Medical before rescue so "dialysis ... stuck"
// stays medical; rescue before food/water so "trapped ... water rising" stays rescue;
// food/shelter/transport before the broad water bucket so incidental flood-water
// mentions don't swamp an explicit food/shelter/transport ask.
const TYPE_RULES: ReadonlyArray<readonly [NeedType, readonly string[]]> = [
  [
    'medical',
    [
      'dialysis',
      'oxygen',
      'chest pain',
      'cardiac',
      'heart attack',
      'seizure',
      'bleeding',
      'injured',
      'wound',
      'dressing',
      'bandage',
      'medicine',
      'medicines',
      'marundhu',
      'tablet',
      'patient',
      'infant',
      'newborn',
      'blood pressure',
      ' bp ',
    ],
  ],
  [
    'rescue',
    [
      'trapped',
      'kaapathunga',
      'maatti',
      'swept',
      'boat rescue',
      'send a boat',
      'rescue',
      'rooftop',
      'stranded',
      'surrounded',
      'cant get out',
      'cant move',
      'cannot move',
      'veliya vara mudiyala',
    ],
  ],
  ['food', ['food', 'hungry', 'sappadu', 'meal', 'meals', 'rice', 'cooking gas', 'food packet']],
  [
    'shelter',
    [
      'place to stay',
      'stay tonight',
      'stay for',
      'dry place',
      'thanga',
      'idam venum',
      'looking for a place',
      'open shelter',
    ],
  ],
  ['transport', ['vehicle', 'vandi', 'transport']],
  ['water', ['drinking water', 'bottled water', 'water can', 'thanni', 'kudikka', 'water']],
];

function classifyType(t: string): NeedType {
  for (const [type, keywords] of TYPE_RULES) {
    if (includesAny(t, keywords)) return type;
  }
  return 'other';
}

// ── Severity ────────────────────────────────────────────────────────────────────
const URGENCY_WORDS: readonly string[] = [
  'urgent',
  'immediately',
  'asap',
  'emergency',
  'right now',
  'hurry',
  'rising fast',
  'very high',
  'send help',
  'romba urgent',
  'venum romba',
  'fast ah',
];
const LOW_SIGNAL_WORDS: readonly string[] = [
  'okay for now',
  'in case',
  'later tonight',
  'list of',
  'helpline',
  'open shelter',
  'charging',
  'phone charge',
  'sandbag',
  'getting low',
  'precaution',
  'contingency',
];

function baseSeverity(t: string): Severity {
  if (includesAny(t, URGENCY_WORDS)) return 'high';
  if (includesAny(t, LOW_SIGNAL_WORDS)) return 'low';
  return 'medium';
}

// ── People count ────────────────────────────────────────────────────────────────
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  oru: 1,
  rendu: 2,
  moonu: 3,
  nalu: 4,
  naalu: 4,
  anju: 5,
  aaru: 6,
};
const PEOPLE_UNITS = '(?:people|persons|members|elderly|per|ppl|families|family)';
const NUM_UNIT_RE = new RegExp(`(\\d+)\\s*${PEOPLE_UNITS}\\b`);
const FAMILY_OF_RE = /family of (\d+)/;
const WORD_UNIT_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\s+${PEOPLE_UNITS}\\b`);
const SINGULAR_INDICATORS: readonly string[] = [
  'uncle',
  'grandfather',
  'grandmother',
  'thatha',
  'paati',
  'amma',
  'a man',
  'an old man',
  'a child',
  'a patient',
  'a diabetic',
  'an infant',
  'a woman',
  'a lady',
  'elderly man',
  'elderly woman',
];

interface CountResult {
  count: number | null;
  status: ProvenanceEntry['status'];
}

/** Household units ("N families") are inferred head-counts; explicit people units are stated. */
function unitStatus(matchText: string): ProvenanceEntry['status'] {
  return /famil/.test(matchText) ? 'inferred' : 'stated';
}

function extractCount(t: string): CountResult {
  const family = FAMILY_OF_RE.exec(t);
  if (family?.[1] !== undefined) return { count: Number(family[1]), status: 'stated' };

  const numUnit = NUM_UNIT_RE.exec(t);
  if (numUnit?.[1] !== undefined) return { count: Number(numUnit[1]), status: unitStatus(numUnit[0]) };

  const wordUnit = WORD_UNIT_RE.exec(t);
  if (wordUnit?.[1] !== undefined) {
    const n = NUMBER_WORDS[wordUnit[1]];
    if (n !== undefined) return { count: n, status: unitStatus(wordUnit[0]) };
  }

  // "couple" → 2, but not "couple of nights/days".
  if (/\bcouple\b(?!\s+of)/.test(t)) return { count: 2, status: 'inferred' };

  if (includesAny(t, SINGULAR_INDICATORS)) return { count: 1, status: 'inferred' };

  return { count: null, status: 'unknown' };
}

// ── Contact ─────────────────────────────────────────────────────────────────────
// Capture a phone-shaped substring; keep the RAW form for contact_raw (the vault gets
// it later), but only if it validates as a real Indian mobile.
const PHONE_RE = /(?:\+?91[\s-]?|\b0)?[6-9]\d{4}[\s-]?\d{5}\b/;

function extractContact(text: string): string | null {
  const m = PHONE_RE.exec(text);
  if (m === null) return null;
  const raw = m[0].trim();
  return normalizeContact(raw) === null ? null : raw;
}

// ── Language ────────────────────────────────────────────────────────────────────
// Distinctive transliterated-Tamil tokens; whole-token match so short particles
// ("la", "ku", "per") don't fire inside English words.
const TAMIL_TOKENS: ReadonlySet<string> = new Set([
  'la',
  'ku',
  'per',
  'iruku',
  'irukanga',
  'venum',
  'thanni',
  'yeruthu',
  'mela',
  'romba',
  'nalu',
  'naalu',
  'oru',
  'rendu',
  'moonu',
  'anju',
  'aaru',
  'paati',
  'thatha',
  'amma',
  'appa',
  'sappadu',
  'marundhu',
  'kaapathunga',
  'poyiduchu',
  'poganum',
  'aachu',
  'aagipochu',
  'pochu',
  'naal',
  'kudikka',
  'maattitaanga',
  'maatti',
  'suthi',
  'thaniya',
  'sollunga',
  'pannunga',
  'panna',
  'mudiyala',
  'mudiyuma',
  'theerundhu',
  'kammi',
  'thanga',
  'idam',
  'therinja',
  'yaaravadhu',
  'edhavadhu',
  'konjam',
  'engaluku',
  'nanjiduchu',
  'pothala',
  'naalaiku',
  'kaalaikku',
  'veetla',
]);

function detectLanguages(t: string): NeedDraft['languages'] {
  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w !== '');
  const hasTamil = tokens.some((w) => TAMIL_TOKENS.has(w));
  return hasTamil ? ['ta', 'en'] : ['en'];
}

// ── Summary (derived only — zero-copy safe) ─────────────────────────────────────
function buildSummary(type: NeedType, severity: Severity, locality: string | null, count: number | null): string {
  const parts = [`${type} need`];
  if (locality !== null) parts.push(`in ${locality}`);
  if (count !== null) parts.push(`for ${count}`);
  if (severity === 'critical') parts.push('(critical)');
  return parts.join(' ');
}

function severityWhy(text: string, severity: Severity): string {
  if (hasFloorKeyword(text)) return 'critical: floor keyword present';
  if (severity === 'high') return 'urgency phrasing present';
  if (severity === 'low') return 'no urgency signal (query/precautionary)';
  return 'default: no strong urgency signal';
}

/**
 * Deterministically extract a NeedDraft from a message. The return value always
 * satisfies NeedDraftSchema — the pipeline can treat it exactly like a validated LLM
 * response. Raw text stays in memory only: locality/count/contact are lifted into
 * derived fields; nothing else of the message is retained.
 */
export function heuristicNeedDraft(text: string): NeedDraft {
  const t = normalize(text);

  const type = classifyType(t);
  const severity = floorSeverity(text, baseSeverity(t));

  let localityGuess: string | null = null;
  for (const cand of localityCandidates()) {
    if (t.includes(cand.key)) {
      localityGuess = cand.canonical;
      break;
    }
  }

  const { count, status: countStatus } = extractCount(t);
  const contactRaw = extractContact(text);

  const provenance: Record<string, ProvenanceEntry> = {
    type: { status: 'inferred', why: `keyword-classified as ${type}` },
    severity: { status: 'inferred', why: severityWhy(text, severity) },
    locality_guess:
      localityGuess === null
        ? { status: 'unknown', why: 'no known locality named' }
        : { status: 'stated', why: 'gazetteer name present in text' },
    location_text: { status: 'unknown', why: 'heuristic extracts no free-text landmark' },
    people_count:
      count === null
        ? { status: 'unknown', why: 'no head-count derivable' }
        : { status: countStatus, why: 'count parsed from text' },
    contact_raw:
      contactRaw === null
        ? { status: 'unknown', why: 'no phone number in text' }
        : { status: 'stated', why: 'phone number present in text' },
  };

  return {
    type,
    severity,
    locality_guess: localityGuess,
    location_text: null,
    people_count: count,
    contact_raw: contactRaw,
    summary_en: buildSummary(type, severity, localityGuess, count),
    languages: detectLanguages(t),
    provenance,
  };
}
