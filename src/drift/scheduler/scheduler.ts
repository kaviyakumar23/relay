// The drift scheduler seam (BUILD-DOC §F4: "Drift engine (worker, 60s tick)").
// Ported from kept's scheduler shape — an interface with a hermetic in-memory
// adapter and a Redis/BullMQ adapter — but simplified to a REPEATABLE SWEEP: the
// drift engine has no per-obligation timers, it re-scans the ledger every tick and
// lets the projection's is_at_risk / is_drifting flags decide what to act on. So
// the scheduler owns exactly one job: "call the sweep with the current time,
// forever." Idempotency of the resulting nudges is the ledger's job, not the
// scheduler's, which is why re-running a sweep at the same clock is always safe.

/** One drift pass. `now` is epoch ms — real (BullMQ) or virtual (in-memory demo). */
export type DriftSweep = (now: number) => Promise<void>;

export interface Scheduler {
  /** Register the sweep to run on each tick. Call once at boot. Idempotent-safe to
   * re-call (replaces the registered sweep); does no work until the first tick. */
  start(sweep: DriftSweep): void;
  /** Release timers / connections. Safe to call when never started. */
  stop(): Promise<void>;
}
