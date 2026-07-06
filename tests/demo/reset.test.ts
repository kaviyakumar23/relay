import { describe, expect, it } from 'vitest';
import { InMemoryDemoResetStore, resetDemo } from '../../src/demo/reset';

// The demo reset orchestrator, over the in-memory purge store (the hermetic path).
// Idempotency is the contract: run once clears the board; run again is a no-op.

describe('resetDemo', () => {
  it('purges is_demo state and republishes the board on the first run', async () => {
    const store = new InMemoryDemoResetStore({ needs: 14, events: 42, obligations: 2, evidence: 4, sitreps: 1 });
    let homes = 0;
    let archiveCalls = 0;

    const res = await resetDemo({
      store,
      purgeIsDemo: true,
      republishHome: async () => {
        homes += 1;
      },
      archiveCards: async () => {
        archiveCalls += 1;
        return 14;
      },
    });

    expect(res.purged.needs).toBe(14);
    expect(res.purged.events).toBe(42);
    expect(res.purged.obligations).toBe(2);
    expect(res.purged.evidence).toBe(4);
    expect(res.purged.sitreps).toBe(1);
    expect(res.cardsArchived).toBe(14);
    expect(res.homeRepublished).toBe(true);
    expect(res.noop).toBe(false);
    expect(homes).toBe(1);
    expect(archiveCalls).toBe(1);
  });

  it('is multi-run safe: the second run purges nothing and reports a no-op', async () => {
    const store = new InMemoryDemoResetStore({ needs: 14, events: 42, obligations: 2 });
    const first = await resetDemo({ store, purgeIsDemo: true });
    expect(first.noop).toBe(false);

    const second = await resetDemo({ store, purgeIsDemo: true, archiveCards: async () => 0 });
    expect(second.purged).toEqual({ needs: 0, events: 0, obligations: 0, evidence: 0, volunteers: 0, sitreps: 0 });
    expect(second.cardsArchived).toBe(0);
    expect(second.noop).toBe(true);
  });

  it('purgeIsDemo=false is a safety gate: it deletes nothing, rows survive for a real reset', async () => {
    const store = new InMemoryDemoResetStore({ needs: 14, events: 42 });

    const guarded = await resetDemo({ store, purgeIsDemo: false });
    expect(guarded.purged.needs).toBe(0);
    expect(guarded.noop).toBe(true);

    // The store still holds its rows: a real reset can still purge them.
    const real = await resetDemo({ store, purgeIsDemo: true });
    expect(real.purged.needs).toBe(14);
    expect(real.purged.events).toBe(42);
  });

  it('skips the purge cleanly when no store is supplied (republish-only)', async () => {
    let homes = 0;
    const res = await resetDemo({
      purgeIsDemo: true,
      republishHome: async () => {
        homes += 1;
      },
    });
    expect(res.purged.needs).toBe(0);
    expect(res.homeRepublished).toBe(true);
    expect(res.noop).toBe(true);
    expect(homes).toBe(1);
  });

  it('reports a duration under the 30s idempotency budget', async () => {
    const store = new InMemoryDemoResetStore({ needs: 200, events: 900 });
    const res = await resetDemo({ store, purgeIsDemo: true });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.durationMs).toBeLessThan(30_000);
  });
});
