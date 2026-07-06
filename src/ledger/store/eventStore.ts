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

/** Dedupe signals persisted on the `needs` row (all PII-free — see src/lib/contactHash.ts). */
export interface DedupeKeys {
  /** Keyed HMAC blind index of the beneficiary number, or null. Never the number itself. */
  contactHash?: string | null;
  /** PII-free derived text for trigram similarity, or null. */
  dedupeText?: string | null;
  /** Embedding vector for cosine similarity, or null when the trigram fallback is used. */
  embedding?: number[] | null;
}

/** Query for active same-type/same-locality needs to dedupe a fresh one against. */
export interface DedupeCandidateQuery {
  type: string;
  /** null → do not filter by locality (used for cross-locality exact-contact matching). */
  localityId: number | null;
  /** Lower bound (epoch ms) on created_at — the start of the dedupe window. */
  sinceMs: number;
  /** The fresh need itself, excluded from its own candidate set. */
  excludeNeedId: string;
  /** Upper bound (epoch ms) on created_at. */
  now: number;
}

/** A candidate need to compare against, with its dedupe signals. */
export interface DedupeCandidate {
  needId: string;
  publicId: string;
  contactHash: string | null;
  dedupeText: string | null;
  embedding: number[] | null;
  status: string;
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

  /** The human-facing public_id (N-0001) for a need, or null if unknown. Read-only —
   * used by surfaces to label a need referenced only by its internal id (e.g. the
   * merged-into target on a duplicate card). */
  getPublicId(needId: string): Promise<string | null>;

  /** Write the `needs`-row projection cache. ONLY needService calls this, after
   * re-projecting — it is the only code allowed to write needs.status. */
  updateProjectionCache(needId: string, cache: ProjectionCache): Promise<void>;

  /**
   * Persist dedupe signals on the `needs` row (additive; does not touch status or any
   * projection field). Fields left undefined are unchanged; an explicit null clears.
   * The contact hash is a blind index — no plaintext contact ever reaches here.
   */
  setDedupeKeys(needId: string, keys: DedupeKeys): Promise<void>;

  /**
   * Active (not DUPLICATE/CLOSED/CANCELLED/EXPIRED) needs of the same type — and same
   * locality when the query pins one — created within [sinceMs, now], excluding the
   * fresh need. Demo-scale: a full scan is fine. Returns each candidate's dedupe signals.
   */
  findDedupeCandidates(q: DedupeCandidateQuery): Promise<DedupeCandidate[]>;
}
