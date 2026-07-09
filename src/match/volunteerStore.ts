import pg from 'pg';

// Volunteer registry (BUILD-DOC §F3). The roster the matcher scores against. The
// `Volunteer` type mirrors the `volunteers` table columns 1:1 (db/migrations/001_init.sql)
// so the Pg and in-memory stores return byte-identical shapes and the scorer never
// learns which backend answered. slack_user_id is the stable business key (unique in
// the table); everything downstream — MatchSuggested candidates, the Assign action id,
// incrementLoad — addresses a volunteer by slack_user_id, never the DB uuid, so the
// hermetic in-memory path needs no uuid minting.
//
// No PII lives here: a volunteer's Slack id + display name are workspace-public, and
// beneficiary contact never touches this table (that lives only in contact_vault).

const { Pool } = pg;

/** One roster entry — mirrors the `volunteers` table columns. */
export interface Volunteer {
  /** DB uuid; absent for in-memory / freshly-built rows (slack_user_id is the business key). */
  id?: string;
  slack_user_id: string;
  display_name: string;
  skills: string[];
  languages: string[];
  /** localities.id (gazetteer), or null when the home locality is unknown/unresolved. */
  home_locality: number | null;
  radius_km: number;
  capacity_per_day: number;
  /** Opaque availability descriptor (jsonb). The scorer reads it pragmatically; see scorer.ts. */
  availability: Record<string, unknown>;
  active_load: number;
  is_demo: boolean;
  /** True for a roster entry that is an AI AGENT pledger, not a human volunteer (Moonshot #2 —
   * pledge_support registers one for the pledging agent/org). Optional so every existing seed /
   * test row compiles unchanged; normalize() defaults it to false. A confirmed agent obligation
   * is still tracked with the SAME SLA/drift/evidence machinery as a human's. */
  is_agent?: boolean;
}

/** The registry seam. In-memory for tests + demo; Postgres in production. */
export interface VolunteerStore {
  /** Insert or update by slack_user_id. active_load is preserved across re-onboarding. */
  upsert(v: Volunteer): Promise<void>;
  getBySlackUser(slackUserId: string): Promise<Volunteer | null>;
  list(): Promise<Volunteer[]>;
  /** Adjust the volunteer's active_load by delta (clamped at 0), keyed by slack_user_id. */
  incrementLoad(slackUserId: string, delta: number): Promise<void>;
}

/** Defensive deep-ish copy so callers can't mutate a store's internal state. */
function cloneVolunteer(v: Volunteer): Volunteer {
  return {
    ...v,
    skills: [...v.skills],
    languages: [...v.languages],
    availability: { ...v.availability },
  };
}

/** Normalize a partially-specified upsert payload into a full row (defaults for optionals). */
function normalize(v: Volunteer): Volunteer {
  return {
    ...cloneVolunteer(v),
    radius_km: v.radius_km ?? 5,
    capacity_per_day: v.capacity_per_day ?? 2,
    active_load: v.active_load ?? 0,
    is_demo: v.is_demo ?? false,
    is_agent: v.is_agent ?? false,
  };
}

/**
 * Hermetic registry: a Map keyed by slack_user_id. Used by every unit test and by
 * `npm run demo`. upsert preserves an existing row's active_load (like the Pg
 * ON CONFLICT below) so re-onboarding never resets accumulated load.
 */
export class InMemoryVolunteerStore implements VolunteerStore {
  private readonly byUser = new Map<string, Volunteer>();

  constructor(seed: Volunteer[] = []) {
    for (const v of seed) this.byUser.set(v.slack_user_id, normalize(v));
  }

  async upsert(v: Volunteer): Promise<void> {
    const existing = this.byUser.get(v.slack_user_id);
    const next = normalize(v);
    if (existing) next.active_load = existing.active_load; // preserve load across re-onboarding
    this.byUser.set(v.slack_user_id, next);
  }

  async getBySlackUser(slackUserId: string): Promise<Volunteer | null> {
    const found = this.byUser.get(slackUserId);
    return found ? cloneVolunteer(found) : null;
  }

  async list(): Promise<Volunteer[]> {
    return [...this.byUser.values()].sort((a, b) => a.display_name.localeCompare(b.display_name)).map(cloneVolunteer);
  }

  async incrementLoad(slackUserId: string, delta: number): Promise<void> {
    const found = this.byUser.get(slackUserId);
    if (!found) return; // unknown volunteer → no-op (matches Pg UPDATE affecting 0 rows)
    found.active_load = Math.max(0, found.active_load + delta);
  }
}

interface VolunteerRow {
  id: string;
  slack_user_id: string;
  display_name: string;
  skills: string[];
  languages: string[];
  home_locality: number | null;
  radius_km: number;
  capacity_per_day: number;
  availability: Record<string, unknown> | null;
  active_load: number;
  is_demo: boolean;
  is_agent: boolean;
}

const SELECT_COLS =
  'id, slack_user_id, display_name, skills, languages, home_locality, radius_km, capacity_per_day, availability, active_load, is_demo, is_agent';

/**
 * Production registry on Postgres (maps to the `volunteers` table). Same contract as
 * InMemoryVolunteerStore. Only used behind the DATABASE_URL-gated integration suite;
 * hermetic tests use the in-memory store.
 */
export class PgVolunteerStore implements VolunteerStore {
  private readonly pool: pg.Pool;

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = opts.pool ?? new Pool({ connectionString: opts.connectionString });
  }

  private static rowToVolunteer(row: VolunteerRow): Volunteer {
    return {
      id: row.id,
      slack_user_id: row.slack_user_id,
      display_name: row.display_name,
      skills: row.skills ?? [],
      languages: row.languages ?? [],
      home_locality: row.home_locality,
      radius_km: row.radius_km,
      capacity_per_day: row.capacity_per_day,
      availability: row.availability ?? {},
      active_load: row.active_load,
      is_demo: row.is_demo,
      is_agent: row.is_agent,
    };
  }

  async upsert(v: Volunteer): Promise<void> {
    const n = normalize(v);
    // active_load is intentionally NOT overwritten on conflict — re-onboarding keeps
    // the volunteer's accumulated load. incrementLoad is the only writer of that column.
    await this.pool.query(
      `INSERT INTO volunteers
         (slack_user_id, display_name, skills, languages, home_locality, radius_km, capacity_per_day, availability, active_load, is_demo, is_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (slack_user_id) DO UPDATE SET
         display_name = excluded.display_name, skills = excluded.skills, languages = excluded.languages,
         home_locality = excluded.home_locality, radius_km = excluded.radius_km,
         capacity_per_day = excluded.capacity_per_day, availability = excluded.availability,
         is_demo = excluded.is_demo, is_agent = excluded.is_agent`,
      [
        n.slack_user_id,
        n.display_name,
        n.skills,
        n.languages,
        n.home_locality,
        n.radius_km,
        n.capacity_per_day,
        JSON.stringify(n.availability),
        n.active_load,
        n.is_demo,
        n.is_agent ?? false,
      ],
    );
  }

  async getBySlackUser(slackUserId: string): Promise<Volunteer | null> {
    const res = await this.pool.query<VolunteerRow>(`SELECT ${SELECT_COLS} FROM volunteers WHERE slack_user_id = $1`, [
      slackUserId,
    ]);
    const row = res.rows[0];
    return row ? PgVolunteerStore.rowToVolunteer(row) : null;
  }

  async list(): Promise<Volunteer[]> {
    const res = await this.pool.query<VolunteerRow>(`SELECT ${SELECT_COLS} FROM volunteers ORDER BY display_name ASC`);
    return res.rows.map(PgVolunteerStore.rowToVolunteer);
  }

  async incrementLoad(slackUserId: string, delta: number): Promise<void> {
    await this.pool.query(
      'UPDATE volunteers SET active_load = greatest(0, active_load + $2) WHERE slack_user_id = $1',
      [slackUserId, delta],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
