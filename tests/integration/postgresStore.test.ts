import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { PostgresEventStore } from '../../src/ledger/store/postgresStore';
import { migrate } from '../../src/lib/migrate';

// Real-Postgres round-trip for the ledger store. Always safe to run without infra:
// the whole block is skipped unless DATABASE_URL is set (docker compose up -d).
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)('PostgresEventStore (integration)', () => {
  let store: PostgresEventStore;
  let pool: pg.Pool;

  beforeAll(async () => {
    await migrate(DB);
    pool = new pg.Pool({ connectionString: DB });
    store = new PostgresEventStore({ pool });
    await store.init();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('round-trips a full lifecycle and keeps the needs.status cache in sync', async () => {
    const svc = new NeedService(store);
    const suffix = Date.now();
    const created = await svc.createNeed({
      source: { permalink: `https://s/${suffix}` },
      actor: { type: 'system', id: 'intake' },
      at: new Date().toISOString(),
      idempotencyKey: `pg-create-${suffix}`,
    });
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const id = created.needId;
    expect(created.publicId).toMatch(/^N-\d{4,}$/);

    const step = async (actor: { type: 'human' | 'agent' | 'system'; id: string }, command: Command, key: string) => {
      const r = await svc.dispatch(id, command, { actor, at: new Date().toISOString(), idempotencyKey: key });
      expect(r.status, `${command.type}`).toBe('applied');
    };

    await step(
      { type: 'agent', id: 'bot' },
      { type: 'ExtractionCompleted', payload: { need_type: 'food', severity: 'high' } },
      `pg-x-${suffix}`,
    );
    await step({ type: 'human', id: 'U1' }, { type: 'TriageConfirmed', payload: {} }, `pg-t-${suffix}`);

    const need = await svc.getNeed(id);
    expect(need?.state).toBe('OPEN');
    expect(need?.severity).toBe('high');

    // needs.status is the projection cache — verify the row was updated.
    const row = await pool.query<{ status: string; type: string }>('SELECT status, type FROM needs WHERE id = $1', [
      id,
    ]);
    expect(row.rows[0]?.status).toBe('OPEN');
    expect(row.rows[0]?.type).toBe('food');

    // Idempotent replay of an applied key is suppressed, not double-appended.
    const replay = await svc.dispatch(
      id,
      { type: 'TriageConfirmed', payload: {} },
      { actor: { type: 'human', id: 'U1' }, at: new Date().toISOString(), idempotencyKey: `pg-t-${suffix}` },
    );
    expect(replay.status).toBe('suppressed');
    expect(await svc.getEvents(id)).toHaveLength(3);
  });

  it('is idempotent on createNeed: a duplicate key creates no second needs row', async () => {
    const svc = new NeedService(store);
    const key = `pg-dup-${Date.now()}`;
    const first = await svc.createNeed({
      source: {},
      actor: { type: 'system', id: 'intake' },
      at: new Date().toISOString(),
      idempotencyKey: key,
    });
    const second = await svc.createNeed({
      source: {},
      actor: { type: 'system', id: 'intake' },
      at: new Date().toISOString(),
      idempotencyKey: key,
    });
    expect(first.status).toBe('created');
    expect(second.status).toBe('deduped');
    if (first.status === 'created' && second.status === 'deduped') {
      expect(second.needId).toBe(first.needId);
      expect(second.publicId).toBe(first.publicId);
    }
  });
});
