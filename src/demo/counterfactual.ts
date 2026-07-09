import { readFileSync } from 'node:fs';
import { parseScenario, type Scenario } from '../../demo/scenarios/schema';
import { isEvent } from '../ledger/events';
import { type BaselineOptions, type BaselineOutcome, runGroupChatBaseline } from './baseline';
import { buildHermeticAssembly, type ExpectationResult, evaluateDrift, evaluateEvidence, runScenario } from './driver';

// Moonshot #3 — the counterfactual delta (BUILD-DOC §Impact). Runs the naive group-chat baseline
// AND drives the SAME fictional scenario through the REAL hermetic Relay pipeline (the exact driver
// assembly `npm run demo` uses — memory store, inline queue, memory dedupe, recording notifier, zero
// env), to VERIFICATION where the scenario supports it, then computes the delta.
//
// HONESTY (the ethos): every BASELINE number comes from actually running the simulator
// (runGroupChatBaseline, rules in docs/BASELINE-RULES.md, labelled SIMULATED everywhere); every
// RELAY number is MEASURED from the actual ledger after the same intake pipeline runs — the need
// count, the exact-contact auto-links, the fuzzy merge proposals, the human-review routes, and the
// verified deliveries are all read back from real events, never fabricated. The delta is a function
// of those two measured sets, so it can only ever report what both actually did.

export const BASELINE_RULES_DOC = 'docs/BASELINE-RULES.md';

/** The measured Relay outcome, read back from the actual ledger after the pipeline runs. */
export interface RelayOutcome {
  scenario_id: string;
  /** Needs materialised — one tracked need per intake message (nothing dropped on the floor). */
  needs: number;
  /** Exact-contact duplicates Relay AUTO-LINKED (DuplicateProposed reason=exact_contact): the
   * incidents a group chat would have double-served, collapsed instead. */
  deduped: number;
  /** Fuzzy duplicates Relay PROPOSED for human merge (reason=similar) — surfaced, human-gated. */
  proposed_merges: number;
  /** Low-confidence needs routed to a human review card (tracked + owned, never silently lost). */
  needs_review: number;
  /** Deliveries VERIFIED on evidence (a Verified event in the ledger) — the group chat's 0. */
  verified: number;
  /** Intake messages that produced NO tracked need (lost). Relay loses none, so this is 0. */
  unrouted: number;
}

/** The measured gap between the two — each field a function of a baseline number and a relay number. */
export interface CounterfactualDelta {
  /** Double-serves the baseline incurred that Relay avoided by auto-linking the duplicates. */
  double_served_avoided: number;
  /** Requests the baseline left with no owner that Relay still tracked (baseline.unclaimed − relay.unrouted). */
  unclaimed_avoided: number;
  /** Verified deliveries Relay produced over the baseline's zero (relay.verified − baseline.verified). */
  verified_gained: number;
}

export interface Counterfactual {
  scenario_id: string;
  scenario_title: string;
  /** ALWAYS true. This whole comparison is a SIMULATION with published rules (BASELINE_RULES_DOC). */
  simulated: true;
  rules_doc: string;
  baseline: BaselineOutcome;
  relay: RelayOutcome;
  delta: CounterfactualDelta;
}

/** Load a frozen scenario by name (e.g. 'flood-1') from demo/scenarios/. Guarded to a safe slug so
 * a name can never escape the scenarios directory. */
export function loadScenario(scenarioName: string): Scenario {
  if (!/^[a-z0-9-]+$/.test(scenarioName)) {
    throw new Error(`invalid scenario name: ${JSON.stringify(scenarioName)} (expected [a-z0-9-]+)`);
  }
  const url = new URL(`../../demo/scenarios/${scenarioName}.yaml`, import.meta.url);
  return parseScenario(readFileSync(url, 'utf8'));
}

/**
 * Drive the SAME scenario through the real hermetic Relay pipeline and MEASURE the outcome from the
 * ledger. runScenario replays every intake message; evaluateDrift + evaluateEvidence then drive the
 * scenario's hero need all the way through claim → drift → reassign → evidence → Verified → Closed
 * (they no-op cleanly for a scenario without those expectations). Nothing here asserts — it reads.
 */
async function measureRelay(scenario: Scenario): Promise<RelayOutcome> {
  const a = buildHermeticAssembly();
  const run = await runScenario(scenario, a);
  // Drive to verification where the scenario supports it (these mutate the shared ledger).
  await evaluateDrift(scenario, a, run);
  await evaluateEvidence(scenario, a, run);

  const needs = await a.service.listNeeds();
  let deduped = 0;
  let proposed_merges = 0;
  let verified = 0;
  let needs_review = 0;
  for (const need of needs) {
    if (need.state === 'NEEDS_REVIEW') needs_review += 1;
    const events = await a.service.getEvents(need.need_id);
    if (events.some((e) => isEvent(e, 'Verified'))) verified += 1;
    for (const e of events) {
      if (isEvent(e, 'DuplicateProposed')) {
        if (e.payload.reason === 'exact_contact') deduped += 1;
        else if (e.payload.reason === 'similar') proposed_merges += 1;
      }
    }
  }

  const intakeCount = scenario.steps.filter((s) => s.kind === 'intake_message').length;

  return {
    scenario_id: scenario.id,
    needs: needs.length,
    deduped,
    proposed_merges,
    needs_review,
    verified,
    unrouted: Math.max(0, intakeCount - needs.length),
  };
}

/**
 * Run the full counterfactual for a named scenario: the naive baseline (simulated) + the real Relay
 * pipeline (measured), and the delta between them. Both operate on the identical frozen scenario, so
 * the comparison is apples-to-apples. `baselineOptions` is passed straight through (tests pin the
 * responder pool there); it never touches the Relay side.
 */
export async function runCounterfactual(
  scenarioName: string,
  baselineOptions: BaselineOptions = {},
): Promise<Counterfactual> {
  const scenario = loadScenario(scenarioName);
  const baseline = await runGroupChatBaseline(scenario, baselineOptions);
  const relay = await measureRelay(scenario);

  // Relay double-serves only the exact-contact duplicates it did NOT collapse (0 when it linked
  // them all). double_served_avoided is thus the overlap of what the baseline double-served and what
  // Relay deduped — a function of BOTH measured numbers, not an assertion.
  const relayDoubleServed = Math.max(0, baseline.double_served - relay.deduped);
  const delta: CounterfactualDelta = {
    double_served_avoided: baseline.double_served - relayDoubleServed,
    unclaimed_avoided: baseline.unclaimed - relay.unrouted,
    verified_gained: relay.verified - baseline.verified_deliveries,
  };

  return {
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    simulated: true,
    rules_doc: BASELINE_RULES_DOC,
    baseline,
    relay,
    delta,
  };
}

/**
 * Demo-driver evaluator for Moonshot #3 (the `counterfactual` capability). Lives here — not in
 * driver.ts — because it depends on runCounterfactual (which itself depends on driver.ts), so
 * putting it here keeps the import one-directional (run.ts → counterfactual.ts → driver.ts) with no
 * cycle. Runs the SIMULATED baseline + the MEASURED Relay pipeline on the scenario and asserts:
 *   · the naive baseline actually BITES — leaves work unclaimed AND double-served, verifies nothing,
 *   · Relay dedupes at least the duplicates the baseline double-served, loses none, and verifies ≥1,
 *   · the delta is exactly a function of both measured runs, and the whole thing is labelled
 *     simulated and points at the published rules doc.
 * Every number is from a real run; nothing is fabricated. Returns nothing when the scenario carries
 * no `counterfactual` expectation (e.g. heatwave-1), so it is a clean no-op there.
 */
export async function evaluateCounterfactual(scenario: Scenario): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'counterfactual_beats_group_chat');
  if (exp === undefined) return results;

  const cf = await runCounterfactual(scenario.id);
  const b = cf.baseline;
  const r = cf.relay;

  const baselineBites = b.unclaimed > 0 && b.double_served > 0 && b.verified_deliveries === 0;
  const relayDedupesAndVerifies = r.deduped >= b.double_served && r.unrouted === 0 && r.verified >= 1;
  const deltaConsistent =
    cf.delta.double_served_avoided === b.double_served &&
    cf.delta.unclaimed_avoided === b.unclaimed - r.unrouted &&
    cf.delta.verified_gained === r.verified - b.verified_deliveries;
  const labelledSimulated = cf.simulated === true && cf.rules_doc === BASELINE_RULES_DOC;

  const pass = baselineBites && relayDedupesAndVerifies && deltaConsistent && labelledSimulated;
  results.push({
    capability: 'counterfactual',
    assert: 'counterfactual_beats_group_chat',
    pass,
    detail: pass
      ? `SIMULATED (${cf.rules_doc}) — group-chat baseline: ${b.unclaimed} unclaimed, ${b.double_served} double-served, ${b.verified_deliveries} verified · Relay (measured): ${r.needs} needs, ${r.deduped} deduped, ${r.verified} verified · delta: ${cf.delta.double_served_avoided} double-serves avoided, ${cf.delta.unclaimed_avoided} kept owned, +${cf.delta.verified_gained} verified`
      : `baselineBites=${baselineBites}, relayDedupesAndVerifies=${relayDedupesAndVerifies}, deltaConsistent=${deltaConsistent}, labelledSimulated=${labelledSimulated}`,
  });
  return results;
}
