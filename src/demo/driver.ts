import { randomBytes } from 'node:crypto';
import type { Expectation, Scenario } from '../../demo/scenarios/schema';
import { MemoryDedupeStore } from '../ingest/dedupe';
import { handleIntakeMessage, type IntakeOutcome } from '../ingest/intakeHandler';
import { RecordingNotifier } from '../ingest/notifier';
import { NeedService } from '../ledger/needService';
import { InMemoryEventStore } from '../ledger/store/memoryStore';
import type { ProjectedNeed } from '../ledger/types';
import { InMemoryContactVault } from '../lib/vault';
import { HeuristicExtractor } from '../pipeline/extract';
import { makeIntakeJobHandler } from '../pipeline/intakeJob';
import { InlineQueue } from '../pipeline/queue';

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

  let tick = base;
  const now = () => {
    const v = tick;
    tick += 1000;
    return v;
  };

  const queue = new InlineQueue(makeIntakeJobHandler({ service, notifier, extractor, vault, now, isDemo: true }));
  const isIntakeChannel = (channelId: string): boolean => channelId === DEMO_INTAKE_CHANNEL;

  return {
    store,
    service,
    notifier,
    dedupe,
    queue,
    vault,
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
        reason: 'capability not built',
      });
    } else {
      skippedSteps.push({
        kind: step.kind,
        ref: `${step.volunteer_ref}:${step.reply}`,
        reason: 'capability not built',
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

/** Asserts the driver evaluates today: the walking skeleton + the extraction-backed
 * triage checks. Everything else is a documented SKIP. */
const EVALUATED_ASSERTS: ReadonlySet<string> = new Set([
  'needs_created_count',
  'needs_review_count',
  'critical_severity_floor',
]);

export interface SkippedExpectation {
  capability: string;
  assert: string;
  reason: string;
}

function skipReason(exp: Expectation): string {
  if (exp.assert === 'distinct_needs_after_dedupe') {
    return 'requires the dedupe capability (exact-contact auto-link + fuzzy merge); extraction alone leaves one need per message';
  }
  return 'capability not built yet';
}

/** Every expectation the driver does NOT evaluate yet, each with an honest reason. */
export function skippedExpectations(scenario: Scenario): SkippedExpectation[] {
  return scenario.expectations
    .filter((e) => !EVALUATED_ASSERTS.has(e.assert))
    .map((e) => ({ capability: e.capability, assert: e.assert, reason: skipReason(e) }));
}
