import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/lib/rateLimiter';

// The per-key min-interval limiter, driven on a VIRTUAL clock: `sleep` advances a
// mutable `now`, so spacing is asserted deterministically with no real waiting.
function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number): Promise<void> => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('spaces consecutive calls on one key by minIntervalMs (start-to-start)', async () => {
    const vc = virtualClock();
    const limiter = createRateLimiter({ minIntervalMs: 1000, clock: vc.now, sleep: vc.sleep });
    const starts: number[] = [];
    const record = () => {
      starts.push(vc.now());
    };
    // Scheduled synchronously in sequence → chained in order on the same key.
    await Promise.all([
      limiter.schedule('chan', record),
      limiter.schedule('chan', record),
      limiter.schedule('chan', record),
    ]);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('preserves call order per key', async () => {
    const vc = virtualClock();
    const limiter = createRateLimiter({ minIntervalMs: 500, clock: vc.now, sleep: vc.sleep });
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => limiter.schedule('k', () => order.push(n))));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('keys are independent — a busy key never delays another', async () => {
    const vc = virtualClock();
    const limiter = createRateLimiter({ minIntervalMs: 1000, clock: vc.now, sleep: vc.sleep });
    const startA: number[] = [];
    const startB: number[] = [];
    await Promise.all([
      limiter.schedule('a', () => startA.push(vc.now())),
      limiter.schedule('b', () => startB.push(vc.now())),
    ]);
    // First call on each key runs immediately (no prior start to space against).
    expect(startA).toEqual([0]);
    expect(startB).toEqual([0]);
  });

  it('does not wait when enough time already elapsed since the last call', async () => {
    const vc = virtualClock();
    const limiter = createRateLimiter({ minIntervalMs: 1000, clock: vc.now, sleep: vc.sleep });
    let firstStart = -1;
    let secondStart = -1;
    await limiter.schedule('k', () => {
      firstStart = vc.now();
    });
    vc.advance(5000); // more than minInterval passes between calls
    await limiter.schedule('k', () => {
      secondStart = vc.now();
    });
    expect(firstStart).toBe(0);
    expect(secondStart).toBe(5000); // ran immediately, no extra spacing added
  });

  it('propagates the function result to the caller', async () => {
    const limiter = createRateLimiter({ minIntervalMs: 0 });
    expect(await limiter.schedule('k', () => 42)).toBe(42);
    expect(await limiter.schedule('k', async () => 'ok')).toBe('ok');
  });

  it('a rejecting call does not wedge the key: later calls still run', async () => {
    const vc = virtualClock();
    const limiter = createRateLimiter({ minIntervalMs: 100, clock: vc.now, sleep: vc.sleep });
    await expect(
      limiter.schedule('k', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await limiter.schedule('k', () => 'recovered')).toBe('recovered');
  });
});
