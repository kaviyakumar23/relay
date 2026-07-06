import type { NeedType } from '../ledger/types';
import type { Volunteer } from './volunteerStore';

// Deterministic volunteer scorer (BUILD-DOC §F3). The LLM never ranks volunteers —
// this pure function does, from structured fields only, so a score is reproducible,
// explainable, and testable to the decimal. The LLM's only job downstream is to phrase
// the winning rationale (rationale.ts), never to change the order.
//
//   score = 0.35·skill + 0.25·proximity + 0.15·availability + 0.15·(1 − load_ratio) + 0.10·language
//
// Every component is normalized to [0,1]; `breakdown` exposes the exact component values
// that went into the weighted sum (breakdown.load is the 1 − load_ratio spare-capacity
// term, so higher = more headroom, consistent with the other components).

/** Weight each component contributes to the final score (sums to 1.0). */
export const SCORE_WEIGHTS = {
  skill: 0.35,
  proximity: 0.25,
  availability: 0.15,
  load: 0.15,
  language: 0.1,
} as const;

export type ScoreWeights = Record<keyof typeof SCORE_WEIGHTS, number>;

/** The canonical skills that satisfy each need type. `other` accepts any skill. */
export const ALL_SKILLS = ['boat', 'medical', 'driver', 'cooking', 'translation', 'tech', 'muscle'] as const;

export const NEED_TYPE_SKILLS: Record<NeedType, readonly string[]> = {
  medical: ['medical'],
  rescue: ['boat', 'muscle', 'driver'],
  food: ['cooking', 'driver'],
  water: ['driver', 'muscle'],
  shelter: ['muscle', 'driver'],
  transport: ['driver'],
  other: ALL_SKILLS,
};

/** The minimal need view the scorer needs — no raw text, no PII. */
export interface ScoreNeed {
  type: NeedType;
  localityId: number | null;
  languages: string[];
}

/** A gazetteer entry (seed/localities.json resolved by src/pipeline/geocode.ts). */
export interface LocalityCoord {
  id: number;
  lat: number;
  lng: number;
}

/** The per-component values that fed the weighted sum, each in [0,1]. */
export interface ScoreBreakdown {
  skill: number;
  proximity: number;
  availability: number;
  /** Spare-capacity term = 1 − load_ratio (higher = more headroom). */
  load: number;
  language: number;
}

export interface ScoredCandidate {
  volunteer: Volunteer;
  score: number;
  /** Haversine km between need locality and volunteer home locality, or null if either is unknown. */
  distanceKm: number | null;
  breakdown: ScoreBreakdown;
}

export interface ScoreOptions {
  /** Override any component weight (defaults to SCORE_WEIGHTS). Determinism preserved. */
  weights?: Partial<ScoreWeights>;
}

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Great-circle distance in km between two lat/lng points. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * skill = 1 when the volunteer holds any skill mapped to the need type; 0.3 (partial /
 * "adjacent") when they hold some skill but none of the required ones; 0 when they list
 * no skills at all.
 */
export function skillScore(needType: NeedType, skills: string[]): number {
  if (skills.length === 0) return 0;
  const required = NEED_TYPE_SKILLS[needType];
  if (skills.some((s) => required.includes(s))) return 1;
  return 0.3;
}

/**
 * availability (pragmatic, clock-free so the scorer stays pure): a volunteer marked
 * always-available (empty descriptor, `{always:true}`, `{mode:'always'}`, or a 7-day
 * schedule) scores 1; a windowed availability (`daytime`/`evenings`, or a partial-week
 * schedule) scores 0.5. The integrator can refine this against a real clock later.
 */
export function availabilityScore(availability: Record<string, unknown> | null | undefined): number {
  if (!availability || Object.keys(availability).length === 0) return 1;
  if (availability.always === true) return 1;
  const mode = availability.mode;
  if (mode === 'always') return 1;
  if (mode === 'daytime' || mode === 'evenings') return 0.5;
  if (Array.isArray(availability.days)) return availability.days.length >= 7 ? 1 : 0.5;
  return 0.5;
}

/** language = 1 if any language is shared (or the need states none); else 0. */
export function languageScore(needLanguages: string[], volunteerLanguages: string[]): number {
  if (needLanguages.length === 0) return 1; // no language constraint on this need
  return needLanguages.some((l) => volunteerLanguages.includes(l)) ? 1 : 0;
}

function proximity(
  need: ScoreNeed,
  volunteer: Volunteer,
  locById: Map<number, LocalityCoord>,
): { score: number; distanceKm: number | null } {
  const from = need.localityId !== null ? locById.get(need.localityId) : undefined;
  const to = volunteer.home_locality !== null ? locById.get(volunteer.home_locality) : undefined;
  if (!from || !to) return { score: 0.5, distanceKm: null }; // unknown locality → neutral
  const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const radius = Math.max(volunteer.radius_km, 1);
  return { score: clamp01(Math.exp(-distanceKm / radius)), distanceKm };
}

function scoreOne(
  need: ScoreNeed,
  volunteer: Volunteer,
  locById: Map<number, LocalityCoord>,
  weights: ScoreWeights,
): ScoredCandidate {
  const skill = skillScore(need.type, volunteer.skills);
  const prox = proximity(need, volunteer, locById);
  const availability = availabilityScore(volunteer.availability);
  const loadRatio = clamp01(volunteer.active_load / Math.max(volunteer.capacity_per_day, 1));
  const load = 1 - loadRatio;
  const language = languageScore(need.languages, volunteer.languages);
  const breakdown: ScoreBreakdown = { skill, proximity: prox.score, availability, load, language };
  const score =
    weights.skill * skill +
    weights.proximity * prox.score +
    weights.availability * availability +
    weights.load * load +
    weights.language * language;
  return { volunteer, score, distanceKm: prox.distanceKm, breakdown };
}

/** Deterministic tie-break: higher score, then nearer (nulls last), then slack_user_id. */
function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return a.volunteer.slack_user_id.localeCompare(b.volunteer.slack_user_id);
}

/**
 * Score every volunteer against a need, returned highest-first. Pure: same inputs always
 * yield the same ordering and the same numbers.
 */
export function scoreVolunteers(
  need: ScoreNeed,
  volunteers: Volunteer[],
  localities: LocalityCoord[],
  opts: ScoreOptions = {},
): ScoredCandidate[] {
  const weights: ScoreWeights = { ...SCORE_WEIGHTS, ...opts.weights };
  const locById = new Map<number, LocalityCoord>(localities.map((l) => [l.id, l]));
  return volunteers.map((v) => scoreOne(need, v, locById, weights)).sort(compareCandidates);
}

/** The top-N scored candidates (default 3). */
export function topN(
  need: ScoreNeed,
  volunteers: Volunteer[],
  localities: LocalityCoord[],
  n = 3,
  opts: ScoreOptions = {},
): ScoredCandidate[] {
  return scoreVolunteers(need, volunteers, localities, opts).slice(0, Math.max(0, n));
}
