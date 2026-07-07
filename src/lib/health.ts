import type pg from 'pg';
import { logger } from './logger';

// Deep health probe backing GET /healthz (BUILD-DOC §9, infra ALB target check).
// The old handler returned a static 200, so a task with a dead Postgres/Redis still
// reported healthy and kept taking traffic through the whole judging window. This
// probes the substrate that actually matters and is pure + injectable: pass a stub
// pool / ping in tests, the live pg.Pool + ioredis `.ping` in prod.

export type CheckStatus = 'ok' | 'skip' | 'fail';

export interface HealthDeps {
  /** Live Postgres pool, or null/undefined in in-memory mode (→ 'skip'). */
  pool?: pg.Pool | null;
  /** Redis PING seam (e.g. ioredis `() => redis.ping()`); absent ⇒ 'skip'. */
  redisPing?: () => Promise<string>;
  /** Per-probe timeout so a stalled dependency can't wedge the health endpoint. */
  timeoutMs?: number;
}

export interface HealthReport {
  ok: boolean;
  checks: Record<string, CheckStatus>;
}

const DEFAULT_TIMEOUT_MS = 1000;

/** Race a probe against a timer so a hung socket surfaces as 'fail', not a hang. */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePostgres(pool: pg.Pool | null | undefined, timeoutMs: number): Promise<CheckStatus> {
  if (!pool) return 'skip';
  try {
    await withTimeout(pool.query('select 1'), timeoutMs, 'postgres healthcheck');
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'health: postgres probe failed');
    return 'fail';
  }
}

async function probeRedis(ping: (() => Promise<string>) | undefined, timeoutMs: number): Promise<CheckStatus> {
  if (!ping) return 'skip';
  try {
    await withTimeout(ping(), timeoutMs, 'redis healthcheck');
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'health: redis probe failed');
    return 'fail';
  }
}

/**
 * Deep health check: probes each dependency that is present and reports per-check
 * status. A missing dependency is 'skip' (running that substrate in-memory is a valid,
 * healthy config); a present-but-failing dependency is 'fail' and forces `ok: false`.
 * Probes run in parallel so the endpoint stays within a single timeout window.
 */
export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [postgres, redis] = await Promise.all([
    probePostgres(deps.pool, timeoutMs),
    probeRedis(deps.redisPing, timeoutMs),
  ]);
  const checks: Record<string, CheckStatus> = { postgres, redis };
  const ok = !Object.values(checks).some((status) => status === 'fail');
  return { ok, checks };
}
