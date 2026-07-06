import { describe, expect, it } from 'vitest';
import type { NeedEvent } from '../../src/ledger/events';
import { emptyFlags, type NeedState, type ProjectedNeed } from '../../src/ledger/types';
import { computeReportStats, computeSitrepStats, type StatSet } from '../../src/narrate/aggregate';

// Aggregation math (BUILD-DOC §F6 sitrep / §F7 report). Pure functions over a hand-built set
// of projected needs (+ events for the report). These numbers become the ONLY digits a
// narrative may print, so the counts must be exactly right.

const need = (over: Partial<ProjectedNeed>): ProjectedNeed => ({
  need_id: 'n',
  state: 'OPEN',
  type: 'food',
  severity: 'medium',
  locality_id: null,
  location_text: null,
  people_count: null,
  languages: [],
  source: {},
  confidence: {},
  merged_into: null,
  assigned_volunteer_id: null,
  obligation_id: null,
  sla_due_at: null,
  evidence: [],
  flags: emptyFlags(),
  state_version: 1,
  history_count: 1,
  created_at: '2026-07-04T00:00:00.000Z',
  updated_at: '2026-07-04T00:00:00.000Z',
  ...over,
});

const withState = (id: string, state: NeedState, over: Partial<ProjectedNeed> = {}): ProjectedNeed =>
  need({ need_id: id, state, ...over });

const statValue = (stats: StatSet, key: string): number | undefined => stats.find((s) => s.key === key)?.value;

const verifiedEvent = (needId: string, at: string): NeedEvent => ({
  event_id: `${needId}-v`,
  need_id: needId,
  at,
  actor: { type: 'human', id: 'coord' },
  idempotency_key: `${needId}-v`,
  type: 'Verified',
  payload: {},
});

const claimedEvent = (needId: string, at: string, volunteerId: string): NeedEvent => ({
  event_id: `${needId}-c`,
  need_id: needId,
  at,
  actor: { type: 'human', id: 'coord' },
  idempotency_key: `${needId}-c`,
  type: 'Claimed',
  payload: { volunteer_id: volunteerId },
});

describe('computeSitrepStats — live snapshot', () => {
  const now = Date.parse('2026-07-06T10:00:00.000Z');
  const needs: ProjectedNeed[] = [
    withState('n1', 'OPEN', { type: 'food', severity: 'high', locality_id: 1 }),
    withState('n2', 'NEW', { type: 'water', severity: 'medium' }),
    withState('n3', 'OPEN', { type: 'rescue', severity: 'critical', locality_id: 2 }),
    withState('n4', 'CLAIMED', {
      type: 'medical',
      severity: 'critical',
      assigned_volunteer_id: 'V1',
      locality_id: 1,
      flags: { ...emptyFlags(), is_drifting: true },
    }),
    withState('n5', 'IN_PROGRESS', {
      type: 'transport',
      severity: 'low',
      assigned_volunteer_id: 'V2',
      locality_id: 3,
      flags: { ...emptyFlags(), is_at_risk: true },
    }),
    withState('n6', 'DELIVERED_UNVERIFIED', { type: 'food', severity: 'medium', assigned_volunteer_id: 'V3' }),
    withState('n7', 'VERIFIED', {
      type: 'food',
      severity: 'high',
      locality_id: 2,
      updated_at: '2026-07-06T09:00:00.000Z',
    }),
    withState('n8', 'CLOSED', { type: 'water', severity: 'medium', updated_at: '2026-07-06T08:00:00.000Z' }),
    withState('n9', 'NEEDS_REVIEW', { type: 'other', severity: 'low' }),
    withState('n10', 'CANCELLED', { type: 'food' }),
    withState('n11', 'DUPLICATE', { type: 'water' }),
  ];
  const s = computeSitrepStats(needs, now);

  it('counts the live board buckets exactly', () => {
    expect(s.totalActive).toBe(8); // all but CLOSED, CANCELLED, DUPLICATE
    expect(s.open).toBe(3); // n1, n2, n3 (pre-claim states)
    expect(s.openCritical).toBe(2); // n3, n4 (critical, not terminal)
    expect(s.claimed).toBe(1);
    expect(s.inProgress).toBe(1);
    expect(s.deliveredUnverified).toBe(1);
    expect(s.verified).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.needsReview).toBe(1);
  });

  it('counts flags, obligations, today, and localities', () => {
    expect(s.drifting).toBe(1); // n4
    expect(s.atRisk).toBe(1); // n5
    expect(s.activeObligations).toBe(3); // n4, n5, n6 (assigned + claimed/in-progress/delivered)
    expect(s.verifiedToday).toBe(2); // n7 VERIFIED + n8 CLOSED, both updated today
    expect(s.localitiesAffected).toBe(3); // {1, 2, 3} over active needs
  });

  it('breaks down active needs by type and severity (sums to totalActive)', () => {
    expect(s.byType.food).toBe(3); // n1, n6, n7 (n8 closed excluded)
    expect(s.byType.water).toBe(1); // n2 only (n8 closed)
    expect(s.bySeverity.critical).toBe(2);
    expect(Object.values(s.byType).reduce((a, b) => a + b, 0)).toBe(s.totalActive);
    expect(Object.values(s.bySeverity).reduce((a, b) => a + b, 0)).toBe(s.totalActive);
  });

  it('records the full status distribution over ALL needs', () => {
    expect(s.byStatus.OPEN).toBe(2);
    expect(s.byStatus.CANCELLED).toBe(1);
    expect(s.byStatus.DUPLICATE).toBe(1);
    expect(Object.values(s.byStatus).reduce((a, b) => a + b, 0)).toBe(needs.length);
  });

  it('emits an ordered StatSet whose headline values match the fields', () => {
    expect(s.stats[0]).toMatchObject({ key: 'total_active', value: 8 });
    expect(statValue(s.stats, 'open_critical')).toBe(2);
    expect(statValue(s.stats, 'verified_today')).toBe(2);
    expect(statValue(s.stats, 'type_food')).toBe(3);
    expect(statValue(s.stats, 'sev_critical')).toBe(2);
    // absent buckets are not emitted as tokens
    expect(statValue(s.stats, 'type_shelter')).toBeUndefined();
  });
});

describe('computeReportStats — verified-only impact', () => {
  // rn1..rn3 verified inside the window; rn4 verified BEFORE it; rn5 never verified.
  const needs: ProjectedNeed[] = [
    need({
      need_id: 'rn1',
      state: 'VERIFIED',
      type: 'food',
      people_count: 4,
      assigned_volunteer_id: 'V1',
      created_at: '2026-07-06T10:00:00.000Z',
      evidence: [{ kind: 'recipient_confirm', at: '2026-07-06T10:29:00.000Z' }],
    }),
    need({
      need_id: 'rn2',
      state: 'CLOSED',
      type: 'water',
      people_count: 10,
      assigned_volunteer_id: 'V2',
      created_at: '2026-07-06T09:00:00.000Z',
      evidence: [{ kind: 'coordinator_signoff', at: '2026-07-06T09:59:00.000Z' }],
    }),
    need({
      need_id: 'rn3',
      state: 'VERIFIED',
      type: 'food',
      people_count: 6,
      assigned_volunteer_id: 'V1',
      created_at: '2026-07-06T08:00:00.000Z',
      evidence: [{ kind: 'photo', at: '2026-07-06T08:19:00.000Z' }], // no human attestation
    }),
    need({
      need_id: 'rn4',
      state: 'VERIFIED',
      type: 'medical',
      people_count: 3,
      assigned_volunteer_id: 'V3',
      created_at: '2026-07-05T07:00:00.000Z',
      evidence: [{ kind: 'recipient_confirm', at: '2026-07-05T07:29:00.000Z' }],
    }),
    need({ need_id: 'rn5', state: 'IN_PROGRESS', type: 'food', people_count: 5, assigned_volunteer_id: 'V4' }),
  ];

  const events = new Map<string, NeedEvent[]>([
    ['rn1', [claimedEvent('rn1', '2026-07-06T10:05:00.000Z', 'V1'), verifiedEvent('rn1', '2026-07-06T10:30:00.000Z')]],
    ['rn2', [verifiedEvent('rn2', '2026-07-06T10:00:00.000Z')]],
    ['rn3', [verifiedEvent('rn3', '2026-07-06T08:20:00.000Z')]],
    ['rn4', [verifiedEvent('rn4', '2026-07-05T07:30:00.000Z')]], // outside the window
    ['rn5', [claimedEvent('rn5', '2026-07-06T11:00:00.000Z', 'V4')]], // never verified
  ]);

  const window = { sinceMs: Date.parse('2026-07-06T00:00:00.000Z'), untilMs: Date.parse('2026-07-07T00:00:00.000Z') };
  const r = computeReportStats(needs, events, window);

  it('scopes to needs verified inside the window', () => {
    expect(r.totalNeeds).toBe(3); // rn1, rn2, rn3 (rn4 out of window, rn5 never verified)
    expect(r.verifiedDeliveries).toBe(3);
  });

  it('sums people helped and counts distinct volunteers over verified needs only', () => {
    expect(r.peopleHelped).toBe(20); // 4 + 10 + 6
    expect(r.volunteersEngaged).toBe(2); // V1 (rn1, rn3) + V2 (rn2)
  });

  it('computes the median response time in whole minutes', () => {
    expect(r.medianResponseMinutes).toBe(30); // sorted [20, 30, 60] → 30
  });

  it('computes the evidence-complete percentage (attestation, not just a photo)', () => {
    expect(r.evidenceCompletePct).toBe(67); // rn1 + rn2 attested, rn3 photo-only → 2/3
  });

  it('breaks down verified deliveries by type', () => {
    expect(r.byType.food).toBe(2); // rn1, rn3
    expect(r.byType.water).toBe(1); // rn2
    expect(r.byType.medical).toBe(0); // rn4 excluded
  });

  it('attaches the backing need_ids to each headline stat for footnotes', () => {
    const peopleHelped = r.stats.find((s) => s.key === 'people_helped');
    expect(peopleHelped?.value).toBe(20);
    expect(peopleHelped?.eventRefs).toEqual(['rn1', 'rn2', 'rn3']);
    const foodType = r.stats.find((s) => s.key === 'type_food');
    expect(foodType?.eventRefs).toEqual(['rn1', 'rn3']);
  });

  it('handles an empty window without dividing by zero', () => {
    const empty = computeReportStats(needs, events, { sinceMs: 0, untilMs: 1 });
    expect(empty.totalNeeds).toBe(0);
    expect(empty.evidenceCompletePct).toBe(0);
    expect(empty.medianResponseMinutes).toBe(0);
    expect(empty.peopleHelped).toBe(0);
  });
});
