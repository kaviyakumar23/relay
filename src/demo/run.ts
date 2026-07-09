import { readFileSync } from 'node:fs';
import { parseScenario, type Scenario } from '../../demo/scenarios/schema';
import { evaluateCounterfactual } from './counterfactual';
import {
  buildHermeticAssembly,
  type ExpectationResult,
  evaluateAgentPledge,
  evaluateAssistant,
  evaluateAuditableReport,
  evaluateDedupe,
  evaluateDegrade,
  evaluateDrift,
  evaluateEvidence,
  evaluateJudge,
  evaluateLiveHero,
  evaluateMatch,
  evaluateMcp,
  evaluatePrewarm,
  evaluateReport,
  evaluateRequester,
  evaluateSecondScenario,
  evaluateSitrep,
  evaluateSkeleton,
  evaluateTriage,
  runScenario,
  skippedExpectations,
} from './driver';

// `npm run demo` — the judge-runnable hermetic storyboard (BUILD-DOC §16.2/§16.3).
// It plays BOTH frozen scenarios through the real intake pipeline (no Slack, no infra, zero
// env) on the SAME driver — proving "same engine, nothing recompiled":
//   · flood-1.yaml   — the signature 48-hour flood: 14 intake messages → triage/dedupe/match →
//     the drift/reassign hero arc → the evidence finale → sitrep/report guarantees → the F8 judge
//     experience + assistant/MCP flourishes + the live self-serve hero, plus the moonshot batch
//     (honest AI-degradation + the language-matched requester loop).
//   · heatwave-1.yaml — a DIFFERENT disaster on the SAME engine: only DATA changes (need mix +
//     a scenario-owned `sla:` override), proving config, not code, drives the SLA regime.
// Prints PASS/FAIL per evaluated expectation, SKIP (with reason) for the rest, and exits
// non-zero on any failure. CLI: console.error only.

const FLOOD_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);
const HEATWAVE_URL = new URL('../../demo/scenarios/heatwave-1.yaml', import.meta.url);

/** Drive one scenario end to end through the shared hermetic driver and return every evaluated
 * result. Missing-capability evaluators return nothing (e.g. heatwave has no assistant/mcp/live
 * hero/degrade expectations; flood has no second-scenario/`sla:` block) — never a failure. */
async function evaluateScenario(scenario: Scenario): Promise<ExpectationResult[]> {
  const assembly = buildHermeticAssembly();
  const run = await runScenario(scenario, assembly);

  console.error(`  · injected ${run.intakeSteps} intake message(s) → ${run.enqueued} enqueued`);
  for (const s of run.skippedSteps) {
    console.error(`  · skipped ${s.kind} (${s.ref}) — ${s.reason}`);
  }
  console.error('');

  return [
    ...(await evaluateSkeleton(scenario, assembly)),
    ...(await evaluateTriage(scenario, assembly, run)),
    ...(await evaluateDedupe(scenario, assembly, run)),
    ...(await evaluateMatch(scenario, assembly, run)),
    ...(await evaluateDrift(scenario, assembly, run)),
    ...(await evaluateEvidence(scenario, assembly, run)),
    ...(await evaluateSitrep(scenario, assembly)),
    ...(await evaluateReport(scenario, assembly)),
    // Moonshot #6 — the click-to-audit donor report, over the same post-hero ledger.
    ...(await evaluateAuditableReport(scenario, assembly)),
    // F8 judge experience + the two P1 flourishes, on the post-hero ledger.
    ...(await evaluateJudge(scenario, assembly)),
    ...(await evaluateAssistant(scenario, assembly)),
    ...(await evaluateMcp(scenario, assembly)),
    // The LIVE self-serve hero (§F5) — runLiveHeroDemo end-to-end on a fresh, isolated assembly.
    ...(await evaluateLiveHero(scenario)),
    // Moonshot batch 1: honest degrade (own fresh assemblies), the requester loop, and the
    // config-only second scenario (a no-op for flood, which carries no `sla:` override).
    ...(await evaluateDegrade(scenario)),
    ...(await evaluateRequester(scenario, assembly, run)),
    ...(await evaluateSecondScenario(scenario, assembly)),
    // Moonshot batch 2: the agent-pledge accountability chain (own fresh assembly) and the measured,
    // SIMULATED counterfactual vs a naive group-chat baseline. Both no-op when the scenario carries
    // no such expectation (heatwave-1).
    ...(await evaluateAgentPledge(scenario)),
    ...(await evaluateCounterfactual(scenario)),
    // Moonshot batch 3 — the pre-warmed backup (own fresh assembly; no-op for a scenario without it).
    ...(await evaluatePrewarm(scenario)),
  ];
}

async function main(): Promise<number> {
  let failures = 0;
  let total = 0;

  for (const url of [FLOOD_URL, HEATWAVE_URL]) {
    const scenario = parseScenario(readFileSync(url, 'utf8'));
    console.error(`relay demo — ${scenario.id}: ${scenario.title}`);
    console.error(
      '  hermetic: memory store · inline queue · memory dedupe · recording notifier · no Slack, no infra\n',
    );

    const results = await evaluateScenario(scenario);
    for (const r of results) {
      total += 1;
      if (!r.pass) failures += 1;
      console.error(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.capability}/${r.assert}: ${r.detail}`);
    }
    for (const s of skippedExpectations(scenario)) {
      console.error(`  SKIP  ${s.capability}/${s.assert}: ${s.reason}`);
    }
    console.error('');
  }

  console.error(`${total - failures}/${total} evaluated expectation(s) passed across 2 scenarios (same engine)`);
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
