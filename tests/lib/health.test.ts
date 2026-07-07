import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { checkHealth } from '../../src/lib/health';

// checkHealth only ever calls `.query`, so a one-method stand-in is enough. Casting
// through `unknown` keeps the real pg.Pool signature at the call boundary without a
// real socket — the whole point of the injectable design.
function stubPool(query: () => Promise<unknown>): pg.Pool {
  return { query } as unknown as pg.Pool;
}

describe('checkHealth', () => {
  it('reports ok when both probes pass', async () => {
    const res = await checkHealth({
      pool: stubPool(async () => ({ rows: [{ '?column?': 1 }] })),
      redisPing: async () => 'PONG',
    });
    expect(res.ok).toBe(true);
    expect(res.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });

  it('reports fail (ok:false) when the pool query throws', async () => {
    const res = await checkHealth({
      pool: stubPool(async () => {
        throw new Error('ECONNREFUSED');
      }),
      redisPing: async () => 'PONG',
    });
    expect(res.ok).toBe(false);
    expect(res.checks.postgres).toBe('fail');
    expect(res.checks.redis).toBe('ok');
  });

  it('reports fail when the Redis PING rejects', async () => {
    const res = await checkHealth({
      pool: stubPool(async () => ({ rows: [] })),
      redisPing: async () => {
        throw new Error('redis down');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.checks).toEqual({ postgres: 'ok', redis: 'fail' });
  });

  it('skips absent dependencies (in-memory mode) and stays ok', async () => {
    const res = await checkHealth({});
    expect(res.ok).toBe(true);
    expect(res.checks).toEqual({ postgres: 'skip', redis: 'skip' });
  });

  it('treats a null pool as skip (config-driven in-memory substrate)', async () => {
    const res = await checkHealth({ pool: null, redisPing: async () => 'PONG' });
    expect(res.checks.postgres).toBe('skip');
    expect(res.checks.redis).toBe('ok');
    expect(res.ok).toBe(true);
  });

  it('fails a probe that exceeds the timeout instead of hanging', async () => {
    const res = await checkHealth({
      pool: stubPool(() => new Promise<never>(() => undefined)), // never settles
      timeoutMs: 10,
    });
    expect(res.checks.postgres).toBe('fail');
    expect(res.ok).toBe(false);
  });
});
