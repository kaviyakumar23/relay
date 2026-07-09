import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { runGroupChatBaseline } from '../../src/demo/baseline';
import { runCounterfactual } from '../../src/demo/counterfactual';

// Moonshot #3 — the counterfactual. The baseline's naive rules (docs/BASELINE-RULES.md) must BITE
// on flood-1 (>0 unclaimed, >0 double-served, 0 verified); the Relay side must dedupe the known
// duplicate pairs and verify at least one delivery; the delta is computed from BOTH real runs.
// Everything is deterministic and hermetic (zero env).

const FLOOD = parseScenario(readFileSync(new URL('../../demo/scenarios/flood-1.yaml', import.meta.url), 'utf8'));

describe('runGroupChatBaseline (SIMULATED group-chat rules)', () => {
  it('R1–R4 bite on flood-1: unclaimed and double-served are both >0, verified is 0', async () => {
    const b = await runGroupChatBaseline(FLOOD);

    // R1: no dedupe — one request per intake message.
    expect(b.total_requests).toBe(14);
    // The naive rules leave needs on the floor.
    expect(b.unclaimed).toBeGreaterThan(0);
    expect(b.double_served).toBeGreaterThan(0);
    // R4: a group chat verifies nothing.
    expect(b.verified_deliveries).toBe(0);

    // The exact flood-1 numbers (12-strong seeded roster, 1 unparseable, 2 duplicate contacts).
    expect(b.responder_pool).toBe(12);
    expect(b.unparseable).toBe(1); // m13, the garbled distress call
    expect(b.double_served).toBe(2); // m06 (dup of m02), m10 (dup of m03)
    expect(b.unclaimed).toBe(2); // m13 unparseable + m14 past capacity
    expect(b.claimed).toBe(12);
    expect(b.distinct_served).toBe(10);

    // Counts are internally consistent.
    expect(b.claimed).toBe(b.distinct_served + b.double_served);
    expect(b.total_requests).toBe(b.claimed + b.unclaimed);
  });

  it('the per-request trace pins WHICH requests each rule catches', async () => {
    const b = await runGroupChatBaseline(FLOOD);
    const disp = new Map(b.trace.map((t) => [t.ref, t.disposition]));

    // R1: the two exact-contact duplicates are the double-serves.
    expect(disp.get('m06')).toBe('double_served');
    expect(disp.get('m10')).toBe('double_served');
    // R2: the garbled message is unparseable → unclaimed.
    expect(disp.get('m13')).toBe('unclaimed_unparseable');
    // R3: with 12 responders and 13 actionable requests, the last actionable one overflows.
    expect(disp.get('m14')).toBe('unclaimed_capacity');
    // A clear, distinct incident is simply served.
    expect(disp.get('m02')).toBe('served');
  });

  it('the responder pool drives capacity deterministically (un-rigged): a bigger pool only drops the unparseable one', async () => {
    const roomy = await runGroupChatBaseline(FLOOD, { responderPool: 100 });
    // No capacity overflow now — only the unparseable request goes unclaimed.
    expect(roomy.unclaimed).toBe(roomy.unparseable);
    expect(roomy.unclaimed).toBe(1);
    // The duplicates are still double-served (dedupe is absent regardless of capacity).
    expect(roomy.double_served).toBe(2);
    expect(roomy.verified_deliveries).toBe(0);
  });

  it('is deterministic: two runs are byte-identical', async () => {
    const a = await runGroupChatBaseline(FLOOD);
    const b = await runGroupChatBaseline(FLOOD);
    expect(a).toStrictEqual(b);
  });
});

describe('runCounterfactual (baseline SIMULATED + Relay MEASURED + delta)', () => {
  it('measures Relay from the real ledger: dedupes the known pairs and verifies', async () => {
    const cf = await runCounterfactual('flood-1');

    expect(cf.simulated).toBe(true);
    expect(cf.rules_doc).toBe('docs/BASELINE-RULES.md');

    // Relay side — measured from the actual ledger.
    expect(cf.relay.needs).toBe(14);
    expect(cf.relay.unrouted).toBe(0); // nothing lost
    expect(cf.relay.deduped).toBe(2); // m06→m02, m10→m03 auto-linked
    expect(cf.relay.proposed_merges).toBe(1); // m12→m01 proposed for human merge
    expect(cf.relay.needs_review).toBe(1); // m13 → human review card
    expect(cf.relay.verified).toBeGreaterThanOrEqual(1); // the hero delivery reaches Verified
  });

  it('computes the delta from both real runs', async () => {
    const cf = await runCounterfactual('flood-1');

    // double-serves the baseline incurred that Relay collapsed.
    expect(cf.delta.double_served_avoided).toBe(cf.baseline.double_served);
    expect(cf.delta.double_served_avoided).toBe(2);
    // requests kept owned instead of lost.
    expect(cf.delta.unclaimed_avoided).toBe(cf.baseline.unclaimed - cf.relay.unrouted);
    expect(cf.delta.unclaimed_avoided).toBe(2);
    // verified deliveries gained over the baseline's zero.
    expect(cf.delta.verified_gained).toBe(cf.relay.verified - cf.baseline.verified_deliveries);
    expect(cf.delta.verified_gained).toBeGreaterThanOrEqual(1);

    // The two exact-contact duplicates the baseline double-served are exactly the ones Relay deduped.
    expect(cf.relay.deduped).toBe(cf.baseline.double_served);
  });

  it('is deterministic across runs (numeric outcome is stable; need_ids may differ)', async () => {
    const a = await runCounterfactual('flood-1');
    const b = await runCounterfactual('flood-1');
    expect(a.baseline).toStrictEqual(b.baseline);
    expect(a.relay).toStrictEqual(b.relay);
    expect(a.delta).toStrictEqual(b.delta);
  });

  it('rejects an unsafe scenario name', async () => {
    await expect(runCounterfactual('../secrets')).rejects.toThrow(/invalid scenario name/);
  });
});
