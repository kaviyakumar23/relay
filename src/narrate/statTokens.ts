import { z } from 'zod';
import { LlmParseError, type LlmProvider, type ParseRequest } from '../llm/provider';
import type { StatSet } from './aggregate';

// The number-integrity engine (BUILD-DOC §F7 — the crown-jewel guarantee): a generated
// narrative's numbers ALWAYS equal the ledger's numbers. Ported from impactlens's
// scrubUnverifiedNumbers + Gate 3 (an allowlist of blessed numeric values), using Relay's
// {{stat:*}} token variant.
//
// The mechanism, in three moves:
//   1. buildTokenMap  — turn the StatSet into {{stat:key}} → "value" tokens AND the set of
//      the ONLY numeric strings a narrative is permitted to contain.
//   2. the model writes prose using those tokens verbatim for every number (P-5/P-6).
//   3. renderTokens substitutes the values, then validateNumbers scans the RESULT for any
//      stray digit run not in the allowlist — that is a hallucinated number → reject.
// On any stray (or an LLM parse failure), narrateWithIntegrity regenerates, then falls back
// to plainStatsTemplate, whose numbers come straight from the StatSet and so always validate.
// No unvalidated number is ever emitted.

/** The narration schema: the model returns prose with {{stat:*}} tokens, nothing else. */
export const NarrativeSchema = z.object({ narrative: z.string().min(1) });
export type NarrativeOutput = z.infer<typeof NarrativeSchema>;

export interface TokenMap {
  /** '{{stat:open_critical}}' -> '3' */
  tokens: Record<string, string>;
  /** Every normalized stat value (and its separator-free digit form). The allowlist. */
  allowedNumbers: Set<string>;
}

/** A token described for the prompt: the literal token, its meaning, and its value. */
export interface TokenInfo {
  token: string;
  key: string;
  label: string;
  value: number;
  eventRefs?: string[];
}

const tokenFor = (key: string): string => `{{stat:${key}}}`;

/** Build the token→value map and the numeric allowlist from a StatSet. */
export function buildTokenMap(stats: StatSet): TokenMap {
  const tokens: Record<string, string> = {};
  const allowedNumbers = new Set<string>();
  for (const s of stats) {
    const value = String(s.value);
    tokens[tokenFor(s.key)] = value;
    allowedNumbers.add(value);
    allowedNumbers.add(value.replace(/[,\s]/g, '')); // separator-free digit form
  }
  return { tokens, allowedNumbers };
}

/** Describe every available token for the prompt's token list. */
export function toTokenList(stats: StatSet): TokenInfo[] {
  return stats.map((s) => ({
    token: tokenFor(s.key),
    key: s.key,
    label: s.label,
    value: s.value,
    ...(s.eventRefs !== undefined ? { eventRefs: s.eventRefs } : {}),
  }));
}

/** Substitute every {{stat:*}} token with its ledger value. Unknown tokens are left
 * intact so the caller can detect an invented token (narrateWithIntegrity treats a
 * residual `{{stat:` as a failed generation). */
export function renderTokens(narrativeWithTokens: string, map: TokenMap): string {
  let out = narrativeWithTokens;
  for (const [token, value] of Object.entries(map.tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

// A permalink / URL — its digits (message ts, channel ids) are NOT claims.
const URL_RE = /https?:\/\/[^\s|>]+/g;
// A footnote reference beginning with a letter, e.g. [N-0421] or [E12] — its digits are a
// ledger citation, not a claim. A bracket starting with a digit (e.g. "[3 items]") is NOT
// exempt and its digits are still validated.
const REF_RE = /\[[A-Za-z][^\]]*\]/g;
// A maximal run of digits, optionally grouped with , or . (e.g. 1,234 or 42.5).
const DIGIT_RUN_RE = /\d+(?:[.,]\d+)*/g;

/**
 * The hallucination guard: after tokens are rendered, scan the final text for any numeric
 * run that is not in the allowlist. Numbers inside URLs/permalinks and inside footnote refs
 * ([N-0421], [E12]) are ignored. Any remaining stray → ok:false.
 */
export function validateNumbers(finalText: string, allowedNumbers: Set<string>): { ok: boolean; strays: string[] } {
  const scrubbed = finalText.replace(URL_RE, ' ').replace(REF_RE, ' ');
  const strays: string[] = [];
  for (const match of scrubbed.matchAll(DIGIT_RUN_RE)) {
    const run = match[0];
    const normalized = run.replace(/[,\s]/g, '');
    if (!allowedNumbers.has(run) && !allowedNumbers.has(normalized)) strays.push(run);
  }
  return { ok: strays.length === 0, strays };
}

/**
 * The deterministic, always-valid narrative — the no-LLM path AND the fallback after failed
 * LLM attempts. Every number comes straight from the StatSet, so it always passes
 * validateNumbers. Labels are digit-free by construction, so no stray can appear.
 */
export function plainStatsTemplate(stats: StatSet, kind: 'sitrep' | 'report'): string {
  const lead =
    kind === 'sitrep'
      ? 'Live situation report.'
      : 'Verified impact report — every figure below is drawn directly from the ledger.';
  if (stats.length === 0) return `${lead} No figures to report.`;
  const clauses = stats.map((s) => `${s.value} ${s.label}`);
  return `${lead} ${clauses.join('; ')}.`;
}

// --- orchestration ----------------------------------------------------------

export interface NarrateArgs {
  stats: StatSet;
  kind: 'sitrep' | 'report';
  llm?: LlmProvider;
  /** Builds the provider-agnostic request from the stats + the described token list
   * (see p5-sitrep / p6-report). */
  buildRequest: (stats: StatSet, tokens: TokenInfo[]) => ParseRequest<typeof NarrativeSchema>;
}

export interface NarrateResult {
  text: string;
  source: 'llm' | 'template';
  attempts: number;
}

/** 1 initial generation + up to 2 regenerations on a stray/parse failure (BUILD-DOC §F6/§F7). */
const MAX_LLM_ATTEMPTS = 3;

/**
 * Produce a narrative whose numbers are guaranteed to equal the ledger's. With an llm:
 * generate → render tokens → validate; on a stray, an unresolved token, or an LlmParseError,
 * regenerate (up to MAX_LLM_ATTEMPTS), then fall back to the deterministic template. With no
 * llm: the template. Either way, an unvalidated number is NEVER emitted.
 */
export async function narrateWithIntegrity(args: NarrateArgs): Promise<NarrateResult> {
  const { stats, kind, llm, buildRequest } = args;
  const template = (): string => plainStatsTemplate(stats, kind);
  if (!llm) return { text: template(), source: 'template', attempts: 0 };

  const map = buildTokenMap(stats);
  const tokenList = toTokenList(stats);
  let attempts = 0;

  for (let i = 0; i < MAX_LLM_ATTEMPTS; i++) {
    attempts += 1;
    try {
      const out = await llm.parse(buildRequest(stats, tokenList));
      const rendered = renderTokens(out.narrative, map);
      if (rendered.includes('{{stat:')) continue; // invented/unknown token → regenerate
      if (validateNumbers(rendered, map.allowedNumbers).ok) {
        return { text: rendered.trim(), source: 'llm', attempts };
      }
      // a stray hallucinated number → regenerate
    } catch (err) {
      if (err instanceof LlmParseError) continue; // schema failure after repair → regenerate
      break; // refusal / transport error → stop trying the model, use the template
    }
  }
  return { text: template(), source: 'template', attempts };
}
