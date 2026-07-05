import { describe, expect, it } from 'vitest';
import { NeedDraftSchema } from '../../src/llm/needDraft';
import { LlmParseError, LlmRefusalError } from '../../src/llm/provider';
import { type Extractor, extractToPayload, HeuristicExtractor, runExtraction } from '../../src/pipeline/extract';
import { heuristicNeedDraft } from '../../src/pipeline/heuristicExtractor';

// extract.ts is the bridge from a validated NeedDraft to an ExtractionCompletedPayload
// (running the deterministic validators the model is never trusted with) plus the
// never-lose-a-message fallback. These lock that wiring directly.

describe('extractToPayload — deterministic validators', () => {
  it('floors severity to critical and maps type/locality/count/confidence', () => {
    const text = 'Family trapped on the terrace in Velachery, 3 people, please call +91 98400 05678.';
    const { payload, contact } = extractToPayload(text, heuristicNeedDraft(text));

    expect(payload.need_type).toBe('rescue');
    expect(payload.severity).toBe('critical'); // 'trapped' floor
    expect(payload.locality_id).toBe(1); // Velachery is the first gazetteer entry → id 1
    expect(payload.people_count).toBe(3);
    // A keyword floor is deterministic → reported as 'stated'.
    expect(payload.confidence?.severity).toBe('stated');
    expect(payload.confidence?.locality).toBe('stated');
    expect(payload.needs_review).toBe(false);

    // Contact is normalized to a display string for the vault — never inside the payload.
    expect(contact).toBe('+91 98400 05678');
    expect(payload.confidence?.contact).toBe('stated');
    expect(JSON.stringify(payload)).not.toContain('9840005678');
  });

  it('resolves an unmatched locality to free-text location, not an id', () => {
    const draft = { ...heuristicNeedDraft('need help'), locality_guess: 'Nowhere-ville' };
    const { payload } = extractToPayload('need help', draft);
    expect(payload.locality_id).toBeNull();
    expect(payload.location_text).toBe('Nowhere-ville');
  });

  it('routes a garbled, information-free message to NEEDS_REVIEW while still flooring on a keyword', () => {
    const text = 'pls help wtr coming in fast nr the ... signal weak cant type childr';
    const { payload } = extractToPayload(text, heuristicNeedDraft(text));
    expect(payload.need_type).toBe('other');
    expect(payload.locality_id).toBeNull();
    expect(payload.people_count).toBeNull();
    expect(payload.needs_review).toBe(true); // no type, no location, no headcount
    expect(payload.severity).toBe('critical'); // 'child' floor keyword still fires
  });
});

describe('runExtraction — never throws out of the pipeline', () => {
  it('applies the heuristic extractor end to end', async () => {
    const { payload, contact } = await runExtraction('Dialysis patient stuck in Taramani', new HeuristicExtractor());
    expect(payload.need_type).toBe('medical');
    expect(payload.severity).toBe('critical');
    expect(contact).toBeNull();
  });

  it('turns an LlmParseError into a minimal NEEDS_REVIEW payload (floored on the raw text)', async () => {
    const throwing: Extractor = {
      name: 'boom',
      extract: async () => {
        throw new LlmParseError('NeedDraft', 'unrepairable');
      },
    };
    const { payload, contact } = await runExtraction('a child is trapped and drowning', throwing);
    expect(payload.need_type).toBe('other');
    expect(payload.needs_review).toBe(true);
    expect(payload.severity).toBe('critical'); // floor keyword survives a total extraction failure
    expect(contact).toBeNull();
  });

  it('turns an LlmRefusalError into a NEEDS_REVIEW payload too', async () => {
    const refusing: Extractor = {
      name: 'refuse',
      extract: async () => {
        throw new LlmRefusalError('safety stop');
      },
    };
    const { payload } = await runExtraction('someone needs food', refusing);
    expect(payload.need_type).toBe('other');
    expect(payload.needs_review).toBe(true);
    expect(payload.severity).toBe('low'); // no floor keyword here
  });

  it('re-throws a non-LLM error (a real bug must not be swallowed as needs-review)', async () => {
    const buggy: Extractor = {
      name: 'buggy',
      extract: async () => {
        throw new TypeError('boom');
      },
    };
    await expect(runExtraction('x', buggy)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('HeuristicExtractor — schema-valid, indistinguishable from an LLM response', () => {
  it('always returns a NeedDraftSchema-valid draft', async () => {
    const draft = await new HeuristicExtractor().extract('No drinking water at the Perungudi hall, 40 people.');
    expect(NeedDraftSchema.safeParse(draft).success).toBe(true);
  });
});
