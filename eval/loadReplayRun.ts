import { type LoadReplayReport, runLoadReplay } from './loadReplay';

// `npm run load` — print the MEASURED intake-throughput replay (local/hermetic). It drives the
// frozen flood's intake messages through the same in-memory pipeline `npm run demo` uses and
// reports p50/p95/p99 latency + throughput.
//
// CLI entrypoint: console.error only (CLAUDE.md — console is banned outside console.error in CLI
// entrypoints). Exits 0 on success. Iterations override: `npm run load -- 50`.
//
// HONESTY: every number is measured on THIS machine against the in-memory engine — no Slack, no
// Postgres, no Redis. It is labelled local/hermetic and must never be quoted as a production SLA.

function render(r: LoadReplayReport): string[] {
  return [
    '',
    '════════════════════════════════════════════════════════════════════',
    '  MEASURED intake load replay — local/hermetic, NOT a production claim',
    `  scenario: ${r.scenarioId} · ${r.iterations} iteration(s) × ${r.messagesPerIteration} intake message(s)`,
    '  pipeline: memory store · inline queue · memory dedupe · heuristic extraction · no Slack/DB/Redis',
    '════════════════════════════════════════════════════════════════════',
    '',
    `  messages processed : ${r.totalMessages}`,
    `  latency  p50       : ${r.p50Ms} ms`,
    `  latency  p95       : ${r.p95Ms} ms   ← headline`,
    `  latency  p99       : ${r.p99Ms} ms`,
    `  latency  min/mean/max: ${r.minMs} / ${r.meanMs} / ${r.maxMs} ms`,
    `  throughput         : ${r.throughputPerSec} msg/s`,
    `  total wall time    : ${r.totalWallMs} ms`,
    '',
    `  local/hermetic intake p95 = ${r.p95Ms} ms (${r.throughputPerSec} msg/s) — measured on this machine.`,
    '',
  ];
}

async function main(): Promise<number> {
  const iterationsArg = process.argv[2];
  const iterations = iterationsArg !== undefined ? Number.parseInt(iterationsArg, 10) : undefined;
  const report = await runLoadReplay(iterations !== undefined && Number.isFinite(iterations) ? { iterations } : {});
  for (const line of render(report)) console.error(line);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
