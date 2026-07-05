import { NeedDraftSchema } from '../needDraft';
import type { ParseRequest } from '../provider';

// P-1 intake-extraction prompt + request builder (BUILD-DOC Appendix C, §10.3).
//
// This module is PURE: buildExtractionRequest(text) is a function of the message text
// only. It does NOT call the LLM — it returns a provider-agnostic ParseRequest that the
// injected LlmProvider forces to schema-valid NeedDraft output and validates at the Zod
// boundary (CLAUDE.md invariant 3). The provider attaches NeedDraftSchema as a forced
// tool, so the SYSTEM prompt teaches the semantics; the schema itself enforces shape.
//
// Locality resolution is deliberately NOT done here: the deterministic gazetteer geocoder
// resolves localities AFTER extraction, so the model only emits a free-text locality_guess.
// Keeping this a pure function of text is what lets `npm test`/`npm run demo` stay hermetic.
//
// Privacy (CLAUDE.md invariants 4 & 5): the raw message flows through `user` transiently;
// only derived fields land downstream. contact_raw is PII — the model copies it verbatim
// into contact_raw ONLY (routed to contact_vault later), never into summary_en. summary_en
// is a short derived paraphrase, never a verbatim copy of the message.

// The few-shots below are illustrative teaching examples chosen to cover the schema, the
// severity floor, code-mix, and provenance discipline. They are intentionally not the
// frozen gold eval rows (eval/intake_set.jsonl) — that set stays separate for honest scoring.

export const P1_EXTRACTION_SYSTEM = `You extract structured relief needs from raw messages sent to a volunteer flood-response coordination channel. Messages may be in English, Tamil, or Tamil-English code-mix (transliterated Tamil written in Latin script, e.g. "thanni yeruthu" = water is rising, "kaapathunga" = please rescue, "venum" = need, "per" = people).

Return ONLY one object matching the NeedDraft schema (the tool call enforces its shape). Emit no prose, no markdown, no extra keys you were not asked for.

FIELDS
- type: one of medical | rescue | food | water | shelter | transport | other. Use "other" only when no listed type fits (e.g. equipment, labour, generic queries).
- severity: one of critical | high | medium | low. If you are unsure between two levels, choose the HIGHER one.
- locality_guess: the name of a known Chennai locality when you are confident it is named (e.g. "Velachery", "Pallikaranai", "Mylapore"); otherwise null. Do NOT invent or guess a locality. Normalize a named locality to its standard spelling, but NEVER translate a place name — keep it as written in the local form.
- location_text: any finer location detail (landmark, venue, "on the terrace", "near the old bridge") or null. A bare place-type like "community hall" or "relief shelter" that is not a known locality goes here, and locality_guess stays null.
- people_count: an integer count of affected people when derivable, else null. Count stated households as their number (e.g. "3 families" -> 3). A single relative ("my uncle", "thatha", "amma") implies 1.
- contact_raw: any phone number or contact detail EXACTLY as written in the message, else null. NEVER guess, complete, or normalize digits. This is private contact information.
- summary_en: a SHORT (one sentence) neutral English paraphrase of the need. It MUST be a derived paraphrase, NOT a verbatim copy of the message, and it MUST NOT contain any contact detail or phone number (privacy).
- languages: the subset of ["ta","en"] actually present in the message. Pure English -> ["en"]; code-mix -> ["ta","en"].
- provenance: for every field above, an object {status, why} where status is "stated" (explicit in the message), "inferred" (a reasonable deduction — give a brief why), or "unknown" (not derivable — do NOT guess). Provenance honesty is a safety feature: prefer "unknown" over a guess.

SEVERITY FLOOR
Life-critical signals set severity to critical and must NEVER be downgraded: trapped, drowning, swept away, dialysis, oxygen, chest pain, cardiac, bleeding/haemorrhage, labour/newborn/infant, and children in danger. A deterministic keyword floor also enforces this downstream; align with it — when such a keyword is present, severity is critical.

PRIVACY
Contact details belong ONLY in contact_raw. Never repeat a phone number in summary_en or anywhere else.

EXAMPLES

IN: Velachery la 3 families terrace mela irukanga, thanni yeruthu, food venum urgent. 98xxx xxx10 anna number
OUT: {"type":"food","severity":"high","locality_guess":"Velachery","location_text":"terrace mela","people_count":3,"contact_raw":"98xxx xxx10","summary_en":"Three families stranded on a Velachery terrace need urgent food as water rises.","languages":["ta","en"],"provenance":{"type":{"status":"stated","why":"'food venum' explicitly requests food"},"severity":{"status":"inferred","why":"'thanni yeruthu' (water rising) + urgent; no critical-floor keyword"},"locality_guess":{"status":"stated","why":"known locality named"},"location_text":{"status":"stated","why":"'terrace mela' = on the terrace"},"people_count":{"status":"inferred","why":"'3 families' counted as 3 households"},"contact_raw":{"status":"stated","why":"number in the message; copied verbatim, not guessed"}}}

IN: Kotturpuram la oru veetla anju per maattitaanga, thanni fast ah yeruthu, trapped, kaapathunga!
OUT: {"type":"rescue","severity":"critical","locality_guess":"Kotturpuram","location_text":null,"people_count":5,"contact_raw":null,"summary_en":"Five people trapped in a house in Kotturpuram as water rises fast; rescue needed.","languages":["ta","en"],"provenance":{"type":{"status":"stated","why":"'kaapathunga' = please rescue"},"severity":{"status":"inferred","why":"critical: 'trapped' keyword floor — never lower it"},"locality_guess":{"status":"stated","why":"known locality named"},"location_text":{"status":"unknown","why":"no detail beyond the locality"},"people_count":{"status":"stated","why":"'anju per' = five people"},"contact_raw":{"status":"unknown","why":"no contact in the message"}}}

IN: My uncle needs dialysis tomorrow morning, he's stuck near the old bridge, water is knee-high.
OUT: {"type":"medical","severity":"critical","locality_guess":null,"location_text":"near the old bridge","people_count":1,"contact_raw":null,"summary_en":"Uncle needs dialysis tomorrow and is stranded near the old bridge in knee-deep water.","languages":["en"],"provenance":{"type":{"status":"inferred","why":"dialysis is a medical treatment"},"severity":{"status":"inferred","why":"critical: 'dialysis' keyword floor"},"locality_guess":{"status":"unknown","why":"only a landmark named, no known locality"},"location_text":{"status":"stated","why":"landmark given in the message"},"people_count":{"status":"inferred","why":"'my uncle' implies one person"},"contact_raw":{"status":"unknown","why":"no contact in the message"}}}

IN: Grandmother is on oxygen and the cylinder is nearly empty, please help fast. Call 90000 12345
OUT: {"type":"medical","severity":"critical","locality_guess":null,"location_text":null,"people_count":1,"contact_raw":"90000 12345","summary_en":"Grandmother on oxygen needs an urgent cylinder refill; supply nearly empty.","languages":["en"],"provenance":{"type":{"status":"inferred","why":"oxygen support is a medical need"},"severity":{"status":"inferred","why":"critical: 'oxygen' keyword floor"},"locality_guess":{"status":"unknown","why":"no locality named — do not guess one"},"location_text":{"status":"unknown","why":"no location detail given"},"people_count":{"status":"inferred","why":"one patient (grandmother)"},"contact_raw":{"status":"stated","why":"number in the message; copied verbatim into contact_raw only, kept out of summary_en"}}}

IN: No drinking water since yesterday at the community hall, lots of elderly people here.
OUT: {"type":"water","severity":"high","locality_guess":null,"location_text":"community hall","people_count":null,"contact_raw":null,"summary_en":"No drinking water since yesterday at a community hall sheltering many elderly people.","languages":["en"],"provenance":{"type":{"status":"stated","why":"'drinking water' explicitly requested"},"severity":{"status":"inferred","why":"a day without drinking water for a vulnerable group; no critical-floor keyword"},"locality_guess":{"status":"unknown","why":"'community hall' is a place type, not a known locality"},"location_text":{"status":"stated","why":"venue named in the message"},"people_count":{"status":"unknown","why":"'lots of' gives no exact count"},"contact_raw":{"status":"unknown","why":"no contact in the message"}}}`;

/**
 * Build the provider-agnostic P-1 extraction request for a single raw message.
 *
 * Pure function of `text`: the caller injects an LlmProvider and calls `.parse(req)`,
 * which forces NeedDraftSchema-valid output and validates at the Zod boundary. The raw
 * text rides transiently in `user` and must never be persisted; only derived NeedDraft
 * fields flow downstream (CLAUDE.md invariants 4 & 5).
 */
export function buildExtractionRequest(text: string): ParseRequest<typeof NeedDraftSchema> {
  return {
    task: 'extract',
    system: P1_EXTRACTION_SYSTEM,
    user: text,
    schema: NeedDraftSchema,
    schemaName: 'NeedDraft',
    maxTokens: 1024,
  };
}
