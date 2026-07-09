import { afterEach, describe, expect, it } from 'vitest';
import {
  DEGRADED_BANNER,
  // The module exports `describe()`; alias it so it doesn't shadow vitest's global `describe`.
  describe as degradeDescribe,
  getDegrade,
  narrationLlmFor,
  ONLINE_BANNER,
  selectExtractor,
  setDegrade,
} from '../../src/demo/degradeMode';
import { MockLlm } from '../../src/llm/mock';
import { HeuristicExtractor, LlmExtractor } from '../../src/pipeline/extract';

// Moonshot #1 — "Unplug the AI". These tests pin the HONEST-degradation contract at the
// seam level: with the toggle on, the LLM is ignored even when present, so extraction and
// narration fall back to their deterministic baselines. A no-op MockLlm stands in for a
// configured provider — selectExtractor never calls it, it only chooses the class.

const noopLlm = (): MockLlm => new MockLlm(() => ({}));

// The toggle is a process-lifetime singleton; reset it so tests never leak state.
afterEach(() => setDegrade(false));

describe('degrade toggle singleton', () => {
  it('defaults to AI-online and reports the online banner', () => {
    expect(getDegrade().llmDisabled).toBe(false);
    expect(degradeDescribe()).toBe(ONLINE_BANNER);
    expect(degradeDescribe()).toBe('AI online');
  });

  it('setDegrade(true) unplugs the AI and flips the banner', () => {
    setDegrade(true);
    expect(getDegrade().llmDisabled).toBe(true);
    expect(degradeDescribe()).toBe(DEGRADED_BANNER);
    expect(degradeDescribe()).toBe('🔌 AI DEGRADED — heuristic extraction, no LLM');
  });

  it('setDegrade(false) reconnects the AI', () => {
    setDegrade(true);
    setDegrade(false);
    expect(getDegrade().llmDisabled).toBe(false);
    expect(degradeDescribe()).toBe(ONLINE_BANNER);
  });

  it('getDegrade returns the live singleton (reads see later writes)', () => {
    const handle = getDegrade();
    setDegrade(true);
    expect(handle.llmDisabled).toBe(true);
  });
});

describe('selectExtractor', () => {
  it('degraded=true forces the HeuristicExtractor even with an llm present', () => {
    const extractor = selectExtractor({ llm: noopLlm(), degraded: true });
    expect(extractor).toBeInstanceOf(HeuristicExtractor);
    expect(extractor.name).toBe('heuristic');
  });

  it('degraded=false with an llm uses the LlmExtractor', () => {
    const extractor = selectExtractor({ llm: noopLlm(), degraded: false });
    expect(extractor).toBeInstanceOf(LlmExtractor);
    expect(extractor.name).toBe('llm:mock');
  });

  it('no llm falls back to the HeuristicExtractor regardless of the flag', () => {
    expect(selectExtractor({ degraded: false })).toBeInstanceOf(HeuristicExtractor);
    expect(selectExtractor({ degraded: true })).toBeInstanceOf(HeuristicExtractor);
  });
});

describe('narrationLlmFor', () => {
  it('returns undefined when degraded so narration takes the template path', () => {
    const llm = noopLlm();
    expect(narrationLlmFor(llm, true)).toBeUndefined();
  });

  it('passes the llm through unchanged when online', () => {
    const llm = noopLlm();
    expect(narrationLlmFor(llm, false)).toBe(llm);
  });

  it('is undefined either way when there is no llm', () => {
    expect(narrationLlmFor(undefined, false)).toBeUndefined();
    expect(narrationLlmFor(undefined, true)).toBeUndefined();
  });
});
