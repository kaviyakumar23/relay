import { z } from 'zod';
import type { NeedType } from '../ledger/types';
import type { LlmProvider } from '../llm/provider';
import { ALL_SKILLS, NEED_TYPE_SKILLS, type ScoredCandidate, type ScoreNeed } from './scorer';

// One-line "why this volunteer" rationale (BUILD-DOC §F3, prompt P-4). The LLM only
// ever PHRASES facts the deterministic scorer already established (name, matched skill,
// distance, shared language, availability) — it can never introduce a new fact. A
// strict validator rejects any line that names a skill the volunteer lacks, a language
// they don't speak, or a distance that isn't theirs; on any failure — or with no llm —
// we fall back to a deterministic template built from the same facts. Never guess
// (CLAUDE.md invariant 3). Input to the model carries derived fields only — no raw
// message text, no beneficiary PII.

const LANG_NAMES: Record<string, string> = { ta: 'Tamil', en: 'English' };

const langLabel = (code: string): string => LANG_NAMES[code] ?? code.toUpperCase();

/** The facts about a candidate that a rationale is allowed to mention. */
interface RationaleFacts {
  name: string;
  skill: string;
  distanceKm: number | null;
  availableNow: boolean;
  sharedLanguages: string[];
}

function factsOf(candidate: ScoredCandidate, need: ScoreNeed): RationaleFacts {
  const required = NEED_TYPE_SKILLS[need.type];
  const skills = candidate.volunteer.skills;
  const skill = skills.find((s) => required.includes(s)) ?? skills[0] ?? 'general help';
  const sharedLanguages = need.languages.filter((l) => candidate.volunteer.languages.includes(l));
  return {
    name: candidate.volunteer.display_name,
    skill,
    distanceKm: candidate.distanceKm,
    availableNow: candidate.breakdown.availability >= 1,
    sharedLanguages,
  };
}

/** Deterministic, always-valid fallback line assembled purely from the candidate facts. */
export function templateRationale(candidate: ScoredCandidate, need: ScoreNeed): string {
  const f = factsOf(candidate, need);
  const parts: string[] = [f.skill];
  if (f.distanceKm !== null) parts.push(`${f.distanceKm.toFixed(1)} km away`);
  parts.push(f.availableNow ? 'available now' : 'limited hours');
  if (f.sharedLanguages.length > 0) parts.push(`speaks ${f.sharedLanguages.map(langLabel).join(' & ')}`);
  return `${f.name}: ${parts.join(', ')}`;
}

const MatchRationaleSchema = z.object({ line: z.string().min(1).max(200) });

/** The volunteer facts a line is allowed to draw on. */
export interface GroundingFacts {
  name: string;
  distanceKm: number | null;
  skills: string[];
  languages: string[];
}

/**
 * Reject a candidate line that asserts a fact not grounded in `facts`:
 *  - must name the volunteer,
 *  - must not name any skill the volunteer lacks,
 *  - must not name any language the volunteer doesn't speak,
 *  - must not cite a "N km" distance other than the candidate's own,
 *  - single line only.
 */
export function isGroundedRationale(line: string, facts: GroundingFacts): boolean {
  if (line.includes('\n') || line.trim().length === 0) return false;
  const lower = line.toLowerCase();
  if (!lower.includes(facts.name.toLowerCase())) return false;

  const held = new Set(facts.skills.map((s) => s.toLowerCase()));
  for (const skill of ALL_SKILLS) {
    if (!held.has(skill) && lower.includes(skill)) return false; // names a skill they don't have
  }

  const spoken = new Set(facts.languages);
  for (const [code, name] of Object.entries(LANG_NAMES)) {
    if (!spoken.has(code) && lower.includes(name.toLowerCase())) return false; // names a language they don't speak
  }

  for (const match of line.matchAll(/(\d+(?:\.\d+)?)\s*km/gi)) {
    const cited = Number(match[1]);
    if (facts.distanceKm === null) return false; // no distance is known → any km claim is invented
    if (Math.abs(cited - facts.distanceKm) > 0.15) return false; // beyond rounding of the real distance
  }
  return true;
}

/**
 * Build the one-line rationale. With an llm, ask it to phrase the facts through the
 * provider seam (task 'matchRationale'), validate the output is grounded, and use it;
 * on any parse/validation failure or with no llm, return the deterministic template.
 */
export async function matchRationale(candidate: ScoredCandidate, need: ScoreNeed, llm?: LlmProvider): Promise<string> {
  const fallback = templateRationale(candidate, need);
  if (!llm) return fallback;

  const f = factsOf(candidate, need);
  const facts = {
    name: f.name,
    matched_skill: f.skill,
    distance_km: f.distanceKm,
    available_now: f.availableNow,
    shared_languages: f.sharedLanguages.map(langLabel),
    need_type: need.type as NeedType,
  };
  try {
    const out = await llm.parse({
      task: 'matchRationale',
      schemaName: 'MatchRationale',
      schema: MatchRationaleSchema,
      system:
        'Write ONE short factual line explaining why this volunteer fits, using ONLY the given facts. ' +
        'Do not invent skills, distances, languages, or credentials. No PII. Under 120 characters.',
      user: JSON.stringify(facts),
      maxTokens: 128,
    });
    const grounded = isGroundedRationale(out.line, {
      name: f.name,
      distanceKm: f.distanceKm,
      skills: candidate.volunteer.skills,
      languages: candidate.volunteer.languages,
    });
    return grounded ? out.line.trim() : fallback;
  } catch {
    return fallback; // LlmParseError / refusal / transport error → deterministic line
  }
}
