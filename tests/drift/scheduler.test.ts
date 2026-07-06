import { describe, expect, it } from 'vitest';
import { runDriftSweep } from '../../src/drift/driftEngine';
import { InMemoryScheduler } from '../../src/drift/scheduler/inMemoryScheduler';
import { slaDueAtIso } from '../../src/drift/sla';
import type { Command } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import type { ProjectedNeed } from '../../src/ledger/types';
import { agent, human } from '../ledger/helpers';

describe('InMemoryScheduler', () => {
  it('invokes the registered sweep with the virtual clock passed to runDue', async () => {
    const scheduler = new InMemoryScheduler();
    const seen: number[] = [];
    scheduler.start(async (now) => {
      seen.push(now);
    });

    await scheduler.runDue(1000);
    await scheduler.runDue(2000);

    expect(seen).toEqual([1000, 2000]);
    expect(scheduler.ranAt).toBe(2000);
  });

  it('is a no-op before start() and after stop()', async () => {
    const scheduler = new InMemoryScheduler();
    let calls = 0;
    await scheduler.runDue(100); // never started
    expect(scheduler.ranAt).toBeNull();

    scheduler.start(async () => {
      calls += 1;
    });
    await scheduler.runDue(200);
    expect(calls).toBe(1);

    await scheduler.stop();
    await scheduler.runDue(300);
    expect(calls).toBe(1); // stopped — sweep no longer fires
  });
});

describe('InMemoryScheduler wired to runDriftSweep (hero drift on a virtual clock)', () => {
  it('advancing the clock past the SLA fires the drift sweep end-to-end', async () => {
    const svc = new NeedService(new InMemoryEventStore());
    const base = Date.parse('2026-07-06T00:00:00.000Z');
    const nudged: string[] = [];
    const reassigned: string[] = [];

    // Build one claimed obligation with a real-time SLA.
    const created = await svc.createNeed({
      source: { permalink: 'https://s/hero' },
      actor: agent('intake'),
      at: new Date(base).toISOString(),
      idempotencyKey: 'hero:create',
    });
    if (created.status !== 'created') throw new Error('setup failed');
    const id = created.needId;
    const step = async (actor: Parameters<NeedService['dispatch']>[2]['actor'], command: Command, k: string) => {
      const r = await svc.dispatch(id, command, {
        actor,
        at: new Date(base).toISOString(),
        idempotencyKey: k,
        now: base,
      });
      if (r.status !== 'applied') throw new Error(`${command.type} → ${r.status}`);
    };
    await step(
      agent(),
      { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
      'hero:x',
    );
    await step(human(), { type: 'TriageConfirmed', payload: {} }, 'hero:t');
    // Real-time SLA so the fixed 15-min risk window applies cleanly. (Demo
    // multiplier compression is covered in sla.test.ts; under heavy compression the
    // fixed risk window simply makes drift fire almost immediately, by design.)
    const dueIso = slaDueAtIso('medical', 'critical', base, 1);
    await step(
      human(),
      { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1', sla_due_at: dueIso } },
      'hero:a',
    );

    const scheduler = new InMemoryScheduler();
    scheduler.start(async (now) => {
      const res = await runDriftSweep({
        service: svc,
        listNeeds: (n) => svc.listNeeds(n),
        notifyNudge: async (need: ProjectedNeed) => {
          nudged.push(need.need_id);
        },
        proposeReassign: async (need: ProjectedNeed) => {
          reassigned.push(need.need_id);
        },
        now,
      });
      void res;
    });

    const dueMs = Date.parse(dueIso);
    await scheduler.runDue(base); // t0 — nothing due yet
    expect(nudged).toHaveLength(0);

    await scheduler.runDue(dueMs - 1000); // inside the risk window → at-risk nudge
    await scheduler.runDue(dueMs + 1000); // past due → overdue nudge + reassign proposal

    expect(nudged).toEqual([id]); // the at-risk DM (overdue drives a reassignment, not a DM)
    expect(reassigned).toEqual([id]); // the overdue reassignment proposal
    await scheduler.stop();
  });
});
