import type { StatSet } from '../../narrate/aggregate';
import { NarrativeSchema, type TokenInfo } from '../../narrate/statTokens';
import type { ParseRequest } from '../provider';

// P-6 donor/impact report prompt + request builder (BUILD-DOC §F7, §10.3). PURE: a function
// of the VERIFIED-ONLY aggregated StatSet + its described tokens. Returns a provider-agnostic
// ParseRequest forcing NarrativeSchema output, validated at the Zod boundary (invariant 3).
//
// The crown-jewel guarantee (F7): every number in the report equals a ledger value AND every
// claim is footnoted to the ledger events backing it. The model reuses {{stat:*}} tokens
// verbatim (statTokens renders + guards them) and appends a [ref] citation drawn ONLY from
// the provided reference list — it can neither invent a number nor invent a source.

/** Max citation refs shown to the model per figure (keeps the prompt compact). */
const MAX_REFS_SHOWN = 4;

export const P6_REPORT_SYSTEM = `You write the verified-impact report for a volunteer flood-response operation — read by donors, partner NGOs, and the public. It must be defensible: every number is real and every claim is sourced.

Return ONLY one object matching the schema: { "narrative": string }. A few short paragraphs of plain prose — no headings, no bullet lists, no markdown tables.

NUMBER DISCIPLINE (a hard integrity rule):
- You are given a fixed set of {{stat:*}} tokens, one per verified figure. Use the token VERBATIM for every number. Write "{{stat:people_helped}} people received verified help", never "500 people".
- NEVER type a raw digit of your own. No invented totals, growth rates, percentages, dates, or times. If a figure is not a token, it does not exist for this report.
- This report covers VERIFIED deliveries only — deliveries closed on evidence. Do not describe unverified or in-progress work as delivered impact.

CITATIONS (every claim links to the ledger):
- After each factual claim, append its reference(s) in square brackets exactly as given in the reference list, e.g. "...reached {{stat:people_helped}} people [N-0421][N-0507].".
- Use ONLY the references provided for that figure. Never invent a reference id. If several are listed, cite one or two representative ones.

TONE: factual, calm, and precise — accountability, not marketing. No superlatives, no emotional appeals, no exclamation marks. Keep it under roughly 150 words.`;

const formatTokenLine = (t: TokenInfo): string => {
  const refs = t.eventRefs ?? [];
  const shown = refs.slice(0, MAX_REFS_SHOWN).map((r) => `[${r}]`);
  const more = refs.length > MAX_REFS_SHOWN ? ` (+${refs.length - MAX_REFS_SHOWN} more)` : '';
  const cite = shown.length > 0 ? ` — cite: ${shown.join('')}${more}` : ' — no reference';
  return `- ${t.token} — ${t.label} (value: ${t.value})${cite}`;
};

/**
 * Build the provider-agnostic P-6 report request. The token list carries each figure's
 * meaning, value, and the ledger references the model may cite. The model reuses tokens
 * verbatim and footnotes each claim from the provided refs; statTokens then renders the
 * tokens and rejects any stray number. Note: reference labels shown here are whatever the
 * caller placed in Stat.eventRefs (need_ids by default; resolve them to public ids /
 * permalinks upstream for reader-facing footnotes).
 */
export function buildReportRequest(_stats: StatSet, tokens: TokenInfo[]): ParseRequest<typeof NarrativeSchema> {
  const tokenBlock = tokens.map(formatTokenLine).join('\n');
  const user = `Write the verified-impact report from these ledger figures. Use each {{stat:*}} token verbatim for its number, and footnote every claim with a reference from its cite list.

VERIFIED FIGURES (token — meaning — allowed citations):
${tokenBlock}

Compose the report now as { "narrative": "..." }.`;
  return {
    task: 'report',
    system: P6_REPORT_SYSTEM,
    user,
    schema: NarrativeSchema,
    schemaName: 'Narrative',
    maxTokens: 768,
  };
}
