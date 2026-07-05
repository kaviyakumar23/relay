import type { NeedDraft, Severity } from '../src/llm/needDraft';
import { FLOOR_KEYWORDS, hasFloorKeyword } from '../src/pipeline/severityFloor';

// eval/score.ts — pure, deterministic scoring for the intake-extraction eval
// (BUILD-DOC §10.5). No LLM, no network, no clock. Every number `npm run eval`
// publishes into the Devpost writeup is computed here, so the math must be exact and
// honest: needs-review deferrals are reported, never hidden as correct answers.

export type EvalLanguage = 'en' | 'ta-en';

// ── Deterministic severity floor ────────────────────────────────────────────────
// CLAUDE.md invariant 4 / BUILD-DOC §11.2: these keywords force severity=critical and
// the model may never lower them. The canonical list + predicate now live in
// src/pipeline/severityFloor.ts — runtime code under src/ must not import from eval/
// (Docker excludes eval/ via .dockerignore), so the single source of truth moved there
// and is re-exported here. eval/run.ts asserts every gold critical case contains a floor
// keyword and no non-critical case does; the runtime extractor enforces the same floor.
export { FLOOR_KEYWORDS };

/** True when a message contains a deterministic critical-floor keyword. */
export const hitsCriticalFloor = hasFloorKeyword;

// The canonical fields the scorer compares provenance status on. `summary_en` and
// `languages` are meta/derived and carry no provenance.
export const PROVENANCE_FIELDS = [
  'type',
  'severity',
  'locality_guess',
  'location_text',
  'people_count',
  'contact_raw',
] as const;
export type ProvField = (typeof PROVENANCE_FIELDS)[number];

// Locality aliases → canonical (all lowercased). Transliteration / spelling variants a
// predictor might emit for the seeded Chennai-style localities. When seed/localities.json
// lands, merge its alias lists into this table so scoring stays consistent with geocoding.
const LOCALITY_ALIASES: Record<string, string> = {
  velacheri: 'velachery',
  velacherry: 'velachery',
  tiruvanmiyur: 'thiruvanmiyur',
  thiruvanmyur: 'thiruvanmiyur',
  tvm: 'thiruvanmiyur',
  bessie: 'besant nagar',
  besantnagar: 'besant nagar',
  'besant nager': 'besant nagar',
  'kottur puram': 'kotturpuram',
  kotturpurm: 'kotturpuram',
  saidapettai: 'saidapet',
  mylapur: 'mylapore',
};

/** Case/alias-insensitive locality normalization. null in → null out. */
export function normalizeLocality(name: string | null): string | null {
  if (name == null) return null;
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (key === '') return null;
  return LOCALITY_ALIASES[key] ?? key;
}

/** Reduce a contact string to comparable digits: strip non-digits, drop an Indian
 *  country code (+91) or trunk 0, and compare the trailing 10 digits. null in → null out. */
export function normalizeContact(raw: string | null): string | null {
  if (raw == null) return null;
  let digits = raw.replace(/\D+/g, '');
  if (digits === '') return null;
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export interface CaseScore {
  needsReview: boolean;
  goldSeverity: Severity;
  predictedSeverity: Severity | null;
  fields: {
    type: boolean;
    severity: boolean;
    locality_guess: boolean;
    people_count: boolean;
    contact_raw: boolean;
  };
  provenance: Record<ProvField, boolean>;
}

export interface EvalResult {
  id: string;
  language: EvalLanguage;
  score: CaseScore;
}

const EMPTY_PROVENANCE: Record<ProvField, boolean> = {
  type: false,
  severity: false,
  locality_guess: false,
  location_text: false,
  people_count: false,
  contact_raw: false,
};

function provStatusMatch(gold: NeedDraft, predicted: NeedDraft, f: ProvField): boolean {
  const gs = gold.provenance[f]?.status;
  if (gs === undefined) return false;
  return gs === predicted.provenance[f]?.status;
}

function scoreProvenance(gold: NeedDraft, predicted: NeedDraft): Record<ProvField, boolean> {
  return {
    type: provStatusMatch(gold, predicted, 'type'),
    severity: provStatusMatch(gold, predicted, 'severity'),
    locality_guess: provStatusMatch(gold, predicted, 'locality_guess'),
    location_text: provStatusMatch(gold, predicted, 'location_text'),
    people_count: provStatusMatch(gold, predicted, 'people_count'),
    contact_raw: provStatusMatch(gold, predicted, 'contact_raw'),
  };
}

// A null prediction = the extractor punted to NEEDS_REVIEW (validation failed after the
// repair pass). We record it as such rather than scoring garbage; aggregate() reports the
// rate separately and counts a punted gold-critical as a recall miss.
export function scoreCase(gold: NeedDraft, predicted: NeedDraft | null): CaseScore {
  if (predicted === null) {
    return {
      needsReview: true,
      goldSeverity: gold.severity,
      predictedSeverity: null,
      fields: { type: false, severity: false, locality_guess: false, people_count: false, contact_raw: false },
      provenance: { ...EMPTY_PROVENANCE },
    };
  }
  return {
    needsReview: false,
    goldSeverity: gold.severity,
    predictedSeverity: predicted.severity,
    fields: {
      type: gold.type === predicted.type,
      severity: gold.severity === predicted.severity,
      locality_guess: normalizeLocality(gold.locality_guess) === normalizeLocality(predicted.locality_guess),
      people_count: gold.people_count === predicted.people_count,
      contact_raw: normalizeContact(gold.contact_raw) === normalizeContact(predicted.contact_raw),
    },
    provenance: scoreProvenance(gold, predicted),
  };
}

export interface FieldAccuracy {
  overall: number;
  type: number;
  severity: number;
  locality_guess: number;
  people_count: number;
  contact_raw: number;
  provenance: number;
}

export interface LangStats {
  n: number;
  fieldAccuracy: number;
  criticalRecall: number;
}

export interface Aggregate {
  n: number;
  attempted: number;
  needsReviewRate: number;
  fieldAccuracy: FieldAccuracy;
  criticalRecall: number;
  criticalPrecision: number;
  perLanguage: Partial<Record<EvalLanguage, LangStats>>;
}

const ZERO_FIELD_ACCURACY: FieldAccuracy = {
  overall: 0,
  type: 0,
  severity: 0,
  locality_guess: 0,
  people_count: 0,
  contact_raw: 0,
  provenance: 0,
};

// Field accuracy is measured over ATTEMPTED extractions (predicted !== null). Needs-review
// deferrals are reported separately via needsReviewRate so a model cannot inflate accuracy
// by punting its hard cases — the writeup publishes both numbers side by side.
function fieldAccuracy(scores: CaseScore[]): FieldAccuracy {
  const n = scores.length;
  if (n === 0) return { ...ZERO_FIELD_ACCURACY };
  let typeC = 0;
  let sevC = 0;
  let locC = 0;
  let pcC = 0;
  let conC = 0;
  let provC = 0;
  let provT = 0;
  for (const s of scores) {
    if (s.fields.type) typeC++;
    if (s.fields.severity) sevC++;
    if (s.fields.locality_guess) locC++;
    if (s.fields.people_count) pcC++;
    if (s.fields.contact_raw) conC++;
    for (const f of PROVENANCE_FIELDS) {
      provT++;
      if (s.provenance[f]) provC++;
    }
  }
  return {
    overall: (typeC + sevC + locC + pcC + conC + provC) / (n * 5 + provT),
    type: typeC / n,
    severity: sevC / n,
    locality_guess: locC / n,
    people_count: pcC / n,
    contact_raw: conC / n,
    provenance: provC / provT,
  };
}

export function aggregate(results: EvalResult[]): Aggregate {
  const n = results.length;
  const attemptedScores = results.filter((r) => !r.score.needsReview).map((r) => r.score);
  const needsReview = results.filter((r) => r.score.needsReview).length;

  const goldCritical = results.filter((r) => r.score.goldSeverity === 'critical');
  const predCritical = results.filter((r) => r.score.predictedSeverity === 'critical');
  const recallHits = goldCritical.filter((r) => r.score.predictedSeverity === 'critical').length;
  const precisionHits = predCritical.filter((r) => r.score.goldSeverity === 'critical').length;

  const perLanguage: Partial<Record<EvalLanguage, LangStats>> = {};
  for (const lang of ['en', 'ta-en'] as const) {
    const subset = results.filter((r) => r.language === lang);
    if (subset.length === 0) continue;
    const subCrit = subset.filter((r) => r.score.goldSeverity === 'critical');
    const subRecall = subCrit.filter((r) => r.score.predictedSeverity === 'critical').length;
    perLanguage[lang] = {
      n: subset.length,
      fieldAccuracy: fieldAccuracy(subset.filter((r) => !r.score.needsReview).map((r) => r.score)).overall,
      criticalRecall: subCrit.length === 0 ? 0 : subRecall / subCrit.length,
    };
  }

  return {
    n,
    attempted: attemptedScores.length,
    needsReviewRate: n === 0 ? 0 : needsReview / n,
    fieldAccuracy: fieldAccuracy(attemptedScores),
    // A gold-critical case punted to needs-review counts as a recall miss (predictedSeverity
    // null): we did not auto-identify it as critical, even though a human still sees it.
    criticalRecall: goldCritical.length === 0 ? 0 : recallHits / goldCritical.length,
    // Vacuous 1.0 when nothing was predicted critical (there are no false alarms to divide).
    criticalPrecision: predCritical.length === 0 ? 1 : precisionHits / predCritical.length,
    perLanguage,
  };
}
