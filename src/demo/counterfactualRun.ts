import { BASELINE_RULES_DOC, type Counterfactual, runCounterfactual } from './counterfactual';

// `npm run counterfactual` — Moonshot #3 (BUILD-DOC §Impact). Prints the measured, clearly-SIMULATED
// delta between an unstructured group-chat baseline and Relay on the SAME fictional flood. It turns
// Impact from adjectives into a number — a number that is explicitly labelled a SIMULATION with
// published rules (docs/BASELINE-RULES.md), never a claim about a real deployment.
//
// CLI entrypoint: console.error only (CLAUDE.md: console is banned outside console.error in CLI
// entrypoints). Exits 0 on success. Default scenario 'flood-1'; override via `... counterfactual <name>`.

const DEFAULT_SCENARIO = 'flood-1';

function render(cf: Counterfactual): string[] {
  const { baseline: b, relay: r, delta: d } = cf;
  return [
    '',
    '════════════════════════════════════════════════════════════════════',
    '  SIMULATED counterfactual — NOT a claim about any real deployment',
    `  scenario: ${cf.scenario_id} — ${cf.scenario_title}`,
    `  baseline rules (published): ${cf.rules_doc}`,
    '════════════════════════════════════════════════════════════════════',
    '',
    '  Group-chat baseline (SIMULATED — naive rules R1–R4):',
    `    · ${b.total_requests} requests (no dedupe), ${b.responder_pool} responders, first-claim-wins`,
    `    · ${b.unclaimed} unclaimed  (${b.unparseable} unparseable + ${b.unclaimed - b.unparseable} past capacity)`,
    `    · ${b.double_served} double-served  (duplicate reports → a second volunteer sent twice)`,
    `    · ${b.verified_deliveries} verified  (delivery is self-reported, never proven)`,
    '',
    '  Relay (MEASURED from the real hermetic ledger):',
    `    · ${r.needs} needs tracked  (${r.unrouted} lost), ${r.needs_review} routed to human review`,
    `    · ${r.deduped} duplicates auto-linked, ${r.proposed_merges} proposed for human merge`,
    `    · ${r.verified} verified deliver${r.verified === 1 ? 'y' : 'ies'} on a complete evidence packet`,
    '',
    '  Delta (baseline → Relay, on the identical scenario):',
    `    · ${d.double_served_avoided} double-serve${d.double_served_avoided === 1 ? '' : 's'} avoided`,
    `    · ${d.unclaimed_avoided} request${d.unclaimed_avoided === 1 ? '' : 's'} kept owned instead of lost`,
    `    · +${d.verified_gained} verified deliver${d.verified_gained === 1 ? 'y' : 'ies'} (baseline proved 0)`,
    '',
    // The one-line punchline (the labelled-SIMULATED headline for the writeup / demo).
    `  SIMULATED flood (rules: ${cf.rules_doc}) — group-chat baseline: ${b.unclaimed} unclaimed, ` +
      `${b.double_served} double-served, ${b.verified_deliveries} verified · ` +
      `Relay: ${r.needs} needs, ${r.deduped} deduped, ${r.verified} verified.`,
    '',
  ];
}

async function main(): Promise<number> {
  const scenarioName = process.argv[2] ?? DEFAULT_SCENARIO;
  const cf = await runCounterfactual(scenarioName);
  for (const line of render(cf)) console.error(line);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    console.error(`(baseline rules: ${BASELINE_RULES_DOC})`);
    process.exit(1);
  });
