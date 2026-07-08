import pg from 'pg';
import { logger } from '../../lib/logger';
import { assertNoRawContent, type NeedEvent } from '../events';
import type { Actor, ActorType, ProjectionCache } from '../types';
import { ConcurrencyError } from './errors';
import type {
  AppendOpts,
  CreateNeedResult,
  DedupeCandidate,
  DedupeCandidateQuery,
  DedupeKeys,
  EventStore,
  NeedInit,
} from './eventStore';

const { Pool } = pg;

interface EventRow {
  seq: string;
  need_id: string;
  type: string;
  actor_type: string;
  actor_id: string | null;
  payload: unknown;
  idempotency_key: string;
  ts: Date;
}

const INSERT_EVENT = `INSERT INTO need_events
  (need_id, type, actor_type, actor_id, payload, evidence_id, idempotency_key, ts)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING seq`;

/**
 * Production event store on Postgres (maps to need_events / needs in
 * db/migrations/001_init.sql). Same contract as InMemoryEventStore: append-only,
 * idempotent (unique idempotency_key), zero-copy, optimistic concurrency. The need
 * projection is derived in code, not stored — a logic change is a replay, not a
 * migration. Only used behind the DATABASE_URL-gated integration suite for now.
 */
export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool;
  /**
   * Whether needs.embedding exists — i.e. pgvector was present at migrate time (001 adds
   * the column only when the `vector` extension installs). null = not yet detected. On a
   * plain Postgres (self-hosted Fly) the column is absent, so the vector dedupe path is
   * skipped and dedupe uses pg_trgm. Detected once via information_schema, then cached.
   */
  private hasEmbedding: boolean | null = null;

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
  }

  /** Create the public_id sequence if needed (the schema migration owns the tables). */
  async init(): Promise<void> {
    await this.pool.query('CREATE SEQUENCE IF NOT EXISTS needs_public_seq START 1');
    // Warm the pgvector-presence cache at boot so the mode is logged once and every
    // later dedupe call is a cache hit. Never fatal: absence just means the pg_trgm path.
    const hasEmbedding = await this.embeddingAvailable();
    logger.info(
      { hasEmbedding },
      `postgres store: embedding dedupe ${hasEmbedding ? 'enabled' : 'disabled (pg_trgm)'}`,
    );
  }

  /**
   * Does the needs.embedding column exist? Queried once from information_schema and
   * cached. When absent (no pgvector), callers skip the ::vector cast and the embedding
   * SELECT so a missing column can NEVER throw — dedupe degrades to pg_trgm.
   */
  private async embeddingAvailable(): Promise<boolean> {
    if (this.hasEmbedding === null) {
      const res = await this.pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'needs' AND column_name = 'embedding'
          LIMIT 1`,
      );
      this.hasEmbedding = (res.rowCount ?? 0) > 0;
    }
    return this.hasEmbedding;
  }

  private static rowToEvent(row: EventRow): NeedEvent {
    const actor: Actor = { type: row.actor_type as ActorType, id: row.actor_id ?? '' };
    return {
      event_id: `evt_${row.seq}`,
      need_id: row.need_id,
      at: row.ts.toISOString(),
      actor,
      idempotency_key: row.idempotency_key,
      type: row.type,
      payload: row.payload,
    } as NeedEvent;
  }

  private static evidenceIdOf(event: NeedEvent): string | null {
    return event.type === 'EvidenceAttached' ? (event.payload.evidence_id ?? null) : null;
  }

  async createNeed(init: NeedInit, firstEvent: NeedEvent): Promise<CreateNeedResult> {
    assertNoRawContent(firstEvent);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seqRes = await client.query<{ n: string }>("SELECT nextval('needs_public_seq') AS n");
      const publicId = `N-${String(seqRes.rows[0]?.n ?? '0').padStart(4, '0')}`;
      await client.query(
        `INSERT INTO needs
          (id, public_id, status, type, severity, locality_id, location_text, people_count, languages, source_permalink, confidence, is_demo)
         VALUES ($1, $2, 'NEW', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          init.needId,
          publicId,
          init.type,
          init.severity,
          init.localityId,
          init.locationText,
          init.peopleCount,
          init.languages,
          init.sourcePermalink,
          JSON.stringify(init.confidence),
          init.isDemo,
        ],
      );
      const evRes = await client.query(INSERT_EVENT, [
        firstEvent.need_id,
        firstEvent.type,
        firstEvent.actor.type,
        firstEvent.actor.id,
        JSON.stringify(firstEvent.payload),
        PostgresEventStore.evidenceIdOf(firstEvent),
        firstEvent.idempotency_key,
        firstEvent.at,
      ]);
      if ((evRes.rowCount ?? 0) === 0) {
        // Duplicate create (same idempotency_key) — discard the orphan needs row.
        await client.query('ROLLBACK');
        const dup = await this.pool.query<{ need_id: string; public_id: string }>(
          `SELECT ne.need_id, n.public_id FROM need_events ne
             JOIN needs n ON n.id = ne.need_id WHERE ne.idempotency_key = $1`,
          [firstEvent.idempotency_key],
        );
        const row = dup.rows[0];
        return { created: false, needId: row?.need_id ?? init.needId, publicId: row?.public_id ?? '' };
      }
      await client.query('COMMIT');
      return { created: true, needId: init.needId, publicId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async append(events: NeedEvent[], opts?: AppendOpts): Promise<NeedEvent[]> {
    const first = events[0];
    if (!first) return [];
    const client = await this.pool.connect();
    const persisted: NeedEvent[] = [];
    try {
      await client.query('BEGIN');
      // Optimistic concurrency: a per-need advisory xact-lock serializes appends for
      // this need, so the count check + insert are race-safe (held to COMMIT).
      if (opts?.expectedVersion !== undefined) {
        const id = first.need_id;
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
        const cnt = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM need_events WHERE need_id = $1', [
          id,
        ]);
        const current = cnt.rows[0]?.n ?? 0;
        if (current !== opts.expectedVersion) {
          throw new ConcurrencyError(opts.expectedVersion, current, id); // catch → ROLLBACK
        }
      }
      for (const event of events) {
        assertNoRawContent(event);
        const res = await client.query(INSERT_EVENT, [
          event.need_id,
          event.type,
          event.actor.type,
          event.actor.id,
          JSON.stringify(event.payload),
          PostgresEventStore.evidenceIdOf(event),
          event.idempotency_key,
          event.at,
        ]);
        if ((res.rowCount ?? 0) > 0) persisted.push(event);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return persisted;
  }

  async hasIdempotencyKey(key: string): Promise<boolean> {
    const res = await this.pool.query('SELECT 1 FROM need_events WHERE idempotency_key = $1 LIMIT 1', [key]);
    return (res.rowCount ?? 0) > 0;
  }

  async getEvents(needId: string): Promise<NeedEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT seq, need_id, type, actor_type, actor_id, payload, idempotency_key, ts
         FROM need_events WHERE need_id = $1 ORDER BY seq ASC`,
      [needId],
    );
    return res.rows.map(PostgresEventStore.rowToEvent);
  }

  async getAllNeedIds(): Promise<string[]> {
    const res = await this.pool.query<{ need_id: string }>('SELECT DISTINCT need_id FROM need_events');
    return res.rows.map((r) => r.need_id);
  }

  async getPublicId(needId: string): Promise<string | null> {
    const res = await this.pool.query<{ public_id: string }>('SELECT public_id FROM needs WHERE id = $1', [needId]);
    return res.rows[0]?.public_id ?? null;
  }

  async updateProjectionCache(needId: string, cache: ProjectionCache): Promise<void> {
    await this.pool.query(
      `UPDATE needs SET status = $2, type = $3, severity = $4, locality_id = $5,
         location_text = $6, people_count = $7, languages = $8, confidence = $9 WHERE id = $1`,
      [
        needId,
        cache.status,
        cache.type,
        cache.severity,
        cache.locality_id,
        cache.location_text,
        cache.people_count,
        cache.languages,
        JSON.stringify(cache.confidence),
      ],
    );
  }

  async setDedupeKeys(needId: string, keys: DedupeKeys): Promise<void> {
    // Build the SET list additively: undefined fields are untouched, null clears.
    const sets: string[] = [];
    const vals: unknown[] = [needId];
    if (keys.contactHash !== undefined) {
      vals.push(keys.contactHash);
      sets.push(`contact_hash = $${vals.length}`);
    }
    if (keys.dedupeText !== undefined) {
      vals.push(keys.dedupeText);
      sets.push(`dedupe_text = $${vals.length}`);
    }
    // Touch the embedding column ONLY when pgvector added it (see 001 migration). On a
    // plain Postgres the column is absent; the embedding is silently ignored — the vector
    // path is dormant without an embeddings key anyway — while contact_hash + dedupe_text
    // still persist. contact_hash + dedupe_text are enough for the pg_trgm dedupe path.
    if (keys.embedding !== undefined && (await this.embeddingAvailable())) {
      // pgvector accepts the textual form '[1,2,3]'; null clears the column.
      vals.push(keys.embedding === null ? null : `[${keys.embedding.join(',')}]`);
      sets.push(`embedding = $${vals.length}::vector`);
    }
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE needs SET ${sets.join(', ')} WHERE id = $1`, vals);
  }

  async findDedupeCandidates(q: DedupeCandidateQuery): Promise<DedupeCandidate[]> {
    // Reference the embedding column only when pgvector added it; on a plain Postgres the
    // column doesn't exist, so select a NULL placeholder — the JS cosine branch then stays
    // off (both sides null) and dedupe falls back to the pg_trgm dedupe_text signal (see
    // src/pipeline/dedupe.ts fuzzyScore). Behaviour is byte-identical when the column IS
    // present. A constant, never user input — no injection surface.
    const embeddingSelect = (await this.embeddingAvailable()) ? 'embedding' : 'NULL AS embedding';
    const res = await this.pool.query<{
      id: string;
      public_id: string;
      contact_hash: string | null;
      dedupe_text: string | null;
      embedding: unknown;
      status: string;
    }>(
      `SELECT id, public_id, contact_hash, dedupe_text, ${embeddingSelect}, status
         FROM needs
        WHERE type = $1
          AND status NOT IN ('DUPLICATE', 'CLOSED', 'CANCELLED', 'EXPIRED')
          AND id <> $2
          AND created_at >= to_timestamp($3 / 1000.0)
          AND created_at <= to_timestamp($4 / 1000.0)
          AND ($5::int IS NULL OR locality_id = $5::int)`,
      [q.type, q.excludeNeedId, q.sinceMs, q.now, q.localityId],
    );
    return res.rows.map((r) => ({
      needId: r.id,
      publicId: r.public_id,
      contactHash: r.contact_hash,
      dedupeText: r.dedupe_text,
      embedding: PostgresEventStore.parseEmbedding(r.embedding),
      status: r.status,
    }));
  }

  /** pgvector returns a vector as the text '[1,2,3]' unless a parser is registered. */
  private static parseEmbedding(raw: unknown): number[] | null {
    if (raw === null || raw === undefined) return null;
    if (Array.isArray(raw)) return raw.map(Number);
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(Number) : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
