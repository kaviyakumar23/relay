import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { type IntakeMessageStep, parseScenario, type Scenario } from '../demo/scenarios/schema';
import { buildHermeticAssembly, injectIntake } from '../src/demo/driver';

// `npm run load` — a MEASURED intake-throughput replay (local/hermetic). It drives the frozen
// flood scenario's intake messages through the EXACT hermetic pipeline `npm run demo` uses
// (memory store · inline queue · memory dedupe · heuristic extraction · recording notifier —
// zero env), timing each message end to end (enqueue → heuristic extraction → dedupe → dispatch
// card), and reports p50/p95/p99 latency + throughput.
//
// HONESTY (the ethos): every number here is MEASURED on THIS machine against the in-memory
// pipeline. It is a local/hermetic engine measurement, NOT a production/Slack-round-trip claim —
// there is no network, no Postgres, no Redis in the loop. The report is labelled local/hermetic
// so it can never be mistaken for a deployment SLA.

const FLOOD_URL = new URL('../demo/scenarios/flood-1.yaml', import.meta.url);

/** Load the frozen flood scenario (default replay corpus). */
export function loadFloodScenario(): Scenario {
  return parseScenario(readFileSync(FLOOD_URL, 'utf8'));
}

/** The intake-message steps of a scenario — the stimulus the load replay times. */
export function intakeSteps(scenario: Scenario): IntakeMessageStep[] {
  return scenario.steps.filter((s): s is IntakeMessageStep => s.kind === 'intake_message');
}

/**
 * Nearest-rank-with-interpolation percentile over an ASCENDING-sorted array. `p` is a percentage
 * in [0, 100]. Empty input ⇒ 0. Pure + deterministic.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sortedAsc[lo] ?? 0;
  const hiVal = sortedAsc[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (rank - lo);
}

export interface ReplayResult {
  /** Per-message end-to-end processing latencies (ms), in the order they were measured. */
  latenciesMs: number[];
  /** Intake messages per iteration. */
  messagesPerIteration: number;
  /** Iterations run. */
  iterations: number;
  /** Total wall-clock of the whole replay (ms), across every iteration + message. */
  totalWallMs: number;
}

export interface ReplayOptions {
  scenario?: Scenario;
  /** How many times to replay the whole flood (each on a fresh, isolated assembly). Default 25. */
  iterations?: number;
}

/**
 * Replay the flood's intake messages through the hermetic pipeline `iterations` times, timing each
 * message end to end. Each iteration builds a FRESH assembly so dedupe/state never leaks between
 * runs (a redelivered idempotency key would otherwise short-circuit and skew the numbers).
 */
export async function replayIntakeFlood(opts: ReplayOptions = {}): Promise<ReplayResult> {
  const scenario = opts.scenario ?? loadFloodScenario();
  const iterations = Math.max(1, opts.iterations ?? 25);
  const steps = intakeSteps(scenario);
  const latenciesMs: number[] = [];

  const wallStart = performance.now();
  for (let iter = 0; iter < iterations; iter++) {
    const a = buildHermeticAssembly();
    let index = 0;
    for (const step of steps) {
      index += 1;
      // A unique event id + ts per (iteration, message) so nothing is transport- or ledger-deduped.
      const ts = `load.${iter}.${String(index).padStart(4, '0')}`;
      const t0 = performance.now();
      await injectIntake(a, {
        eventId: `load:${scenario.id}:${iter}:${step.id}`,
        messageTs: ts,
        userId: `load_${step.persona.replace(/\W+/g, '_')}`,
        text: step.text,
        permalink: `https://relay.local/load/${iter}/${index}`,
      });
      latenciesMs.push(performance.now() - t0);
    }
  }
  const totalWallMs = performance.now() - wallStart;

  return { latenciesMs, messagesPerIteration: steps.length, iterations, totalWallMs };
}

export interface LoadReplayReport {
  scenarioId: string;
  iterations: number;
  messagesPerIteration: number;
  totalMessages: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  totalWallMs: number;
  /** Messages processed per second across the whole replay. */
  throughputPerSec: number;
  /** Provenance label — this is a local, in-memory measurement, never a production claim. */
  environment: 'local/hermetic';
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Run the intake load replay and reduce it to a labelled report. All latency figures are MEASURED
 * on this machine against the in-memory pipeline (local/hermetic) — not a production SLA.
 */
export async function runLoadReplay(opts: ReplayOptions = {}): Promise<LoadReplayReport> {
  const scenario = opts.scenario ?? loadFloodScenario();
  const result = await replayIntakeFlood({ ...opts, scenario });
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  const total = sorted.length;
  const sum = sorted.reduce((n, v) => n + v, 0);
  const mean = total === 0 ? 0 : sum / total;
  const throughputPerSec = result.totalWallMs > 0 ? (total / result.totalWallMs) * 1000 : 0;

  return {
    scenarioId: scenario.id,
    iterations: result.iterations,
    messagesPerIteration: result.messagesPerIteration,
    totalMessages: total,
    minMs: round2(sorted[0] ?? 0),
    meanMs: round2(mean),
    p50Ms: round2(percentile(sorted, 50)),
    p95Ms: round2(percentile(sorted, 95)),
    p99Ms: round2(percentile(sorted, 99)),
    maxMs: round2(sorted[total - 1] ?? 0),
    totalWallMs: round2(result.totalWallMs),
    throughputPerSec: round2(throughputPerSec),
    environment: 'local/hermetic',
  };
}
