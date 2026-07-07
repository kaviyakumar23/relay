import { describe, expect, it } from 'vitest';
import type { Volunteer } from '../../src/match/volunteerStore';
import {
  ASSIGN_PICK_ACTION,
  buildMatchBlocks,
  encodeAssignTarget,
  type MatchNeed,
  parseAssignTarget,
  type RankedCandidate,
  scoreBar,
} from '../../src/surfaces/matchCard';
import { parseActionId, type SlackBlock } from '../../src/surfaces/primitives';

const vol = (slack_user_id: string, display_name: string): Volunteer => ({
  slack_user_id,
  display_name,
  skills: ['medical'],
  languages: ['ta'],
  home_locality: 1,
  radius_km: 5,
  capacity_per_day: 3,
  availability: {},
  active_load: 0,
  is_demo: false,
});

const ranked = (slack_user_id: string, name: string, score: number, rationale: string): RankedCandidate => ({
  volunteer: vol(slack_user_id, name),
  score,
  distanceKm: 1.2,
  breakdown: { skill: 1, proximity: 0.9, availability: 1, load: 1, language: 1 },
  rationale,
});

const NEED: MatchNeed = { needId: 'need-uuid-1', publicId: 'N-0007', type: 'medical', localityText: 'Velachery' };

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

describe('assign target encoding', () => {
  it('round-trips needId + volunteerId through a single | packed id', () => {
    const packed = encodeAssignTarget('need-uuid-1', 'SEED_U01');
    expect(packed).toBe('need-uuid-1|SEED_U01');
    expect(parseAssignTarget(packed)).toEqual({ needId: 'need-uuid-1', volunteerId: 'SEED_U01' });
  });

  it('survives parseActionId (which splits on the first colon only)', () => {
    const entity = encodeAssignTarget('need-uuid-1', 'SEED_U01');
    const actionId = `${ASSIGN_PICK_ACTION}:${entity}`;
    const parsed = parseActionId(actionId);
    expect(parsed.action).toBe(ASSIGN_PICK_ACTION);
    expect(parseAssignTarget(parsed.id)).toEqual({ needId: 'need-uuid-1', volunteerId: 'SEED_U01' });
  });
});

describe('scoreBar', () => {
  it('renders a proportional 10-cell meter', () => {
    expect(scoreBar(1)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(scoreBar(0)).toBe('░░░░░░░░░░');
    expect(scoreBar(0.5)).toBe('▓▓▓▓▓░░░░░');
    expect(scoreBar(1.5)).toBe('▓▓▓▓▓▓▓▓▓▓'); // clamps
  });
});

describe('buildMatchBlocks', () => {
  it('renders a header, a per-candidate section, and an Assign button wired to both ids', () => {
    const blocks = buildMatchBlocks(NEED, [ranked('SEED_U01', 'Anitha', 0.92, 'Anitha: medical, 1.2 km away')]);
    const dump = jsonOf(blocks);
    expect(dump).toContain('N-0007');
    expect(dump).toContain('Anitha');
    expect(dump).toContain('Velachery');
    expect(dump).toContain('92%');

    const assign = blocks
      .filter((b) => (b as { type?: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
      .map((el) => parseActionId(el.action_id))
      .filter((p) => p.action === ASSIGN_PICK_ACTION);
    expect(assign).toHaveLength(1);
    expect(parseAssignTarget(assign[0]?.id ?? '')).toEqual({ needId: 'need-uuid-1', volunteerId: 'SEED_U01' });
  });

  it('keeps top-3 order and one Assign button per candidate', () => {
    const blocks = buildMatchBlocks(NEED, [
      ranked('U1', 'First', 0.9, 'r1'),
      ranked('U2', 'Second', 0.7, 'r2'),
      ranked('U3', 'Third', 0.5, 'r3'),
    ]);
    const buttons = blocks
      .filter((b) => (b as { type?: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Array<{ value: string }> }).elements);
    expect(buttons.map((b) => parseAssignTarget(b.value).volunteerId)).toEqual(['U1', 'U2', 'U3']);
  });

  it('renders a no-match note (and no buttons) for an empty ranking', () => {
    const blocks = buildMatchBlocks(NEED, []);
    const dump = jsonOf(blocks);
    expect(dump).toContain('No available volunteers');
    expect(dump).not.toContain(ASSIGN_PICK_ACTION);
  });

  it('separates candidates with dividers so the slate is not a stacked wall', () => {
    const blocks = buildMatchBlocks(NEED, [
      ranked('U1', 'First', 0.9, 'r1'),
      ranked('U2', 'Second', 0.7, 'r2'),
      ranked('U3', 'Third', 0.5, 'r3'),
    ]);
    const dividers = blocks.filter((b) => (b as { type?: string }).type === 'divider').length;
    // One divider under the header context, then one between each of the 3 candidates.
    expect(dividers).toBe(3);
  });
});
