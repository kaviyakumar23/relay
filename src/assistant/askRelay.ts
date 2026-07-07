import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ProjectedNeed } from '../ledger/types';
import { TERMINAL_STATES } from '../ledger/types';
import { logger } from '../lib/logger';
import { type AskGrounding, buildAskRequest } from '../llm/prompts/p7-ask';
import type { LlmProvider } from '../llm/provider';
import { computeSitrepStats, type SitrepStats } from '../narrate/aggregate';
import { assertNoPii, scrubText } from '../narrate/redaction';
import { buildTokenMap, validateNumbers } from '../narrate/statTokens';
import { resolveLocality } from '../pipeline/geocode';
import type { Citation, RtsReference, RtsResolver } from './rts';

// Ask-Relay — the assistant brain (BUILD-DOC §F8 / the Slack-AI qualifying technology).
// A coordinator asks a question; askRelay:
//   1. gates scope + classifies a lightweight intent (deterministic, keyword-based),
//   2. gathers PII-free grounding from the ledger projection (+ OPTIONAL RTS field context),
//   3. synthesises a cited answer — the LLM via P-7 when a key is present, else a fully
//      deterministic template built from the same grounding (the hermetic path),
//   4. enforces the guarantees: out-of-scope → polite refusal; numbers only from the
//      grounding (a stray → template fallback); NEVER any PII/contact (RTS snippets are
//      scrubbed on the way in, and the final answer is PII-gated).
//
// PRIVACY: the ledger is PII-free by construction (contact lives only in the vault, never in
// a ProjectedNeed). RTS results are ephemeral (CLAUDE.md invariant 9) — used at query time,
// scrubbed, never persisted here.

export type AskIntent =
  | 'open-criticals'
  | 'by-locality'
  | 'drifting'
  | 'sitrep'
  | 'other'
  | 'out-of-scope'
  | 'emergency';

export interface AnswerCitation {
  label: string;
  permalink?: string;
}

/** The narrow slice of NeedService askRelay needs (structural, so tests pass a fake). */
export interface AskService {
  listNeeds(now?: number): Promise<ProjectedNeed[]>;
}

export interface AskRelayArgs {
  question: string;
  service: AskService;
  /** Present iff an LLM key is configured; undefined ⇒ the deterministic template path. */
  llm?: LlmProvider;
  /** Present iff RTS is wired (RtsClient with a user token, or the mock). */
  rts?: RtsResolver;
  /** Reference clock. Defaults to Date.now(). */
  now?: number;
}

export interface AskRelayResult {
  answer: string;
  citations: AnswerCitation[];
  source: 'llm' | 'template';
  usedRts: boolean;
  intent: AskIntent;
}

const MAX_ROWS = 12;
const REFUSAL =
  'I track relief operations, not general questions. Ask me about open needs, criticals, a specific locality, drift and SLA risk, or the live sitrep.';

// --- emergency-dispatch safety refusal (BUILD-DOC §11.3) --------------------------------
// Relay coordinates volunteers; it does NOT dispatch emergency services. If a coordinator asks
// Relay to call 911 / 108 / an ambulance, or whether this is an emergency line, we must say so
// plainly and redirect to the real emergency number — never answer from the ledger. This is a
// DETERMINISTIC pre-check (runs before the scope gate and before any LLM call) so it holds
// identically with or without an LLM key; the P-7 system prompt reinforces it as defense-in-depth.

const EMERGENCY_RESPONSE =
  'Relay coordinates volunteer relief inside this workspace — it is not an emergency service. For a life-threatening emergency contact your local emergency number directly.';

/** Emergency / dispatch phrases. A bare mention here is enough — the safe failure mode is to
 * redirect to the real emergency number, never to serve a ledger answer. */
const EMERGENCY_PHRASES: readonly string[] = [
  'emergency service',
  'emergency services',
  'emergency number',
  'emergency line',
  'emergency hotline',
  'emergency helpline',
  'emergency responder',
  'emergency dispatch',
  'dispatch emergency',
  'call emergency',
  'ambulance',
  'paramedic',
  'fire brigade',
  'fire department',
];

/** Public emergency numbers (IN + intl): ambulance 108/102, unified 112, police 100, fire 101,
 * US/other 911/999/000. Matched only next to a dialling verb so a bare quantity never trips. */
const EMERGENCY_NUMBERS: ReadonlySet<string> = new Set(['911', '108', '112', '100', '101', '102', '999', '000']);
const DIAL_VERB_RE = /\b(call|calling|dial|dialling|dialing|ring|phone)\b/;

/** True when the question is about calling/dispatching emergency services or whether Relay is an
 * emergency line. Deterministic — keyword/number intent only, no model. */
function isEmergencyDispatchQuestion(question: string): boolean {
  const t = question.toLowerCase();
  if (EMERGENCY_PHRASES.some((p) => t.includes(p))) return true;
  // "call/dial <emergency number>" — the dialling verb keeps "100 meals served" from tripping.
  if (DIAL_VERB_RE.test(t)) {
    for (const n of t.match(/\d{3,4}/g) ?? []) if (EMERGENCY_NUMBERS.has(n)) return true;
  }
  return false;
}

// --- locality name resolution (reverse of geocode's name/alias → id) --------------------

const LocalityNameSchema = z.array(z.object({ name: z.string() }));
let cachedLocalityNames: string[] | null = null;

function localityNames(): string[] {
  if (cachedLocalityNames !== null) return cachedLocalityNames;
  const raw = readFileSync(new URL('../../seed/localities.json', import.meta.url), 'utf8');
  cachedLocalityNames = LocalityNameSchema.parse(JSON.parse(raw)).map((l) => l.name);
  return cachedLocalityNames;
}

/** Gazetteer id (1-based) → canonical name, or null. */
function localityNameFor(id: number | null): string | null {
  if (id === null) return null;
  return localityNames()[id - 1] ?? null;
}

/** Scan uni/bi-grams of the question for a known locality (case/spelling-insensitive). */
function detectLocality(question: string): { id: number; name: string } | null {
  const words = question.split(/[^A-Za-z.]+/).filter((w) => w.length > 0);
  for (let i = 0; i < words.length; i++) {
    const uni = words[i] ?? '';
    const bi = i + 1 < words.length ? `${uni} ${words[i + 1]}` : '';
    for (const candidate of bi ? [bi, uni] : [uni]) {
      const r = resolveLocality(candidate);
      if (r.matched && r.localityId !== null)
        return { id: r.localityId, name: localityNameFor(r.localityId) ?? candidate };
    }
  }
  return null;
}

// --- scope gate + intent classifier (deterministic) -------------------------------------

const RELIEF_TERMS = new Set<string>([
  'need',
  'needs',
  'critical',
  'criticals',
  'open',
  'close',
  'closed',
  'closing',
  'volunteer',
  'volunteers',
  'rescue',
  'food',
  'water',
  'medical',
  'shelter',
  'shelters',
  'transport',
  'deliver',
  'delivery',
  'delivered',
  'verify',
  'verified',
  'evidence',
  'sitrep',
  'situation',
  'status',
  'board',
  'report',
  'impact',
  'drift',
  'drifting',
  'overdue',
  'sla',
  'risk',
  'flood',
  'flooding',
  'relief',
  'help',
  'helped',
  'helping',
  'people',
  'family',
  'families',
  'household',
  'households',
  'claim',
  'claimed',
  'assign',
  'assigned',
  'reassign',
  'triage',
  'triaged',
  'review',
  'pending',
  'active',
  'locality',
  'area',
  'stranded',
  'trapped',
]);

const FIELD_CONTEXT_TERMS = [
  'shelter',
  'road',
  'boat',
  'relief center',
  'relief centre',
  'supply',
  'supplies',
  'capacity',
  'power',
  'electricity',
  'pump',
  'evacuat',
  'water level',
  'rescue team',
];

function isInScope(question: string, locality: { id: number } | null): boolean {
  if (locality !== null) return true;
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  return tokens.some((t) => RELIEF_TERMS.has(t));
}

function classifyIntent(question: string, locality: { id: number } | null): AskIntent {
  const t = question.toLowerCase();
  const has = (...keys: string[]): boolean => keys.some((k) => t.includes(k));
  if (has('sitrep', 'situation report', 'overview', 'summary', 'how are we', 'whole picture', 'the board', 'overall'))
    return 'sitrep';
  if (has('drift', 'overdue', 'at risk', 'at-risk', 'behind', 'sla', 'late', 'stalled', 'slipping', 'missing deadline'))
    return 'drifting';
  if (has('critical')) return 'open-criticals';
  if (locality !== null) return 'by-locality';
  return 'other';
}

// --- need selection + PII-free rows -----------------------------------------------------

const isActive = (n: ProjectedNeed): boolean => !TERMINAL_STATES.has(n.state);
const isOpenCritical = (n: ProjectedNeed): boolean => n.severity === 'critical' && isActive(n);
const isDrifting = (n: ProjectedNeed): boolean => n.flags.is_drifting || n.flags.is_at_risk;

interface NeedRow {
  label: string;
  permalink: string | null;
  text: string;
}

const shortLabel = (n: ProjectedNeed): string => `N${n.need_id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

/** Where a need is, PII-safe: gazetteer name, else scrubbed free-text, else a generic. */
function whereOf(n: ProjectedNeed): string {
  const named = localityNameFor(n.locality_id);
  if (named !== null) return named;
  if (n.location_text !== null && n.location_text.length > 0) return scrubText(n.location_text);
  return 'an unknown area';
}

function describeNeed(n: ProjectedNeed): string {
  return `${n.severity} ${n.type} in ${whereOf(n)}`;
}

function toRow(n: ProjectedNeed): NeedRow {
  const people = n.people_count !== null ? ` — ${n.people_count} ${n.people_count === 1 ? 'person' : 'people'}` : '';
  return {
    label: shortLabel(n),
    permalink: n.source.permalink ?? null,
    text: `[${shortLabel(n)}] ${describeNeed(n)} — ${n.state}${people}`,
  };
}

function selectNeeds(intent: AskIntent, active: ProjectedNeed[], locality: { id: number } | null): ProjectedNeed[] {
  let selected: ProjectedNeed[];
  switch (intent) {
    case 'open-criticals':
      selected = active.filter(isOpenCritical);
      break;
    case 'drifting':
      selected = active.filter(isDrifting);
      break;
    case 'by-locality':
      selected = locality === null ? [] : active.filter((n) => n.locality_id === locality.id);
      break;
    case 'sitrep':
      selected = [...active.filter(isOpenCritical), ...active.filter((n) => isDrifting(n) && !isOpenCritical(n))];
      break;
    default:
      selected = active.filter((n) => n.flags.is_open);
      break;
  }
  // A locality named alongside a non-locality intent narrows the selection (e.g. "criticals in Adyar").
  if (locality !== null && (intent === 'open-criticals' || intent === 'drifting' || intent === 'other')) {
    selected = selected.filter((n) => n.locality_id === locality.id);
  }
  return selected.slice(0, MAX_ROWS);
}

// --- RTS field context ------------------------------------------------------------------

function shouldUseRts(intent: AskIntent, locality: { id: number } | null, question: string): boolean {
  if (intent === 'by-locality' || locality !== null) return true;
  const t = question.toLowerCase();
  return FIELD_CONTEXT_TERMS.some((k) => t.includes(k));
}

function buildRtsRefs(question: string, locality: { id: number; name: string } | null): RtsReference[] {
  if (locality !== null) return [{ rtsQuery: `${locality.name} flood relief shelter status` }];
  return [{ rtsQuery: question.trim() }];
}

// --- figures + number allowlist ---------------------------------------------------------

function buildFigures(
  stats: SitrepStats,
  selectedCount: number,
  locality: { name: string } | null,
  localityCount: number,
): string[] {
  const figures = [
    `open_critical = ${stats.openCritical} (critical needs still open)`,
    `open = ${stats.open} (open, awaiting a volunteer)`,
    `total_active = ${stats.totalActive} (active needs on the board)`,
    `drifting = ${stats.drifting} (past their SLA)`,
    `at_risk = ${stats.atRisk} (approaching their SLA)`,
    `verified = ${stats.verified} (verified deliveries)`,
    `selected_rows = ${selectedCount} (needs listed below)`,
  ];
  if (locality !== null)
    figures.push(`in_${locality.name.replace(/\s+/g, '_')} = ${localityCount} (active needs there)`);
  return figures;
}

/** The only numbers an LLM answer may contain: every stat value + per-need counts + row counts. */
function buildAllowedNumbers(stats: SitrepStats, selected: ProjectedNeed[], localityCount: number): Set<string> {
  const allowed = new Set(buildTokenMap(stats.stats).allowedNumbers);
  allowed.add(String(selected.length));
  allowed.add(String(localityCount));
  for (const n of selected) if (n.people_count !== null) allowed.add(String(n.people_count));
  return allowed;
}

// --- citations --------------------------------------------------------------------------

/** Keep only citations whose permalink (if any) is one we actually provided; dedupe. */
function sanitizeCitations(cits: { label: string; permalink?: string }[], allowed: Set<string>): AnswerCitation[] {
  const out: AnswerCitation[] = [];
  const seen = new Set<string>();
  for (const c of cits) {
    const permalink = c.permalink !== undefined && allowed.has(c.permalink) ? c.permalink : undefined;
    const key = `${c.label}|${permalink ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(permalink !== undefined ? { label: c.label, permalink } : { label: c.label });
  }
  return out;
}

function templateCitations(rows: NeedRow[], rts: Citation[]): AnswerCitation[] {
  const out: AnswerCitation[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 6)) {
    if (r.permalink !== null && !seen.has(r.permalink)) {
      seen.add(r.permalink);
      out.push({ label: r.label, permalink: r.permalink });
    }
  }
  for (const c of rts) {
    if (c.permalink !== null && !seen.has(c.permalink)) {
      seen.add(c.permalink);
      out.push({ label: c.sourceLabel ?? 'field report', permalink: c.permalink });
    }
  }
  return out;
}

// --- deterministic template answer (no-LLM path AND llm-guard fallback) ------------------

function templateAnswer(
  intent: AskIntent,
  stats: SitrepStats,
  selected: ProjectedNeed[],
  locality: { name: string } | null,
): string {
  const list = (max: number): string => selected.slice(0, max).map(describeNeed).join('; ');
  const where = locality !== null ? ` in ${locality.name}` : '';
  const n = selected.length;
  switch (intent) {
    case 'open-criticals':
      return n === 0
        ? `No critical needs are open${where} right now — every critical need is claimed, verified, or closed.`
        : `${n} critical need${n === 1 ? ' is' : 's are'} still open${where}: ${list(6)}.`;
    case 'drifting':
      return n === 0
        ? `No needs are drifting or at risk of missing their SLA${where} right now.`
        : `${n} need${n === 1 ? ' is' : 's are'} drifting or at risk${where}: ${list(6)}.`;
    case 'by-locality':
      return n === 0
        ? `No active needs${where} right now.`
        : `${locality?.name ?? 'That area'}: ${n} active need${n === 1 ? '' : 's'} — ${list(8)}.`;
    case 'sitrep':
      return `Live board: ${stats.totalActive} active, ${stats.open} open and awaiting a volunteer, ${stats.openCritical} critical still open, ${stats.drifting} drifting, ${stats.verified} verified.`;
    default:
      return `${stats.open} need${stats.open === 1 ? ' is' : 's are'} open and awaiting a volunteer; ${stats.openCritical} of them ${stats.openCritical === 1 ? 'is' : 'are'} critical.`;
  }
}

/** Append short, scrubbed RTS field context to a template answer when RTS lit up. */
function withFieldContext(answer: string, rts: Citation[]): string {
  const notes = rts
    .map((c) => scrubText(c.snippet))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 2);
  return notes.length > 0 ? `${answer} Field context: ${notes.join(' ')}` : answer;
}

// --- the brain --------------------------------------------------------------------------

/**
 * Answer a coordinator's question, grounded in the ledger (+ optional RTS). Deterministic in
 * the no-LLM path; guarded (numbers + PII → template fallback) in the LLM path. Never returns
 * PII/contact, and refuses out-of-relief-scope questions.
 */
export async function askRelay(args: AskRelayArgs): Promise<AskRelayResult> {
  const now = args.now ?? Date.now();

  // 0) Safety pre-check — an emergency-dispatch question is answered with the safety refusal and
  // NEVER from the ledger. Runs first (before scope + before any LLM call) so it is deterministic
  // and holds with no LLM key. No ledger data, no citations.
  if (isEmergencyDispatchQuestion(args.question)) {
    return { answer: EMERGENCY_RESPONSE, citations: [], source: 'template', usedRts: false, intent: 'emergency' };
  }

  const locality = detectLocality(args.question);

  // 1) Scope gate — cheap short-circuit before any ledger/RTS work.
  if (!isInScope(args.question, locality)) {
    return { answer: REFUSAL, citations: [], source: 'template', usedRts: false, intent: 'out-of-scope' };
  }

  const intent = classifyIntent(args.question, locality);

  // 2) Gather PII-free grounding from the projection.
  const allNeeds = await args.service.listNeeds(now);
  const active = allNeeds.filter(isActive);
  const stats = computeSitrepStats(allNeeds, now);
  const selected = selectNeeds(intent, active, locality);
  const rows = selected.map(toRow);
  const localityCount = locality !== null ? active.filter((n) => n.locality_id === locality.id).length : 0;

  // 3) OPTIONAL RTS field context — degrade to ledger-only on any failure.
  let usedRts = false;
  let rtsCitations: Citation[] = [];
  if (args.rts !== undefined && shouldUseRts(intent, locality, args.question)) {
    try {
      const found = (await args.rts.resolveReferences(buildRtsRefs(args.question, locality))).filter((c) => c.found);
      rtsCitations = found;
      usedRts = found.length > 0;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'RTS unavailable — degrading to ledger-only',
      );
      rtsCitations = [];
      usedRts = false;
    }
  }

  const figures = buildFigures(stats, selected.length, locality, localityCount);
  const allowedNumbers = buildAllowedNumbers(stats, selected, localityCount);
  const allowedPermalinks = new Set<string>(
    [...rows.map((r) => r.permalink), ...rtsCitations.map((c) => c.permalink)].filter((p): p is string => p !== null),
  );

  const template = (): AskRelayResult => ({
    answer: withFieldContext(templateAnswer(intent, stats, selected, locality), rtsCitations),
    citations: templateCitations(rows, rtsCitations),
    source: 'template',
    usedRts,
    intent,
  });

  // 4a) No LLM → deterministic template (grounded, PII-free, hermetic).
  if (args.llm === undefined) return template();

  // 4b) LLM synthesis — guarded. On any failure or guard breach, fall back to the template.
  const grounding: AskGrounding = {
    intent,
    needRows: rows.map((r) => r.text),
    rtsSnippets: rtsCitations.map((c) => ({
      snippet: scrubText(c.snippet),
      sourceLabel: c.sourceLabel,
      permalink: c.permalink,
    })),
    availablePermalinks: [...allowedPermalinks],
    figures,
  };

  try {
    const out = await args.llm.parse(buildAskRequest(args.question, grounding));
    if (out.out_of_scope) {
      const answer = out.answer.trim().length > 0 ? out.answer.trim() : REFUSAL;
      return { answer, citations: [], source: 'llm', usedRts, intent: 'out-of-scope' };
    }
    const answer = out.answer.trim();
    const numbersOk = validateNumbers(answer, allowedNumbers).ok;
    const piiOk = assertNoPii(answer).ok;
    if (answer.length > 0 && numbersOk && piiOk) {
      return { answer, citations: sanitizeCitations(out.citations, allowedPermalinks), source: 'llm', usedRts, intent };
    }
    logger.warn({ numbersOk, piiOk }, 'ask-relay LLM answer failed a guard; falling back to template');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown' },
      'ask-relay LLM failed; falling back to template',
    );
  }
  return template();
}
