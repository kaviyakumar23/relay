import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { buildHermeticAssembly, evaluateDrift, runScenario } from '../../src/demo/driver';

// Drift/reassign hero e2e (BUILD-DOC §F4/§16.2). Drives flood-1 through the same hermetic
// assembly the live app + demo use, then exercises the drift evaluation: a self-claim stamps a
// compressed SLA, the in-memory scheduler's virtual clock fires at-risk (a DM nudge) then
// overdue, the volunteer releases, a reassignment card is posted, and the coordinator hands the
// obligation to a SECOND volunteer. Everything is read from the ledger / recorded notifications.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

describe('drift e2e — SLA nudge → overdue → release → reassignment', () => {
  it('passes both drift expectations and leaves the obligation with a second volunteer', async () => {
    const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
    const a = buildHermeticAssembly();
    const run = await runScenario(scenario, a);
    expect(run.intakeSteps).toBe(14);

    const results = await evaluateDrift(scenario, a, run);
    // Both drift expectations are evaluated and pass.
    expect(results.map((r) => r.assert).sort()).toEqual(['nudge_before_overdue', 'reassign_after_release']);
    for (const r of results) expect(r, r.detail).toMatchObject({ pass: true });

    // The at-risk crossing DM'd the claiming volunteer (SEED_U03) with the three reply buttons.
    const claimant = 'SEED_U03';
    const dm = a.notifier.dms.find((d) => d.userId === claimant);
    expect(dm).toBeDefined();

    // A reassignment card was posted to the dispatch channel (overdue sweep + post-release).
    expect(a.notifier.dispatchPosts.length).toBeGreaterThanOrEqual(1);

    // The Velachery food need (m01) ends CLAIMED by a DIFFERENT volunteer, on a fresh SLA.
    const m01Ts = [...run.stepIdByTs.entries()].find(([, id]) => id === 'm01')?.[0];
    const needs = await a.service.listNeeds();
    const m01 = needs.find((n) => n.source.ts === m01Ts);
    expect(m01).toBeDefined();
    if (m01 === undefined) throw new Error('m01 not found');
    expect(m01.assigned_volunteer_id).not.toBeNull();
    expect(m01.assigned_volunteer_id).not.toBe(claimant);
    expect(['CLAIMED', 'IN_PROGRESS']).toContain(m01.state);
    expect(m01.sla_due_at).not.toBeNull();

    // The ledger recorded both drift crossings on m01.
    const kinds = (await a.service.getEvents(m01.need_id))
      .filter((e) => e.type === 'Nudged')
      .map((e) => (e.type === 'Nudged' ? e.payload.kind : undefined));
    expect(kinds).toContain('at_risk');
    expect(kinds).toContain('overdue');
  });
});
