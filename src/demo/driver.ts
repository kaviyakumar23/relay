import { randomBytes } from 'node:crypto';
import type { Expectation, Scenario } from '../../demo/scenarios/schema';
import { MemoryDedupeStore } from '../ingest/dedupe';
import { handleIntakeMessage, type IntakeOutcome } from '../ingest/intakeHandler';
import { RecordingNotifier } from '../ingest/notifier';
import { isEvent } from '../ledger/events';
import { needEventKey } from '../ledger/idempotency';
import { NeedService } from '../ledger/needService';
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
        reason:
          'self-claim needs the need OPEN + the drift capability (Jul 8); match is demonstrated via the match expectation',
      });
    } else {
      skippedSteps.push({
        kind: step.kind,
        ref: `${step.volunteer_ref}:${step.reply}`,
        reason: 'release → reassign lands with the drift capability (Jul 8)',
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

/** Asserts the driver evaluates today: the walking skeleton, extraction-backed triage,
 * dedupe auto-detection, and the deterministic match slate. Everything else is a
 * documented SKIP. */
const EVALUATED_ASSERTS: ReadonlySet<string> = new Set([
  'needs_created_count',
  'needs_review_count',
  'critical_severity_floor',
  'exact_contact_auto_link',
  'duplicate_proposed_pairs',
  'candidates_suggested',
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
  if (exp.capability === 'drift') return 'drift engine (SLA timers, nudges, reassignment) lands Jul 8';
  if (exp.capability === 'evidence') return 'evidence/verification gating lands with F5';
  if (exp.capability === 'sitrep') return 'sitrep narration lands with F6';
  return 'capability not built yet';
}

/** Every expectation the driver does NOT evaluate yet, each with an honest reason. */
export function skippedExpectations(scenario: Scenario): SkippedExpectation[] {
  return scenario.expectations
    .filter((e) => !EVALUATED_ASSERTS.has(e.assert))
    .map((e) => ({ capability: e.capability, assert: e.assert, reason: skipReason(e) }));
}
