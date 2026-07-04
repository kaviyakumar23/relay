import type { Scenario } from '../../demo/scenarios/schema';
import { MemoryDedupeStore } from '../ingest/dedupe';
import { handleIntakeMessage, type IntakeOutcome } from '../ingest/intakeHandler';
import { RecordingNotifier } from '../ingest/notifier';
import { NeedService } from '../ledger/needService';
import { InMemoryEventStore } from '../ledger/store/memoryStore';
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
  teamId: string;
  intakeChannelId: string;
  isIntakeChannel: (channelId: string) => boolean;
}

/** Assemble the hermetic pipeline. Deterministic monotonic clock so successive
 * needs get ordered, reproducible timestamps. */
export function buildHermeticAssembly(opts: { baseClockMs?: number } = {}): HermeticAssembly {
  const base = opts.baseClockMs ?? BASE_CLOCK_MS;
  const store = new InMemoryEventStore();
  const service = new NeedService(store, () => base);
  const notifier = new RecordingNotifier();
  const dedupe = new MemoryDedupeStore();

  let tick = base;
  const now = () => {
    const v = tick;
    tick += 1000;
    return v;
  };

  const queue = new InlineQueue(makeIntakeJobHandler({ service, notifier, now, isDemo: true }));
  const isIntakeChannel = (channelId: string): boolean => channelId === DEMO_INTAKE_CHANNEL;

  return {
    store,
    service,
    notifier,
    dedupe,
    queue,
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
}

/** Execute a scenario's steps against an assembly. delay_ms is ignored (hermetic);
 * volunteer steps are skipped — those capabilities aren't built yet. */
export async function runScenario(scenario: Scenario, a: HermeticAssembly): Promise<ScenarioRunResult> {
  let index = 0;
  let intakeSteps = 0;
  let enqueued = 0;
  const skippedSteps: SkippedStep[] = [];

  for (const step of scenario.steps) {
    if (step.kind === 'intake_message') {
      index += 1;
      intakeSteps += 1;
      const ts = demoTs(index);
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

  return { intakeSteps, enqueued, skippedSteps };
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

/** The expectations the driver does NOT evaluate yet (their capability isn't built). */
export function pendingExpectations(scenario: Scenario): Array<{ capability: string; assert: string }> {
  return scenario.expectations
    .filter((e) => e.capability !== 'skeleton')
    .map((e) => ({ capability: e.capability, assert: e.assert }));
}
