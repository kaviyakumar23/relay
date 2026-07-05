import { readFileSync } from 'node:fs';
import { parseScenario } from '../../demo/scenarios/schema';
import { buildHermeticAssembly, evaluateSkeleton, evaluateTriage, runScenario, skippedExpectations } from './driver';

// `npm run demo` — the judge-runnable hermetic storyboard (BUILD-DOC §16.2/§16.3).
// It plays flood-1.yaml through the real intake pipeline (no Slack, no infra, zero
// env): 14 intake messages → 14 NeedCreated events → P-1 (heuristic) extraction →
// 14 dispatch cards. Asserts the walking-skeleton count AND the extraction-backed
// triage expectations (NEEDS_REVIEW routing + the critical severity floor). Prints
// PASS/FAIL per evaluated expectation, SKIP (with reason) for the rest, and exits
// non-zero on any failure. CLI entrypoint — console.error only.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

async function main(): Promise<number> {
  const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));

  console.error(`relay demo — ${scenario.id}: ${scenario.title}`);
  console.error('  hermetic: memory store · inline queue · memory dedupe · recording notifier · no Slack, no infra\n');

  const assembly = buildHermeticAssembly();
  const run = await runScenario(scenario, assembly);

  console.error(`  · injected ${run.intakeSteps} intake message(s) → ${run.enqueued} enqueued`);
  for (const s of run.skippedSteps) {
    console.error(`  · skipped ${s.kind} (${s.ref}) — ${s.reason}`);
  }
  console.error('');

  const results = [...(await evaluateSkeleton(scenario, assembly)), ...(await evaluateTriage(scenario, assembly, run))];
  let failures = 0;
  for (const r of results) {
    if (!r.pass) failures += 1;
    console.error(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.capability}/${r.assert}: ${r.detail}`);
  }
  for (const s of skippedExpectations(scenario)) {
    console.error(`  SKIP  ${s.capability}/${s.assert}: ${s.reason}`);
  }

  const total = results.length;
  console.error(`\n${total - failures}/${total} evaluated expectation(s) passed`);
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
