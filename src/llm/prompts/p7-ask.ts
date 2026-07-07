import { z } from 'zod';
import type { ParseRequest } from '../provider';

// P-7 Ask-Relay synthesis prompt + request builder (BUILD-DOC §10.3, CLAUDE.md conventions).
// PURE: buildAskRequest(question, grounding) is a function of the question + the grounding
// that src/assistant/askRelay.ts gathered from the ledger (and, optionally, RTS). It returns
// a provider-agnostic ParseRequest that forces AskAnswer-schema output, validated at the Zod
// boundary (invariant 3).
//
// The model SYNTHESISES a cited answer from the provided rows/snippets only. It never sources
// a fact or a number of its own: numbers must come from the FIGURES list (the {{stat:*}}
// discipline of P-5/P-6, applied conceptually here), and citations must be permalinks drawn
// from the provided AVAILABLE SOURCES list — it can neither invent a figure nor invent a link.
// Out-of-relief-scope questions are refused. The ledger rows are PII-free by construction and
// RTS snippets are redacted upstream, so no contact detail is ever in scope.

/** The Ask-Relay structured answer. `citations` link claims to ledger/RTS permalinks. */
export const AskAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({ label: z.string(), permalink: z.string().optional() })),
  out_of_scope: z.boolean(),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

/** The prompt-facing grounding: strings only, assembled by askRelay from the projection. */
export interface AskGrounding {
  /** The classifier's read of the question (open-criticals / by-locality / drifting / sitrep / other). */
  intent: string;
  /** PII-free ledger lines, each prefixed with a [Nxxxxxx] label. */
  needRows: string[];
  /** Redacted RTS excerpts for field context (ephemeral — cite the permalink). */
  rtsSnippets: { snippet: string; sourceLabel: string | null; permalink: string | null }[];
  /** The ONLY permalinks the model may cite. */
  availablePermalinks: string[];
  /** The ONLY numbers the model may state, e.g. "open_critical = 2". */
  figures: string[];
}

export const P7_ASK_SYSTEM = `You are Ask-Relay, the assistant for a volunteer flood-response coordination workspace. A coordinator asks a question; you answer it from the ledger rows and field snippets provided in the user message — and from nothing else.

Return ONLY one object matching the schema: { "answer": string, "citations": [{ "label": string, "permalink"?: string }], "out_of_scope": boolean }.

SCOPE:
- You answer operational questions about THIS relief effort: open needs, critical needs, a locality's needs, drift / SLA risk, verification, and the live sitrep.
- If the question is outside relief operations (weather, general knowledge, chit-chat, math, coding, opinions, anything not about this operation), set "out_of_scope": true, leave "citations" empty, and make "answer" a brief polite refusal: "I track relief operations, not general questions." Do not attempt to answer the off-topic question.

SAFETY (emergency dispatch):
- Relay coordinates volunteers; it is NOT an emergency service and cannot dispatch police, fire, or ambulances. If the question asks you to call emergency services / 911 / 108 / an ambulance, or asks whether this is an emergency line, set "out_of_scope": true, leave "citations" empty, and make "answer" exactly: "Relay coordinates volunteer relief inside this workspace — it is not an emergency service. For a life-threatening emergency contact your local emergency number directly." Never answer such a question from the ledger.

GROUNDING (hard rules):
- Use ONLY the provided ledger rows and field snippets. If they do not contain the answer, say so plainly — never speculate or fall back on outside knowledge.
- NUMBERS: every figure you state must come from the FIGURES list, or be a count you can directly see in the provided rows. Never invent totals, percentages, rates, or estimates. If a number is not supported by the context, do not state it.
- Refer to needs by their type and locality (e.g. "a critical medical need in Taramani"), not by raw id.

CITATIONS:
- Put your sources in the "citations" array as { "label", "permalink" }. Cite ONLY permalinks from the AVAILABLE SOURCES list; never invent or alter a link. If you have no permalink for a claim, you may still answer from the rows, but do not fabricate a citation.

PRIVACY: Never include a phone number, name, address, or any personal contact detail. The rows and snippets are already redacted — keep them that way.

TONE: factual, calm, and specific — this is disaster operations, not marketing. Lead with the direct answer, then the supporting detail. No praise, no exclamation marks. Keep it under roughly 120 words.`;

const joinOr = (lines: string[], empty: string): string =>
  lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : empty;

/**
 * Build the provider-agnostic P-7 request. The grounding teaches the model the exact figures
 * it may cite, the PII-free rows that are the operational truth, any redacted field snippets,
 * and the closed set of permalinks it may use as sources. askRelay renders/guards the result.
 */
export function buildAskRequest(question: string, grounding: AskGrounding): ParseRequest<typeof AskAnswerSchema> {
  const snippetLines = grounding.rtsSnippets.map((s) => {
    const label = s.sourceLabel ? ` (${s.sourceLabel})` : '';
    const link = s.permalink ? ` [${s.permalink}]` : '';
    return `${s.snippet}${label}${link}`;
  });

  const user = `Question: ${question}

CLASSIFIER INTENT: ${grounding.intent}

FIGURES (the ONLY numbers you may state):
${joinOr(grounding.figures, '- (no figures)')}

LEDGER ROWS (PII-free operational truth):
${joinOr(grounding.needRows, '- (no matching needs on the board)')}

FIELD SNIPPETS (Real-Time Search; ephemeral — cite the permalink):
${joinOr(snippetLines, '- (no field snippets)')}

AVAILABLE SOURCES (cite ONLY these permalinks):
${joinOr(grounding.availablePermalinks, '- (no sources)')}

Answer now as { "answer": "...", "citations": [ ... ], "out_of_scope": false }.`;

  return {
    task: 'askRelay',
    system: P7_ASK_SYSTEM,
    user,
    schema: AskAnswerSchema,
    schemaName: 'AskAnswer',
    maxTokens: 512,
  };
}
