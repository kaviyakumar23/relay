import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config';

// Minimal forward-only migrator: applies db/migrations/*.sql in filename order,
// tracked in _migrations. Event-sourced core means logic changes are replays,
// not schema churn (kept convention) — this stays deliberately small.
export async function migrate(databaseUrl = config.databaseUrl): Promise<string[]> {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const dir = path.resolve('db/migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const seen = await client.query('select 1 from _migrations where name = $1', [file]);
      if (seen.rowCount) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into _migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate()
    .then((applied) => {
      console.error(`migrations applied: ${applied.length ? applied.join(', ') : '(none — up to date)'}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
