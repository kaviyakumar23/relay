import type { StatSet } from '../../narrate/aggregate';
import { NarrativeSchema, type TokenInfo } from '../../narrate/statTokens';
import type { ParseRequest } from '../provider';

// P-5 sitrep prompt + request builder (BUILD-DOC §F6, §10.3). PURE: buildSitrepRequest is a
// function of the aggregated StatSet + its described tokens only. It returns a
// provider-agnostic ParseRequest that forces NarrativeSchema output and validates at the Zod
// boundary (CLAUDE.md invariant 3). The model PHRASES a live snapshot; it never sources a
// number — every digit must be a {{stat:*}} token, which statTokens renders to the ledger's
// value and then guards against any stray. No PII is ever in scope (the ledger is PII-free).

export const P5_SITREP_SYSTEM = `You write the live situation report ("sitrep") for #relay-hq, the coordination channel of a volunteer flood-response operation. Coordinators read it to see the state of the board right now.

Return ONLY one object matching the schema: { "narrative": string }. No markdown headings, no lists — a few short paragraphs of plain prose.

NUMBER DISCIPLINE (this is a hard safety rule, not a style note):
- You are given a fixed set of {{stat:*}} tokens. Use the token VERBATIM for every number you mention. For example write "{{stat:open_critical}} critical needs are still open", never "3 critical needs".
- NEVER type a raw digit of your own. Every numeric figure in your output must be a {{stat:*}} token. Do not invent totals, percentages, dates, or times. If a number is not in the token list, do not state it.
- Only mention figures that matter operationally. You do not have to use every token; prefer the ones that tell coordinators where to act.

TONE: factual, calm, and specific — this is disaster operations, not marketing. No praise, no exclamation marks, no speculation about causes or outcomes. Lead with what needs attention (open criticals, drift, needs awaiting review), then the working picture (claimed / in progress / verified). Keep it under roughly 120 words.`;

const formatTokenLine = (t: TokenInfo): string => `- ${t.token} — ${t.label} (value: ${t.value})`;

/**
 * Build the provider-agnostic P-5 sitrep request. The token list teaches the model which
 * figures exist and what each means; the model must reuse the tokens verbatim. Values are
 * shown only to help phrasing (pluralization, "none") — the token is the number.
 */
export function buildSitrepRequest(_stats: StatSet, tokens: TokenInfo[]): ParseRequest<typeof NarrativeSchema> {
  const tokenBlock = tokens.map(formatTokenLine).join('\n');
  const user = `Write the current sitrep from these ledger figures. Use each {{stat:*}} token verbatim for its number; do not type any raw digit.

AVAILABLE FIGURES (token — meaning):
${tokenBlock}

Compose the sitrep now as { "narrative": "..." }.`;
  return {
    task: 'sitrep',
    system: P5_SITREP_SYSTEM,
    user,
    schema: NarrativeSchema,
    schemaName: 'Narrative',
    maxTokens: 512,
  };
}
