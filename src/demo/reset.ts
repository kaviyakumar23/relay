import pg from 'pg';

// Idempotent demo teardown (CLAUDE.md 10). Between judge runs the board must reset
// to a clean slate in well under 30s, and a second run must be a safe no-op. All
// demo data is flagged `is_demo`, so the reset purges exactly those rows and leaves
// any real data untouched.
//
// APPEND-ONLY vs. PURGE — the honest bit. `need_events` is append-only, enforced by
// a DB trigger (invariant #1). A demo reset is an administrative teardown of demo
// data, NOT a state transition, so it must not pretend to "delete" through the
// normal path. The Pg impl opens ONE transaction and sets a session flag
// (`relay.allow_purge = on`, via SET LOCAL so it dies with the txn) that a
// purge-aware trigger honours (see PURGE_MODE_TRIGGER_SQL). If that trigger change
// is NOT deployed, the DELETE on need_events RAISES and the whole transaction ROLLS
// BACK — the reset fails loud and never silently violates the invariant. The
// hermetic/demo path uses InMemoryDemoResetStore, which just clears its maps.

/** Row counts purged, per table. */
export interface PurgeCounts {
  needs: number;
  events: number;
  obligations: number;
  evidence: number;
  volunteers: number;
  sitreps: number;
}

const ZERO_COUNTS: PurgeCounts = {
  needs: 0,
  events: 0,
  obligations: 0,
  evidence: 0,
  volunteers: 0,
  sitreps: 0,
};

const COUNT_KEYS = Object.keys(ZERO_COUNTS) as (keyof PurgeCounts)[];

const totalPurged = (c: PurgeCounts): number => COUNT_KEYS.reduce((sum, k) => sum + c[k], 0);

/** The purge seam: one call clears all `is_demo` state and reports what it removed. */
export interface DemoResetStore {
  purgeDemoRows(): Promise<PurgeCounts>;
}

/**
 * In-memory purge store for tests + the hermetic demo path. Seeded with row counts
 * per table; `purgeDemoRows` reports the current counts then clears them, so a
 * second call is a no-op returning zeros.
 */
export class InMemoryDemoResetStore implements DemoResetStore {
  private readonly rows: Record<keyof PurgeCounts, number>;

  constructor(seed: Partial<PurgeCounts> = {}) {
    this.rows = { ...ZERO_COUNTS, ...seed };
  }

  async purgeDemoRows(): Promise<PurgeCounts> {
    const counts: PurgeCounts = { ...this.rows };
    for (const k of COUNT_KEYS) this.rows[k] = 0;
    return counts;
  }
}

export interface PgResetOptions {
  pool?: pg.Pool;
  connectionString?: string;
  /**
   * Also wipe the demo volunteer roster. Default false: the roster + gazetteer are
   * seed REGISTRY that `npm run seed` owns, not per-run demo state, so a judge reset
   * keeps them and the next run can start immediately without re-seeding.
   */
  purgeVolunteers?: boolean;
}

/** DELETE the count from a statement's rowCount (null-safe). */
async function del(client: pg.PoolClient, sql: string): Promise<number> {
  const res = await client.query(sql);
  return res.rowCount ?? 0;
}

/**
 * Production purge on Postgres. Deletes all `is_demo` rows in FK-safe order inside
 * one purge-mode transaction. Needs the purge-aware append-only trigger deployed
 * (PURGE_MODE_TRIGGER_SQL); without it the need_events DELETE raises and the whole
 * transaction rolls back (fail-loud, never a partial purge).
 */
export class PgDemoResetStore implements DemoResetStore {
  private readonly pool: pg.Pool;
  private readonly purgeVolunteers: boolean;

  constructor(opts: PgResetOptions = {}) {
    this.pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString });
    this.purgeVolunteers = opts.purgeVolunteers ?? false;
  }

  async purgeDemoRows(): Promise<PurgeCounts> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Purge-mode escape hatch, scoped to THIS transaction (SET LOCAL). The
      // append-only trigger must honour it (see PURGE_MODE_TRIGGER_SQL); otherwise
      // the need_events DELETE below raises → ROLLBACK, and nothing is removed.
      await client.query("SET LOCAL relay.allow_purge = 'on'");

      // FK-safe order: children before parents. evidence → obligations, then the
      // per-need tables (contact_vault, need_events) before the needs themselves.
      const evidence = await del(client, 'DELETE FROM evidence WHERE is_demo');
      const obligations = await del(client, 'DELETE FROM obligations WHERE is_demo');
      await del(client, 'DELETE FROM contact_vault WHERE need_id IN (SELECT id FROM needs WHERE is_demo)');
      const events = await del(client, 'DELETE FROM need_events WHERE need_id IN (SELECT id FROM needs WHERE is_demo)');
      const needs = await del(client, 'DELETE FROM needs WHERE is_demo');
      const sitreps = await del(client, 'DELETE FROM sitreps WHERE is_demo');
      const volunteers = this.purgeVolunteers ? await del(client, 'DELETE FROM volunteers WHERE is_demo') : 0;

      await client.query('COMMIT');
      return { needs, events, obligations, evidence, volunteers, sitreps };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The recommended migration that lets the reset purge `need_events` (and `audit_log`)
 * WITHOUT loosening the append-only invariant for normal operation: it only permits a
 * mutation when the session flag `relay.allow_purge = on` is set (which the reset sets
 * with SET LOCAL, so it is scoped to the single teardown transaction and to demo rows).
 * This shared function backs both append-only triggers, so during a purge txn only the
 * reset's own scoped DELETEs run. Hand to the DB owner; do NOT run it on the live path.
 */
export const PURGE_MODE_TRIGGER_SQL = `-- Purge-mode escape hatch for demo teardown ONLY (relay.allow_purge = on).
create or replace function relay_forbid_mutation () returns trigger as $$
begin
  if current_setting('relay.allow_purge', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$ language plpgsql;`;

export interface ResetDemoOptions {
  /** The purge seam. Omit to skip the DB purge (e.g. only republish home). */
  store?: DemoResetStore;
  /** Safety gate — must be true to actually delete `is_demo` rows. */
  purgeIsDemo: boolean;
  /** Re-publish the (now empty) App Home / board. Injected by the integrator. */
  republishHome?: () => Promise<void>;
  /** Archive/delete the posted dispatch cards in Slack; returns how many. Optional. */
  archiveCards?: () => Promise<number>;
  /** Clock (ms) for durationMs. Default `Date.now`. */
  clock?: () => number;
}

export interface ResetDemoResult {
  purged: PurgeCounts;
  cardsArchived: number;
  homeRepublished: boolean;
  durationMs: number;
  /** True when the run removed nothing (a safe repeat run). */
  noop: boolean;
}

/**
 * Orchestrate a demo reset: purge `is_demo` state (gated by `purgeIsDemo`), then
 * republish an empty board and archive stale cards. Idempotent — a second run
 * purges nothing and returns `noop: true`. Deterministic and free of any Slack/DB
 * knowledge beyond the injected seams, so it is fully unit-testable.
 */
export async function resetDemo(opts: ResetDemoOptions): Promise<ResetDemoResult> {
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();

  const purged = opts.purgeIsDemo && opts.store ? await opts.store.purgeDemoRows() : { ...ZERO_COUNTS };

  let homeRepublished = false;
  if (opts.republishHome) {
    await opts.republishHome();
    homeRepublished = true;
  }

  const cardsArchived = opts.archiveCards ? await opts.archiveCards() : 0;

  return {
    purged,
    cardsArchived,
    homeRepublished,
    durationMs: clock() - start,
    noop: totalPurged(purged) === 0 && cardsArchived === 0,
  };
}
