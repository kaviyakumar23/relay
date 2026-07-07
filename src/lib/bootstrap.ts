import pg from 'pg';
import { logger } from './logger';
import { migrate } from './migrate';

// Startup migration guard (review finding: migrations were a manual, out-of-band step,
// so a fresh ECS task booted "healthy" against an empty schema). Run this on every boot
// before serving so the schema is present when the first request lands. Safe to call
// unconditionally: no DATABASE_URL ⇒ in-memory mode ⇒ no-op; migrate() tracks _migrations
// so re-runs only apply what's new.

// Fixed advisory-lock key ("RELY") so concurrent boots (multiple ECS tasks rolling out at
// once) serialize migrations instead of racing on _migrations. Held on a dedicated session
// that Postgres frees automatically if the task dies mid-migration.
const MIGRATION_LOCK_KEY = 0x52454c59;

/**
 * Idempotently apply pending migrations at boot and return the names applied
 * (empty when the schema is already current or when running in-memory).
 */
export async function runStartupMigrations(databaseUrl: string): Promise<string[]> {
  if (!databaseUrl) {
    logger.info('bootstrap: no DATABASE_URL — skipping startup migrations (in-memory mode)');
    return [];
  }

  const lockClient = new pg.Client({ connectionString: databaseUrl });
  await lockClient.connect();
  try {
    // Blocks until any concurrently-booting task releases the lock; that task will have
    // applied the schema, so migrate() then finds nothing to do (idempotent).
    await lockClient.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const applied = await migrate(databaseUrl);
    if (applied.length) {
      logger.info({ applied }, `bootstrap: applied ${applied.length} migration(s) on boot`);
    } else {
      logger.info('bootstrap: schema already current on boot (no migrations applied)');
    }
    return applied;
  } finally {
    try {
      await lockClient.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (err) {
      logger.warn({ err }, 'bootstrap: advisory unlock failed (session close will release it)');
    }
    await lockClient.end();
  }
}
