import { randomBytes, randomUUID } from 'node:crypto';
import type { Expectation, Scenario, VolunteerClaimStep } from '../../demo/scenarios/schema';
import { buildDriftCallbacks } from '../drift/callbacks';
import { runDriftSweep } from '../drift/driftEngine';
import { InMemoryScheduler } from '../drift/scheduler/inMemoryScheduler';
import { slaDueAtIso } from '../drift/sla';
import { MemoryDedupeStore } from '../ingest/dedupe';
import { handleIntakeMessage, type IntakeOutcome } from '../ingest/intakeHandler';
import { RecordingNotifier } from '../ingest/notifier';
import { isEvent, type NeedEvent } from '../ledger/events';
import { needEventKey } from '../ledger/idempotency';
import { NeedService } from '../ledger/needService';
import { DEFAULT_RISK_WINDOW_MS } from '../ledger/projection';
import { meetsVerificationPolicy } from '../ledger/stateMachine';
import { InMemoryEventStore } from '../ledger/store/memoryStore';
import type { ProjectedNeed } from '../ledger/types';
import { InMemoryContactVault } from '../lib/vault';
import { matchRationale } from '../match/rationale';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import { loadLocalityCoords, loadSeedVolunteers } from '../match/seedData';
import { InMemoryVolunteerStore } from '../match/volunteerStore';
import { HeuristicExtractor } from '../pipeline/extract';
import { makeIntakeJobHandler } from '../pipeline/intakeJob';
import { InlineQueue } from '../pipeline/queue';
import { buildMatchBlocks, type MatchNeed, type RankedCandidate } from '../surfaces/matchCard';

// The hermetic storyboard driver (BUILD-DOC §12, §16.2). It assembles the EXACT
// same intake pipeline the live app runs — memory event store + InlineQueue +
// MemoryDedupeStore + RecordingNotifier — with no Slack and no infra, then feeds
// scenario steps through it. Only `skeleton`-tagged expectations are evaluated
// today; later capabilities are skipped, never failed (the scenario schema is
// designed to grow with the build). Shared by `npm run demo` and the e2e test so
// both drive one assembly.

const DEMO_TEAM = 'T_DEMO';
const DEMO_INTAKE_CHANNEL = 'C_RELAY_INTAKE';
const BASE_CLOCK_MS = Date.parse('2026-07-04T00:00:00.000Z');

export interface HermeticAssembly {
  store: InMemoryEventStore;
  service: NeedService;
  notifier: RecordingNotifier;
  dedupe: MemoryDedupeStore;
  queue: InlineQueue;
  vault: InMemoryContactVault;
  volunteerStore: InMemoryVolunteerStore;
  localities: LocalityCoord[];
  teamId: string;
  intakeChannelId: string;
  isIntakeChannel: (channelId: string) => boolean;
}

/** Assemble the hermetic pipeline. Deterministic monotonic clock so successive
 * needs get ordered, reproducible timestamps. Extraction runs through the
 * deterministic HeuristicExtractor and contacts vault to an in-memory encrypted
 * store — the whole assembly needs zero env (no API key, no DB, no vault key). */
export function buildHermeticAssembly(opts: { baseClockMs?: number } = {}): HermeticAssembly {
  const base = opts.baseClockMs ?? BASE_CLOCK_MS;
  const store = new InMemoryEventStore();
  const service = new NeedService(store, () => base);
  const notifier = new RecordingNotifier();
  const dedupe = new MemoryDedupeStore();
  const extractor = new HeuristicExtractor();
  // A per-run random key: the vault is encrypted-at-rest even in the hermetic demo.
  const vault = new InMemoryContactVault(randomBytes(32).toString('hex'));
  // Seed the roster + gazetteer so matching has candidates with zero env.
  const volunteerStore = new InMemoryVolunteerStore(loadSeedVolunteers({ isDemo: true }));
  const localities = loadLocalityCoords();

  let tick = base;
  const now = () => {
    const v = tick;
    tick += 1000;
    return v;
  };

  // `store` is threaded in so dedupe runs after extraction (exact-contact + fuzzy
  // DuplicateProposed). No contactHashKey → the fixed dev salt (deterministic).
  const queue = new InlineQueue(
    makeIntakeJobHandler({ service, notifier, extractor, vault, store, now, isDemo: true }),
  );
  const isIntakeChannel = (channelId: string): boolean => channelId === DEMO_INTAKE_CHANNEL;

  return {
    store,
    service,
    notifier,
    dedupe,
    queue,
    vault,
    volunteerStore,
    localities,
    teamId: DEMO_TEAM,
    intakeChannelId: DEMO_INTAKE_CHANNEL,
    isIntakeChannel,
  };
}

export interface InjectInput {
  eventId: string;
  messageTs: string;
  userId: string;
  text: string;
  permalink?: string;
  teamId?: string;
  channelId?: string;
}

/** Push one synthetic intake message through the pipeline (as Slack would). */
export async function injectIntake(a: HermeticAssembly, input: InjectInput): Promise<IntakeOutcome> {
  return handleIntakeMessage(
    {
      eventId: input.eventId,
      teamId: input.teamId ?? a.teamId,
      channelId: input.channelId ?? a.intakeChannelId,
      messageTs: input.messageTs,
      userId: input.userId,
      text: input.text,
      permalink: input.permalink,
    },
    { queue: a.queue, dedupe: a.dedupe, isIntakeChannel: a.isIntakeChannel },
  );
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

/** A stable, ts-shaped id per intake message index (unique → unique idempotency key). */
const demoTs = (index: number): string => `1720051200.${String(index).padStart(6, '0')}`;

export interface SkippedStep {
  kind: string;
  ref: string;
  reason: string;
}

export interface ScenarioRunResult {
  intakeSteps: number;
  enqueued: number;
  skippedSteps: SkippedStep[];
  /** demoTs(index) → intake message step id (m01…), so needs can be mapped back to
   * their originating step via need.source.ts (for triage expectations). */
  stepIdByTs: Map<string, string>;
}

/** Execute a scenario's steps against an assembly. delay_ms is ignored (hermetic);
 * volunteer steps are skipped — those capabilities aren't built yet. */
export async function runScenario(scenario: Scenario, a: HermeticAssembly): Promise<ScenarioRunResult> {
  let index = 0;
  let intakeSteps = 0;
  let enqueued = 0;
  const skippedSteps: SkippedStep[] = [];
  const stepIdByTs = new Map<string, string>();

  for (const step of scenario.steps) {
    if (step.kind === 'intake_message') {
      index += 1;
      intakeSteps += 1;
      const ts = demoTs(index);
      stepIdByTs.set(ts, step.id);
      const outcome = await injectIntake(a, {
        eventId: `ev:${scenario.id}:${step.id}`,
        messageTs: ts,
        userId: `demo_${slug(step.persona)}`,
        text: step.text,
        permalink: `https://relay.demo/${a.intakeChannelId}/p${ts.replace('.', '')}`,
      });
      if (outcome === 'enqueued') enqueued += 1;
    } else if (step.kind === 'volunteer_claim') {
      skippedSteps.push({
        kind: step.kind,
        ref: `${step.volunteer_ref}->${step.need_ref}`,
        reason: 'driven by the drift evaluation (evaluateDrift): claim → SLA → nudge, not inline in runScenario',
      });
    } else {
      skippedSteps.push({
        kind: step.kind,
        ref: `${step.volunteer_ref}:${step.reply}`,
        reason: 'driven by the drift evaluation (evaluateDrift): release → reassignment proposal → reassigned',
      });
    }
  }

  return { intakeSteps, enqueued, skippedSteps, stepIdByTs };
}

export interface ExpectationResult {
  capability: string;
  assert: string;
  pass: boolean;
  detail: string;
}

/** Evaluate ONLY the skeleton-tagged expectations against the run's outcome. */
export async function evaluateSkeleton(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const needs = await a.service.listNeeds();
  const results: ExpectationResult[] = [];

  for (const exp of scenario.expectations) {
    if (exp.capability !== 'skeleton') continue;
    if (exp.assert === 'needs_created_count') {
      const expected = exp.params.count;
      const cards = a.notifier.cards.length;
      const created = needs.length;
      const pass = cards === expected && created === expected;
      results.push({
        capability: exp.capability,
        assert: exp.assert,
        pass,
        detail: pass
          ? `${created} needs created, ${cards} dispatch cards (expected ${expected})`
          : `expected ${expected}, got ${created} needs / ${cards} cards`,
      });
    }
  }

  return results;
}

/**
 * Evaluate the triage expectations that P-1 extraction now backs: NEEDS_REVIEW routing
 * and the deterministic critical-severity floor. Needs are mapped back to their intake
 * step via `need.source.ts`. `distinct_needs_after_dedupe` is deliberately NOT evaluated
 * here — it needs the dedupe capability — and is reported as a SKIP.
 */
export async function evaluateTriage(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const needs = await a.service.listNeeds();
  const needByStep = new Map<string, ProjectedNeed>();
  for (const n of needs) {
    const ref = n.source.ts === undefined ? undefined : run.stepIdByTs.get(n.source.ts);
    if (ref !== undefined) needByStep.set(ref, n);
  }

  const results: ExpectationResult[] = [];
  for (const exp of scenario.expectations) {
    if (exp.capability !== 'triage') continue;
    if (exp.assert === 'needs_review_count') {
      const got = needs.filter((n) => n.state === 'NEEDS_REVIEW').length;
      const pass = got === exp.params.count;
      results.push({
        capability: exp.capability,
        assert: exp.assert,
        pass,
        detail: `${got} need(s) routed to NEEDS_REVIEW (expected ${exp.params.count})`,
      });
    } else if (exp.assert === 'critical_severity_floor') {
      const refs = exp.params.need_refs;
      const misses = refs.filter((ref) => needByStep.get(ref)?.severity !== 'critical');
      const pass = misses.length === 0;
      results.push({
        capability: exp.capability,
        assert: exp.assert,
        pass,
        detail: pass ? `severity floored to critical for ${refs.join(', ')}` : `NOT critical for ${misses.join(', ')}`,
      });
    }
  }
  return results;
}

/** Index needs back to their originating intake step via `need.source.ts`. */
function mapNeedsByStep(needs: ProjectedNeed[], run: ScenarioRunResult): Map<string, ProjectedNeed> {
  const byStep = new Map<string, ProjectedNeed>();
  for (const n of needs) {
    const ref = n.source.ts === undefined ? undefined : run.stepIdByTs.get(n.source.ts);
    if (ref !== undefined) byStep.set(ref, n);
  }
  return byStep;
}

/** The auto-detected duplicate proposals on a need: [otherNeedId, reason] per event. */
async function proposalsOn(
  a: HermeticAssembly,
  need: ProjectedNeed,
): Promise<Array<{ other: string; reason: string }>> {
  const out: Array<{ other: string; reason: string }> = [];
  for (const e of await a.service.getEvents(need.need_id)) {
    if (isEvent(e, 'DuplicateProposed')) out.push({ other: e.payload.other_need_id, reason: e.payload.reason ?? '' });
  }
  return out;
}

/**
 * Evaluate the dedupe expectations the engine now backs: exact-contact links and fuzzy
 * "similar" proposals. Each yields a DuplicateProposed on the LATER (duplicate) need that
 * references the ORIGINAL. Reads the ledger truth — never fakes a pass.
 */
export async function evaluateDedupe(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const byStep = mapNeedsByStep(await a.service.listNeeds(), run);
  const results: ExpectationResult[] = [];
  for (const exp of scenario.expectations) {
    if (exp.capability !== 'dedupe') continue;
    if (exp.assert !== 'exact_contact_auto_link' && exp.assert !== 'duplicate_proposed_pairs') continue;
    const wantReason = exp.assert === 'exact_contact_auto_link' ? 'exact_contact' : 'similar';
    const misses: string[] = [];
    for (const [dupRef, origRef] of exp.params.pairs) {
      const dup = byStep.get(dupRef);
      const orig = byStep.get(origRef);
      if (dup === undefined || orig === undefined) {
        misses.push(`${dupRef}->${origRef} (need not found)`);
        continue;
      }
      const props = await proposalsOn(a, dup);
      if (!props.some((p) => p.other === orig.need_id && p.reason === wantReason)) misses.push(`${dupRef}->${origRef}`);
    }
    const pass = misses.length === 0;
    results.push({
      capability: exp.capability,
      assert: exp.assert,
      pass,
      detail: pass
        ? `${exp.params.pairs.length} pair(s) proposed with reason '${wantReason}'`
        : `no '${wantReason}' proposal for ${misses.join(', ')}`,
    });
  }
  return results;
}

/**
 * Evaluate the match expectation: a confirmed need yields a top-N volunteer slate. Drives
 * the real flow deterministically — TriageConfirmed (human) → OPEN, deterministic scorer +
 * grounded rationale → MatchSuggested (system) — then counts the suggested candidates from
 * the ledger and renders the slate under the card.
 */
export async function evaluateMatch(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const needs = await a.service.listNeeds();
  const byStep = mapNeedsByStep(needs, run);
  const volunteers = await a.volunteerStore.list();
  // A reference "now" comfortably after every intake event (transitions are time-gate-free).
  const demoNow = Math.max(BASE_CLOCK_MS, ...needs.map((n) => Date.parse(n.created_at))) + 60_000;

  for (const exp of scenario.expectations) {
    if (exp.capability !== 'match' || exp.assert !== 'candidates_suggested') continue;
    const need = byStep.get(exp.params.need_ref);
    if (need === undefined) {
      results.push({
        capability: exp.capability,
        assert: exp.assert,
        pass: false,
        detail: `need ${exp.params.need_ref} not found`,
      });
      continue;
    }

    if (need.state === 'TRIAGED' || need.state === 'NEEDS_REVIEW') {
      await a.service.dispatch(
        need.need_id,
        { type: 'TriageConfirmed', payload: {} },
        {
          actor: { type: 'human', id: 'demo-coordinator' },
          at: new Date(demoNow).toISOString(),
          idempotencyKey: needEventKey(need.need_id, 'TriageConfirmed', 'demo'),
          now: demoNow,
        },
      );
    }
    const open = (await a.service.getNeed(need.need_id, demoNow)) ?? need;
    const scoreNeed: ScoreNeed = { type: open.type, localityId: open.locality_id, languages: open.languages };
    const top = topN(scoreNeed, volunteers, a.localities, Math.max(exp.params.min_count, 3));
    const ranked: RankedCandidate[] = [];
    for (const c of top) ranked.push({ ...c, rationale: await matchRationale(c, scoreNeed) });

    const suggested = await a.service.dispatch(
      need.need_id,
      {
        type: 'MatchSuggested',
        payload: {
          candidates: ranked.map((c) => ({
            volunteer_id: c.volunteer.slack_user_id,
            score: Math.round(c.score * 10000) / 10000,
          })),
        },
      },
      {
        actor: { type: 'system', id: 'relay-match' },
        at: new Date(demoNow).toISOString(),
        idempotencyKey: needEventKey(need.need_id, 'MatchSuggested', 'demo'),
        now: demoNow,
      },
    );

    let count = 0;
    for (const e of await a.service.getEvents(need.need_id)) {
      if (isEvent(e, 'MatchSuggested')) count = Math.max(count, e.payload.candidates.length);
    }

    // Render the slate under the (already-posted) card so the demo card shows the match.
    const card = a.notifier.cards.find((c) => c.needId === need.need_id);
    if (card !== undefined && suggested.need !== undefined) {
      const matchNeed: MatchNeed = {
        needId: need.need_id,
        publicId: card.publicId,
        type: suggested.need.type,
        localityText: suggested.need.location_text,
      };
      await a.notifier.updateCard(
        { channel: card.channel, ts: card.ts },
        { needId: need.need_id, publicId: card.publicId },
        suggested.need,
        { events: await a.service.getEvents(need.need_id), extraBlocks: buildMatchBlocks(matchNeed, ranked) },
      );
    }

    const pass = count >= exp.params.min_count;
    results.push({
      capability: exp.capability,
      assert: exp.assert,
      pass,
      detail: pass
        ? `${count} volunteer(s) suggested for ${exp.params.need_ref} (min ${exp.params.min_count})`
        : `only ${count} suggested for ${exp.params.need_ref} (min ${exp.params.min_count})`,
    });
  }
  return results;
}

/**
 * Drive + evaluate the drift/reassign hero arc for the drift need (m01): confirm → self-claim
 * (stamping a COMPRESSED SLA) → advance the in-memory scheduler's virtual clock so the sweep
 * fires at-risk (a DM nudge) then overdue (a reassignment card) → the volunteer releases →
 * a fresh reassignment proposal appears → the coordinator hands the obligation to a second
 * volunteer. Every assertion reads the ledger / recorded notifications — nothing is faked.
 * The scheduler + drift callbacks are the SAME seams live mode wires (src/server.ts).
 *
 * Note on the post-release reassignment: ClaimReleased returns the need to OPEN, from which the
 * legal "commit a volunteer" transition is Assigned (not Reassigned, which applies from a still
 * -held CLAIMED/IN_PROGRESS/REOPENED need) — so the demo reassigns via Assigned. The live
 * need_reassign_pick handler is state-aware and uses whichever the current state allows.
 */
export async function evaluateDrift(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const nudgeExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'nudge_before_overdue' }> => e.assert === 'nudge_before_overdue',
  );
  const reassignExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'reassign_after_release' }> => e.assert === 'reassign_after_release',
  );
  const driftRef = (nudgeExp ?? reassignExp)?.params.need_ref;
  if (driftRef === undefined) return results;

  const needs0 = await a.service.listNeeds();
  const seed = mapNeedsByStep(needs0, run).get(driftRef);
  const claimStep = scenario.steps.find(
    (s): s is VolunteerClaimStep => s.kind === 'volunteer_claim' && s.need_ref === driftRef,
  );
  const claimVol = claimStep?.volunteer_ref;

  const fail = (assert: 'nudge_before_overdue' | 'reassign_after_release', detail: string): void => {
    results.push({ capability: 'drift', assert, pass: false, detail });
  };
  if (seed === undefined || claimVol === undefined) {
    if (nudgeExp) fail('nudge_before_overdue', `drift need ${driftRef} or its claim step not found`);
    if (reassignExp) fail('reassign_after_release', `drift need ${driftRef} or its claim step not found`);
    return results;
  }
  const needId = seed.need_id;

  const resolvePublicId = async (id: string): Promise<string> => (await a.store.getPublicId(id)) ?? id;
  const { notifyNudge, proposeReassign } = buildDriftCallbacks({
    service: a.service,
    notifier: a.notifier,
    volunteerStore: a.volunteerStore,
    localities: a.localities,
    resolvePublicId,
  });

  const claimAt = Math.max(BASE_CLOCK_MS, ...needs0.map((n) => Date.parse(n.created_at))) + 120_000;

  // Confirm triage → OPEN (human) if still pre-open.
  const preClaim = (await a.service.getNeed(needId, claimAt)) ?? seed;
  if (preClaim.state === 'TRIAGED' || preClaim.state === 'NEEDS_REVIEW') {
    await a.service.dispatch(
      needId,
      { type: 'TriageConfirmed', payload: {} },
      {
        actor: { type: 'human', id: 'demo-coordinator' },
        at: new Date(claimAt).toISOString(),
        idempotencyKey: needEventKey(needId, 'TriageConfirmed', 'drift'),
        now: claimAt,
      },
    );
  }

  // Self-claim (F3), stamping the compressed SLA the sweep will chase.
  const open = (await a.service.getNeed(needId, claimAt)) ?? preClaim;
  const slaIso = slaDueAtIso(open.type, open.severity, claimAt, scenario.sla_multiplier);
  const claimed = await a.service.dispatch(
    needId,
    { type: 'Claimed', payload: { volunteer_id: claimVol, obligation_id: randomUUID(), sla_due_at: slaIso } },
    {
      actor: { type: 'human', id: claimVol },
      at: new Date(claimAt).toISOString(),
      idempotencyKey: needEventKey(needId, 'Claimed', 'drift'),
      now: claimAt,
    },
  );
  if (claimed.status !== 'applied') {
    if (nudgeExp) fail('nudge_before_overdue', `self-claim did not apply (${claimed.status})`);
    if (reassignExp) fail('reassign_after_release', `self-claim did not apply (${claimed.status})`);
    return results;
  }
  await a.volunteerStore.incrementLoad(claimVol, 1);
  const dueMs = Date.parse(slaIso);

  // The in-memory scheduler drives the sweep on a virtual clock — the demo's on-cue drift.
  const scheduler = new InMemoryScheduler();
  scheduler.start(async (now) => {
    await runDriftSweep({
      service: a.service,
      listNeeds: (n) => a.service.listNeeds(n),
      notifyNudge,
      proposeReassign,
      now,
    });
  });

  // 1) A sweep INSIDE the risk window, before due → Nudged('at_risk') + a DM nudge.
  const preDue = Math.max(1, Math.min(Math.floor((dueMs - claimAt) / 2), DEFAULT_RISK_WINDOW_MS - 1));
  await scheduler.runDue(dueMs - preDue);
  // 2) A sweep PAST due → Nudged('overdue') + a reassignment proposal.
  await scheduler.runDue(dueMs + 1_000);

  if (nudgeExp) {
    const events = await a.service.getEvents(needId);
    const atRiskNudged = events.some((e) => isEvent(e, 'Nudged') && e.payload.kind === 'at_risk');
    const dm = a.notifier.dms.some((d) => d.userId === claimVol);
    const pass = atRiskNudged && dm;
    results.push({
      capability: 'drift',
      assert: 'nudge_before_overdue',
      pass,
      detail: pass
        ? `Nudged('at_risk') fired before due and DM'd ${claimVol}`
        : `at_risk nudge=${atRiskNudged}, DM=${dm}`,
    });
  }

  if (reassignExp) {
    // 3) The volunteer releases → OPEN, then a fresh reassignment proposal is posted.
    const releaseAt = dueMs + 2_000;
    const released = await a.service.dispatch(
      needId,
      { type: 'ClaimReleased', payload: { volunteer_id: claimVol, reason: 'volunteer_released' } },
      {
        actor: { type: 'human', id: claimVol },
        at: new Date(releaseAt).toISOString(),
        idempotencyKey: needEventKey(needId, 'ClaimReleased', 'drift'),
        now: releaseAt,
      },
    );
    await a.volunteerStore.incrementLoad(claimVol, -1);
    const openAgain = (await a.service.getNeed(needId, releaseAt)) ?? open;
    const postsBefore = a.notifier.dispatchPosts.length;
    await proposeReassign(openAgain, claimVol);
    const proposalPosted = a.notifier.dispatchPosts.length > postsBefore;

    // 4) The coordinator one-click reassigns to the top fresh candidate (from OPEN → Assigned).
    const scoreNeed: ScoreNeed = {
      type: openAgain.type,
      localityId: openAgain.locality_id,
      languages: openAgain.languages,
    };
    const vols = (await a.volunteerStore.list()).filter((v) => v.slack_user_id !== claimVol);
    const newVol = topN(scoreNeed, vols, a.localities, 3)[0]?.volunteer.slack_user_id;
    let finalVol: string | null = null;
    let reassigned = false;
    if (newVol !== undefined) {
      const reassignAt = dueMs + 3_000;
      const newSla = slaDueAtIso(openAgain.type, openAgain.severity, reassignAt, scenario.sla_multiplier);
      const rr = await a.service.dispatch(
        needId,
        { type: 'Assigned', payload: { volunteer_id: newVol, obligation_id: randomUUID(), sla_due_at: newSla } },
        {
          actor: { type: 'human', id: 'demo-coordinator' },
          at: new Date(reassignAt).toISOString(),
          idempotencyKey: needEventKey(needId, 'Assigned', 'drift-reassign'),
          now: reassignAt,
        },
      );
      if (rr.status === 'applied') await a.volunteerStore.incrementLoad(newVol, 1);
      const finalNeed = await a.service.getNeed(needId, reassignAt);
      finalVol = finalNeed?.assigned_volunteer_id ?? null;
      reassigned =
        finalNeed !== null &&
        finalVol === newVol &&
        newVol !== claimVol &&
        (finalNeed.state === 'CLAIMED' || finalNeed.state === 'IN_PROGRESS');
    }
    const releaseApplied = released.status === 'applied';
    const pass = releaseApplied && proposalPosted && reassigned;
    results.push({
      capability: 'drift',
      assert: 'reassign_after_release',
      pass,
      detail: pass
        ? `released by ${claimVol} → proposal posted → reassigned to ${finalVol}`
        : `release=${releaseApplied}, proposal=${proposalPosted}, reassignedTo=${finalVol ?? 'none'}`,
    });
  }

  return results;
}

/** An ordered-subsequence match over an event log: every predicate must be satisfied, in
 * order, by some event (gaps allowed). Proves the hero chain happened in the right sequence. */
function matchesChain(events: NeedEvent[], steps: ReadonlyArray<(e: NeedEvent) => boolean>): boolean {
  let i = 0;
  for (const e of events) {
    if (i < steps.length && steps[i]?.(e)) i += 1;
  }
  return i === steps.length;
}

/** The event types that are consequential human gates (§6.2). The engine already rejects a
 * non-human actor on these, so any that made it into the log MUST carry a human actor — the
 * hero assertion reads that back from the ledger to prove the invariant end to end. */
const HUMAN_GATED_TYPES: ReadonlySet<string> = new Set([
  'TriageConfirmed',
  'DuplicateConfirmed',
  'Assigned',
  'Reassigned',
  'CoordinatorSignedOff',
  'Verified',
  'Closed',
  'Cancelled',
]);

/**
 * Drive + evaluate the evidence/verification HERO FINALE on the drift need (m01) — the demo's
 * hero moment (§F5). REQUIRES evaluateDrift to have run first: it continues from the post-reassign
 * obligation held by the SECOND volunteer and drives the delivery → close chain on the SAME
 * ledger, reading every assertion back from the event log (never fabricated):
 *   1. deliver: EvidenceAttached(photo) + EvidenceAttached(locality_confirm) → DELIVERED_UNVERIFIED (L1)
 *   2. CLOSE-GATING PROOF: a Verified attempted here (high-severity need, only L1 present) is
 *      REJECTED with INSUFFICIENT_EVIDENCE — the engine will not close on a partial packet.
 *   3. recipient confirm (+ EvidenceAttached recipient_confirm) → L2
 *   4. coordinator sign-off: EvidenceAttached(coordinator_signoff) + CoordinatorSignedOff (human) → L3
 *   5. Verified (human) → VERIFIED, then Closed (human) → CLOSED, on the now-complete packet.
 * Evaluates BOTH evidence expectations (close_requires_evidence + hero_e2e) from this one drive.
 * Human-gated steps carry a human actor; evidence attaches / recipient confirm are agent events.
 */
export async function evaluateEvidence(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const closeExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'close_requires_evidence' }> => e.assert === 'close_requires_evidence',
  );
  const heroExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'hero_e2e' }> => e.assert === 'hero_e2e',
  );
  const ref = (heroExp ?? closeExp)?.params.need_ref;
  if (ref === undefined) return results;

  const fail = (assert: 'close_requires_evidence' | 'hero_e2e', detail: string): void => {
    results.push({ capability: 'evidence', assert, pass: false, detail });
  };

  const seed = mapNeedsByStep(await a.service.listNeeds(), run).get(ref);
  if (seed === undefined) {
    if (closeExp) fail('close_requires_evidence', `need ${ref} not found`);
    if (heroExp) fail('hero_e2e', `need ${ref} not found`);
    return results;
  }
  const needId = seed.need_id;

  // Post-drift the obligation is held by a SECOND volunteer (state CLAIMED, fresh SLA). Anchor
  // the evidence timeline just after the reassign; the F5 transitions are all time-gate-free.
  const held = await a.service.getNeed(needId);
  const holder = held?.assigned_volunteer_id ?? null;
  if (held === null || holder === null || (held.state !== 'CLAIMED' && held.state !== 'IN_PROGRESS')) {
    const detail = `${ref} is ${held?.state ?? 'missing'} (holder ${holder ?? 'none'}) — the evidence arc needs the post-reassign claimed obligation (run evaluateDrift first)`;
    if (closeExp) fail('close_requires_evidence', detail);
    if (heroExp) fail('hero_e2e', detail);
    return results;
  }

  let clock = Date.parse(held.updated_at) + 1000;
  const at = (): string => {
    const v = new Date(clock).toISOString();
    clock += 1000;
    return v;
  };
  const coordinator = 'demo-coordinator';
  const recipient = 'demo-recipient';

  // 1) DELIVER — the second volunteer attaches L1 (photo + locality). Evidence stores REFERENCES
  // only (a Slack file id), never beneficiary content (zero-copy, invariant #5).
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'F_DEMO_PHOTO', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: holder },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'photo'),
    },
  );
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: holder },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'locality'),
    },
  );

  // 2) CLOSE-GATING PROOF — Verified with only L1 present is REJECTED (high need requires L3).
  const premature = await a.service.dispatch(
    needId,
    { type: 'Verified', payload: {} },
    {
      actor: { type: 'human', id: coordinator },
      at: at(),
      idempotencyKey: needEventKey(needId, 'Verified', 'premature'),
    },
  );
  const rejectedEarly = premature.status === 'rejected' && premature.code === 'INSUFFICIENT_EVIDENCE';

  // 3) RECIPIENT CONFIRM (+ evidence ref) → L2. Not human-gated: the recipient closes their own loop.
  await a.service.dispatch(
    needId,
    { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } },
    {
      actor: { type: 'agent', id: recipient },
      at: at(),
      idempotencyKey: needEventKey(needId, 'RecipientConfirmed', 'demo'),
    },
  );
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'recipient_confirm', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: recipient },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'recipient'),
    },
  );

  // 4) COORDINATOR SIGN-OFF (+ evidence ref) → L3. CoordinatorSignedOff is human-gated.
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'coordinator_signoff', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: 'relay-evidence' },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'signoff'),
    },
  );
  await a.service.dispatch(
    needId,
    { type: 'CoordinatorSignedOff', payload: {} },
    {
      actor: { type: 'human', id: coordinator },
      at: at(),
      idempotencyKey: needEventKey(needId, 'CoordinatorSignedOff', 'demo'),
    },
  );

  // 5) VERIFY (human) → VERIFIED, then CLOSE (human) → CLOSED, on the now-complete L3 packet.
  const preVerify = await a.service.getNeed(needId);
  const policyMet = preVerify !== null && meetsVerificationPolicy(preVerify);
  const verified = await a.service.dispatch(
    needId,
    { type: 'Verified', payload: {} },
    { actor: { type: 'human', id: coordinator }, at: at(), idempotencyKey: needEventKey(needId, 'Verified', 'final') },
  );
  const closed = await a.service.dispatch(
    needId,
    { type: 'Closed', payload: {} },
    { actor: { type: 'human', id: coordinator }, at: at(), idempotencyKey: needEventKey(needId, 'Closed', 'final') },
  );

  // --- Read the truth back from the ledger (never fabricate a pass) -----------
  const finalNeed = await a.service.getNeed(needId);
  const events = await a.service.getEvents(needId);
  const kinds = new Set(finalNeed?.evidence.map((e) => e.kind) ?? []);
  const requiredKinds = closeExp?.params.required ?? [
    'photo',
    'locality_confirm',
    'recipient_confirm',
    'coordinator_signoff',
  ];
  const packetComplete = requiredKinds.every((k) => kinds.has(k));
  const isClosed = finalNeed?.state === 'CLOSED';
  const closeApplied = closed.status === 'applied';
  const verifyApplied = verified.status === 'applied';

  // Render the closed card so the demo surfaces the evidence packet + "Verified · Closed" badge.
  const card = a.notifier.cards.find((c) => c.needId === needId);
  if (card !== undefined && finalNeed !== null) {
    await a.notifier.updateCard(
      { channel: card.channel, ts: card.ts },
      { needId, publicId: card.publicId },
      finalNeed,
      {
        events,
      },
    );
  }

  if (closeExp) {
    const pass = rejectedEarly && policyMet && verifyApplied && closeApplied && packetComplete;
    results.push({
      capability: 'evidence',
      assert: 'close_requires_evidence',
      pass,
      detail: pass
        ? `close blocked at L1 (rejected: INSUFFICIENT_EVIDENCE), then verified+closed once ${requiredKinds.join(', ')} were all present`
        : `rejectedEarly=${rejectedEarly}, policyMet=${policyMet}, verified=${verified.status}, closed=${closed.status}, packet=[${[...kinds].join(', ')}]`,
    });
  }

  if (heroExp) {
    // The full hero chain, in order, as an ordered subsequence of the event log.
    const chainOk = matchesChain(events, [
      (e) => isEvent(e, 'Claimed'),
      (e) => isEvent(e, 'Nudged') && e.payload.kind === 'at_risk',
      (e) => isEvent(e, 'ClaimReleased'),
      (e) => isEvent(e, 'Assigned') || isEvent(e, 'Reassigned'),
      (e) => isEvent(e, 'EvidenceAttached') && e.payload.kind === 'photo',
      (e) => isEvent(e, 'EvidenceAttached') && e.payload.kind === 'locality_confirm',
      (e) => isEvent(e, 'RecipientConfirmed'),
      (e) => isEvent(e, 'CoordinatorSignedOff'),
      (e) => isEvent(e, 'Verified'),
      (e) => isEvent(e, 'Closed'),
    ]);
    // No auto-merge: neither a DuplicateConfirmed on the log nor a merged_into on the projection.
    const autoMerged = events.some((e) => isEvent(e, 'DuplicateConfirmed')) || finalNeed?.merged_into !== null;
    // Every human-gated event that made it into the log carries a human actor.
    const gateViolations = events.filter((e) => HUMAN_GATED_TYPES.has(e.type) && e.actor.type !== 'human');
    const pass = chainOk && isClosed && packetComplete && rejectedEarly && !autoMerged && gateViolations.length === 0;
    results.push({
      capability: 'evidence',
      assert: 'hero_e2e',
      pass,
      detail: pass
        ? `claim→at-risk nudge→release→reassign→deliver(photo+locality)→recipient confirm→sign-off→Verified→Closed; complete packet, no auto-merge, all ${events.filter((e) => HUMAN_GATED_TYPES.has(e.type)).length} human-gated steps human-signed, premature Verified rejected`
        : `chain=${chainOk}, closed=${isClosed}, packet=${packetComplete}, rejectedEarly=${rejectedEarly}, autoMerged=${autoMerged}, gateViolations=${gateViolations.map((e) => e.type).join(',') || 'none'}`,
    });
  }

  return results;
}

/** Asserts the driver evaluates today: the walking skeleton, extraction-backed triage,
 * dedupe auto-detection, the deterministic match slate, the drift/reassign hero arc, and
 * the evidence/verification finale. Everything else is a documented SKIP. */
const EVALUATED_ASSERTS: ReadonlySet<string> = new Set([
  'needs_created_count',
  'needs_review_count',
  'critical_severity_floor',
  'exact_contact_auto_link',
  'duplicate_proposed_pairs',
  'candidates_suggested',
  'nudge_before_overdue',
  'reassign_after_release',
  'close_requires_evidence',
  'hero_e2e',
]);

export interface SkippedExpectation {
  capability: string;
  assert: string;
  reason: string;
}

function skipReason(exp: Expectation): string {
  if (exp.assert === 'distinct_needs_after_dedupe') {
    return 'dedupe auto-detects duplicates (DuplicateProposed), but the merge itself is a human-gated DuplicateConfirmed — the hermetic demo does not auto-merge, so all 14 needs remain';
  }
  if (exp.capability === 'sitrep') return 'sitrep narration lands with F6';
  return 'capability not built yet';
}

/** Every expectation the driver does NOT evaluate yet, each with an honest reason. */
export function skippedExpectations(scenario: Scenario): SkippedExpectation[] {
  return scenario.expectations
    .filter((e) => !EVALUATED_ASSERTS.has(e.assert))
    .map((e) => ({ capability: e.capability, assert: e.assert, reason: skipReason(e) }));
}
