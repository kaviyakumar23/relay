import type { IntakeMessageStep, Scenario } from '../../demo/scenarios/schema';
import { createRateLimiter, type RateLimiter } from '../lib/rateLimiter';

// The live flood injector (BUILD-DOC §12, CLAUDE.md 10). It plays a scenario's
// `intake_message` steps into a channel as the labelled "Relay Simulator 🧪"
// identity — every simulated message carries the 🧪 mark so judges never wonder
// whether the flood is real. It is Slack-agnostic: `postMessage` is INJECTED
// (the live wiring posts via chat.postMessage; the hermetic test passes a
// recorder), delays come from an injected `sleep`, and every send goes through
// the shared per-channel rate limiter (~1 msg/s). Volunteer steps are NOT played
// here — those are driven by the drift engine / storyboard driver.

/** The bot identity every simulated message posts under (CLAUDE.md 10). */
export const SIMULATOR_IDENTITY = 'Relay Simulator 🧪';
/** The honesty marker prefixed onto every persona display name. */
export const SIMULATOR_MARK = '🧪';
/** Per-channel send budget shared with the drift engine (CLAUDE.md 8). */
export const DEFAULT_MIN_INTERVAL_MS = 1000;
/** The single rate-limit key: the flood targets one channel (#relay-intake). */
const RATE_LIMIT_KEY = 'relay-intake';

/** The honesty-marked display name for a scenario persona, e.g. `🧪 Selvi M.`. */
export const simulatorPersona = (persona: string): string => `${SIMULATOR_MARK} ${persona}`;

/**
 * The injected sink for a simulated message. The live implementation posts to
 * #relay-intake via chat.postMessage with `username = personaName` (already 🧪
 * marked) and a `:test_tube:` icon, so the pipeline triages it exactly as a real
 * message. The hermetic test passes a recorder.
 */
export type InjectorPostMessage = (text: string, opts: { personaName: string }) => Promise<void>;

export interface FloodInjectorOptions {
  scenario: Scenario;
  postMessage: InjectorPostMessage;
  /** Clock (ms) for the default rate limiter. Default `Date.now`. */
  now?: () => number;
  /** Sleep for a step's `delay_ms`. Default a real setTimeout; inject to virtualize. */
  sleep?: (ms: number) => Promise<void>;
  /** Shared per-channel limiter. Default one built from `minIntervalMs` + `now`/`sleep`. */
  rateLimiter?: RateLimiter;
  /** Per-channel min gap when building the default limiter. Default 1000 ms. */
  minIntervalMs?: number;
}

export interface FloodInjectorSummary {
  /** Count of intake messages actually posted. */
  posted: number;
  /** The scenario's compressed-clock factor (§12.3). */
  slaMultiplier: number;
  /** A judge-facing label for the compressed demo clock (integrator surfaces it). */
  clockNote: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A human-readable note about the demo's compressed SLAs, for the integrator to label. */
export function compressedClockNote(slaMultiplier: number): string {
  const factor = slaMultiplier > 0 ? Math.round(1 / slaMultiplier) : 1;
  return `SLAs compressed ~${factor}× for the demo (sla_multiplier=${slaMultiplier}) so drift fires on camera.`;
}

/**
 * Play a scenario's intake flood into a channel. Each `intake_message` step waits
 * its `delay_ms` (jitter authored into the scenario), then posts under the 🧪
 * simulator persona through the rate limiter. Sequential + serialized, so message
 * order is preserved. Returns a summary the integrator can surface to judges.
 */
export async function runFloodInjector(opts: FloodInjectorOptions): Promise<FloodInjectorSummary> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const limiter = opts.rateLimiter ?? createRateLimiter({ minIntervalMs, clock: now, sleep });

  const intake = opts.scenario.steps.filter((s): s is IntakeMessageStep => s.kind === 'intake_message');
  let posted = 0;
  for (const step of intake) {
    if (step.delay_ms > 0) await sleep(step.delay_ms);
    await limiter.schedule(RATE_LIMIT_KEY, () =>
      opts.postMessage(step.text, { personaName: simulatorPersona(step.persona) }),
    );
    posted += 1;
  }

  return {
    posted,
    slaMultiplier: opts.scenario.sla_multiplier,
    clockNote: compressedClockNote(opts.scenario.sla_multiplier),
  };
}
