import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import {
  buildHermeticAssembly,
  evaluateAssistant,
  evaluateDrift,
  evaluateEvidence,
  evaluateJudge,
  evaluateMatch,
  evaluateMcp,
  runScenario,
} from '../../src/demo/driver';

// F8 + the two P1 flourishes, proven hermetically (no Slack, no infra): the judge flood injector
// posts every message as the 🧪 simulator, the demo reset is idempotent, Ask-Relay answers the open
// criticals (PII-free) and refuses out-of-scope, and the read-only MCP search matches the ledger.
// Drives flood-1.yaml through the same assembly the storyboard runner + live app use.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

describe('judge experience + assistant + MCP — hermetic e2e', () => {
  it('judge/injector + judge/reset + assistant + mcp expectations all pass on the post-hero ledger', async () => {
    const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
    const a = buildHermeticAssembly();
    const run = await runScenario(scenario, a);

    // Advance the ledger to its post-hero state so the assistant/MCP reads reflect the live board:
    // match m02, then run the drift → reassign → evidence-close arc on m01 (same as `npm run demo`).
    await evaluateMatch(scenario, a, run);
    await evaluateDrift(scenario, a, run);
    await evaluateEvidence(scenario, a, run);

    const judge = await evaluateJudge(scenario, a);
    expect(judge.map((r) => r.assert).sort()).toEqual(['injector_posts_as_simulator', 'reset_idempotent']);
    for (const r of judge) expect(r, r.detail).toMatchObject({ pass: true });

    const assistant = await evaluateAssistant(scenario, a);
    expect(assistant.map((r) => r.assert).sort()).toEqual(['answers_open_criticals', 'refuses_out_of_scope']);
    for (const r of assistant) expect(r, r.detail).toMatchObject({ pass: true });

    const mcp = await evaluateMcp(scenario, a);
    expect(mcp.map((r) => r.assert)).toEqual(['search_needs_matches_ledger']);
    for (const r of mcp) expect(r, r.detail).toMatchObject({ pass: true });
  });
});
