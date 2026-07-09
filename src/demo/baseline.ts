import type { IntakeMessageStep, Scenario } from '../../demo/scenarios/schema';
import { loadSeedVolunteers } from '../match/seedData';
import { normalizeContact } from '../pipeline/contact';
import { type Extractor, HeuristicExtractor, runExtraction } from '../pipeline/extract';

// Moonshot #3 — the counterfactual: a "group-chat baseline" simulator (BUILD-DOC §Impact).
//
// This is a SIMULATION of how an UNSTRUCTURED group chat would coordinate the SAME fictional
// flood, using the EXPLICIT, DETERMINISTIC, PUBLISHED naive rules below. It is NOT a claim about
// any real deployment. The rules — and this honesty note — are published verbatim in
// docs/BASELINE-RULES.md; every number the demo prints comes from actually running this simulator
// on the same scenario (never fabricated). See the ethos in the task brief: the counterfactual is
// a simulation with published rules, labelled 'simulated' everywhere.
//
// The naive rules (each referenced by tag in the code below and documented in BASELINE-RULES.md):
//
//   R1 — NO DEDUPE. Every intake message is a separate "request". A group chat has no way to see
//        that two posts describe the same incident, so a request whose beneficiary phone repeats an
//        EARLIER request's phone gets its own volunteer → the incident is served twice (double_served).
//        Exact-contact collision (identical normalized phone) is the only duplicate signal derivable
//        from raw scenario data without a fuzzy matcher, so it is the conservative ground truth used
//        here — reworded no-contact repeats (which a chat also cannot catch) are NOT counted, so the
//        double-serve number is if anything an UNDER-count.
//
//   R2 — NO TRIAGE (ambiguity drop). A message a naive reader cannot turn into an actionable need —
//        no type, no place, no head-count — gets no claimant: nobody knows what to do with it. This
//        is modelled with the deterministic HeuristicExtractor (the same keyword skim the hermetic
//        pipeline uses as its zero-env parse), treating its needs_review flag as "unparseable". It is
//        the naive-reader model, NOT Relay's LLM / severity-floor / human-review path.
//
//   R3 — FIRST-CLAIM-WINS, NO TRACKING, FINITE ATTENTION. Volunteers claim actionable requests in
//        arrival order. With no assignment board reminding anyone of open work — and with nothing
//        ever verified-closed (R4), so a claim never frees its owner — each responder can shepherd
//        only ONE request. Once the responder pool is exhausted, every later request scrolls past
//        unclaimed (capacity overflow). The responder pool is the SEEDED volunteer roster
//        (loadSeedVolunteers) — the SAME people Relay coordinates — so the comparison is symmetric,
//        not a rigged constant.
//
//   R4 — NO VERIFICATION. "Delivered" is self-reported ("got it 👍") and unproven, so
//        verified_deliveries is always 0. A group chat produces no evidence packet.
//
// unclaimed = R2 ambiguity drops + R3 capacity overflow. double_served = R1 collisions that a
// responder actually claimed (a collision that scrolls past unclaimed is counted as unclaimed, not
// double-served). Nothing here is tuned to a target: the numbers fall out of the scenario (message
// count, which messages are unparseable, which phones repeat) and the roster size.

/** What happened to one request in the group-chat simulation (arrival order). */
export type BaselineDisposition = 'served' | 'double_served' | 'unclaimed_unparseable' | 'unclaimed_capacity';

/** Per-request trace, so the outcome is fully auditable (and testable) from the rules. */
export interface BaselineRequestResult {
  /** The intake message id (m01…) this request came from. */
  ref: string;
  disposition: BaselineDisposition;
}

/**
 * The measured outcome of running the naive group-chat rules on a scenario. Every field is a
 * count produced by the simulation above — nothing is asserted or hand-written. `verified_deliveries`
 * is typed as the literal `0`: R4 guarantees a group chat verifies nothing.
 */
export interface BaselineOutcome {
  scenario_id: string;
  /** R1: one request per intake message (no dedupe). */
  total_requests: number;
  /** R3: responders available (the seeded roster, unless overridden). */
  responder_pool: number;
  /** R2: requests a naive reader could not turn into an actionable need. */
  unparseable: number;
  /** R3: requests a responder committed to (served + double-served). */
  claimed: number;
  /** Claimed requests that covered a distinct incident once (claimed − double_served). */
  distinct_served: number;
  /** R1: claimed requests that duplicated an earlier request's contact — a second volunteer sent
   * to an already-covered incident. */
  double_served: number;
  /** R2 + R3: requests that never got a claimant (unparseable + capacity overflow). */
  unclaimed: number;
  /** R4: always 0 — nothing is verified in a group chat. */
  verified_deliveries: 0;
  /** The full per-request trace in arrival order. */
  trace: BaselineRequestResult[];
}

export interface BaselineOptions {
  /** Responder pool size for R3 (first-claim-wins). Defaults to the seeded volunteer roster
   * (loadSeedVolunteers) — the SAME people Relay coordinates. Injectable so a test can pin it
   * independently of the roster file. */
  responderPool?: number;
  /** The naive-reader parse for R2. Defaults to the deterministic HeuristicExtractor. */
  extractor?: Extractor;
}

/** The ground-truth incident key for R1: the normalized beneficiary phone (or null when a message
 * carries none). Two requests with the same key are the same incident a chat cannot see is a repeat. */
function incidentKey(step: IntakeMessageStep): string | null {
  if (step.contact === undefined) return null;
  return normalizeContact(step.contact)?.digits ?? null;
}

/**
 * Run the group-chat baseline (Moonshot #3). Applies R1–R4 above, deterministically, to the
 * scenario's intake messages and returns the measured BaselineOutcome. Async only because the
 * naive-reader parse (R2) goes through the same Extractor seam the pipeline uses.
 */
export async function runGroupChatBaseline(scenario: Scenario, opts: BaselineOptions = {}): Promise<BaselineOutcome> {
  const extractor = opts.extractor ?? new HeuristicExtractor();
  const responderPool = opts.responderPool ?? loadSeedVolunteers({ isDemo: true }).length;

  const requests = scenario.steps.filter((s): s is IntakeMessageStep => s.kind === 'intake_message');

  const seenContacts = new Set<string>();
  let respondersUsed = 0;
  const trace: BaselineRequestResult[] = [];

  for (const step of requests) {
    // R1 — is this the same incident as an earlier request (repeated contact)?
    const key = incidentKey(step);
    const isDuplicate = key !== null && seenContacts.has(key);
    if (key !== null) seenContacts.add(key);

    // R2 — can a naive reader even act on it?
    const parseable = !(await runExtraction(step.text, extractor)).payload.needs_review;

    let disposition: BaselineDisposition;
    if (!parseable) {
      // R2: ambiguous / garbled → nobody claims it (no responder consumed).
      disposition = 'unclaimed_unparseable';
    } else if (respondersUsed < responderPool) {
      // R3: a responder claims it. R1: a duplicate burns that responder on redundant work.
      respondersUsed += 1;
      disposition = isDuplicate ? 'double_served' : 'served';
    } else {
      // R3: responders exhausted → scrolls past unclaimed.
      disposition = 'unclaimed_capacity';
    }
    trace.push({ ref: step.id, disposition });
  }

  const count = (d: BaselineDisposition): number => trace.filter((t) => t.disposition === d).length;
  const unparseable = count('unclaimed_unparseable');
  const double_served = count('double_served');
  const distinct_served = count('served');
  const claimed = distinct_served + double_served;
  const unclaimed = unparseable + count('unclaimed_capacity');

  return {
    scenario_id: scenario.id,
    total_requests: requests.length,
    responder_pool: responderPool,
    unparseable,
    claimed,
    distinct_served,
    double_served,
    unclaimed,
    verified_deliveries: 0, // R4 — never verified.
    trace,
  };
}
