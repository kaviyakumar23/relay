import type { NeedEvent } from '../events';
import type { ConfidenceStatus, NeedType, ProjectionCache, Severity } from '../types';

// The append-only event store. Implementations: InMemoryEventStore (hermetic
// tests + demo) and PostgresEventStore (production). Higher layers depend only on
// this interface, so the substrate is swappable — the engine is what matters, not
// the DB. Both implementations enforce identical semantics: append-only,
// idempotent (unique idempotency_key), zero-copy, optimistic concurrency.

export interface AppendOpts {
  /** Optimistic concurrency: append succeeds only when the need's current event
   * count equals this value; otherwise ConcurrencyError. All events in one append
   * must belong to the same need. */
  expectedVersion?: number;
}

/** Fields for the `needs` registry row created alongside the first event. */
export interface NeedInit {
  needId: string;
  type: NeedType;
  severity: Severity;
  localityId: number | null;
  locationText: string | null;
  peopleCount: number | null;
  languages: string[];
  sourcePermalink: string | null;
  confidence: Record<string, ConfidenceStatus>;
  isDemo: boolean;
}

export interface CreateNeedResult {
  /** false = idempotent duplicate (an existing need with the same key; no row created). */
  created: boolean;
  /** The need's id (the existing one when created === false). */
  needId: string;
  /** The public_id (N-0001). Monotonic per store. */
  publicId: string;
}

export interface EventStore {
  /**
   * Atomically allocate a public_id, insert the `needs` registry row, and append
   * the first (NeedCreated) event — the row must exist before events (FK). Idempotent
   * on the event's idempotency_key: a duplicate returns { created: false } WITHOUT
   * orphaning a needs row.
   */
  createNeed(init: NeedInit, firstEvent: NeedEvent): Promise<CreateNeedResult>;

  /**
   * Append events atomically. Events whose idempotency_key already exists are skipped
   * (idempotent). Returns the events actually persisted. When opts.expectedVersion is
   * given, the compare-and-append is atomic (advisory lock in Postgres).
   */
  append(events: NeedEvent[], opts?: AppendOpts): Promise<NeedEvent[]>;

  hasIdempotencyKey(key: string): Promise<boolean>;

  /** Ordered event log for one need. */
  getEvents(needId: string): Promise<NeedEvent[]>;

  getAllNeedIds(): Promise<string[]>;

  /** Write the `needs`-row projection cache. ONLY needService calls this, after
   * re-projecting — it is the only code allowed to write needs.status. */
  updateProjectionCache(needId: string, cache: ProjectionCache): Promise<void>;
}
