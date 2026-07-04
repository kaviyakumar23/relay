import { assertNoRawContent, type NeedEvent } from '../events';
import type { NeedState, ProjectionCache } from '../types';
import { ConcurrencyError } from './errors';
import type { AppendOpts, CreateNeedResult, EventStore, NeedInit } from './eventStore';

/** In-memory `needs` registry row (mirrors the Postgres `needs` table cache). */
interface NeedRow {
  publicId: string;
  status: NeedState;
  init: NeedInit;
  cache?: ProjectionCache;
}

/**
 * In-memory event store — hermetic, deterministic, used by the test suite and the
 * eval/demo runner. Mirrors PostgresEventStore semantics EXACTLY (append-only,
 * idempotent, zero-copy, optimistic concurrency, monotonic public_id) without a DB,
 * so the same behaviour is exercised in tests.
 */
export class InMemoryEventStore implements EventStore {
  private readonly byNeed = new Map<string, NeedEvent[]>();
  private readonly rows = new Map<string, NeedRow>();
  private readonly keys = new Map<string, string>(); // idempotency_key -> needId
  private publicSeq = 0;

  private nextPublicId(): string {
    this.publicSeq += 1;
    return `N-${String(this.publicSeq).padStart(4, '0')}`;
  }

  async createNeed(init: NeedInit, firstEvent: NeedEvent): Promise<CreateNeedResult> {
    // Idempotent: a duplicate key must NOT create a second needs row.
    const existingNeedId = this.keys.get(firstEvent.idempotency_key);
    if (existingNeedId !== undefined) {
      const row = this.rows.get(existingNeedId);
      return { created: false, needId: existingNeedId, publicId: row?.publicId ?? '' };
    }
    assertNoRawContent(firstEvent);
    const publicId = this.nextPublicId();
    this.rows.set(init.needId, { publicId, status: 'NEW', init });
    this.byNeed.set(init.needId, [firstEvent]);
    this.keys.set(firstEvent.idempotency_key, init.needId);
    return { created: true, needId: init.needId, publicId };
  }

  async append(events: NeedEvent[], opts?: AppendOpts): Promise<NeedEvent[]> {
    const first = events[0];
    if (!first) return [];
    const needId = first.need_id;
    // Optimistic concurrency: compare-and-append (synchronous → atomic on the JS loop).
    if (opts?.expectedVersion !== undefined) {
      const current = (this.byNeed.get(needId) ?? []).length;
      if (current !== opts.expectedVersion) throw new ConcurrencyError(opts.expectedVersion, current, needId);
    }
    const persisted: NeedEvent[] = [];
    for (const event of events) {
      assertNoRawContent(event); // safety net (also enforced in decide)
      if (this.keys.has(event.idempotency_key)) continue; // idempotent skip
      this.keys.set(event.idempotency_key, event.need_id);
      const log = this.byNeed.get(event.need_id) ?? [];
      log.push(event);
      this.byNeed.set(event.need_id, log);
      persisted.push(event);
    }
    return persisted;
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    return this.keys.has(key);
  }

  async getEvents(needId: string): Promise<NeedEvent[]> {
    return [...(this.byNeed.get(needId) ?? [])];
  }

  async getAllNeedIds(): Promise<string[]> {
    return [...this.byNeed.keys()];
  }

  async updateProjectionCache(needId: string, cache: ProjectionCache): Promise<void> {
    const row = this.rows.get(needId);
    if (!row) return;
    row.status = cache.status;
    row.cache = cache;
  }

  /** Test/demo helper: read the cached `needs`-row projection for a need. */
  getRow(needId: string): { publicId: string; status: NeedState; cache?: ProjectionCache } | undefined {
    const row = this.rows.get(needId);
    return row ? { publicId: row.publicId, status: row.status, cache: row.cache } : undefined;
  }
}
