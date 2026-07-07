import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/lib/migrate';
import { PgVolunteerStore, type Volunteer } from '../../src/match/volunteerStore';

// Real-Postgres round-trip for the volunteer registry (BUILD-DOC §F3). Skipped unless
// DATABASE_URL is set. Volunteers carry no beneficiary PII and the table has no
// append-only trigger, so this file cleans up its own run-scoped rows by slack_user_id.
const DB = process.env.DATABASE_URL;

describe.skipIf(!DB)('PgVolunteerStore (integration)', () => {
  let pool: pg.Pool;
  let store: PgVolunteerStore;
  const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const createdUsers: string[] = [];

  // A run-scoped slack_user_id, tracked so afterAll can delete exactly what we made.
  const uid = (name: string): string => {
    const id = `U-${name}-${run}`;
    createdUsers.push(id);
    return id;
  };

  // Build a full roster row from the two required identity fields + optional overrides.
  const vol = (overrides: Partial<Volunteer> & Pick<Volunteer, 'slack_user_id' | 'display_name'>): Volunteer => ({
    skills: [],
    languages: [],
    home_locality: null,
    radius_km: 5,
    capacity_per_day: 2,
    availability: {},
    active_load: 0,
    is_demo: true,
    ...overrides,
  });

  beforeAll(async () => {
    await migrate(DB);
    pool = new pg.Pool({ connectionString: DB });
    store = new PgVolunteerStore({ pool });
  });

  afterAll(async () => {
    if (pool) {
      if (createdUsers.length > 0) {
        await pool.query('DELETE FROM volunteers WHERE slack_user_id = ANY($1)', [createdUsers]);
      }
      await pool.end();
    }
  });

  it('upserts and round-trips a volunteer by slack_user_id (DB mints a uuid)', async () => {
    const slack = uid('rai');
    await store.upsert(
      vol({
        slack_user_id: slack,
        display_name: 'Rai Kumar',
        skills: ['medical', 'driver'],
        languages: ['en', 'ta'],
        radius_km: 8,
        capacity_per_day: 4,
        availability: { shift: 'day' },
      }),
    );

    const got = await store.getBySlackUser(slack);
    expect(got).not.toBeNull();
    expect(got?.slack_user_id).toBe(slack);
    expect(got?.display_name).toBe('Rai Kumar');
    expect(got?.skills).toEqual(['medical', 'driver']);
    expect(got?.languages).toEqual(['en', 'ta']);
    expect(got?.radius_km).toBe(8);
    expect(got?.capacity_per_day).toBe(4);
    expect(got?.availability).toEqual({ shift: 'day' });
    expect(got?.is_demo).toBe(true);
    expect(typeof got?.id).toBe('string'); // gen_random_uuid() minted a real uuid
  });

  it('getBySlackUser returns null for an unknown volunteer', async () => {
    expect(await store.getBySlackUser(`U-nobody-${run}`)).toBeNull();
  });

  it('upsert twice on the same slack_user_id updates in place and preserves active_load', async () => {
    const slack = uid('devi');
    await store.upsert(vol({ slack_user_id: slack, display_name: 'Devi One', skills: ['food'] }));
    await store.incrementLoad(slack, 2); // active_load → 2

    await store.upsert(vol({ slack_user_id: slack, display_name: 'Devi Two', skills: ['water', 'shelter'] }));

    const got = await store.getBySlackUser(slack);
    expect(got?.display_name).toBe('Devi Two'); // profile fields updated
    expect(got?.skills).toEqual(['water', 'shelter']);
    // Re-onboarding must NOT reset accumulated load — ON CONFLICT leaves active_load alone.
    expect(got?.active_load).toBe(2);

    // The unique constraint on slack_user_id means one row, not two.
    const count = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM volunteers WHERE slack_user_id = $1',
      [slack],
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('incrementLoad adjusts by delta, clamps at zero, and no-ops on unknown users', async () => {
    const slack = uid('mani');
    await store.upsert(vol({ slack_user_id: slack, display_name: 'Mani' }));

    await store.incrementLoad(slack, 3);
    expect((await store.getBySlackUser(slack))?.active_load).toBe(3);

    await store.incrementLoad(slack, -10); // greatest(0, active_load + delta) clamps at 0
    expect((await store.getBySlackUser(slack))?.active_load).toBe(0);

    const ghost = uid('ghost');
    await store.incrementLoad(ghost, 5); // UPDATE affects 0 rows → no throw, no insert
    expect(await store.getBySlackUser(ghost)).toBeNull();
  });

  it('list returns volunteers ordered by display_name', async () => {
    const zeta = uid('zeta');
    const alpha = uid('alpha');
    await store.upsert(vol({ slack_user_id: zeta, display_name: `Zeta ${run}` }));
    await store.upsert(vol({ slack_user_id: alpha, display_name: `Alpha ${run}` }));

    const names = (await store.list()).map((v) => v.display_name);
    const ai = names.indexOf(`Alpha ${run}`);
    const zi = names.indexOf(`Zeta ${run}`);
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(zi).toBeGreaterThan(ai); // ORDER BY display_name ASC ⇒ Alpha precedes Zeta
  });
});
