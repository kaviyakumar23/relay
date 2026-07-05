import type { ExtractionCompletedPayload } from '../ledger/events';
import type { ConfidenceStatus } from '../ledger/types';
import type { NeedDraft } from '../llm/needDraft';
import { buildExtractionRequest } from '../llm/prompts/p1-extraction';
import { LlmParseError, type LlmProvider, LlmRefusalError } from '../llm/provider';
import { normalizeContact } from './contact';
import { resolveLocality } from './geocode';
import { heuristicNeedDraft } from './heuristicExtractor';
import { floorSeverity, hasFloorKeyword } from './severityFloor';

// P-1 extraction wired into the intake pipeline (BUILD-DOC §16.3). This module is
// the bridge from a validated NeedDraft (LLM or heuristic) to an
// ExtractionCompletedPayload the ledger can apply — running the DETERMINISTIC
// validators the model is never trusted with:
//   • severity floor (invariant #4, only ever raises)
//   • gazetteer geocode (locality_guess → stable locality_id)
//   • Indian-mobile normalization (contact routed to the vault, never persisted here)
//   • provenance → confidence projection for the dispatch card
//
// The LLM is INJECTED (Extractor), so tests/demo drive a deterministic heuristic
// with zero env while live mode swaps in the real provider behind the same seam.
// A message must NEVER be lost: runExtraction converts an LLM parse/refusal into a
// minimal NEEDS_REVIEW payload rather than throwing out of the pipeline.

/** The intake pipeline's extraction seam — one method, provider-agnostic. */
export interface Extractor {
  extract(text: string): Promise<NeedDraft>;
  readonly name: string;
}

/** Live extractor: forces schema-valid NeedDraft output through the injected provider. */
export class LlmExtractor implements Extractor {
  readonly name: string;
  constructor(private readonly llm: LlmProvider) {
    this.name = `llm:${llm.name}`;
  }

  async extract(text: string): Promise<NeedDraft> {
    return this.llm.parse(buildExtractionRequest(text));
  }
}

/** Deterministic extractor: the hermetic baseline for tests, demo, and eval. */
export class HeuristicExtractor implements Extractor {
  readonly name = 'heuristic';

  async extract(text: string): Promise<NeedDraft> {
    // A thin wrapper so callers depend only on the Extractor seam, not the heuristic.
    return heuristicNeedDraft(text);
  }
}

export interface ExtractionResult {
  payload: ExtractionCompletedPayload;
  /**
   * Normalized contact display string destined for the encrypted contact_vault, or
   * null. PII (invariant #5): the caller vaults it and NEVER logs/persists it in a
   * need row, event payload, or log line.
   */
  contact: string | null;
}

/**
 * Turn a validated NeedDraft into an ExtractionCompletedPayload, applying every
 * deterministic guard the model is not trusted with. `text` is required because the
 * severity floor is a property of the raw message, not the draft.
 */
export function extractToPayload(text: string, draft: NeedDraft): ExtractionResult {
  const severity = floorSeverity(text, draft.severity);
  const resolved = resolveLocality(draft.locality_guess);
  const contactNorm = normalizeContact(draft.contact_raw);
  const contact = contactNorm === null ? null : contactNorm.display;

  // A human-readable location for the card: prefer the model's finer detail, else the
  // (matched or unmatched) locality name. The stable id lives in locality_id.
  const locationText = draft.location_text ?? draft.locality_guess;

  // Per-field confidence for the dispatch card. A keyword floor is deterministic, so
  // report severity as 'stated' when it fires. Contact confidence reflects whether a
  // valid number was actually normalized (never the number itself).
  const confidence: Record<string, ConfidenceStatus> = {};
  const set = (key: string, status: ConfidenceStatus | undefined): void => {
    if (status !== undefined) confidence[key] = status;
  };
  set('type', draft.provenance.type?.status);
  set('severity', hasFloorKeyword(text) ? 'stated' : draft.provenance.severity?.status);
  set('locality', draft.provenance.locality_guess?.status);
  set('people_count', draft.provenance.people_count?.status);
  if (contact !== null) confidence.contact = 'stated';

  // Untrustworthy when we could not derive anything actionable: no need type, no
  // location (neither a resolved id nor free text), and no head-count. Routes the
  // need to NEEDS_REVIEW + a human card instead of a confident TRIAGED.
  const needsReview =
    draft.type === 'other' && resolved.localityId === null && locationText === null && draft.people_count === null;

  const payload: ExtractionCompletedPayload = {
    need_type: draft.type,
    severity,
    locality_id: resolved.localityId,
    location_text: locationText,
    people_count: draft.people_count,
    languages: [...draft.languages],
    confidence,
    needs_review: needsReview,
  };
  return { payload, contact };
}

/**
 * Run extraction end to end: extract → validate → payload. On an LLM parse or refusal
 * failure (already after the provider's one repair pass), fall back to a minimal
 * NEEDS_REVIEW payload — a message must never be lost. The floor still applies to the
 * raw text so a life-critical keyword survives even a total extraction failure.
 */
export async function runExtraction(text: string, extractor: Extractor): Promise<ExtractionResult> {
  try {
    const draft = await extractor.extract(text);
    return extractToPayload(text, draft);
  } catch (err) {
    if (err instanceof LlmParseError || err instanceof LlmRefusalError) {
      return {
        payload: { need_type: 'other', severity: floorSeverity(text, 'low'), needs_review: true, confidence: {} },
        contact: null,
      };
    }
    throw err;
  }
}
