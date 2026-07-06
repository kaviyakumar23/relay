import { describe, expect, it } from 'vitest';
import type { Command, NeedEvent } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { ConcurrencyError } from '../../src/ledger/store/errors';
import type {
  AppendOpts,
  CreateNeedResult,
  DedupeCandidate,
  DedupeCandidateQuery,
  DedupeKeys,
  EventStore,
  NeedInit,
} from '../../src/ledger/store/eventStore';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import type { ProjectionCache } from '../../src/ledger/types';
import { agent, human, isoClock, system } from './helpers';

function newService(store: EventStore = new InMemoryEventStore()): { svc: NeedService; store: EventStore } {
  return { svc: new NeedService(store), store };
}

async function createOne(svc: NeedService, key: string, at = '2026-07-04T00:00:00.000Z') {
  return svc.createNeed({
    source: { permalink: `https://s/${key}` },
    actor: system('intake'),
    at,
    idempotencyKey: key,
  });
}

describe('NeedService — creation & public_id', () => {
  it('creates a need with a projection cache and NEW status', async () => {
    const store = new InMemoryEventStore();
    const svc = new NeedService(store);
    const r = await createOne(svc, 'k1');
    expect(r.status).toBe('created');
    if (r.status !== 'created') return;
    expect(r.publicId).toBe('N-0001');
    expect(r.need.state).toBe('NEW');
    expect(store.getRow(r.needId)?.status).toBe('NEW');
  });

  it('allocates monotonic public_ids', async () => {
    const { svc } = newService();
    const ids: string[] = [];
    for (const k of ['a', 'b', 'c']) {
      const r = await createOne(svc, k);
      if (r.status === 'created') ids.push(r.publicId);
    }
    expect(ids).toEqual(['N-0001', 'N-0002', 'N-0003']);
  });

  it('is idempotent: a duplicate create returns the same need, no second row', async () => {
    const { svc } = newService();
    const first = await createOne(svc, 'dup');
    const second = await createOne(svc, 'dup');
    expect(first.status).toBe('created');
    expect(second.status).toBe('deduped');
    if (first.status === 'created' && second.status === 'deduped') {
      expect(second.needId).toBe(first.needId);
      expect(second.publicId).toBe(first.publicId);
    }
    expect(await svc.listNeeds()).toHaveLength(1);
  });
});

describe('NeedService — full lifecycle', () => {
  it('drives a critical need from NEW to CLOSED, updating the cache each step', async () => {
    const store = new InMemoryEventStore();
    const svc = new NeedService(store);
    const at = isoClock();
    const created = await createOne(svc, 'life', at());
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const id = created.needId;

    const apply = async (actor: Parameters<typeof svc.dispatch>[2]['actor'], command: Command, key: string) => {
      const r = await svc.dispatch(id, command, { actor, at: at(), idempotencyKey: key });
      expect(r.status, `${command.type} should apply`).toBe('applied');
      return r;
    };

    await apply(
      agent(),
      { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
      's1',
    );
    expect(store.getRow(id)?.status).toBe('TRIAGED');
    await apply(human(), { type: 'TriageConfirmed', payload: {} }, 's2');
    await apply(human(), { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1' } }, 's3');
    expect(store.getRow(id)?.status).toBe('CLAIMED');
    await apply(agent(), { type: 'EnRouteReported', payload: { eta_minutes: 5 } }, 's4');
    await apply(agent(), { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'E1' } }, 's5');
    await apply(agent(), { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', evidence_id: 'E2' } }, 's6');
    await apply(human('U_RECIP'), { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } }, 's7');
    await apply(human(), { type: 'CoordinatorSignedOff', payload: {} }, 's8');
    await apply(human(), { type: 'Verified', payload: {} }, 's9');
    const closed = await apply(human(), { type: 'Closed', payload: {} }, 's10');

    expect(closed.need?.state).toBe('CLOSED');
    expect(store.getRow(id)?.status).toBe('CLOSED');
    expect(closed.need?.evidence.map((e) => e.kind)).toEqual([
      'photo',
      'locality_confirm',
      'recipient_confirm',
      'coordinator_signoff',
    ]);
  });
});

describe('NeedService — idempotent double-append', () => {
  it('applies once and suppresses the replay of the same idempotency key', async () => {
    const store = new InMemoryEventStore();
    const svc = new NeedService(store);
    const created = await createOne(svc, 'idem');
    if (created.status !== 'created') throw new Error('setup failed');
    const id = created.needId;

    const cmd: Command = { type: 'ExtractionCompleted', payload: { need_type: 'food', severity: 'high' } };
    const first = await svc.dispatch(id, cmd, {
      actor: agent(),
      at: '2026-07-04T00:00:01.000Z',
      idempotencyKey: 'once',
    });
    const second = await svc.dispatch(id, cmd, {
      actor: agent(),
      at: '2026-07-04T00:00:02.000Z',
      idempotencyKey: 'once',
    });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('suppressed');
    expect(await svc.getEvents(id)).toHaveLength(2); // NeedCreated + one ExtractionCompleted
  });
});

/** Wraps a real store but makes the FIRST append throw a ConcurrencyError, to
 * exercise the dispatch retry loop deterministically. */
class FlakyOnceStore implements EventStore {
  private thrown = false;
  constructor(private readonly inner: InMemoryEventStore) {}
  createNeed(init: NeedInit, firstEvent: NeedEvent): Promise<CreateNeedResult> {
    return this.inner.createNeed(init, firstEvent);
  }
  async append(events: NeedEvent[], opts?: AppendOpts): Promise<NeedEvent[]> {
    if (!this.thrown) {
      this.thrown = true;
      const expected = opts?.expectedVersion ?? 0;
      throw new ConcurrencyError(expected, expected + 1, events[0]?.need_id);
    }
    return this.inner.append(events, opts);
  }
  hasIdempotencyKey(key: string): Promise<boolean> {
    return this.inner.hasIdempotencyKey(key);
  }
  getEvents(needId: string): Promise<NeedEvent[]> {
    return this.inner.getEvents(needId);
  }
  getAllNeedIds(): Promise<string[]> {
    return this.inner.getAllNeedIds();
  }
  getPublicId(needId: string): Promise<string | null> {
    return this.inner.getPublicId(needId);
  }
  updateProjectionCache(needId: string, cache: ProjectionCache): Promise<void> {
    return this.inner.updateProjectionCache(needId, cache);
  }
  setDedupeKeys(needId: string, keys: DedupeKeys): Promise<void> {
    return this.inner.setDedupeKeys(needId, keys);
  }
  findDedupeCandidates(q: DedupeCandidateQuery): Promise<DedupeCandidate[]> {
    return this.inner.findDedupeCandidates(q);
  }
}

describe('NeedService — concurrency retry', () => {
  it('retries after a ConcurrencyError and appends exactly once', async () => {
    const inner = new InMemoryEventStore();
    const flaky = new FlakyOnceStore(inner);
    const svc = new NeedService(flaky);
    const created = await createOne(svc, 'conc');
    if (created.status !== 'created') throw new Error('setup failed');
    const id = created.needId;

    const r = await svc.dispatch(
      id,
      { type: 'ExtractionCompleted', payload: { need_type: 'water', severity: 'medium' } },
      { actor: agent(), at: '2026-07-04T00:00:01.000Z', idempotencyKey: 'retry-1' },
    );

    expect(r.status).toBe('applied');
    expect(await inner.getEvents(id)).toHaveLength(2); // no double-append across the retry
  });
});
