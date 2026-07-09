import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { setDegrade } from '../../src/demo/degradeMode';
import {
  buildHermeticAssembly,
  evaluateDegrade,
  evaluateRequester,
  evaluateSecondScenario,
  runScenario,
} from '../../src/demo/driver';
import { appHomeView } from '../../src/surfaces/appHome';

// Moonshot batch 1 e2e — the three judge-facing capabilities, driven through the SAME hermetic
// driver the storyboard + live app use. Reads each evaluator's ledger-grounded verdict back
// (never fabricated). The degrade toggle is a process singleton, so it is reset after each test.

const FLOOD_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);
const HEATWAVE_URL = new URL('../../demo/scenarios/heatwave-1.yaml', import.meta.url);
const flood = parseScenario(readFileSync(FLOOD_URL, 'utf8'));
const heatwave = parseScenario(readFileSync(HEATWAVE_URL, 'utf8'));

afterEach(() => setDegrade(false));

describe('moonshot #1 — honest AI degradation', () => {
  it('degrade/honest_degradation passes on flood-1: no need lost, ≥ NEEDS_REVIEW, seam swaps extractor', async () => {
    const res = (await evaluateDegrade(flood))[0];
    expect(res?.pass, res?.detail).toBe(true);
    // The toggle is left online after the evaluator returns.
    setDegrade(true);
    setDegrade(false);
  });
});

describe('moonshot #4 — the requester loop (language-matched reply in the source thread)', () => {
  it('passes on flood-1 (bilingual reply threaded into the ta need m01)', async () => {
    const a = buildHermeticAssembly();
    const run = await runScenario(flood, a);
    const res = (await evaluateRequester(flood, a, run))[0];
    expect(res?.pass, res?.detail).toBe(true);
  });

  it('passes on heatwave-1 too (same seam, same engine — ta need h01)', async () => {
    const a = buildHermeticAssembly();
    const run = await runScenario(heatwave, a);
    const res = (await evaluateRequester(heatwave, a, run))[0];
    expect(res?.pass, res?.detail).toBe(true);
  });
});

describe('moonshot #5 — same engine, config-only second scenario', () => {
  it('second_scenario passes on heatwave-1: the SLA override drives an earlier deadline via the same engine', async () => {
    const a = buildHermeticAssembly();
    await runScenario(heatwave, a);
    const res = (await evaluateSecondScenario(heatwave, a))[0];
    expect(res?.pass, res?.detail).toBe(true);
  });

  it('is a no-op on flood-1 (no `sla:` override → no such expectation)', async () => {
    const a = buildHermeticAssembly();
    await runScenario(flood, a);
    expect(await evaluateSecondScenario(flood, a)).toEqual([]);
  });
});

describe('App Home surfaces the AI-DEGRADED banner only when degraded', () => {
  it('renders the banner iff opts.degraded', () => {
    const on = JSON.stringify(appHomeView([], { degraded: true }));
    const off = JSON.stringify(appHomeView([], { degraded: false }));
    expect(on).toContain('AI DEGRADED');
    expect(off).not.toContain('AI DEGRADED');
  });
});
