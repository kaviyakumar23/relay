import { describe, expect, it } from 'vitest';
import { emptyFlags, type NeedFlags, type ProjectedNeed } from '../../src/ledger/types';
import type { Volunteer } from '../../src/match/volunteerStore';
import {
  buildNudgeBlocks,
  buildReassignBlocks,
  DELAYED_ACTION,
  ENROUTE_ACTION,
  RELEASE_ACTION,
} from '../../src/surfaces/driftCard';
import type { RankedCandidate } from '../../src/surfaces/matchCard';
import { REASSIGN_PICK_ACTION } from '../../src/surfaces/matchCard';
import { parseActionId, type SlackBlock } from '../../src/surfaces/primitives';

// Drift surface shape (BUILD-DOC §F4). The DM nudge carries the three reply buttons wired to
// the need id; the reassignment card flares the drift and wires a fresh slate to
// REASSIGN_PICK_ACTION. Both are pure over the projection — no Slack client, no store.

function need(over: Omit<Partial<ProjectedNeed>, 'flags'> & { flags?: Partial<NeedFlags> } = {}): ProjectedNeed {
  const { flags, ...rest } = over;
  return {
    need_id: 'need-1',
    state: 'CLAIMED',
    type: 'food',
    severity: 'high',
    locality_id: 3,
    location_text: 'Velachery',
    people_count: 3,
    languages: ['ta'],
    source: {},
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: 'SEED_U03',
    obligation_id: 'OB1',
    sla_due_at: '2026-07-06T00:10:00.000Z',
    evidence: [],
    flags: { ...emptyFlags(), ...flags },
    state_version: 3,
    history_count: 4,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:05:00.000Z',
    ...rest,
  };
}

const vol = (slack_user_id: string, display_name: string): Volunteer => ({
  slack_user_id,
  display_name,
  skills: ['cooking'],
  languages: ['ta'],
  home_locality: 3,
  radius_km: 5,
  capacity_per_day: 3,
  availability: {},
  active_load: 0,
  is_demo: false,
});

const ranked = (id: string, name: string): RankedCandidate => ({
  volunteer: vol(id, name),
  score: 0.8,
  distanceKm: 1.1,
  breakdown: { skill: 1, proximity: 0.9, availability: 1, load: 1, language: 1 },
  rationale: `${name}: cooking, 1.1 km away`,
});

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);
const actionIds = (blocks: SlackBlock[]): string[] =>
  blocks
    .filter((b) => (b as { type?: string }).type === 'actions')
    .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
    .map((el) => el.action_id);

describe('buildNudgeBlocks', () => {
  it('renders the three reply buttons wired to the need id (at_risk)', () => {
    const blocks = buildNudgeBlocks(need(), 'N-0001', 'at_risk');
    const ids = actionIds(blocks).map(parseActionId);
    expect(ids).toContainEqual({ action: ENROUTE_ACTION, id: 'need-1' });
    expect(ids).toContainEqual({ action: DELAYED_ACTION, id: 'need-1' });
    expect(ids).toContainEqual({ action: RELEASE_ACTION, id: 'need-1' });
    expect(jsonOf(blocks)).toContain('N-0001');
  });

  it('reads OVERDUE for the overdue kind', () => {
    expect(jsonOf(buildNudgeBlocks(need(), 'N-0001', 'overdue'))).toContain('OVERDUE');
  });

  it('drops the buttons and shows an acknowledgement once the volunteer taps one', () => {
    const blocks = buildNudgeBlocks(need(), 'N-0001', 'at_risk', { ack: 'en_route' });
    expect(actionIds(blocks)).toHaveLength(0);
    expect(jsonOf(blocks)).toContain('On my way');
  });
});

describe('buildReassignBlocks', () => {
  it('carries the hero narration (stuck volunteer, caught before missed) and wires a fresh slate', () => {
    const blocks = buildReassignBlocks(need({ flags: { is_drifting: true } }), 'N-0001', [ranked('SEED_U12', 'Kavya')]);
    const dump = jsonOf(blocks);
    // The hero moment must read as a caught silent-failure, not a neutral routing task.
    const head = blocks[0] as { type: string; text?: { text?: string } };
    expect(head.type).toBe('header');
    expect(head.text?.text).toContain('Delivery drifting');
    expect(head.text?.text).toContain('volunteer stuck');
    expect(dump).toContain('N-0001');
    expect(dump).toContain('past its SLA');
    expect(dump).toContain("hasn't moved");
    expect(dump).toContain('Relay caught it');
    expect(dump).toContain('Kavya');
    const reassign = actionIds(blocks)
      .map(parseActionId)
      .filter((p) => p.action === REASSIGN_PICK_ACTION);
    expect(reassign).toHaveLength(1);
    expect(reassign[0]?.id).toBe('need-1|SEED_U12');
  });

  it('narrates the at-risk case as caught early, before the SLA is missed', () => {
    const blocks = buildReassignBlocks(need({ flags: { is_at_risk: true } }), 'N-0003', [ranked('SEED_U12', 'Kavya')]);
    const head = blocks[0] as { text?: { text?: string } };
    expect(head.text?.text).toContain('at risk');
    expect(jsonOf(blocks)).toContain('Relay flagged it early');
  });

  it('reads a released narration when the need was handed back', () => {
    const blocks = buildReassignBlocks(need({ state: 'OPEN', assigned_volunteer_id: null }), 'N-0002', [
      ranked('SEED_U12', 'Kavya'),
    ]);
    const dump = jsonOf(blocks);
    expect(dump).toContain('Released');
    expect(dump).toContain('handed back');
  });
});
