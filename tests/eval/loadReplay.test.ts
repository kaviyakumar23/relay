import { describe, expect, it } from 'vitest';
import { intakeSteps, loadFloodScenario, percentile, replayIntakeFlood, runLoadReplay } from '../../eval/loadReplay';

// `npm run load` — a MEASURED, local/hermetic intake-throughput replay. These tests assert the
// STRUCTURE + invariants of the measurement (percentile math, message accounting, ordering of
// p50 ≤ p95 ≤ p99), not the wall-clock numbers themselves (which vary per machine).

describe('percentile', () => {
  it('returns 0 for an empty array and the sole value for a singleton', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([7], 95)).toBe(7);
  });

  it('interpolates between ranks and clamps p to [0,100]', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 100)).toBe(5);
    expect(percentile(xs, 50)).toBe(3);
    expect(percentile(xs, 25)).toBe(2);
    expect(percentile(xs, -10)).toBe(1); // clamped low
    expect(percentile(xs, 999)).toBe(5); // clamped high
  });
});

describe('intakeSteps', () => {
  it('extracts exactly the flood scenario intake messages', () => {
    const steps = intakeSteps(loadFloodScenario());
    expect(steps.length).toBe(14);
    expect(steps.every((s) => s.kind === 'intake_message')).toBe(true);
  });
});

describe('replayIntakeFlood', () => {
  it('times one latency per (iteration, message)', async () => {
    const result = await replayIntakeFlood({ iterations: 2 });
    expect(result.messagesPerIteration).toBe(14);
    expect(result.iterations).toBe(2);
    expect(result.latenciesMs.length).toBe(28);
    expect(result.latenciesMs.every((ms) => ms >= 0 && Number.isFinite(ms))).toBe(true);
    expect(result.totalWallMs).toBeGreaterThan(0);
  });
});

describe('runLoadReplay', () => {
  it('produces a labelled report with ordered percentiles and positive throughput', async () => {
    const r = await runLoadReplay({ iterations: 3 });
    expect(r.environment).toBe('local/hermetic');
    expect(r.scenarioId).toBe('flood-1');
    expect(r.totalMessages).toBe(42);
    expect(r.messagesPerIteration).toBe(14);
    // Percentiles are monotonic and bounded by the observed min/max.
    expect(r.minMs).toBeLessThanOrEqual(r.p50Ms);
    expect(r.p50Ms).toBeLessThanOrEqual(r.p95Ms);
    expect(r.p95Ms).toBeLessThanOrEqual(r.p99Ms);
    expect(r.p99Ms).toBeLessThanOrEqual(r.maxMs);
    expect(r.throughputPerSec).toBeGreaterThan(0);
    for (const v of [r.minMs, r.meanMs, r.p50Ms, r.p95Ms, r.p99Ms, r.maxMs, r.totalWallMs]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
