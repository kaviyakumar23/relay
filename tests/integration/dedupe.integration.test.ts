import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDemoResetStore } from '../../src/demo/reset';
import type { NeedEvent } from '../../src/ledger/events';
import type { NeedInit } from '../../src/ledger/store/eventStore';
import { PostgresEventStore } from '../../src/ledger/store/postgresStore';
import type { NeedType } from '../../src/ledger/types';
import { contactHash } from '../../src/lib/contactHash';
import { migrate } from '../../src/lib/migrate';

// Real-Postgres exercise of the dedupe SQL on the needs projection (setDedupeKeys +
// findDedupeCandidates, plus the vector(1536) ::vector cast and pg_trgm). Skipped
// unless DATABASE_URL is set. Needs are is_demo and purged in afterAll; the two
// localities this file inserts are FK parents of those needs, deleted after the purge.
//
// This suite runs against pgvector (local docker compose, pgvector/pgvector:pg16), so the
// embedding column exists and the vector path IS exercised here. pgvector is OPTIONAL in
// production: on a plain Postgres (self-hosted Fly, no `vector` extension) 001 skips the
// embedding column, and postgresStore guards both the ::vector write and the embedding
// SELECT behind a cached column-presence check — dedupe degrades to pg_trgm and the app
// still boots. That absent-pgvector branch is covered by the plain-Postgres migrate boot
// check (see the verifier note), not by this suite (which needs pgvector present).
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)('Postgres dedupe (integration)', () => {
  let pool: pg.Pool;
  let store: PostgresEventStore;
  let locA: number;
  let locB: number;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // A window generous enough to bracket every need this test creates.
  const sinceMs = Date.now() - 3_600_000;
  const now = Date.now() + 3_600_000;
  // A full-length pgvector value (the column is vector(1536)) exercises the ::vector cast.
  const embedding = Array.from({ length: 1536 }, (_, i) => (i % 97 === 0 ? 0.13 : 0));

  const needInit = (needId: string, type: NeedType, localityId: number | null): NeedInit => ({
    needId,
    type,
    severity: 'high',
    localityId,
    locationText: null,
    peopleCount: null,
    languages: [],
    sourcePermalink: null,
    confidence: {},
    isDemo: true,
  });

  // Create an is_demo need pinned to a type + locality via the raw store (bypassing the
  // projection, so needs.type/locality_id stay exactly what the dedupe query filters on).
  const createNeed = async (type: NeedType, localityId: number | null): Promise<string> => {
    const needId = randomUUID();
    const s = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const firstEvent: NeedEvent = {
      event_id: `evt_${s}`,
      need_id: needId,
      at: new Date().toISOString(),
      actor: { type: 'system', id: 'intake' },
      idempotency_key: `dedupe-${s}`,
      type: 'NeedCreated',
      payload: { source: { permalink: `https://s/${s}` }, is_demo: true },
    };
    const res = await store.createNeed(needInit(needId, type, localityId), firstEvent);
    expect(res.created).toBe(true);
    return needId;
  };

  const insertLocality = async (name: string): Promise<number> => {
    const res = await pool.query<{ id: number }>(
      'INSERT INTO localities (name, lat, lng, is_demo) VALUES ($1, $2, $3, true) RETURNING id',
      [name, 13.08, 80.27],
    );
    const id = res.rows[0]?.id;
    if (id === undefined) throw new Error('failed to insert locality');
    return id;
  };

  beforeAll(async () => {
    await migrate(DB);
    pool = new pg.Pool({ connectionString: DB });
    store = new PostgresEventStore({ pool });
    await store.init();
    locA = await insertLocality(`dedupe-a-${run}`);
    locB = await insertLocality(`dedupe-b-${run}`);
  });

  afterAll(async () => {
    if (pool) {
      await new PgDemoResetStore({ pool }).purgeDemoRows(); // removes is_demo needs (FK children of localities)
      await pool.query('DELETE FROM localities WHERE id = ANY($1)', [[locA, locB]]);
      await pool.end();
    }
  });

  it('finds an earlier same-contact same-locality need and casts the embedding vector', async () => {
    const hash = contactHash('9840005678');
    const need1 = await createNeed('food', locA); // earlier
    const need2 = await createNeed('food', locA); // the fresh need being deduped
    const need3 = await createNeed('food', locB); // same contact, DIFFERENT locality

    await store.setDedupeKeys(need1, { contactHash: hash, dedupeText: 'flood food packets anna nagar', embedding });
    await store.setDedupeKeys(need2, { contactHash: hash, dedupeText: 'need food packets anna nagar', embedding });
    await store.setDedupeKeys(need3, { contactHash: hash, dedupeText: 'food packets tnagar', embedding });

    const candidates = await store.findDedupeCandidates({
      type: 'food',
      localityId: locA,
      sinceMs,
      now,
      excludeNeedId: need2,
    });
    const ids = candidates.map((c) => c.needId);

    expect(ids).toContain(need1); // the earlier same-locality need IS a candidate
    expect(ids).not.toContain(need2); // never itself
    expect(ids).not.toContain(need3); // a different-locality need is filtered out

    const cand = candidates.find((c) => c.needId === need1);
    expect(cand?.contactHash).toBe(hash);
    expect(cand?.dedupeText).toBe('flood food packets anna nagar');
    // The vector column round-tripped: ::vector on write, parsed back to number[] on read.
    expect(Array.isArray(cand?.embedding)).toBe(true);
    expect(cand?.embedding?.length).toBe(1536);
    expect(cand?.status).toBe('NEW');
  });

  it('a null-locality query matches across localities (cross-locality exact-contact path)', async () => {
    const hash = contactHash('9820001111');
    const near = await createNeed('water', locA);
    const fresh = await createNeed('water', locA);
    const far = await createNeed('water', locB);
    for (const id of [near, fresh, far]) {
      await store.setDedupeKeys(id, { contactHash: hash });
    }

    const candidates = await store.findDedupeCandidates({
      type: 'water',
      localityId: null, // do not pin locality → exact-contact match spans localities
      sinceMs,
      now,
      excludeNeedId: fresh,
    });
    const ids = candidates.map((c) => c.needId);
    expect(ids).toContain(near); // same locality
    expect(ids).toContain(far); // AND the different-locality need
  });

  it('setDedupeKeys is additive: an explicit null clears one column, others are untouched', async () => {
    const need = await createNeed('shelter', locA);
    await store.setDedupeKeys(need, {
      contactHash: contactHash('9998887777'),
      dedupeText: 'blankets shelter kk nagar',
      embedding,
    });
    // Second call touches ONLY contact_hash (null clears); dedupe_text + embedding stay.
    await store.setDedupeKeys(need, { contactHash: null });

    const candidates = await store.findDedupeCandidates({
      type: 'shelter',
      localityId: locA,
      sinceMs,
      now,
      excludeNeedId: randomUUID(),
    });
    const cand = candidates.find((c) => c.needId === need);
    expect(cand).toBeDefined();
    expect(cand?.contactHash).toBeNull(); // cleared
    expect(cand?.dedupeText).toBe('blankets shelter kk nagar'); // untouched
    expect(cand?.embedding?.length).toBe(1536); // untouched
  });

  it('pg_trgm similarity is available for the fuzzy same-incident fallback', async () => {
    const near = await pool.query<{ s: number }>('SELECT similarity($1, $2) AS s', [
      'food packets anna nagar',
      'food packets anna nagar east',
    ]);
    const far = await pool.query<{ s: number }>('SELECT similarity($1, $2) AS s', [
      'food packets anna nagar',
      'medical oxygen tnagar',
    ]);
    expect(Number(near.rows[0]?.s)).toBeGreaterThan(0);
    expect(Number(near.rows[0]?.s)).toBeGreaterThan(Number(far.rows[0]?.s));
  });
});
