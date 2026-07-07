import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type IntakeMessageStep, parseScenario } from '../../demo/scenarios/schema';
import {
  HERO_BEATS,
  type LiveHeroDemoDeps,
  type NarrateChannel,
  runLiveHeroDemo,
} from '../../src/demo/liveOrchestrator';
import { runDriftSweep } from '../../src/drift/driftEngine';
import { isEvent, type NeedEvent } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import type { NeedType, Severity } from '../../src/ledger/types';
import { loadLocalityCoords } from '../../src/match/seedData';
import { InMemoryVolunteerStore, type Volunteer } from '../../src/match/volunteerStore';
import { agent } from '../ledger/helpers';

// The LIVE hero orchestrator, driven with an in-memory ledger + stub deps (virtual sleep,
// a pickTarget over a seeded ledger, a recording narrate, a driftSweep that runs the real
// runDriftSweep behind recording callbacks). This is the live analog of the hermetic
// driver's `hero_e2e`: it asserts the beats fire IN ORDER and the driven need reaches CLOSED
// with a full evidence packet, reassigned to a SECOND volunteer, every human-gated event
// carrying the demo human actor — i.e. the hero chain runs end to end THROUGH the orchestrator.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);
const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));

const BASE = Date.parse('2026-07-07T00:00:00.000Z');
const DEMO_ACTOR = { type: 'human', id: 'DEMO_COORDINATOR' } as const;

/** The consequential human gates (§6.2) — the engine rejects a non-human actor on these, so
 * any that reached the log MUST be human; the test reads that back to prove the invariant. */
const HUMAN_GATED: ReadonlySet<string> = new Set([
  'TriageConfirmed',
  'DuplicateConfirmed',
  'Assigned',
  'Reassigned',
  'CoordinatorSignedOff',
  'Verified',
  'Closed',
  'Cancelled',
]);

/** Two roster entries so reassignment always has a distinct second volunteer. */
function roster(): Volunteer[] {
  return [
    {
      slack_user_id: 'SEED_U01',
      display_name: 'Anitha Paramedic',
      skills: ['medical'],
      languages: ['en'],
      home_locality: null,
      radius_km: 5,
      capacity_per_day: 3,
      availability: {},
      active_load: 0,
      is_demo: true,
    },
    {
      slack_user_id: 'SEED_U02',
      display_name: 'Ravi Medic',
      skills: ['medical', 'driver'],
      languages: ['en'],
      home_locality: null,
      radius_km: 5,
      capacity_per_day: 3,
      availability: {},
      active_load: 0,
      is_demo: true,
    },
  ];
}

interface Rig {
  deps: LiveHeroDemoDeps;
  service: NeedService;
  store: InMemoryEventStore;
  narrations: Array<{ channel: NarrateChannel; text: string }>;
  nudges: Array<{ id: string; kind: string }>;
  sleeps: number[];
  intakeCalls: () => number;
  selectedId: () => string | null;
}

/** Seed a TRIAGED need (NeedCreated → ExtractionCompleted) so the orchestrator can drive it. */
async function seedTriaged(svc: NeedService, key: string, type: NeedType, severity: Severity): Promise<string> {
  const created = await svc.createNeed({
    source: { permalink: `https://relay.demo/${key}` },
    actor: agent('intake'),
    at: new Date(BASE).toISOString(),
    idempotencyKey: `${key}:create`,
    now: BASE,
    isDemo: true,
  });
  if (created.status !== 'created') throw new Error(`seed ${key}: create ${created.status}`);
  const x = await svc.dispatch(
    created.needId,
    { type: 'ExtractionCompleted', payload: { need_type: type, severity, languages: [] } },
    { actor: agent('extract'), at: new Date(BASE + 1000).toISOString(), idempotencyKey: `${key}:x`, now: BASE + 1000 },
  );
  if (x.status !== 'applied') throw new Error(`seed ${key}: extraction ${x.status}`);
  return created.needId;
}

/**
 * Build a fully-wired hermetic rig. `pickTarget` picks over the seeded ledger; `driftSweep`
 * runs the REAL runDriftSweep behind recording callbacks; `narrate`/`sleep`/`postIntake` record;
 * the clock is a fixed virtual base (the orchestrator advances its own logical clock from it).
 */
async function buildRig(opts: { forceNoTarget?: boolean } = {}): Promise<Rig> {
  const store = new InMemoryEventStore();
  const service = new NeedService(store, () => BASE);

  // A medical/critical need first (the hero target), plus two others so the board is realistic.
  await seedTriaged(service, 'm-crit', 'medical', 'critical');
  await seedTriaged(service, 'f-high', 'food', 'high');
  await seedTriaged(service, 'w-med', 'water', 'medium');

  const volunteerStore = new InMemoryVolunteerStore(roster());
  const localities = loadLocalityCoords();

  const narrations: Array<{ channel: NarrateChannel; text: string }> = [];
  const nudges: Array<{ id: string; kind: string }> = [];
  const sleeps: number[] = [];
  let intakeCalls = 0;
  let selected: string | null = null;
  const pickClock = BASE + 500_000;

  const deps: LiveHeroDemoDeps = {
    scenario,
    service,
    volunteerStore,
    localities,
    postIntake: async () => {
      intakeCalls += 1;
    },
    driftSweep: async (now) => {
      await runDriftSweep({
        service,
        listNeeds: (n) => service.listNeeds(n),
        notifyNudge: async (need, kind) => {
          nudges.push({ id: need.need_id, kind });
        },
        proposeReassign: async () => {},
        now,
      });
    },
    narrate: async (channel, text) => {
      narrations.push({ channel, text });
    },
    pickTarget: async (pred) => {
      if (opts.forceNoTarget === true) return null;
      const found = (await service.listNeeds(pickClock)).find(pred) ?? null;
      if (found !== null && selected === null) selected = found.need_id;
      return found;
    },
    resolvePublicId: async (id) => (await store.getPublicId(id)) ?? id,
    now: () => BASE + 100_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    demoActor: DEMO_ACTOR,
  };

  return {
    deps,
    service,
    store,
    narrations,
    nudges,
    sleeps,
    intakeCalls: () => intakeCalls,
    selectedId: () => selected,
  };
}

/** Ordered-subsequence match: every predicate satisfied, in order, by some event (gaps allowed). */
function orderedSubsequence(events: NeedEvent[], preds: ReadonlyArray<(e: NeedEvent) => boolean>): boolean {
  let i = 0;
  for (const e of events) if (i < preds.length && preds[i]?.(e)) i += 1;
  return i === preds.length;
}

describe('runLiveHeroDemo', () => {
  it('runs the full hero sequence in order and drives the target to CLOSED', async () => {
    const rig = await buildRig();
    const { beats } = await runLiveHeroDemo(rig.deps);

    // 1) The beats fire IN ORDER, the full (non-degraded) sequence.
    expect(beats).toEqual([
      HERO_BEATS.intake,
      HERO_BEATS.triage,
      HERO_BEATS.assign,
      HERO_BEATS.nudge,
      HERO_BEATS.reassign,
      HERO_BEATS.deliver,
      HERO_BEATS.sitrep,
    ]);

    // 2) postIntake fired exactly once.
    expect(rig.intakeCalls()).toBe(1);

    // 3) The picked target (medical/critical, seeded first) reached CLOSED.
    const targetId = rig.selectedId();
    expect(targetId).not.toBeNull();
    const finalNow = BASE + 10_000_000;
    const target = await rig.service.getNeed(targetId ?? '', finalNow);
    expect(target?.state).toBe('CLOSED');

    const events = await rig.service.getEvents(targetId ?? '');

    // 4) Reassigned to a SECOND, distinct volunteer; the projection ends held by that volunteer.
    const assignVols = events.flatMap((e) => (isEvent(e, 'Assigned') ? [e.payload.volunteer_id] : []));
    expect(assignVols).toHaveLength(2);
    expect(assignVols[1]).not.toBe(assignVols[0]);
    expect(target?.assigned_volunteer_id).toBe(assignVols[1]);

    // 5) A full evidence packet is present.
    const kinds = new Set((target?.evidence ?? []).map((e) => e.kind));
    expect(kinds).toEqual(new Set(['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']));

    // 6) The hero chain, in order, as an ordered subsequence of the ledger.
    const chainOk = orderedSubsequence(events, [
      (e) => isEvent(e, 'Assigned'),
      (e) => isEvent(e, 'Nudged') && e.payload.kind === 'at_risk',
      (e) => isEvent(e, 'ClaimReleased'),
      (e) => isEvent(e, 'Assigned'),
      (e) => isEvent(e, 'EvidenceAttached') && e.payload.kind === 'photo',
      (e) => isEvent(e, 'EvidenceAttached') && e.payload.kind === 'locality_confirm',
      (e) => isEvent(e, 'RecipientConfirmed'),
      (e) => isEvent(e, 'CoordinatorSignedOff'),
      (e) => isEvent(e, 'Verified'),
      (e) => isEvent(e, 'Closed'),
    ]);
    expect(chainOk).toBe(true);

    // 7) Every human-gated event carries the LABELED demo human actor (invariant #2).
    const gated = events.filter((e) => HUMAN_GATED.has(e.type));
    expect(gated.length).toBeGreaterThan(0);
    for (const e of gated) {
      expect(e.actor.type).toBe('human');
      expect(e.actor.id).toBe(DEMO_ACTOR.id);
    }

    // 8) The at-risk drift nudge fired on the target (through the real runDriftSweep).
    expect(rig.nudges).toContainEqual({ id: targetId, kind: 'at_risk' });

    // 9) No auto-merge crept in.
    expect(events.some((e) => isEvent(e, 'DuplicateConfirmed'))).toBe(false);
    expect(target?.merged_into).toBeNull();
  });

  it('narrates the hero line across the simulator channels', async () => {
    const rig = await buildRig();
    await runLiveHeroDemo(rig.deps);

    const channels = new Set(rig.narrations.map((n) => n.channel));
    expect(channels.has('dispatch')).toBe(true);
    expect(channels.has('volunteers')).toBe(true);
    expect(channels.has('hq')).toBe(true);

    const heroLine = rig.narrations.find((n) => n.text.includes('re-routed'));
    expect(heroLine).toBeDefined();
    expect(heroLine?.channel).toBe('dispatch');
    // The sitrep pointer lands in #relay-hq.
    expect(rig.narrations.some((n) => n.channel === 'hq' && n.text.includes('/relay sitrep'))).toBe(true);
  });

  it('never surfaces beneficiary PII in the narration', async () => {
    const rig = await buildRig();
    await runLiveHeroDemo(rig.deps);

    const seedDigits = scenario.steps
      .filter((s): s is IntakeMessageStep => s.kind === 'intake_message')
      .map((s) => (s.contact ?? '').replace(/\D+/g, ''))
      .filter((d) => d.length > 0);
    expect(seedDigits.length).toBeGreaterThan(0); // guard: the scenario really does carry contacts

    const narrationDigits = rig.narrations
      .map((n) => n.text)
      .join(' ')
      .replace(/\D+/g, '');
    for (const d of seedDigits) expect(narrationDigits.includes(d)).toBe(false);
  });

  it('paces each beat through the injected sleep', async () => {
    const rig = await buildRig();
    await runLiveHeroDemo(rig.deps);
    // One settle pause + five between-beat pauses (sitrep pointer has no trailing sleep).
    expect(rig.sleeps.length).toBeGreaterThanOrEqual(6);
  });

  it('degrades gracefully when there is no target: skip beats, no throw, nothing closes', async () => {
    const rig = await buildRig({ forceNoTarget: true });
    const { beats } = await runLiveHeroDemo(rig.deps);

    expect(beats).toEqual([
      HERO_BEATS.intake,
      HERO_BEATS.triageSkipped,
      HERO_BEATS.assignSkipped,
      HERO_BEATS.nudgeSkipped,
      HERO_BEATS.reassignSkipped,
      HERO_BEATS.deliverSkipped,
      HERO_BEATS.sitrep,
    ]);

    // The ledger was left as seeded — nothing was driven to a terminal state.
    const needs = await rig.service.listNeeds(BASE + 10_000_000);
    expect(needs.every((n) => n.state === 'TRIAGED')).toBe(true);
    // Intake still fired, and the sitrep pointer still posts.
    expect(rig.intakeCalls()).toBe(1);
    expect(rig.narrations.some((n) => n.text.includes('/relay sitrep'))).toBe(true);
  });

  it('is idempotent-safe: a second run over the same board makes no duplicate transitions', async () => {
    const rig = await buildRig();
    const first = await runLiveHeroDemo(rig.deps);
    const targetId = rig.selectedId() ?? '';
    const eventsAfterFirst = (await rig.service.getEvents(targetId)).length;

    // A second run re-picks the same (now CLOSED) need? No — pickTarget only matches TRIAGED/
    // NEEDS_REVIEW, so the CLOSED target is no longer selectable. The run degrades on the other
    // seeded needs but never re-mutates the closed target's log (deterministic idempotency keys).
    const second = await runLiveHeroDemo(rig.deps);
    expect(second.beats[0]).toBe(HERO_BEATS.intake);
    const eventsAfterSecond = (await rig.service.getEvents(targetId)).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
    expect(first.beats).toContain(HERO_BEATS.deliver);
  });
});
