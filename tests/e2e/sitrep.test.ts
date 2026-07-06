import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import {
  buildHermeticAssembly,
  evaluateDrift,
  evaluateEvidence,
  evaluateReport,
  evaluateSitrep,
  runScenario,
} from '../../src/demo/driver';

// Sitrep/report narration e2e (BUILD-DOC §F6/§F7). Runs the full hero arc on the hermetic
// ledger, then proves the three narration guarantees over REAL demo data:
//   · sitrep numbers equal an INDEPENDENT recount of listNeeds (numbers-match-ledger);
//   · a hallucinated figure is rejected → the deterministic template (no stray survives);
//   · the generated report Markdown is PII-clean (assertNoPii ok, no seed phone digits).

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

describe('sitrep/report e2e — narrated aggregates over the live ledger', () => {
  it('passes stats_match_ledger, integrity_guard, and no_pii over the full demo run', async () => {
    const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
    const a = buildHermeticAssembly();
    const run = await runScenario(scenario, a);
    expect(run.intakeSteps).toBe(14);

    // The hero arc must run first so the ledger has a CLOSED/verified need for the report.
    for (const r of await evaluateDrift(scenario, a, run)) expect(r, r.detail).toMatchObject({ pass: true });
    for (const r of await evaluateEvidence(scenario, a, run)) expect(r, r.detail).toMatchObject({ pass: true });

    const sitrep = await evaluateSitrep(scenario, a);
    expect(sitrep.map((r) => r.assert)).toEqual(['stats_match_ledger']);
    for (const r of sitrep) expect(r, r.detail).toMatchObject({ pass: true });

    const report = await evaluateReport(scenario, a);
    expect(report.map((r) => r.assert).sort()).toEqual(['integrity_guard', 'no_pii']);
    for (const r of report) expect(r, r.detail).toMatchObject({ pass: true });
  });
});
