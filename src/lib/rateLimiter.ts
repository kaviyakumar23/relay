// A tiny per-key min-interval (token-bucket-of-one) limiter. Relay's per-channel
// send budget is ~1 msg/s (CLAUDE.md 8) and the injector + drift engine share it,
// so calls are (a) SERIALIZED per key — same key never overlaps — and (b) SPACED
// so consecutive starts for a key are at least `minIntervalMs` apart. No deps: a
// setTimeout-based sleep by default, with an injectable clock + sleep so tests can
// drive it on a virtual clock (no real waiting, no flakiness).

export interface RateLimiterOptions {
  /** Minimum start-to-start gap between two calls sharing a key (ms). */
  minIntervalMs: number;
  /** Monotonic-ish clock in ms. Default `Date.now`. */
  clock?: () => number;
  /** Sleep for `ms`. Default a real setTimeout promise; inject to virtualize time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /**
   * Run `fn` under the budget for `key`: it waits for any in-flight call on the
   * same key (serialize), then delays until at least `minIntervalMs` has passed
   * since the previous call on that key started (space). Resolves/rejects with
   * `fn`'s result. Different keys are independent.
   */
  schedule<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const minInterval = Math.max(0, opts.minIntervalMs);
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;

  // Per-key serialization tail (a promise chain that never rejects) + the clock
  // reading of the previous call's start, so spacing is measured start-to-start.
  const tails = new Map<string, Promise<void>>();
  const lastStart = new Map<string, number>();

  async function run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = lastStart.get(key);
    if (prev !== undefined) {
      const wait = prev + minInterval - clock();
      if (wait > 0) await sleep(wait);
    }
    lastStart.set(key, clock());
    return await fn();
  }

  return {
    schedule<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      // Chain regardless of the previous call's outcome so one failure never wedges
      // the key. The returned promise carries fn's result to the caller.
      const result = prev.then(
        () => run(key, fn),
        () => run(key, fn),
      );
      // The tail is kept settled (never rejected) so the next schedule always chains.
      tails.set(
        key,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
  };
}
