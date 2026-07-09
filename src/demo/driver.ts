import { randomBytes, randomUUID } from 'node:crypto';
import type { Expectation, IntakeMessageStep, Scenario, VolunteerClaimStep } from '../../demo/scenarios/schema';
import { askRelay } from '../assistant/askRelay';
import { buildDriftCallbacks } from '../drift/callbacks';
import { runDriftSweep } from '../drift/driftEngine';
import { computeBackup } from '../drift/prewarm';
import { InMemoryScheduler } from '../drift/scheduler/inMemoryScheduler';
import { computeSlaDueAtMs, slaDueAtIso } from '../drift/sla';
import { DEFAULT_SLA_TABLE, mergeSlaTable } from '../drift/slaConfig';
import { MemoryDedupeStore } from '../ingest/dedupe';
import { handleIntakeMessage, type IntakeOutcome } from '../ingest/intakeHandler';
import { RecordingNotifier } from '../ingest/notifier';
import { postRequesterReply } from '../ingest/requesterReply';
import { isEvent, type NeedEvent } from '../ledger/events';
import { needEventKey } from '../ledger/idempotency';
import { NeedService } from '../ledger/needService';
import { DEFAULT_RISK_WINDOW_MS } from '../ledger/projection';
import { meetsVerificationPolicy } from '../ledger/stateMachine';
import { InMemoryEventStore } from '../ledger/store/memoryStore';
import type { NeedType, Severity } from '../ledger/types';
import { type Actor, type NeedState, type ProjectedNeed, TERMINAL_STATES } from '../ledger/types';
import { InMemoryContactVault } from '../lib/vault';
import { MockLlm } from '../llm/mock';
import { buildSitrepRequest } from '../llm/prompts/p5-sitrep';
import { matchRationale } from '../match/rationale';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import { loadLocalityCoords, loadSeedVolunteers } from '../match/seedData';
import { InMemoryVolunteerStore } from '../match/volunteerStore';
import { agentVolunteerId, createPledgeTool } from '../mcp-server/pledge';
import { createRelayTools, type NeedReadPort } from '../mcp-server/tools';
import { computeSitrepStats } from '../narrate/aggregate';
import { assertNoPii } from '../narrate/redaction';
import { generateReport } from '../narrate/report';
import { generateSitrep } from '../narrate/sitrep';
import { buildTokenMap, narrateWithIntegrity, validateNumbers } from '../narrate/statTokens';
import { HeuristicExtractor } from '../pipeline/extract';
import { makeIntakeJobHandler } from '../pipeline/intakeJob';
import { InlineQueue } from '../pipeline/queue';
import { appHomeView } from '../surfaces/appHome';
import { buildAuditTrail, buildReportAuditPanel, decodeFigureAudit } from '../surfaces/auditTrail';
import { buildMatchBlocks, type MatchNeed, type RankedCandidate } from '../surfaces/matchCard';
import { dispatchCard } from '../surfaces/needCard';
import { selectExtractor, setDegrade } from './degradeMode';
import { runFloodInjector, SIMULATOR_MARK } from './injector';
import { HERO_BEATS, type LiveHeroDemoDeps, runLiveHeroDemo } from './liveOrchestrator';
import { InMemoryDemoResetStore, resetDemo } from './reset';

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
export function buildHermeticAssembly(opts: { baseClockMs?: number; degradeAware?: boolean } = {}): HermeticAssembly {
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
  // degradeAware: omit the pinned extractor so the intake worker chooses it PER JOB via
  // selectExtractor (honouring the /relay demo degrade toggle). With no llm hermetically, that is
  // the SAME HeuristicExtractor either way — the honest hermetic truth, no faked AI/degraded gap.
  const queue = new InlineQueue(
    makeIntakeJobHandler({
      service,
      notifier,
      ...(opts.degradeAware ? {} : { extractor }),
      vault,
      store,
      now,
      isDemo: true,
    }),
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

/** The pre-claim "open work queue" states, recounted here INDEPENDENTLY of computeSitrepStats
 * so the sitrep assertion is a genuine cross-check, not a tautology. */
const OPEN_STATE_SET: ReadonlySet<NeedState> = new Set<NeedState>([
  'NEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'REOPENED',
]);

/** A reference "now" comfortably after every event, so drift flags + "today" are stable. */
function referenceNow(needs: ProjectedNeed[]): number {
  return Math.max(BASE_CLOCK_MS, ...needs.map((n) => Date.parse(n.updated_at))) + 60_000;
}

/**
 * Evaluate the sitrep expectation (§F6): generateSitrep over the live hermetic ledger, then
 * ASSERT its headline figures equal an INDEPENDENT recount of listNeeds (numbers-match-ledger),
 * and that the (deterministic, no-LLM) narrative contains no stray number. Reads the ledger
 * truth — never fabricates a pass.
 */
export async function evaluateSitrep(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'stats_match_ledger');
  if (exp === undefined) return results;

  const now = referenceNow(await a.service.listNeeds());
  const needs = await a.service.listNeeds(now);

  // Independent recount straight off the projection (NOT via computeSitrepStats).
  const recount = {
    totalActive: needs.filter((n) => !TERMINAL_STATES.has(n.state)).length,
    open: needs.filter((n) => OPEN_STATE_SET.has(n.state)).length,
    verified: needs.filter((n) => n.state === 'VERIFIED').length,
    closed: needs.filter((n) => n.state === 'CLOSED').length,
    needsReview: needs.filter((n) => n.state === 'NEEDS_REVIEW').length,
  };

  const sitrep = await generateSitrep({ service: a.service, now }); // no llm → deterministic template
  const s = sitrep.stats;
  const mismatches: string[] = [];
  const check = (name: string, got: number, want: number): void => {
    if (got !== want) mismatches.push(`${name}: sitrep=${got} ledger=${want}`);
  };
  check('total_active', s.totalActive, recount.totalActive);
  check('open', s.open, recount.open);
  check('verified', s.verified, recount.verified);
  check('closed', s.closed, recount.closed);
  check('needs_review', s.needsReview, recount.needsReview);

  // The narrative must contain ONLY ledger numbers (the {{stat:*}} allowlist).
  const strays = validateNumbers(sitrep.text, buildTokenMap(s.stats).allowedNumbers);
  if (!strays.ok) mismatches.push(`narrative stray number(s): ${strays.strays.join(', ')}`);

  const pass = mismatches.length === 0;
  results.push({
    capability: 'sitrep',
    assert: 'stats_match_ledger',
    pass,
    detail: pass
      ? `sitrep headline figures equal an independent recount of listNeeds (active=${recount.totalActive}, open=${recount.open}, verified=${recount.verified}, closed=${recount.closed}, review=${recount.needsReview}); narrative has no stray number`
      : mismatches.join('; '),
  });
  return results;
}

/**
 * Evaluate the report guarantees (§F7):
 *   · integrity_guard — a MockLlm that ALWAYS emits a hallucinated figure is rejected by
 *     narrateWithIntegrity and the output falls back to the deterministic template with NO
 *     stray number: a fabricated figure can never reach a sitrep/report.
 *   · no_pii — generateReport over the seeded ledger produces PII-clean Markdown (assertNoPii
 *     ok) that contains none of the seed phone-number digit strings.
 * Both read real outputs — nothing is faked.
 */
export async function evaluateReport(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const integrityExp = scenario.expectations.find((e) => e.assert === 'integrity_guard');
  const noPiiExp = scenario.expectations.find((e) => e.assert === 'no_pii');
  const now = referenceNow(await a.service.listNeeds());

  if (integrityExp !== undefined) {
    const stats = computeSitrepStats(await a.service.listNeeds(now), now).stats;
    // A figure that is NOT on the board (the demo tops out around a dozen needs).
    const HALLUCINATION = 90210;
    const strayLlm = new MockLlm(() => ({
      narrative: `A staggering ${HALLUCINATION} people were reached {{stat:total_active}} active on the board.`,
    }));
    const out = await narrateWithIntegrity({
      stats,
      kind: 'sitrep',
      llm: strayLlm,
      buildRequest: buildSitrepRequest,
    });
    const fellBack = out.source === 'template';
    const noStray = !out.text.includes(String(HALLUCINATION));
    const pass = fellBack && noStray && out.attempts >= 1;
    results.push({
      capability: 'report',
      assert: 'integrity_guard',
      pass,
      detail: pass
        ? `hallucinated ${HALLUCINATION} rejected across ${out.attempts} attempt(s) → template fallback; fabricated figure never reached the output`
        : `source=${out.source}, attempts=${out.attempts}, containsHallucination=${!noStray}`,
    });
  }

  if (noPiiExp !== undefined) {
    const resolvePublicId = async (id: string): Promise<string> => (await a.store.getPublicId(id)) ?? id;
    const report = await generateReport({ service: a.service, period: { label: 'all time' }, now, resolvePublicId });
    const gate = assertNoPii(report.markdown);
    // Independent grep: none of the seed phone digit strings survive into the Markdown.
    const seedContacts = scenario.steps
      .filter((step): step is IntakeMessageStep => step.kind === 'intake_message' && step.contact !== undefined)
      .map((step) => (step.contact ?? '').replace(/\D+/g, ''))
      .filter((d) => d.length > 0);
    const mdDigits = report.markdown.replace(/\D+/g, '');
    const leaked = seedContacts.filter((d) => mdDigits.includes(d));
    const pass = gate.ok && leaked.length === 0;
    results.push({
      capability: 'report',
      assert: 'no_pii',
      pass,
      detail: pass
        ? `report Markdown is PII-clean (assertNoPii ok) and contains none of the ${seedContacts.length} seed phone number(s)`
        : `assertNoPii.ok=${gate.ok} (${gate.hits.length} hit(s)); leaked ${leaked.length} seed number(s)`,
    });
  }
  return results;
}

/** Digits of every seed beneficiary contact in the scenario, so an assistant/MCP answer can be
 * grepped for a leak independently of assertNoPii (defense in depth). */
function seedContactDigits(scenario: Scenario): string[] {
  return scenario.steps
    .filter((s): s is IntakeMessageStep => s.kind === 'intake_message' && s.contact !== undefined)
    .map((s) => (s.contact ?? '').replace(/\D+/g, ''))
    .filter((d) => d.length > 0);
}

/**
 * Evaluate the F8 judge tooling (P1 flourish surfaces), proven WITHOUT Slack:
 *   · injector_posts_as_simulator — runFloodInjector plays every intake message through a
 *     recorder and each post carries the 🧪 simulator mark (CLAUDE.md 10). No real waiting
 *     (sleep is stubbed); the count must equal the scenario's intake-message count.
 *   · reset_idempotent — resetDemo over an in-memory purge store clears the board on run 1
 *     (noop=false) and is a safe no-op on run 2 (noop=true), republishing App Home both times.
 * Ledger-independent: it exercises the same seams the live judge buttons wire (src/ingest).
 */
export async function evaluateJudge(scenario: Scenario, _a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];

  const injectorExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'injector_posts_as_simulator' }> =>
      e.assert === 'injector_posts_as_simulator',
  );
  if (injectorExp !== undefined) {
    const posts: string[] = [];
    const summary = await runFloodInjector({
      scenario,
      postMessage: async (_text, opts) => {
        posts.push(opts.personaName);
      },
      now: () => 0,
      sleep: async () => {},
    });
    const allMarked = posts.length > 0 && posts.every((p) => p.startsWith(`${SIMULATOR_MARK} `));
    const pass = summary.posted === injectorExp.params.count && posts.length === injectorExp.params.count && allMarked;
    results.push({
      capability: 'judge',
      assert: 'injector_posts_as_simulator',
      pass,
      detail: pass
        ? `injector posted ${summary.posted} intake message(s), every one under the 🧪 simulator identity`
        : `posted=${summary.posted}/${injectorExp.params.count}, recorded=${posts.length}, allMarked=${allMarked}`,
    });
  }

  const resetExp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'reset_idempotent' }> => e.assert === 'reset_idempotent',
  );
  if (resetExp !== undefined) {
    const store = new InMemoryDemoResetStore({ needs: 14, events: 42, obligations: 2, evidence: 4, sitreps: 1 });
    let homes = 0;
    const republishHome = async (): Promise<void> => {
      homes += 1;
    };
    const first = await resetDemo({ store, purgeIsDemo: true, republishHome });
    const second = await resetDemo({ store, purgeIsDemo: true, republishHome });
    const pass = first.noop === false && second.noop === true && homes === 2 && first.durationMs < 30_000;
    results.push({
      capability: 'judge',
      assert: 'reset_idempotent',
      pass,
      detail: pass
        ? `reset purged ${first.purged.needs} need(s) on run 1 then no-oped on run 2; App Home republished both runs (<30s)`
        : `firstNoop=${first.noop}, secondNoop=${second.noop}, homes=${homes}`,
    });
  }

  return results;
}

/**
 * Evaluate Ask-Relay (the Slack-AI qualifying technology) against the post-hero ledger, no LLM
 * (the deterministic template path is the hermetic one):
 *   · answers_open_criticals — intent classifies as open-criticals, the answer names the open
 *     critical needs, states the count that an INDEPENDENT recount of listNeeds produces, and is
 *     PII-free (assertNoPii + no seed contact digits).
 *   · refuses_out_of_scope — a non-relief question is refused: out-of-scope intent, no citations,
 *     the polite refusal text. Reads real askRelay output — nothing is faked.
 */
export async function evaluateAssistant(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const now = referenceNow(await a.service.listNeeds());
  const seedDigits = seedContactDigits(scenario);
  const leaks = (text: string): string[] => seedDigits.filter((d) => text.replace(/\D+/g, '').includes(d));

  const openCritExp = scenario.expectations.find((e) => e.assert === 'answers_open_criticals');
  if (openCritExp !== undefined) {
    // Independent recount: critical needs not in a terminal state (askRelay's open-critical set).
    const active = (await a.service.listNeeds(now)).filter((n) => !TERMINAL_STATES.has(n.state));
    const openCriticals = active.filter((n) => n.severity === 'critical');
    const res = await askRelay({ question: 'any critical needs still open?', service: a.service, now });
    const answerLeaks = leaks(res.answer);
    const pass =
      res.intent === 'open-criticals' &&
      res.source === 'template' &&
      res.usedRts === false &&
      openCriticals.length > 0 &&
      res.answer.includes(String(openCriticals.length)) &&
      assertNoPii(res.answer).ok &&
      answerLeaks.length === 0;
    results.push({
      capability: 'assistant',
      assert: 'answers_open_criticals',
      pass,
      detail: pass
        ? `Ask-Relay named the ${openCriticals.length} open critical need(s), grounded in the ledger, PII-free`
        : `intent=${res.intent}, source=${res.source}, openCriticals=${openCriticals.length}, containsCount=${res.answer.includes(String(openCriticals.length))}, pii=${!assertNoPii(res.answer).ok}, leaks=${answerLeaks.length}`,
    });
  }

  const refuseExp = scenario.expectations.find((e) => e.assert === 'refuses_out_of_scope');
  if (refuseExp !== undefined) {
    const res = await askRelay({ question: 'write me a short poem about the sunset', service: a.service, now });
    const pass =
      res.intent === 'out-of-scope' &&
      res.citations.length === 0 &&
      res.answer.includes('relief operations') &&
      assertNoPii(res.answer).ok;
    results.push({
      capability: 'assistant',
      assert: 'refuses_out_of_scope',
      pass,
      detail: pass
        ? 'out-of-scope question refused (no citations, polite refusal)'
        : `intent=${res.intent}, citations=${res.citations.length}, answer="${res.answer.slice(0, 60)}"`,
    });
  }

  return results;
}

/**
 * Evaluate the read-only MCP server (the MCP qualifying technology): search_needs with
 * only_open + severity=critical must equal an INDEPENDENT recount off listNeeds (same
 * open-state set + critical filter), return the same public ids, and carry no PII field.
 * Drives the SAME createRelayTools the stdio entrypoint registers — nothing is faked.
 */
export async function evaluateMcp(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'search_needs_matches_ledger');
  if (exp === undefined) return results;

  const now = referenceNow(await a.service.listNeeds());
  const service: NeedReadPort = {
    listNeeds: (n) => a.service.listNeeds(n),
    getPublicId: (id) => a.store.getPublicId(id),
  };
  const tools = createRelayTools({ service, now: () => now });

  // Independent recount straight off the projection: critical needs still in an OPEN_STATE_SET.
  const recount: string[] = [];
  for (const need of await a.service.listNeeds(now)) {
    if (need.severity === 'critical' && OPEN_STATE_SET.has(need.state)) {
      recount.push((await a.store.getPublicId(need.need_id)) ?? need.need_id);
    }
  }

  const result = await tools.search_needs({ only_open: true, severity: 'critical' });
  const body = JSON.parse(result.content[0]?.text ?? 'null') as {
    count: number;
    needs: Array<Record<string, unknown>>;
  };
  const toolIds = body.needs.map((n) => String(n.public_id)).sort();
  const wantIds = [...recount].sort();
  const noPiiKeys = body.needs.every((n) =>
    Object.keys(n).every((k) => !/contact|phone|mobile|address|email|name/i.test(k)),
  );
  const idsMatch = toolIds.length === wantIds.length && toolIds.every((id, i) => id === wantIds[i]);
  const pass = body.count === recount.length && idsMatch && noPiiKeys;
  results.push({
    capability: 'mcp',
    assert: 'search_needs_matches_ledger',
    pass,
    detail: pass
      ? `search_needs(only_open, critical) returned ${body.count} need(s) == an independent ledger recount [${toolIds.join(', ')}], PII-free`
      : `tool=[${toolIds.join(', ')}] (${body.count}) vs ledger=[${wantIds.join(', ')}] (${recount.length}), piiFree=${noPiiKeys}`,
  });
  return results;
}

/**
 * Evaluate the LIVE self-serve hero (§F5) — the live analog of evidence/hero_e2e. On a FRESH,
 * isolated assembly (so it never disturbs the shared driver ledger), it plays the flood then runs
 * runLiveHeroDemo with stub side effects + a virtual clock: recording narrate/nudges, a pickTarget
 * over listNeeds, the REAL runDriftSweep behind recording callbacks, and a no-op sleep. It proves
 * the SAME orchestrator the live "Run flood demo" button fires drives the picked critical/high need
 * all the way to CLOSED — reassigned to a SECOND volunteer, with a complete evidence packet, an
 * at-risk nudge from the real sweep, and every human-gated step carrying the demo coordinator. It
 * then renders the App Home board over that post-hero ledger and asserts every §F2 section is present.
 * Reads the ledger / the rendered view back — never fabricates a pass.
 */
export async function evaluateLiveHero(scenario: Scenario): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const heroExp = scenario.expectations.find((e) => e.assert === 'hero_live_e2e');
  const homeExp = scenario.expectations.find((e) => e.assert === 'app_home_board');
  if (heroExp === undefined && homeExp === undefined) return results;

  // A fresh assembly + the flood, so the orchestrator drives the REAL pipeline deterministically.
  const a = buildHermeticAssembly();
  await runScenario(scenario, a);

  const needs0 = await a.service.listNeeds();
  const base = Math.max(BASE_CLOCK_MS, ...needs0.map((n) => Date.parse(n.created_at))) + 60_000;
  const resolvePublicId = async (id: string): Promise<string> => (await a.store.getPublicId(id)) ?? id;
  const { notifyNudge, proposeReassign } = buildDriftCallbacks({
    service: a.service,
    notifier: a.notifier,
    volunteerStore: a.volunteerStore,
    localities: a.localities,
    resolvePublicId,
  });

  const nudges: Array<{ id: string; kind: string }> = [];
  let selected: string | null = null;
  const demoActor: Actor = { type: 'human', id: 'DEMO_COORDINATOR' };
  const deps: LiveHeroDemoDeps = {
    scenario,
    service: a.service,
    volunteerStore: a.volunteerStore,
    localities: a.localities,
    postIntake: async () => {}, // the flood is already injected above (this is the driver, not live Slack)
    driftSweep: async (now) => {
      await runDriftSweep({
        service: a.service,
        listNeeds: (n) => a.service.listNeeds(n),
        notifyNudge: async (need, kind) => {
          nudges.push({ id: need.need_id, kind });
          await notifyNudge(need, kind);
        },
        proposeReassign,
        now,
      });
    },
    narrate: async () => {},
    pickTarget: async (pred) => {
      const found = (await a.service.listNeeds(base)).find(pred) ?? null;
      if (found !== null && selected === null) selected = found.need_id;
      return found;
    },
    resolvePublicId,
    now: () => base,
    sleep: async () => {},
    demoActor,
  };

  const { beats } = await runLiveHeroDemo(deps);

  if (heroExp !== undefined) {
    const targetId = selected;
    const finalNow = base + 10_000_000;
    const target = targetId === null ? null : await a.service.getNeed(targetId, finalNow);
    const events = targetId === null ? [] : await a.service.getEvents(targetId);
    const assignVols = events.flatMap((e) => (isEvent(e, 'Assigned') ? [e.payload.volunteer_id] : []));
    const kinds = new Set((target?.evidence ?? []).map((e) => e.kind));
    const packetComplete = (['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff'] as const).every(
      (k) => kinds.has(k),
    );
    const reassignedToSecond =
      assignVols.length === 2 && assignVols[1] !== assignVols[0] && target?.assigned_volunteer_id === assignVols[1];
    const gateViolations = events.filter((e) => HUMAN_GATED_TYPES.has(e.type) && e.actor.type !== 'human');
    const atRiskNudged = targetId !== null && nudges.some((n) => n.id === targetId && n.kind === 'at_risk');
    const beatsOk =
      beats[0] === HERO_BEATS.intake && beats.includes(HERO_BEATS.reassign) && beats.includes(HERO_BEATS.deliver);
    const pass =
      target?.state === 'CLOSED' &&
      packetComplete &&
      reassignedToSecond &&
      atRiskNudged &&
      gateViolations.length === 0 &&
      beatsOk;
    results.push({
      capability: 'live_hero',
      assert: 'hero_live_e2e',
      pass,
      detail: pass
        ? `runLiveHeroDemo drove ${await resolvePublicId(targetId ?? '')} to CLOSED, reassigned ${assignVols[0]}→${assignVols[1]}, complete packet, at-risk nudge fired, all human-gated steps signed by ${demoActor.id}`
        : `state=${target?.state ?? 'missing'}, packet=${packetComplete}, reassignedToSecond=${reassignedToSecond}, atRiskNudged=${atRiskNudged}, gateViolations=${gateViolations.map((e) => e.type).join(',') || 'none'}, beats=${beats.join(' ')}`,
    });
  }

  if (homeExp !== undefined) {
    const needs = await a.service.listNeeds(base);
    const dump = JSON.stringify(appHomeView(needs, { now: base, slaMultiplier: scenario.sla_multiplier }));
    const checks: Array<[string, boolean]> = [
      ['attention list', dump.includes('Needs your attention')],
      ['drift panel', dump.includes('Drifting obligations')],
      ['filters', dump.includes('Filter the board')],
      ['verification policy', dump.includes('Verification policy')],
      ['SLA table', dump.includes('SLA clock')],
    ];
    const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
    const pass = missing.length === 0;
    results.push({
      capability: 'live_hero',
      assert: 'app_home_board',
      pass,
      detail: pass
        ? `App Home renders all §F2 sections over the post-hero ledger (attention list, drift panel, filters, config panel)`
        : `missing board section(s): ${missing.join(', ')}`,
    });
  }

  return results;
}

/**
 * Evaluate Moonshot #1 — "Unplug the AI" (honest degradation). Drives the flood twice through the
 * REAL intake pipeline on fresh degrade-aware assemblies — once AI-online, once with the degrade
 * toggle ON — and proves the degradation is HONEST, never faked:
 *   · no message is lost either way (every intake still creates a need + a dispatch card),
 *   · the degraded run routes AT LEAST as many needs to NEEDS_REVIEW as AI-online (never fewer),
 *   · at the seam, an LLM present is IGNORED when degraded (HeuristicExtractor) yet used when
 *     online (LlmExtractor) — the toggle genuinely swaps the extractor class.
 * Hermetically there is no real LLM, so AI-online and degraded both run the heuristic and the
 * NEEDS_REVIEW counts are EQUAL — the honest hermetic truth (the strict gap only appears live with
 * a real model; equalising is never faked into a gap). The toggle is reset to online on return.
 */
export async function evaluateDegrade(scenario: Scenario): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'honest_degradation');
  if (exp === undefined) return results;

  const intakeCount = scenario.steps.filter((s) => s.kind === 'intake_message').length;

  const runOnce = async (degraded: boolean): Promise<{ created: number; cards: number; review: number }> => {
    setDegrade(degraded);
    try {
      const a = buildHermeticAssembly({ degradeAware: true });
      await runScenario(scenario, a);
      const needs = await a.service.listNeeds();
      return {
        created: needs.length,
        cards: a.notifier.cards.length,
        review: needs.filter((n) => n.state === 'NEEDS_REVIEW').length,
      };
    } finally {
      setDegrade(false);
    }
  };

  const ai = await runOnce(false);
  const degraded = await runOnce(true);

  // Seam proof: with an LLM present, degraded IGNORES it (heuristic) while online uses it (llm:*).
  const probe = new MockLlm(() => ({}));
  const forcesHeuristicWhenDegraded = selectExtractor({ llm: probe, degraded: true }).name === 'heuristic';
  const usesLlmWhenOnline = selectExtractor({ llm: probe, degraded: false }).name.startsWith('llm:');

  const noLoss =
    ai.created === intakeCount &&
    ai.cards === intakeCount &&
    degraded.created === intakeCount &&
    degraded.cards === intakeCount;
  const honest = degraded.review >= ai.review;
  const pass = noLoss && honest && forcesHeuristicWhenDegraded && usesLlmWhenOnline;
  results.push({
    capability: 'degrade',
    assert: 'honest_degradation',
    pass,
    detail: pass
      ? `AI-online and degraded both created all ${intakeCount} needs (no message lost); degraded routed ${degraded.review} to NEEDS_REVIEW (≥ AI-online ${ai.review}); the seam ignores a present LLM when degraded (heuristic) and uses it when online (llm:*)`
      : `noLoss=${noLoss} (ai ${ai.created}/${ai.cards}, degraded ${degraded.created}/${degraded.cards} of ${intakeCount}), reviewDegraded=${degraded.review} reviewAi=${ai.review}, forcesHeuristic=${forcesHeuristicWhenDegraded}, usesLlm=${usesLlmWhenOnline}`,
  });
  return results;
}

/** Any character in the Tamil Unicode block (U+0B80–U+0BFF). */
const TAMIL_BLOCK = /[஀-௿]/;

/**
 * Evaluate Moonshot #4 — the requester loop. On the live hermetic ledger, drives the SAME
 * postRequesterReply seam the Slack handlers use for a ta (Tamil code-mix) need and proves the
 * reply is threaded back into the requester's OWN source message, bilingual and PII-safe:
 *   · posted into need.source.channel under need.source.ts (thread_ts) — the original message,
 *   · contains Tamil script AND English, carries the public id, and has no phone-length digit run,
 *   · uses the assigned volunteer's real display name (first token only, via the pure builder).
 * Reads the recorded notification back — never fabricated.
 */
export async function evaluateRequester(
  scenario: Scenario,
  a: HermeticAssembly,
  run: ScenarioRunResult,
): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'bilingual_reply_in_source_thread' }> =>
      e.assert === 'bilingual_reply_in_source_thread',
  );
  if (exp === undefined) return results;

  const fail = (detail: string): void => {
    results.push({ capability: 'requester_loop', assert: 'bilingual_reply_in_source_thread', pass: false, detail });
  };

  const need = mapNeedsByStep(await a.service.listNeeds(), run).get(exp.params.need_ref);
  if (need === undefined) {
    fail(`need ${exp.params.need_ref} not found`);
    return results;
  }
  if (!need.languages.some((l) => l.trim().toLowerCase() === 'ta')) {
    fail(`need ${exp.params.need_ref} is not a Tamil need (languages=${need.languages.join('+')})`);
    return results;
  }
  const publicId = (await a.store.getPublicId(need.need_id)) ?? need.need_id;
  const vol = need.assigned_volunteer_id ? await a.volunteerStore.getBySlackUser(need.assigned_volunteer_id) : null;

  const before = a.notifier.channelPosts.length;
  const posted = await postRequesterReply({
    notifier: a.notifier,
    need,
    kind: 'assigned',
    volunteerName: vol?.display_name,
    publicId,
  });
  const post = a.notifier.channelPosts[a.notifier.channelPosts.length - 1];
  if (!posted || post === undefined || a.notifier.channelPosts.length !== before + 1) {
    fail(`postRequesterReply did not record exactly one threaded reply (posted=${posted})`);
    return results;
  }

  const threaded = post.channel === need.source.channel && post.threadTs === need.source.ts;
  const bilingual = TAMIL_BLOCK.test(post.text) && /[A-Za-z]/.test(post.text);
  const carriesId = post.text.includes(publicId);
  const noPhone = !/\d{7,}/.test(post.text);
  const pass = threaded && bilingual && carriesId && noPhone;
  results.push({
    capability: 'requester_loop',
    assert: 'bilingual_reply_in_source_thread',
    pass,
    detail: pass
      ? `bilingual 'assigned' reply for ${publicId} threaded into the requester's source message (channel ${need.source.channel}, thread ${need.source.ts}); Tamil + English, public id only, no phone digits`
      : `posted=${posted}, threaded=${threaded}, bilingual=${bilingual}, carriesId=${carriesId}, noPhone=${noPhone}`,
  });
  return results;
}

/**
 * Evaluate Moonshot #5 — "same engine, different disaster, nothing recompiled". Proves the second
 * scenario's `sla:` OVERRIDE (config, not code) drives a genuinely different drift regime through
 * the UNCHANGED engine:
 *   · the pipeline created the scenario's needs (the same intake→triage path ran) and a real need
 *     of an overridden type exists (the override applies to actual traffic, not just to a table),
 *   · for every overridden (type, severity): the merged budget equals the scenario value, DIFFERS
 *     from DEFAULT_SLA_TABLE, and the SAME computeSlaDueAtMs yields a genuinely different (earlier)
 *     deadline — the honest proof it is data, not a fork,
 *   · a cell the scenario did NOT override is byte-identical to the default (same engine defaults).
 * A scenario with no `sla:` block (flood-1) has no such expectation, so this is a no-op there.
 */
export async function evaluateSecondScenario(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'sla_table_config_drives_drift');
  if (exp === undefined) return results;

  const fail = (detail: string): void => {
    results.push({ capability: 'second_scenario', assert: 'sla_table_config_drives_drift', pass: false, detail });
  };

  const overrides = scenario.sla;
  if (overrides === undefined || Object.keys(overrides).length === 0) {
    fail('scenario carries no `sla:` override block — nothing to prove it is config-driven');
    return results;
  }
  const needs = await a.service.listNeeds();
  const merged = mergeSlaTable(overrides);
  const assignedAt = BASE_CLOCK_MS;
  const m = scenario.sla_multiplier;

  const proofs: string[] = [];
  const misses: string[] = [];
  const overriddenTypes = new Set<NeedType>();
  for (const [typeKey, row] of Object.entries(overrides)) {
    const type = typeKey as NeedType;
    overriddenTypes.add(type);
    for (const [sevKey, mins] of Object.entries(row ?? {})) {
      const sev = sevKey as Severity;
      const def = DEFAULT_SLA_TABLE[type][sev];
      const mergedMin = merged[type][sev];
      const dueDefault = computeSlaDueAtMs(type, sev, assignedAt, m, DEFAULT_SLA_TABLE);
      const dueMerged = computeSlaDueAtMs(type, sev, assignedAt, m, merged);
      if (mergedMin === mins && mins !== def && dueMerged !== dueDefault) {
        proofs.push(
          `${type}/${sev} ${def}→${mergedMin}m (deadline ${Math.round((dueDefault - dueMerged) / 1000)}s earlier)`,
        );
      } else {
        misses.push(
          `${type}/${sev}: merged=${mergedMin} scenario=${mins} default=${def} dueΔ=${dueDefault - dueMerged}`,
        );
      }
    }
  }

  // A cell the scenario did NOT override must equal the default (same engine defaults untouched).
  const untouchedOk =
    merged.shelter.critical === DEFAULT_SLA_TABLE.shelter.critical && merged.food.low === DEFAULT_SLA_TABLE.food.low;
  // The override must apply to REAL traffic: a need of an overridden type exists in the ledger.
  const overriddenNeedExists = needs.some((n) => overriddenTypes.has(n.type));
  const pass = needs.length > 0 && misses.length === 0 && proofs.length > 0 && untouchedOk && overriddenNeedExists;
  results.push({
    capability: 'second_scenario',
    assert: 'sla_table_config_drives_drift',
    pass,
    detail: pass
      ? `${needs.length} needs on the same engine; the scenario SLA override drives distinct deadlines [${proofs.join('; ')}] via the unchanged computeSlaDueAtMs, with defaults intact elsewhere`
      : `needs=${needs.length}, proofs=${proofs.length}, misses=[${misses.join(', ')}], untouchedOk=${untouchedOk}, overriddenNeedExists=${overriddenNeedExists}`,
  });
  return results;
}

/**
 * Evaluate Moonshot #2 — "Relay holds AI agents accountable too." On a FRESH, isolated assembly it
 * plays the flood, confirms triage on the pledge need (human → OPEN), then files an agent pledge
 * through the REAL pledge_support logic (createPledgeTool) and proves the whole accountability chain
 * from the ledger — never fabricated:
 *   1. the pledge lands as an AGENT-actor PledgeProposed and the need is NOT auto-claimed (still
 *      MATCH_SUGGESTED, no volunteer); an is_agent volunteer is registered for the pledging org,
 *   2. the agent CANNOT self-assign past the gate — an agent-actor Assigned is REJECTED (HUMAN_GATE),
 *   3. a human Assigned commits it to the agent volunteer → CLAIMED with a stamped SLA,
 *   4. the obligation then DRIFTS on the identical projection flags a human promise uses (on time
 *      before due, drifting past due), and
 *   5. closes only on a complete EVIDENCE packet — a premature Verified is rejected
 *      (INSUFFICIENT_EVIDENCE), then photo+locality+recipient+sign-off → Verified → Closed, every
 *      human-gated step carrying a human actor. One path, no shortcut for the agent.
 */
export async function evaluateAgentPledge(scenario: Scenario): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'pledge_requires_human_confirm' }> =>
      e.assert === 'pledge_requires_human_confirm',
  );
  if (exp === undefined) return results;

  const fail = (detail: string): void => {
    results.push({ capability: 'agent_pledge', assert: 'pledge_requires_human_confirm', pass: false, detail });
  };

  const a = buildHermeticAssembly();
  const run = await runScenario(scenario, a);
  const seed = mapNeedsByStep(await a.service.listNeeds(), run).get(exp.params.need_ref);
  if (seed === undefined) {
    fail(`pledge need ${exp.params.need_ref} not found`);
    return results;
  }
  const needId = seed.need_id;
  const coordinator = 'demo-coordinator';
  const now = referenceNow(await a.service.listNeeds());

  // Confirm triage (human) → OPEN so the need is pledgeable (mirrors the coordinator's Confirm click).
  if (seed.state === 'TRIAGED' || seed.state === 'NEEDS_REVIEW') {
    await a.service.dispatch(
      needId,
      { type: 'TriageConfirmed', payload: {} },
      {
        actor: { type: 'human', id: coordinator },
        at: new Date(now).toISOString(),
        idempotencyKey: needEventKey(needId, 'TriageConfirmed', 'pledge'),
        now,
      },
    );
  }
  const publicId = (await a.store.getPublicId(needId)) ?? needId;

  // File the pledge through the REAL pledge_support logic (agent actor), with writes enabled.
  const pledger = 'Chennai Food Bank agent';
  const volId = agentVolunteerId(pledger);
  const pledge = createPledgeTool({
    listNeeds: (n) => a.service.listNeeds(n),
    getPublicId: (id) => a.store.getPublicId(id),
    dispatch: (id, command, ctx) => a.service.dispatch(id, command, ctx),
    volunteers: a.volunteerStore,
    enabled: true,
    now: () => now,
    isDemo: true,
  });
  const toolRes = await pledge({ need_public_id: publicId, pledged_by: pledger, note: 'can deliver 200 meals by 6pm' });
  const toolBody = JSON.parse(toolRes.content[0]?.text ?? 'null') as { status?: string };

  // (1) Agent-actor PROPOSAL, not auto-claimed; an is_agent volunteer registered for the pledger.
  const afterPledge = await a.service.getNeed(needId, now);
  const pledgeEvent = (await a.service.getEvents(needId)).find((e) => isEvent(e, 'PledgeProposed'));
  const proposalIsAgent = pledgeEvent?.actor.type === 'agent';
  const notAutoClaimed = afterPledge?.state === 'MATCH_SUGGESTED' && afterPledge.assigned_volunteer_id === null;
  const agentRegistered = (await a.volunteerStore.getBySlackUser(volId))?.is_agent === true;

  // (2) The agent CANNOT self-assign past the human gate.
  const agentAssign = await a.service.dispatch(
    needId,
    { type: 'Assigned', payload: { volunteer_id: volId, obligation_id: randomUUID() } },
    {
      actor: { type: 'agent', id: volId },
      at: new Date(now).toISOString(),
      idempotencyKey: needEventKey(needId, 'Assigned', 'agent-self'),
    },
  );
  const gateHeld = agentAssign.status === 'rejected' && agentAssign.code === 'HUMAN_GATE';

  // (3) A human confirms → CLAIMED to the agent volunteer, SLA stamped exactly as the live Assign handler.
  const assignedAt = now + 1000;
  const slaIso = slaDueAtIso(seed.type, seed.severity, assignedAt); // full SLA (not compressed) for a genuine on-time/overdue read
  const humanAssign = await a.service.dispatch(
    needId,
    { type: 'Assigned', payload: { volunteer_id: volId, obligation_id: randomUUID(), sla_due_at: slaIso } },
    {
      actor: { type: 'human', id: coordinator },
      at: new Date(assignedAt).toISOString(),
      idempotencyKey: needEventKey(needId, 'Assigned', 'human-confirm'),
      now: assignedAt,
    },
  );
  const committed = humanAssign.status === 'applied';
  await a.volunteerStore.incrementLoad(volId, 1);

  // (4) It drifts on the SAME projection flags a human promise uses (on time before due, drifting after).
  const dueMs = Date.parse(slaIso);
  const onTime = await a.service.getNeed(needId, dueMs - 60_000);
  const overdue = await a.service.getNeed(needId, dueMs + 60_000);
  const driftsLikeHuman =
    onTime?.flags.is_drifting === false &&
    overdue?.state === 'CLAIMED' &&
    overdue?.assigned_volunteer_id === volId &&
    overdue?.flags.is_drifting === true;

  // (5) Closes only on a complete EVIDENCE packet — the identical gate a human obligation faces.
  let clock = dueMs + 120_000;
  const at = (): string => {
    const v = new Date(clock).toISOString();
    clock += 1000;
    return v;
  };
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'F_PLEDGE', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: volId },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'photo'),
    },
  );
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: volId },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'locality'),
    },
  );
  // Premature Verified (human) → rejected for insufficient evidence, exactly as for a human obligation.
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
  await a.service.dispatch(
    needId,
    { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } },
    {
      actor: { type: 'agent', id: 'demo-recipient' },
      at: at(),
      idempotencyKey: needEventKey(needId, 'RecipientConfirmed', 'pledge'),
    },
  );
  await a.service.dispatch(
    needId,
    { type: 'EvidenceAttached', payload: { kind: 'recipient_confirm', meta: { via: 'demo' } } },
    {
      actor: { type: 'agent', id: 'demo-recipient' },
      at: at(),
      idempotencyKey: needEventKey(needId, 'EvidenceAttached', 'recipient'),
    },
  );
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
      idempotencyKey: needEventKey(needId, 'CoordinatorSignedOff', 'pledge'),
    },
  );
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

  const finalNeed = await a.service.getNeed(needId);
  const events = await a.service.getEvents(needId);
  const gateViolations = events.filter((e) => HUMAN_GATED_TYPES.has(e.type) && e.actor.type !== 'human');
  const closedOnEvidence =
    verified.status === 'applied' && closed.status === 'applied' && finalNeed?.state === 'CLOSED';
  const humanGatedCount = events.filter((e) => HUMAN_GATED_TYPES.has(e.type)).length;

  const pass =
    toolBody.status === 'pledge_filed' &&
    proposalIsAgent &&
    notAutoClaimed &&
    agentRegistered &&
    gateHeld &&
    committed &&
    driftsLikeHuman &&
    rejectedEarly &&
    closedOnEvidence &&
    gateViolations.length === 0;
  results.push({
    capability: 'agent_pledge',
    assert: 'pledge_requires_human_confirm',
    pass,
    detail: pass
      ? `agent pledge on ${publicId} filed as an agent PROPOSAL (not auto-claimed); agent self-assign rejected at the human gate; a human Assign committed it to the agent volunteer, which then drifted past SLA and closed only on a complete evidence packet — exactly like a human promise (premature Verified rejected; all ${humanGatedCount} human-gated steps human-signed)`
      : `toolStatus=${toolBody.status}, proposalIsAgent=${proposalIsAgent}, notAutoClaimed=${notAutoClaimed}, agentRegistered=${agentRegistered}, gateHeld=${gateHeld}, committed=${committed}, drifts=${driftsLikeHuman}, rejectedEarly=${rejectedEarly}, closedOnEvidence=${closedOnEvidence}, gateViolations=${gateViolations.map((e) => e.type).join(',') || 'none'}`,
  });
  return results;
}

/**
 * Evaluate Moonshot #6 — the click-to-audit donor report. Over the post-hero SHARED ledger (the
 * hero need is CLOSED by evaluateEvidence) it generates the real report, takes a headline figure's
 * backing need_ids, and proves — reading real outputs, never faking:
 *   · the 🔍 Audit panel round-trips: a button's encoded value decodes back to that figure's backing
 *     need_ids (so a click resolves the exact needs behind the number),
 *   · the evidence chain (buildAuditTrail over the need's REAL event log) is REDACTED — it shows the
 *     lifecycle (Need created → … → Verified on evidence) with actor ROLES, but leaks NO actor id, NO
 *     evidence file reference, NO free-text note, and is PII-clean (assertNoPii + no seed digits).
 * Requires evaluateEvidence to have run first (a verified need must back a figure).
 */
export async function evaluateAuditableReport(scenario: Scenario, a: HermeticAssembly): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find((e) => e.assert === 'audit_trail_redacted');
  if (exp === undefined) return results;

  const fail = (detail: string): void => {
    results.push({ capability: 'auditable_report', assert: 'audit_trail_redacted', pass: false, detail });
  };

  const now = referenceNow(await a.service.listNeeds());
  const resolvePublicId = async (id: string): Promise<string> => (await a.store.getPublicId(id)) ?? id;
  const report = await generateReport({ service: a.service, period: { label: 'all time' }, now, resolvePublicId });

  const figure = report.stats.stats.find((s) => (s.eventRefs?.length ?? 0) > 0);
  if (figure === undefined || figure.eventRefs === undefined || figure.eventRefs.length === 0) {
    fail('no verified need backs any report figure — the evidence finale must run first');
    return results;
  }

  // (1) The audit panel round-trips: a button decodes back to this figure's backing need_ids.
  const panel = buildReportAuditPanel(report.stats);
  const panelJson = JSON.stringify(panel);
  let decoded: { figureKey: string; needIds: string[] } | null = null;
  for (const block of panel) {
    for (const el of (block as { elements?: Array<{ value?: unknown }> }).elements ?? []) {
      if (typeof el.value === 'string') {
        const d = decodeFigureAudit(el.value);
        if (d.figureKey === figure.key) decoded = d;
      }
    }
  }
  const roundTrips =
    decoded !== null && decoded.needIds.length > 0 && decoded.needIds.every((id) => figure.eventRefs?.includes(id));

  // (2) The redacted evidence chain for the first backing need, from its REAL event log.
  const needId = figure.eventRefs[0] ?? '';
  const events = await a.service.getEvents(needId);
  const publicId = await resolvePublicId(needId);
  const trailJson = JSON.stringify(buildAuditTrail(publicId, events));

  const showsLifecycle =
    trailJson.includes('Need created') && trailJson.includes('Verified on evidence') && trailJson.includes(publicId);
  const showsActorRole = /a human actor|an automated agent|the system/.test(trailJson);
  const leakedActorId = trailJson.includes('demo-coordinator') || trailJson.includes('relay-evidence');
  const leakedEvidenceRef = trailJson.includes('F_DEMO_PHOTO');
  const seedDigits = seedContactDigits(scenario);
  const trailDigits = trailJson.replace(/\D+/g, '');
  const leakedSeed = seedDigits.filter((d) => trailDigits.includes(d));
  const piiClean = assertNoPii(trailJson).ok;

  const redacted =
    showsLifecycle && showsActorRole && !leakedActorId && !leakedEvidenceRef && leakedSeed.length === 0 && piiClean;
  const pass = roundTrips && redacted && panelJson.includes('report_audit');
  results.push({
    capability: 'auditable_report',
    assert: 'audit_trail_redacted',
    pass,
    detail: pass
      ? `every report figure carries a 🔍 Audit control; ${publicId}'s evidence chain shows the lifecycle + actor ROLES only — no actor id, no evidence ref, PII-clean (assertNoPii ok, 0 of ${seedDigits.length} seed number(s))`
      : `roundTrips=${roundTrips}, showsLifecycle=${showsLifecycle}, showsActorRole=${showsActorRole}, leakedActorId=${leakedActorId}, leakedEvidenceRef=${leakedEvidenceRef}, leakedSeed=${leakedSeed.length}, piiClean=${piiClean}`,
  });
  return results;
}

/**
 * Evaluate Moonshot — the pre-warmed backup (a REAL scored candidate, not theater). On a FRESH
 * assembly it plays the flood, confirms + assigns the named need to its top volunteer (→ CLAIMED
 * with a stamped SLA), then proves — reading the scorer + the rendered card back:
 *   · computeBackup returns a GENUINE scored candidate that is NOT the current assignee (same
 *     deterministic scorer, current holder excluded), with a real positive score,
 *   · the dispatch card renders the standby chip WITH that backup and does NOT render it WITHOUT one
 *     (so the chip is driven by a real candidate), and the chip is PII-clean.
 */
export async function evaluatePrewarm(scenario: Scenario): Promise<ExpectationResult[]> {
  const results: ExpectationResult[] = [];
  const exp = scenario.expectations.find(
    (e): e is Extract<Expectation, { assert: 'backup_prewarmed' }> => e.assert === 'backup_prewarmed',
  );
  if (exp === undefined) return results;

  const fail = (detail: string): void => {
    results.push({ capability: 'prewarm_backup', assert: 'backup_prewarmed', pass: false, detail });
  };

  const a = buildHermeticAssembly();
  const run = await runScenario(scenario, a);
  const seed = mapNeedsByStep(await a.service.listNeeds(), run).get(exp.params.need_ref);
  if (seed === undefined) {
    fail(`need ${exp.params.need_ref} not found`);
    return results;
  }
  const needId = seed.need_id;
  const coordinator = 'demo-coordinator';
  const now = referenceNow(await a.service.listNeeds());

  if (seed.state === 'TRIAGED' || seed.state === 'NEEDS_REVIEW') {
    await a.service.dispatch(
      needId,
      { type: 'TriageConfirmed', payload: {} },
      {
        actor: { type: 'human', id: coordinator },
        at: new Date(now).toISOString(),
        idempotencyKey: needEventKey(needId, 'TriageConfirmed', 'prewarm'),
        now,
      },
    );
  }
  const open = (await a.service.getNeed(needId, now)) ?? seed;
  const scoreNeed: ScoreNeed = { type: open.type, localityId: open.locality_id, languages: open.languages };
  const roster = await a.volunteerStore.list();
  const assignee = topN(scoreNeed, roster, a.localities, 1)[0]?.volunteer.slack_user_id;
  if (assignee === undefined) {
    fail('no volunteer to assign — roster empty');
    return results;
  }
  const assignedAt = now + 1000;
  const slaIso = slaDueAtIso(open.type, open.severity, assignedAt, scenario.sla_multiplier);
  const assigned = await a.service.dispatch(
    needId,
    { type: 'Assigned', payload: { volunteer_id: assignee, obligation_id: randomUUID(), sla_due_at: slaIso } },
    {
      actor: { type: 'human', id: coordinator },
      at: new Date(assignedAt).toISOString(),
      idempotencyKey: needEventKey(needId, 'Assigned', 'prewarm'),
      now: assignedAt,
    },
  );
  if (assigned.status !== 'applied') {
    fail(`assign did not apply (${assigned.status})`);
    return results;
  }
  await a.volunteerStore.incrementLoad(assignee, 1);
  const claimed = (await a.service.getNeed(needId, assignedAt)) ?? open;

  // The genuine pre-warmed backup: the #1 alternative with the assignee excluded.
  const backup = computeBackup(
    {
      type: claimed.type,
      localityId: claimed.locality_id,
      languages: claimed.languages,
      assignedVolunteerId: claimed.assigned_volunteer_id,
    },
    await a.volunteerStore.list(),
    a.localities,
  );
  const realCandidate = backup !== null && backup.volunteer.slack_user_id !== assignee && backup.score > 0;

  // Card WITH the backup shows the chip; WITHOUT it, no chip.
  const publicId = (await a.store.getPublicId(needId)) ?? needId;
  const events = await a.service.getEvents(needId);
  const withCard = dispatchCard(publicId, claimed, { events, backup });
  const withoutCard = dispatchCard(publicId, claimed, { events });
  const chipText = (() => {
    for (const b of withCard) {
      for (const el of (b as { elements?: Array<{ text?: unknown }> }).elements ?? []) {
        if (typeof el.text === 'string' && el.text.includes('Backup pre-warmed')) return el.text;
      }
    }
    return '';
  })();
  const backupName = backup ? (backup.volunteer.display_name.trim().split(/\s+/)[0] ?? '') : '';
  const chipShown = chipText.includes('Backup pre-warmed') && backupName.length > 0 && chipText.includes(backupName);
  const chipHiddenWithout = !JSON.stringify(withoutCard).includes('Backup pre-warmed');
  const piiSafe = assertNoPii(chipText).ok && !/\d{7,}/.test(chipText);

  const pass = realCandidate && chipShown && chipHiddenWithout && piiSafe && claimed.state === 'CLAIMED';
  results.push({
    capability: 'prewarm_backup',
    assert: 'backup_prewarmed',
    pass,
    detail: pass
      ? `${publicId} claimed by ${assignee}; pre-warmed backup ${backup?.volunteer.slack_user_id} (match ${Math.round((backup?.score ?? 0) * 100)}%, ≠ assignee) renders on the card and is absent without a backup — a real scored candidate, PII-free`
      : `realCandidate=${realCandidate}, chipShown=${chipShown}, chipHiddenWithout=${chipHiddenWithout}, piiSafe=${piiSafe}, state=${claimed.state}`,
  });
  return results;
}

/** Asserts the driver evaluates today: the walking skeleton, extraction-backed triage,
 * dedupe auto-detection, the deterministic match slate, the drift/reassign hero arc, the
 * evidence/verification finale, the sitrep/report narration guarantees (F6/F7), the F8
 * judge experience + P1 assistant/MCP flourishes, the live self-serve hero (§F5), and the
 * moonshot batch (honest degrade, the requester loop, the config-only second scenario,
 * click-to-audit, and the pre-warmed backup). Everything else is a documented SKIP. */
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
  'stats_match_ledger',
  'integrity_guard',
  'no_pii',
  'injector_posts_as_simulator',
  'reset_idempotent',
  'answers_open_criticals',
  'refuses_out_of_scope',
  'search_needs_matches_ledger',
  'hero_live_e2e',
  'app_home_board',
  'honest_degradation',
  'bilingual_reply_in_source_thread',
  'sla_table_config_drives_drift',
  // Moonshot batch 2 — the agent-pledge accountability chain and the SIMULATED counterfactual.
  'pledge_requires_human_confirm',
  'counterfactual_beats_group_chat',
  // Moonshot batch 3 — the click-to-audit donor report + the pre-warmed backup.
  'audit_trail_redacted',
  'backup_prewarmed',
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
  return 'capability not built yet';
}

/** Every expectation the driver does NOT evaluate yet, each with an honest reason. */
export function skippedExpectations(scenario: Scenario): SkippedExpectation[] {
  return scenario.expectations
    .filter((e) => !EVALUATED_ASSERTS.has(e.assert))
    .map((e) => ({ capability: e.capability, assert: e.assert, reason: skipReason(e) }));
}
