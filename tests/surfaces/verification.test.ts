import { describe, expect, it } from 'vitest';
import type { EvidenceKind, ProjectedNeed, Severity } from '../../src/ledger/types';
import { emptyFlags } from '../../src/ledger/types';
import { verificationStatus } from '../../src/surfaces/verification';

// verificationStatus mirrors the engine's close policy (BUILD-DOC §F5 / §6.2 rule 3):
// L1 = photo + locality_confirm · L2 = recipient_confirm · L3 = coordinator_signoff.
// critical|high verify at L3; medium|low at L2. Pure over the projection.

function needWith(severity: Severity, kinds: EvidenceKind[]): ProjectedNeed {
  return {
    need_id: 'need_1',
    state: 'DELIVERED_UNVERIFIED',
    type: 'food',
    severity,
    locality_id: null,
    location_text: null,
    people_count: null,
    languages: [],
    source: {},
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: 'V1',
    obligation_id: null,
    sla_due_at: null,
    evidence: kinds.map((kind, i) => ({ kind, at: `2026-07-06T10:0${i}:00.000Z` })),
    flags: emptyFlags(),
    state_version: 1,
    history_count: 1,
    created_at: '2026-07-06T09:00:00.000Z',
    updated_at: '2026-07-06T10:00:00.000Z',
  };
}

describe('verificationStatus — medium/low (policy L2)', () => {
  it('a recipient confirmation alone meets policy at level 2', () => {
    const v = verificationStatus(needWith('medium', ['recipient_confirm']));
    expect(v.level).toBe(2);
    expect(v.haveL1).toBe(false);
    expect(v.haveL2).toBe(true);
    expect(v.meetsPolicy).toBe(true);
    expect(v.missing).toEqual([]);
    expect(v.requiredLabel).toBe('L2 (recipient confirmation)');
  });

  it('no evidence is level 0 and short a recipient confirmation', () => {
    const v = verificationStatus(needWith('low', []));
    expect(v.level).toBe(0);
    expect(v.meetsPolicy).toBe(false);
    expect(v.missing).toEqual(['recipient_confirm']);
    expect(v.label).toBe('L0 (self-report)');
  });
});

describe('verificationStatus — critical/high (policy L3)', () => {
  it('photo + locality + recipient but no sign-off fails policy, missing only the sign-off', () => {
    const v = verificationStatus(needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm']));
    expect(v.haveL1).toBe(true);
    expect(v.haveL2).toBe(true);
    expect(v.haveL3).toBe(false);
    expect(v.level).toBe(2);
    expect(v.meetsPolicy).toBe(false);
    expect(v.missing).toEqual(['coordinator_signoff']);
    expect(v.requiredLabel).toBe('L3 (photo + location + recipient + sign-off)');
  });

  it('a full packet meets policy at level 3', () => {
    const v = verificationStatus(
      needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
    );
    expect(v.level).toBe(3);
    expect(v.haveL3).toBe(true);
    expect(v.meetsPolicy).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it('a lone photo is level 0 and reports the full missing set in canonical order', () => {
    const v = verificationStatus(needWith('high', ['photo']));
    expect(v.level).toBe(0);
    expect(v.haveL1).toBe(false); // needs locality too
    expect(v.meetsPolicy).toBe(false);
    expect(v.missing).toEqual(['locality_confirm', 'recipient_confirm', 'coordinator_signoff']);
  });

  it('photo + locality reaches L1 but still needs recipient + sign-off', () => {
    const v = verificationStatus(needWith('high', ['photo', 'locality_confirm']));
    expect(v.level).toBe(1);
    expect(v.haveL1).toBe(true);
    expect(v.meetsPolicy).toBe(false);
    expect(v.missing).toEqual(['recipient_confirm', 'coordinator_signoff']);
  });
});
