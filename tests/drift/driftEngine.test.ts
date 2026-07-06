import { describe, expect, it } from 'vitest';
import { decideDrift, type NudgeKind, runDriftSweep } from '../../src/drift/driftEngine';
import { slaDueAtIso } from '../../src/drift/sla';
import type { Command } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import { emptyFlags, type NeedState, type ProjectedNeed } from '../../src/ledger/types';
import { agent, human } from '../ledger/helpers';

const BASE = Date.parse('2026-07-06T00:00:00.000Z');
const RISK_WINDOW = 15 * 60 * 1000;

// --- decideDrift (pure, in isolation) ---------------------------------------

function makeNeed(over: Partial<ProjectedNeed>): ProjectedNeed {
  return {
    need_id: 'n1',
    state: 'CLAIMED',
    type: 'medical',
    severity: 'critical',
    locality_id: null,
    location_text: null,
    people_count: null,
    languages: [],
    source: {},
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: 'V1',
    obligation_id: 'OB1',
    sla_due_at: null,
    evidence: [],
    flags: emptyFlags(),
    state_version: 1,
    history_count: 1,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    ...over,
  };
}

describe('decideDrift', () => {
  const due = BASE + 3_600_000; // 1h out
  const dueIso = new Date(due).toISOString();

  it('is inert while the obligation is comfortably before its risk window', () => {
    const d = decideDrift(makeNeed({ sla_due_at: dueIso }), due - RISK_WINDOW - 1);
    expect(d).toEqual({ atRisk: false, overdue: false, alreadyHandled: false });
  });

  it('flags at-risk once inside the risk window (still before due)', () => {
    const d = decideDrift(makeNeed({ sla_due_at: dueIso }), due - 60_000);
    expect(d).toEqual({ atRisk: true, overdue: false, alreadyHandled: false });
  });

  it('treats the exact due instant as at-risk, not overdue', () => {
    const d = decideDrift(makeNeed({ sla_due_at: dueIso }), due);
    expect(d).toEqual({ atRisk: true, overdue: false, alreadyHandled: false });
  });

  it('flags overdue the instant after due', () => {
    const d = decideDrift(makeNeed({ sla_due_at: dueIso }), due + 1);
    expect(d).toEqual({ atRisk: false, overdue: true, alreadyHandled: false });
  });

  it('works for IN_PROGRESS obligations too', () => {
    const d = decideDrift(makeNeed({ state: 'IN_PROGRESS', sla_due_at: dueIso }), due + 1);
    expect(d.overdue).toBe(true);
  });

  it('is alreadyHandled when there is no sla_due_at', () => {
    const d = decideDrift(makeNeed({ sla_due_at: null }), due + 1);
    expect(d).toEqual({ atRisk: false, overdue: false, alreadyHandled: true });
  });

  it('is alreadyHandled for non-delivering states even when past due', () => {
    const states: NeedState[] = ['OPEN', 'DELIVERED_UNVERIFIED', 'VERIFIED', 'CLOSED'];
    for (const state of states) {
      const d = decideDrift(makeNeed({ state, sla_due_at: dueIso }), due + 1_000_000);
      expect(d.alreadyHandled, state).toBe(true);
    }
  });
});

// --- runDriftSweep (integration over a real ledger + virtual clock) ---------

interface Recorder {
  nudges: Array<{ id: string; kind: NudgeKind }>;
  reassigns: string[];
  notifyNudge: (need: ProjectedNeed, kind: NudgeKind) => Promise<void>;
  proposeReassign: (need: ProjectedNeed) => Promise<void>;
}

function recorder(): Recorder {
  const nudges: Array<{ id: string; kind: NudgeKind }> = [];
  const reassigns: string[] = [];
  return {
    nudges,
    reassigns,
    notifyNudge: async (need, kind) => {
      nudges.push({ id: need.need_id, kind });
    },
    proposeReassign: async (need) => {
      reassigns.push(need.need_id);
    },
  };
}

/** Drive a fresh need to CLAIMED with an sla_due_at computed at BASE. Returns id + due. */
async function claimedNeed(
  svc: NeedService,
  key: string,
  opts: { multiplier?: number } = {},
): Promise<{ id: string; dueMs: number }> {
  const created = await svc.createNeed({
    source: { permalink: `https://s/${key}` },
    actor: agent('intake'),
    at: new Date(BASE).toISOString(),
    idempotencyKey: `${key}:create`,
  });
  if (created.status !== 'created') throw new Error('setup: create failed');
  const id = created.needId;
  const step = async (actor: Parameters<NeedService['dispatch']>[2]['actor'], command: Command, k: string) => {
    const r = await svc.dispatch(id, command, {
      actor,
      at: new Date(BASE).toISOString(),
      idempotencyKey: k,
      now: BASE,
    });
    if (r.status !== 'applied') throw new Error(`setup: ${command.type} → ${r.status} ${r.reason ?? ''}`);
  };
  await step(
    agent(),
    { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
    `${key}:x`,
  );
  await step(human(), { type: 'TriageConfirmed', payload: {} }, `${key}:t`);
  const dueIso = slaDueAtIso('medical', 'critical', BASE, opts.multiplier ?? 1);
  await step(
    human(),
    { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1', sla_due_at: dueIso } },
    `${key}:a`,
  );
  return { id, dueMs: Date.parse(dueIso) };
}

function sweep(svc: NeedService, rec: Recorder, now: number) {
  return runDriftSweep({
    service: svc,
    listNeeds: (n) => svc.listNeeds(n),
    notifyNudge: rec.notifyNudge,
    proposeReassign: rec.proposeReassign,
    now,
  });
}

describe('runDriftSweep', () => {
  it('does nothing before a claimed need reaches its risk window', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { dueMs } = await claimedNeed(svc, 'quiet');
    const res = await sweep(svc, rec, dueMs - RISK_WINDOW - 60_000);
    expect(res).toEqual({ nudged: [], overdue: [] });
    expect(rec.nudges).toHaveLength(0);
    expect(rec.reassigns).toHaveLength(0);
  });

  it('nudges exactly once when a delivery crosses at-risk, idempotent across repeated sweeps', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { id, dueMs } = await claimedNeed(svc, 'atrisk');
    const now = dueMs - 60_000; // inside the window, before due

    const first = await sweep(svc, rec, now);
    expect(first.nudged).toEqual([id]);
    expect(first.overdue).toEqual([]);

    // Repeat sweeps at the same clock — no duplicate Nudged event, no duplicate DM.
    await sweep(svc, rec, now);
    await sweep(svc, rec, now);

    expect(rec.nudges).toEqual([{ id, kind: 'at_risk' }]);
    expect(rec.reassigns).toHaveLength(0);
    const events = await svc.getEvents(id);
    expect(events.filter((e) => e.type === 'Nudged')).toHaveLength(1);
  });

  it('on overdue, nudges + proposes reassignment exactly once', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { id, dueMs } = await claimedNeed(svc, 'over');
    const now = dueMs + 60_000;

    const res = await sweep(svc, rec, now);
    expect(res.overdue).toEqual([id]);
    expect(res.nudged).toEqual([]);

    await sweep(svc, rec, now); // repeat — must not re-fire
    expect(rec.nudges).toEqual([]); // overdue proposes reassignment; the DM nudge is the at-risk action
    expect(rec.reassigns).toEqual([id]);
    const kinds = (await svc.getEvents(id))
      .filter((e) => e.type === 'Nudged')
      .map((e) => (e.type === 'Nudged' ? e.payload.kind : undefined));
    expect(kinds).toEqual(['overdue']); // one Nudged event, tagged overdue
  });

  it('fires the full hero arc: at-risk once, then overdue once, as the clock advances', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { id, dueMs } = await claimedNeed(svc, 'hero');

    await sweep(svc, rec, dueMs - 60_000); // at-risk
    await sweep(svc, rec, dueMs + 60_000); // overdue
    await sweep(svc, rec, dueMs + 120_000); // still overdue — no new action

    expect(rec.nudges).toEqual([{ id, kind: 'at_risk' }]); // one DM, at the at-risk crossing
    expect(rec.reassigns).toEqual([id]); // one reassignment proposal, at the overdue crossing
    const kinds = (await svc.getEvents(id))
      .filter((e) => e.type === 'Nudged')
      .map((e) => (e.type === 'Nudged' ? e.payload.kind : undefined));
    expect(kinds).toEqual(['at_risk', 'overdue']); // both crossings recorded in the ledger
  });

  it('never nudges a delivered / verified / closed need', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { id, dueMs } = await claimedNeed(svc, 'delivered');
    // Attach evidence → DELIVERED_UNVERIFIED (leaves the delivering states).
    const r = await svc.dispatch(
      id,
      { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'E1' } },
      { actor: agent(), at: new Date(BASE + 1000).toISOString(), idempotencyKey: 'delivered:e', now: BASE + 1000 },
    );
    expect(r.status).toBe('applied');

    await sweep(svc, rec, dueMs + 600_000); // long past due
    expect(rec.nudges).toHaveLength(0);
    expect(rec.reassigns).toHaveLength(0);
    expect((await svc.getEvents(id)).filter((e) => e.type === 'Nudged')).toHaveLength(0);
  });

  it('starts a fresh drift cycle after reassignment stamps a new sla_due_at', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const rec = recorder();
    const { id, dueMs } = await claimedNeed(svc, 'reassign');

    // First obligation goes overdue → nudge + reassign proposal.
    await sweep(svc, rec, dueMs + 60_000);
    expect(rec.reassigns).toEqual([id]);

    // Coordinator reassigns with a fresh SLA further out.
    const newDueMs = dueMs + 3_600_000;
    const rr = await svc.dispatch(
      id,
      {
        type: 'Reassigned',
        payload: {
          to_volunteer_id: 'V2',
          from_volunteer_id: 'V1',
          obligation_id: 'OB2',
          sla_due_at: new Date(newDueMs).toISOString(),
        },
      },
      {
        actor: human(),
        at: new Date(dueMs + 120_000).toISOString(),
        idempotencyKey: 'reassign:rr',
        now: dueMs + 120_000,
      },
    );
    expect(rr.status).toBe('applied');

    // The new obligation gets its own at-risk + overdue nudges (fresh keys).
    await sweep(svc, rec, newDueMs - 60_000); // at-risk for OB2
    await sweep(svc, rec, newDueMs + 60_000); // overdue for OB2

    expect(rec.nudges).toEqual([{ id, kind: 'at_risk' }]); // only OB2's at-risk DM (OB1 jumped straight to overdue)
    expect(rec.reassigns).toEqual([id, id]); // OB1 overdue + OB2 overdue
  });
});
