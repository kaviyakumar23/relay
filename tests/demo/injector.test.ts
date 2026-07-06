import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type IntakeMessageStep, parseScenario } from '../../demo/scenarios/schema';
import { runFloodInjector, SIMULATOR_MARK, simulatorPersona } from '../../src/demo/injector';

// The live flood injector, driven with a recorder `postMessage` + injected sleep —
// no Slack, no real waiting. It plays flood-1's intake messages (the exact scenario
// the storyboard driver + `npm run demo` use) and marks every one 🧪.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);
const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
const intakeSteps = scenario.steps.filter((s): s is IntakeMessageStep => s.kind === 'intake_message');

interface Recorded {
  text: string;
  personaName: string;
}

describe('runFloodInjector', () => {
  it('plays every intake message as a 🧪 simulator persona, in order', async () => {
    const posts: Recorded[] = [];
    const summary = await runFloodInjector({
      scenario,
      postMessage: async (text, opts) => {
        posts.push({ text, personaName: opts.personaName });
      },
      now: () => 0,
      sleep: async () => {},
    });

    // One post per intake step (14), volunteer steps ignored.
    expect(summary.posted).toBe(intakeSteps.length);
    expect(posts).toHaveLength(intakeSteps.length);

    // Order preserved; text matches the scenario verbatim.
    expect(posts.map((p) => p.text)).toEqual(intakeSteps.map((s) => s.text));

    // Every persona carries the honesty marker (CLAUDE.md 10).
    expect(posts.map((p) => p.personaName)).toEqual(intakeSteps.map((s) => simulatorPersona(s.persona)));
    for (const p of posts) {
      expect(p.personaName.startsWith(`${SIMULATOR_MARK} `)).toBe(true);
    }
  });

  it('waits each step’s delay_ms through the injected sleep (and skips zero delays)', async () => {
    const slept: number[] = [];
    await runFloodInjector({
      scenario,
      postMessage: async () => {},
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
      minIntervalMs: 0, // isolate scenario delays from the rate limiter's spacing
    });
    const expectedDelays = intakeSteps.map((s) => s.delay_ms).filter((d) => d > 0);
    expect(slept).toEqual(expectedDelays);
  });

  it('surfaces the scenario’s compressed-clock note for the integrator', async () => {
    const summary = await runFloodInjector({
      scenario,
      postMessage: async () => {},
      now: () => 0,
      sleep: async () => {},
    });
    expect(summary.slaMultiplier).toBe(scenario.sla_multiplier);
    // flood-1 compresses 0.02 → ~50×.
    expect(summary.clockNote).toContain('50×');
    expect(summary.clockNote).toContain(String(scenario.sla_multiplier));
  });

  it('respects an externally supplied rate limiter (per-channel budget)', async () => {
    const scheduled: string[] = [];
    let posted = 0;
    const summary = await runFloodInjector({
      scenario,
      postMessage: async () => {
        posted += 1;
      },
      now: () => 0,
      sleep: async () => {},
      rateLimiter: {
        schedule: async (key, fn) => {
          scheduled.push(key);
          return fn();
        },
      },
    });
    // Every send went through the injected limiter, on a single channel key.
    expect(scheduled).toHaveLength(intakeSteps.length);
    expect(new Set(scheduled).size).toBe(1);
    expect(posted).toBe(summary.posted);
  });
});
