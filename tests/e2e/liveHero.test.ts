import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { evaluateLiveHero } from '../../src/demo/driver';

// The LIVE self-serve hero (§F5) proven through the driver on the REAL flood-1 scenario + seed
// roster — the live analog of evidence/hero_e2e that `npm run demo` also prints. evaluateLiveHero
// plays the flood into a fresh hermetic assembly, runs runLiveHeroDemo (stub side effects, virtual
// clock), and reads the ledger + rendered App Home back: the driven need reaches CLOSED reassigned
// to a second volunteer with a complete packet, and the App Home board renders every §F2 section.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

describe('live_hero — hermetic e2e via the driver', () => {
  it('drives the full live chain to CLOSED and renders the App Home board', async () => {
    const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
    const results = await evaluateLiveHero(scenario);

    // Both live_hero asserts are evaluated…
    expect(results.map((r) => r.assert).sort()).toEqual(['app_home_board', 'hero_live_e2e']);
    // …and both pass (the detail is surfaced on failure for a precise message).
    for (const r of results) expect(r, r.detail).toMatchObject({ pass: true });
  });
});
