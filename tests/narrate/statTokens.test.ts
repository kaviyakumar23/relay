import { describe, expect, it } from 'vitest';
import { MockLlm } from '../../src/llm/mock';
import { buildSitrepRequest } from '../../src/llm/prompts/p5-sitrep';
import { buildReportRequest } from '../../src/llm/prompts/p6-report';
import type { StatSet } from '../../src/narrate/aggregate';
import {
  buildTokenMap,
  narrateWithIntegrity,
  plainStatsTemplate,
  renderTokens,
  toTokenList,
  validateNumbers,
} from '../../src/narrate/statTokens';

// The number-integrity engine (BUILD-DOC §F7): every digit in a narrative must be a ledger
// value. buildTokenMap defines the allowlist; validateNumbers is the hallucination guard;
// narrateWithIntegrity never emits an unvalidated number — on any stray it regenerates, then
// falls back to the deterministic template.

const SITREP_STATS: StatSet = [
  { key: 'open', value: 4, label: 'open, awaiting a volunteer' },
  { key: 'open_critical', value: 3, label: 'critical needs still open' },
  { key: 'verified', value: 12, label: 'verified' },
];

const REPORT_STATS: StatSet = [
  { key: 'people_helped', value: 20, label: 'people helped', eventRefs: ['N-0421', 'N-0507'] },
  { key: 'verified_deliveries', value: 3, label: 'verified deliveries', eventRefs: ['N-0421'] },
];

describe('buildTokenMap + renderTokens', () => {
  it('maps each stat to its {{stat:*}} token and value, and round-trips', () => {
    const map = buildTokenMap(SITREP_STATS);
    expect(map.tokens['{{stat:open}}']).toBe('4');
    expect(map.tokens['{{stat:open_critical}}']).toBe('3');
    expect(map.tokens['{{stat:verified}}']).toBe('12');

    const rendered = renderTokens(
      '{{stat:open}} open, {{stat:open_critical}} critical, {{stat:verified}} verified.',
      map,
    );
    expect(rendered).toBe('4 open, 3 critical, 12 verified.');
  });

  it('builds the allowlist from the stat values', () => {
    const map = buildTokenMap(SITREP_STATS);
    expect(map.allowedNumbers).toEqual(new Set(['4', '3', '12']));
  });

  it('leaves an unknown token intact (so the orchestrator can reject it)', () => {
    const map = buildTokenMap(SITREP_STATS);
    expect(renderTokens('{{stat:open}} open, {{stat:invented}} extra', map)).toBe('4 open, {{stat:invented}} extra');
  });
});

describe('validateNumbers — the hallucination guard', () => {
  const allowed = buildTokenMap(SITREP_STATS).allowedNumbers;

  it('passes a narrative whose numbers are all token-derived', () => {
    const res = validateNumbers('4 open needs, 3 critical, 12 verified.', allowed);
    expect(res).toEqual({ ok: true, strays: [] });
  });

  it('catches a stray hallucinated number', () => {
    const res = validateNumbers('We helped 500 families today.', allowed);
    expect(res.ok).toBe(false);
    expect(res.strays).toContain('500');
  });

  it('ignores numbers inside a permalink and a footnote ref', () => {
    const text =
      'We verified 12 deliveries [N-0421]. Source: https://acme.slack.com/archives/C0ABCD123/p1699999999000000 here.';
    expect(validateNumbers(text, allowed)).toEqual({ ok: true, strays: [] });
  });

  it('still validates digits inside a bracket that is NOT a letter-led ref', () => {
    // "[3 items]" starts with a digit → not a footnote ref → its digits are checked.
    const res = validateNumbers('Received [7 items] today.', allowed);
    expect(res.ok).toBe(false);
    expect(res.strays).toContain('7');
  });

  it('normalizes thousands separators before checking', () => {
    const allowedBig = buildTokenMap([{ key: 'people', value: 1234, label: 'people' }]).allowedNumbers;
    expect(validateNumbers('reached 1,234 people', allowedBig).ok).toBe(true);
  });
});

describe('plainStatsTemplate — always-valid fallback', () => {
  it('produces a narrative that passes its own number validation', () => {
    const map = buildTokenMap(SITREP_STATS);
    const text = plainStatsTemplate(SITREP_STATS, 'sitrep');
    expect(text).toContain('Live situation report.');
    expect(validateNumbers(text, map.allowedNumbers)).toEqual({ ok: true, strays: [] });
  });

  it('handles an empty stat set', () => {
    expect(plainStatsTemplate([], 'report')).toContain('No figures to report');
  });
});

describe('toTokenList', () => {
  it('describes each token with its meaning, value, and refs', () => {
    const list = toTokenList(REPORT_STATS);
    expect(list[0]).toEqual({
      token: '{{stat:people_helped}}',
      key: 'people_helped',
      label: 'people helped',
      value: 20,
      eventRefs: ['N-0421', 'N-0507'],
    });
  });
});

describe('narrateWithIntegrity', () => {
  it('with no llm returns the deterministic template', async () => {
    const res = await narrateWithIntegrity({ stats: SITREP_STATS, kind: 'sitrep', buildRequest: buildSitrepRequest });
    expect(res.source).toBe('template');
    expect(res.attempts).toBe(0);
    expect(res.text).toBe(plainStatsTemplate(SITREP_STATS, 'sitrep'));
  });

  it('uses a well-behaved llm narrative and renders its tokens', async () => {
    const llm = new MockLlm(() => ({
      narrative: 'Board: {{stat:open}} open, {{stat:open_critical}} critical still open.',
    }));
    const res = await narrateWithIntegrity({
      stats: SITREP_STATS,
      kind: 'sitrep',
      llm,
      buildRequest: buildSitrepRequest,
    });
    expect(res.source).toBe('llm');
    expect(res.attempts).toBe(1);
    expect(res.text).toBe('Board: 4 open, 3 critical still open.');
    expect(res.text).not.toContain('{{stat:');
    expect(llm.callCount).toBe(1);
  });

  it('accepts a correct RAW digit (the allowlist, not just the token, is the guard)', async () => {
    const llm = new MockLlm(() => ({ narrative: 'There are 4 open needs right now.' }));
    const res = await narrateWithIntegrity({
      stats: SITREP_STATS,
      kind: 'sitrep',
      llm,
      buildRequest: buildSitrepRequest,
    });
    expect(res.source).toBe('llm');
    expect(res.text).toBe('There are 4 open needs right now.');
  });

  it('falls back to the template when the llm hallucinates a number', async () => {
    const llm = new MockLlm(() => ({ narrative: 'We rescued 500 families and 9 boats.' }));
    const res = await narrateWithIntegrity({
      stats: SITREP_STATS,
      kind: 'sitrep',
      llm,
      buildRequest: buildSitrepRequest,
    });
    expect(res.source).toBe('template');
    expect(res.attempts).toBe(3); // 1 initial + 2 regenerations
    expect(res.text).toBe(plainStatsTemplate(SITREP_STATS, 'sitrep'));
    expect(llm.callCount).toBe(3);
  });

  it('falls back when the llm output never satisfies the schema (LlmParseError)', async () => {
    const llm = new MockLlm(() => ({ not_narrative: true })); // missing required `narrative`
    const res = await narrateWithIntegrity({
      stats: SITREP_STATS,
      kind: 'sitrep',
      llm,
      buildRequest: buildSitrepRequest,
    });
    expect(res.source).toBe('template');
    expect(res.attempts).toBe(3);
  });

  it('renders a report narrative with token numbers and ledger footnotes', async () => {
    const llm = new MockLlm(() => ({
      narrative:
        'We reached {{stat:people_helped}} people [N-0421] across {{stat:verified_deliveries}} deliveries [N-0421].',
    }));
    const res = await narrateWithIntegrity({
      stats: REPORT_STATS,
      kind: 'report',
      llm,
      buildRequest: buildReportRequest,
    });
    expect(res.source).toBe('llm');
    expect(res.text).toBe('We reached 20 people [N-0421] across 3 deliveries [N-0421].');
  });
});

describe('prompt request builders', () => {
  it('buildSitrepRequest wires the sitrep task, schema, and the token list', () => {
    const req = buildSitrepRequest(SITREP_STATS, toTokenList(SITREP_STATS));
    expect(req.task).toBe('sitrep');
    expect(req.schemaName).toBe('Narrative');
    expect(req.system).toContain('{{stat:*}}');
    expect(req.user).toContain('{{stat:open_critical}}');
    expect(req.user).toContain('critical needs still open');
  });

  it('buildReportRequest lists citations and demands per-claim footnotes', () => {
    const req = buildReportRequest(REPORT_STATS, toTokenList(REPORT_STATS));
    expect(req.task).toBe('report');
    expect(req.system).toContain('CITATIONS');
    expect(req.user).toContain('{{stat:people_helped}}');
    expect(req.user).toContain('[N-0421]');
  });
});
