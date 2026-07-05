import { z } from 'zod';

// NeedDraft — the structured output of P-1 intake extraction (BUILD-DOC Appendix C).
// Validated at the LLM boundary (CLAUDE.md invariant 3): parse → one repair pass →
// NEEDS_REVIEW + human card. Never free-parse, never guess. Every field carries
// per-field provenance so a card can show stated vs. inferred vs. unknown.

export const NeedTypeSchema = z.enum(['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other']);
export type NeedType = z.infer<typeof NeedTypeSchema>;

// Severity floors only raise (CLAUDE.md invariant 4 / BUILD-DOC §11.2); the model may
// never lower a keyword-floored severity. The deterministic floor lives in
// src/pipeline/severityFloor.ts (FLOOR_KEYWORDS) — the single source of truth, which
// eval/score.ts re-exports so the gold set and the runtime extractor stay identical.
export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

// The message's own language(s). Distinct from the eval-line `language` tag ('en'|'ta-en').
export const MessageLanguageSchema = z.enum(['ta', 'en']);
export type MessageLanguage = z.infer<typeof MessageLanguageSchema>;

export const ProvenanceStatusSchema = z.enum(['stated', 'inferred', 'unknown']);
export type ProvenanceStatus = z.infer<typeof ProvenanceStatusSchema>;

// Per-field provenance (InView DNA): 'stated' = explicit in the text, 'inferred' = a
// reasonable deduction (explain in `why`), 'unknown' = not derivable. `why` is required
// by convention for 'inferred' and optional otherwise.
export const ProvenanceEntrySchema = z.object({
  status: ProvenanceStatusSchema,
  why: z.string().optional(),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

export const NeedDraftSchema = z.object({
  type: NeedTypeSchema,
  severity: SeveritySchema,
  locality_guess: z.string().nullable(),
  location_text: z.string().nullable(),
  people_count: z.number().int().nullable(),
  contact_raw: z.string().nullable(),
  summary_en: z.string(),
  languages: z.array(MessageLanguageSchema),
  // Open record keyed by field name (Appendix C). The scorer inspects a fixed canonical
  // subset (eval/score.ts PROVENANCE_FIELDS); extra keys are permitted and ignored.
  provenance: z.record(z.string(), ProvenanceEntrySchema),
});
export type NeedDraft = z.infer<typeof NeedDraftSchema>;
