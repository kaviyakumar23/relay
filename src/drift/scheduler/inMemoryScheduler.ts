import type { DriftSweep, Scheduler } from './scheduler';

/**
 * Deterministic, timer-free scheduler for tests and the demo runner (kept pattern).
 * There is NO wall clock and NO setInterval: the caller advances a VIRTUAL clock by
 * calling runDue(now), which invokes the registered sweep with that instant. This is
 * how the demo driver fires the hero drift on cue — `runDue(assignedAt + slaMs + 1)`
 * makes an obligation cross its SLA on camera, fully reproducibly, with no flakiness.
 *
 * Re-running runDue at the same (or an earlier) clock is safe: the sweep is
 * idempotent through the ledger's deterministic Nudged keys, so no duplicate nudges
 * or side effects result. This adapter deliberately keeps NO per-obligation state.
 */
export class InMemoryScheduler implements Scheduler {
  private sweep: DriftSweep | null = null;
  private lastRunAt: number | null = null;

  start(sweep: DriftSweep): void {
    this.sweep = sweep;
  }

  /** Fire the sweep as of virtual time `now`. No-op if start() was never called. */
  async runDue(now: number): Promise<void> {
    if (!this.sweep) return;
    this.lastRunAt = now;
    await this.sweep(now);
  }

  /** Virtual time of the most recent runDue, or null if never run (test introspection). */
  get ranAt(): number | null {
    return this.lastRunAt;
  }

  async stop(): Promise<void> {
    this.sweep = null;
  }
}
