import { readFileSync } from 'node:fs';
import { parseScenario } from '../../demo/scenarios/schema';
import { buildHermeticAssembly, evaluateSkeleton, pendingExpectations, runScenario } from './driver';

// `npm run demo` — the judge-runnable hermetic storyboard (BUILD-DOC §16.2). It
// plays flood-1.yaml through the real intake pipeline (no Slack, no infra, zero
// env) and asserts the walking-skeleton expectations: 14 intake messages → 14
// NeedCreated events → 14 dispatch cards. Prints PASS/FAIL per expectation and
// exits non-zero on any failure. CLI entrypoint — console.error only.

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

  const results = await evaluateSkeleton(scenario, assembly);
  let failures = 0;
  for (const r of results) {
    if (!r.pass) failures += 1;
    console.error(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.capability}/${r.assert}: ${r.detail}`);
  }
  for (const p of pendingExpectations(scenario)) {
    console.error(`  SKIP  ${p.capability}/${p.assert}: capability not built yet`);
  }

  const total = results.length;
  console.error(`\n${total - failures}/${total} skeleton expectation(s) passed`);
  return failures > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
