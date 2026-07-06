import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { buildHermeticAssembly, evaluateDrift, evaluateEvidence, runScenario } from '../../src/demo/driver';

// Evidence/verification HERO finale e2e (BUILD-DOC §F5/§16.2). Continues the drift→reassign arc
// on the SAME hermetic assembly: the second volunteer delivers with photo + locality, a premature
// Verified is REJECTED (close-gating), then recipient confirm + coordinator sign-off complete the
// L3 packet → Verified → Closed. Everything is read back from the ledger / recorded notifications.

const SCENARIO_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);

describe('evidence e2e — deliver → close-gating → recipient confirm → sign-off → Verified → Closed', () => {
  it('passes both evidence expectations and closes m01 on a complete packet with human-signed gates', async () => {
    const scenario = parseScenario(readFileSync(SCENARIO_URL, 'utf8'));
    const a = buildHermeticAssembly();
    const run = await runScenario(scenario, a);
    expect(run.intakeSteps).toBe(14);

    // The drift arc must run first — it leaves m01 reassigned to a SECOND volunteer (CLAIMED).
    const drift = await evaluateDrift(scenario, a, run);
    for (const r of drift) expect(r, r.detail).toMatchObject({ pass: true });

    const results = await evaluateEvidence(scenario, a, run);
    expect(results.map((r) => r.assert).sort()).toEqual(['close_requires_evidence', 'hero_e2e']);
    for (const r of results) expect(r, r.detail).toMatchObject({ pass: true });

    // Locate m01 and read the final ledger truth.
    const m01Ts = [...run.stepIdByTs.entries()].find(([, id]) => id === 'm01')?.[0];
    const needs = await a.service.listNeeds();
    const m01 = needs.find((n) => n.source.ts === m01Ts);
    expect(m01).toBeDefined();
    if (m01 === undefined) throw new Error('m01 not found');

    // Closed on a complete high-severity packet (photo + locality + recipient + sign-off).
    expect(m01.state).toBe('CLOSED');
    const kinds = m01.evidence.map((e) => e.kind).sort();
    expect(kinds).toEqual(['coordinator_signoff', 'locality_confirm', 'photo', 'recipient_confirm']);

    const events = await a.service.getEvents(m01.need_id);

    // The full chain is present in the log, and there is NO auto-merge.
    const types = events.map((e) => e.type);
    for (const t of [
      'Claimed',
      'ClaimReleased',
      'Assigned',
      'RecipientConfirmed',
      'CoordinatorSignedOff',
      'Verified',
      'Closed',
    ]) {
      expect(types, `missing ${t}`).toContain(t);
    }
    expect(types).not.toContain('DuplicateConfirmed');
    expect(m01.merged_into).toBeNull();

    // Every human-gated event that made it into the log carries a human actor.
    const humanGated = new Set([
      'TriageConfirmed',
      'Assigned',
      'Reassigned',
      'CoordinatorSignedOff',
      'Verified',
      'Closed',
    ]);
    for (const e of events) {
      if (humanGated.has(e.type)) expect(e.actor.type, `${e.type} must be human-signed`).toBe('human');
    }

    // A Verified attempted BEFORE the policy was met never made it into the log (proves gating).
    const verifiedEvents = events.filter((e) => e.type === 'Verified');
    expect(verifiedEvents).toHaveLength(1);

    // The closed card was re-rendered with the "Verified · Closed" banner + the evidence packet.
    const closedUpdate = a.notifier.updates.find(
      (u) => u.needId === m01.need_id && JSON.stringify(u.blocks).includes('Verified · Closed'),
    );
    expect(closedUpdate).toBeDefined();
    expect(JSON.stringify(closedUpdate?.blocks)).toContain('Verification: L3');
  });
});
