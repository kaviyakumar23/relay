import { describe, expect, it } from 'vitest';
import { MockLlm } from '../../src/llm/mock';
import { isGroundedRationale, matchRationale, templateRationale } from '../../src/match/rationale';
import type { ScoredCandidate, ScoreNeed } from '../../src/match/scorer';
import type { Volunteer } from '../../src/match/volunteerStore';

// Rationale grounding contract (BUILD-DOC §F3): the LLM only phrases facts the scorer
// established; a validator rejects any invented fact; with no llm (or on failure) a
// deterministic template is returned. Never guess (CLAUDE.md invariant 3).

const PRIYA: Volunteer = {
  slack_user_id: 'V1',
  display_name: 'Priya',
  skills: ['medical'],
  languages: ['ta', 'en'],
  home_locality: 1,
  radius_km: 5,
  capacity_per_day: 3,
  availability: { always: true },
  active_load: 0,
  is_demo: false,
};

const candidate = (over: Partial<ScoredCandidate> = {}): ScoredCandidate => ({
  volunteer: PRIYA,
  score: 0.9,
  distanceKm: 1.2,
  breakdown: { skill: 1, proximity: 0.8, availability: 1, load: 1, language: 1 },
  ...over,
});

const NEED: ScoreNeed = { type: 'medical', localityId: 1, languages: ['ta'] };

describe('templateRationale', () => {
  it('assembles a factual one-liner from the breakdown', () => {
    expect(templateRationale(candidate(), NEED)).toBe('Priya: medical, 1.2 km away, available now, speaks Tamil');
  });

  it('omits distance when unknown and marks limited hours', () => {
    const c = candidate({
      distanceKm: null,
      breakdown: { skill: 1, proximity: 0.5, availability: 0.5, load: 1, language: 1 },
    });
    expect(templateRationale(c, NEED)).toBe('Priya: medical, limited hours, speaks Tamil');
  });
});

describe('isGroundedRationale', () => {
  const facts = { name: 'Priya', distanceKm: 1.2, skills: ['medical'], languages: ['ta'] };
  it('accepts a line built only from grounded facts', () => {
    expect(isGroundedRationale('Priya: medical, 1.2 km away, speaks Tamil', facts)).toBe(true);
  });
  it('rejects a skill the volunteer lacks', () => {
    expect(isGroundedRationale('Priya is a driver, 1.2 km away', facts)).toBe(false);
  });
  it('rejects a language the volunteer does not speak', () => {
    expect(isGroundedRationale('Priya: medical, speaks English', facts)).toBe(false);
  });
  it('rejects a fabricated distance', () => {
    expect(isGroundedRationale('Priya: medical, 9.0 km away', facts)).toBe(false);
  });
  it('rejects a line missing the volunteer name', () => {
    expect(isGroundedRationale('medical, 1.2 km away', facts)).toBe(false);
  });
});

describe('matchRationale', () => {
  it('with no llm returns the deterministic template', async () => {
    expect(await matchRationale(candidate(), NEED)).toBe(templateRationale(candidate(), NEED));
  });

  it('uses a grounded llm line verbatim', async () => {
    const llm = new MockLlm(() => ({ line: 'Priya: medical, 1.2 km away, speaks Tamil' }));
    expect(await matchRationale(candidate(), NEED, llm)).toBe('Priya: medical, 1.2 km away, speaks Tamil');
  });

  it('falls back when the llm invents a skill', async () => {
    const llm = new MockLlm(() => ({ line: 'Priya: expert boat pilot, 1.2 km away' }));
    expect(await matchRationale(candidate(), NEED, llm)).toBe(templateRationale(candidate(), NEED));
  });

  it('falls back when the llm output never validates (LlmParseError)', async () => {
    const llm = new MockLlm(() => ({ nope: true })); // missing required `line`
    expect(await matchRationale(candidate(), NEED, llm)).toBe(templateRationale(candidate(), NEED));
    expect(llm.callCount).toBe(2); // initial + one repair, then give up → fallback
  });
});
