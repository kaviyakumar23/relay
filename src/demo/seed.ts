import { readFileSync } from 'node:fs';
import pg from 'pg';
import { z } from 'zod';
import { config } from '../config';

// seed — loads the fictional gazetteer + volunteer roster into Postgres
// (CLAUDE.md: `npm run seed`). Everything is flagged `is_demo=true` so a reset
// can purge it cleanly (rule 10). Idempotent: localities upsert by name,
// volunteers by slack_user_id, so re-running is safe and converges. CLI
// entrypoint — console.error only.

const LOCALITIES_URL = new URL('../../seed/localities.json', import.meta.url);
const VOLUNTEERS_URL = new URL('../../seed/volunteers.json', import.meta.url);

const SKILLS = ['boat', 'medical', 'driver', 'cooking', 'translation', 'tech', 'muscle'] as const;
const LANGUAGES = ['ta', 'en'] as const;

const localitySeedSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});
type LocalitySeed = z.infer<typeof localitySeedSchema>;

const volunteerSeedSchema = z.object({
  slack_user_id: z.string().min(1),
  display_name: z.string().min(1),
  skills: z.array(z.enum(SKILLS)).min(1),
  languages: z.array(z.enum(LANGUAGES)).min(1),
  home_locality: z.string().min(1), // gazetteer name; resolved to localities.id below
  radius_km: z.number().int().positive(),
  capacity_per_day: z.number().int().positive(),
  availability: z.record(z.string(), z.unknown()),
});
type VolunteerSeed = z.infer<typeof volunteerSeedSchema>;

function readSeed<T>(url: URL, schema: z.ZodType<T>, label: string): T[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (err) {
    throw new Error(`seed/${label}.json is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first ? `${label}${first.path.length ? `.${first.path.join('.')}` : ''}` : label;
    throw new Error(`seed/${label}.json failed validation at ${path}: ${first?.message ?? 'unknown'}`);
  }
  return parsed.data;
}

export interface SeedCounts {
  localities: number;
  volunteers: number;
}

export async function seed(databaseUrl = config.databaseUrl): Promise<SeedCounts> {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const localities: LocalitySeed[] = readSeed(LOCALITIES_URL, localitySeedSchema, 'localities');
  const volunteers: VolunteerSeed[] = readSeed(VOLUNTEERS_URL, volunteerSeedSchema, 'volunteers');

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin');

    for (const l of localities) {
      await client.query(
        `insert into localities (name, aliases, lat, lng, is_demo)
         values ($1, $2, $3, $4, true)
         on conflict (name) do update set
           aliases = excluded.aliases, lat = excluded.lat, lng = excluded.lng, is_demo = true`,
        [l.name, l.aliases, l.lat, l.lng],
      );
    }

    // Resolve gazetteer names -> ids (from the whole table, not just this batch)
    // and fail loudly on any volunteer pointing at a locality we don't have.
    const localityRows = await client.query<{ id: number; name: string }>('select id, name from localities');
    const idByName = new Map(localityRows.rows.map((r) => [r.name, r.id]));
    const missing = [...new Set(volunteers.map((v) => v.home_locality))].filter((n) => !idByName.has(n));
    if (missing.length > 0) {
      throw new Error(`volunteers reference unknown localities: ${missing.join(', ')}`);
    }

    for (const v of volunteers) {
      const homeLocalityId = idByName.get(v.home_locality) ?? null;
      await client.query(
        `insert into volunteers
           (slack_user_id, display_name, skills, languages, home_locality, radius_km, capacity_per_day, availability, is_demo)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true)
         on conflict (slack_user_id) do update set
           display_name = excluded.display_name, skills = excluded.skills, languages = excluded.languages,
           home_locality = excluded.home_locality, radius_km = excluded.radius_km,
           capacity_per_day = excluded.capacity_per_day, availability = excluded.availability, is_demo = true`,
        [
          v.slack_user_id,
          v.display_name,
          v.skills,
          v.languages,
          homeLocalityId,
          v.radius_km,
          v.capacity_per_day,
          JSON.stringify(v.availability),
        ],
      );
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    await client.end();
  }

  return { localities: localities.length, volunteers: volunteers.length };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed()
    .then(({ localities, volunteers }) => {
      console.error(`seed complete: ${localities} localities, ${volunteers} volunteers (is_demo=true)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
