import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDemoResetStore } from '../../src/demo/reset';
import type { NeedEvent } from '../../src/ledger/events';
import type { NeedInit } from '../../src/ledger/store/eventStore';
import { PostgresEventStore } from '../../src/ledger/store/postgresStore';
import { migrate } from '../../src/lib/migrate';

// Real-Postgres exercise of the demo teardown (CLAUDE.md 10) and the migration-003
// purge-mode trigger. Skipped unless DATABASE_URL is set. The purge is GLOBAL over
// is_demo rows, so it doubles as this file's own cleanup; only the fixture volunteer
// (kept by default — purgeVolunteers is false) is removed by slack_user_id in afterAll.
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)('PgDemoResetStore + purge-mode trigger (integration)', () => {
  let pool: pg.Pool;
  let store: PostgresEventStore;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const volSlack = `U-reset-${run}`;

  const needInit = (needId: string): NeedInit => ({
    needId,
    type: 'food',
    severity: 'high',
    localityId: null,
    locationText: null,
    peopleCount: null,
    languages: [],
    sourcePermalink: null,
    confidence: {},
    isDemo: true,
  });

  // An is_demo need with TWO need_events, to prove multi-row per-need purge.
  const createNeedWithEvents = async (): Promise<string> => {
    const needId = randomUUID();
    const s = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first: NeedEvent = {
      event_id: `evt_${s}`,
      need_id: needId,
      at: new Date().toISOString(),
      actor: { type: 'system', id: 'intake' },
      idempotency_key: `reset-c-${s}`,
      type: 'NeedCreated',
      payload: { source: { permalink: `https://s/${s}` }, is_demo: true },
    };
    const created = await store.createNeed(needInit(needId), first);
    expect(created.created).toBe(true);
    const second: NeedEvent = {
      event_id: `evt_${s}b`,
      need_id: needId,
      at: new Date().toISOString(),
      actor: { type: 'human', id: 'U-demo' },
      idempotency_key: `reset-x-${s}`,
      type: 'CommentAdded',
      payload: { ref: 'seed' },
    };
    await store.append([second]);
    return needId;
  };

  const seedVolunteerId = async (): Promise<string> => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO volunteers (slack_user_id, display_name, is_demo) VALUES ($1, $2, true)
         ON CONFLICT (slack_user_id) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [volSlack, 'Reset Vol'],
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error('failed to seed volunteer');
    return id;
  };

  beforeAll(async () => {
    await migrate(DB);
    pool = new pg.Pool({ connectionString: DB });
    store = new PostgresEventStore({ pool });
    await store.init();
  });

  afterAll(async () => {
    if (pool) {
      await new PgDemoResetStore({ pool }).purgeDemoRows();
      await pool.query('DELETE FROM volunteers WHERE slack_user_id = $1', [volSlack]);
      await pool.end();
    }
  });

  it('purges every is_demo table (need_events via purge mode); a second purge is a no-op', async () => {
    const volunteerId = await seedVolunteerId();
    const needIds = [await createNeedWithEvents(), await createNeedWithEvents()];
    for (const needId of needIds) {
      const ob = await pool.query<{ id: string }>(
        'INSERT INTO obligations (need_id, volunteer_id, status, is_demo) VALUES ($1, $2, $3, true) RETURNING id',
        [needId, volunteerId, 'CLAIMED'],
      );
      const obligationId = ob.rows[0]?.id;
      if (!obligationId) throw new Error('failed to seed obligation');
      await pool.query('INSERT INTO evidence (obligation_id, kind, is_demo) VALUES ($1, $2, true)', [
        obligationId,
        'photo',
      ]);
      await pool.query('INSERT INTO contact_vault (need_id, encrypted_payload) VALUES ($1, $2)', [
        needId,
        Buffer.from('ciphertext-placeholder'),
      ]);
    }
    await pool.query("INSERT INTO sitreps (stats, narrative, is_demo) VALUES ('{}'::jsonb, $1, true)", [
      `sitrep ${run}`,
    ]);

    // Pre-purge sanity: two events per need exist.
    const before = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM need_events WHERE need_id = ANY($1)',
      [needIds],
    );
    expect(Number(before.rows[0]?.n)).toBe(needIds.length * 2);

    const reset = new PgDemoResetStore({ pool });
    const counts = await reset.purgeDemoRows();
    expect(counts.needs).toBeGreaterThanOrEqual(needIds.length);
    expect(counts.events).toBeGreaterThanOrEqual(needIds.length * 2);
    expect(counts.obligations).toBeGreaterThanOrEqual(needIds.length);
    expect(counts.evidence).toBeGreaterThanOrEqual(needIds.length);
    expect(counts.sitreps).toBeGreaterThanOrEqual(1);

    // need_events for those needs are GONE — the SET LOCAL relay.allow_purge trigger fired.
    const eventsAfter = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM need_events WHERE need_id = ANY($1)',
      [needIds],
    );
    expect(Number(eventsAfter.rows[0]?.n)).toBe(0);
    const needsAfter = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM needs WHERE id = ANY($1)', [
      needIds,
    ]);
    expect(Number(needsAfter.rows[0]?.n)).toBe(0);
    const vaultAfter = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM contact_vault WHERE need_id = ANY($1)',
      [needIds],
    );
    expect(Number(vaultAfter.rows[0]?.n)).toBe(0);

    // A second purge finds nothing left to remove → safe idempotent repeat.
    const second = await reset.purgeDemoRows();
    expect(second.needs).toBe(0);
    expect(second.events).toBe(0);
    expect(second.obligations).toBe(0);
    expect(second.evidence).toBe(0);
    expect(second.sitreps).toBe(0);
  });

  it('append-only holds OUTSIDE purge mode: a plain DELETE on need_events raises', async () => {
    const needId = await createNeedWithEvents();
    // No SET LOCAL relay.allow_purge here ⇒ the append-only trigger must reject the DELETE.
    await expect(pool.query('DELETE FROM need_events WHERE need_id = $1', [needId])).rejects.toThrow(/append-only/i);

    // The transaction rolled back — the events are untouched.
    const events = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM need_events WHERE need_id = $1', [
      needId,
    ]);
    expect(Number(events.rows[0]?.n)).toBe(2);

    // Clean this need up via the sanctioned purge path.
    await new PgDemoResetStore({ pool }).purgeDemoRows();
  });
});
