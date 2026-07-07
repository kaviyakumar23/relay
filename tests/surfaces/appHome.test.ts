import { describe, expect, it } from 'vitest';
import { emptyFlags, type NeedFlags, type ProjectedNeed } from '../../src/ledger/types';
import { appHomeView, homeStats, verifiedTodayCount } from '../../src/surfaces/appHome';
import {
  applyHomeFilter,
  decodeHomeFilter,
  encodeHomeFilter,
  filterLabel,
  type HomeFilter,
} from '../../src/surfaces/homeFilters';
import { parseActionId, type SlackView } from '../../src/surfaces/primitives';

// App Home operations board shape (BUILD-DOC §F2). Pure over the projection + now/filter:
// the board must carry the attention list, the drift panel, the filter buttons, and the
// config panel; applyHomeFilter must narrow the set by type/severity/locality; and the
// empty-state lines must render when there are no needs / nothing drifting.

const NOW = Date.parse('2026-07-06T01:00:00.000Z');

function need(over: Omit<Partial<ProjectedNeed>, 'flags'> & { flags?: Partial<NeedFlags> } = {}): ProjectedNeed {
  const { flags, ...rest } = over;
  return {
    need_id: 'need-1',
    state: 'OPEN',
    type: 'food',
    severity: 'medium',
    locality_id: 3,
    location_text: 'Velachery',
    people_count: 3,
    languages: ['ta'],
    source: {},
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: null,
    obligation_id: null,
    sla_due_at: null,
    evidence: [],
    flags: { ...emptyFlags(), ...flags },
    state_version: 1,
    history_count: 1,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:30:00.000Z',
    ...rest,
  };
}

const view = (needs: ProjectedNeed[], opts = {}): SlackView => appHomeView(needs, { now: NOW, ...opts });
const blocksOf = (v: SlackView): SlackBlockLike[] => (v as { blocks: SlackBlockLike[] }).blocks;
const jsonOf = (v: SlackView): string => JSON.stringify(v);

interface SlackBlockLike {
  type?: string;
  elements?: Array<{ action_id?: string }>;
  accessory?: { action_id?: string; value?: string };
}

/** Every action id in the view — from actions rows AND section accessories (the View button). */
function actionIds(v: SlackView): string[] {
  const ids: string[] = [];
  for (const b of blocksOf(v)) {
    if (b.type === 'actions' && b.elements) for (const el of b.elements) if (el.action_id) ids.push(el.action_id);
    if (b.type === 'section' && b.accessory?.action_id) ids.push(b.accessory.action_id);
  }
  return ids;
}

describe('applyHomeFilter', () => {
  const set = [
    need({ need_id: 'a', type: 'medical', severity: 'critical', locality_id: 1 }),
    need({ need_id: 'b', type: 'food', severity: 'medium', locality_id: 2 }),
    need({ need_id: 'c', type: 'medical', severity: 'low', locality_id: 2 }),
  ];

  it('narrows by type', () => {
    const out = applyHomeFilter(set, { kind: 'type', value: 'medical' });
    expect(out.map((n) => n.need_id)).toEqual(['a', 'c']);
  });

  it('narrows by severity', () => {
    const out = applyHomeFilter(set, { kind: 'severity', value: 'critical' });
    expect(out.map((n) => n.need_id)).toEqual(['a']);
  });

  it('narrows by locality', () => {
    const out = applyHomeFilter(set, { kind: 'locality', value: 2 });
    expect(out.map((n) => n.need_id)).toEqual(['b', 'c']);
  });

  it('returns the list unchanged for a null filter', () => {
    expect(applyHomeFilter(set, null)).toHaveLength(3);
    expect(applyHomeFilter(set)).toHaveLength(3);
  });
});

describe('encode/decode home filter', () => {
  const cases: HomeFilter[] = [
    { kind: 'type', value: 'medical' },
    { kind: 'severity', value: 'critical' },
    { kind: 'locality', value: 42 },
  ];
  it('round-trips every filter kind through the action value', () => {
    for (const f of cases) expect(decodeHomeFilter(encodeHomeFilter(f))).toEqual(f);
  });
  it('maps the All reset (null) to the "all" sentinel and back to null', () => {
    expect(encodeHomeFilter(null)).toBe('all');
    expect(decodeHomeFilter('all')).toBeNull();
  });
  it('rejects malformed / unknown encodings', () => {
    expect(decodeHomeFilter('type|nonsense')).toBeNull();
    expect(decodeHomeFilter('bogus|x')).toBeNull();
    expect(decodeHomeFilter('locality|NaN')).toBeNull();
  });
  it('labels the active filter for the context line', () => {
    expect(filterLabel({ kind: 'type', value: 'medical' })).toContain('medical');
    expect(filterLabel({ kind: 'locality', value: 7 })).toContain('#7');
    expect(filterLabel(null)).toBe('All needs');
  });
});

describe('homeStats / verifiedTodayCount', () => {
  it('tallies needs by current state', () => {
    const stats = homeStats([need({ state: 'OPEN' }), need({ state: 'OPEN' }), need({ state: 'CLAIMED' })]);
    expect(stats.total).toBe(3);
    expect(stats.byStatus.OPEN).toBe(2);
    expect(stats.byStatus.CLAIMED).toBe(1);
  });

  it('counts VERIFIED/CLOSED needs updated within the last 24h', () => {
    const recent = need({ state: 'VERIFIED', updated_at: '2026-07-06T00:30:00.000Z' });
    const stale = need({ state: 'CLOSED', updated_at: '2026-07-04T00:00:00.000Z' });
    const openRecent = need({ state: 'OPEN', updated_at: '2026-07-06T00:59:00.000Z' });
    expect(verifiedTodayCount([recent, stale, openRecent], NOW)).toBe(1);
  });
});

describe('appHomeView — operations board', () => {
  it('renders a home view with the header and an as-of line', () => {
    const v = view([]);
    expect((v as { type: string }).type).toBe('home');
    const head = blocksOf(v)[0] as { type: string; text?: { text?: string } };
    expect(head.type).toBe('header');
    expect(head.text?.text).toContain('operations board');
    expect(jsonOf(v)).toContain('As of');
  });

  it('shows counters and the verified-today figure', () => {
    const v = view([
      need({ need_id: 'a', state: 'OPEN' }),
      need({ need_id: 'b', state: 'VERIFIED', updated_at: '2026-07-06T00:45:00.000Z' }),
    ]);
    const dump = jsonOf(v);
    expect(dump).toContain('verified in the last 24h');
    expect(dump).toContain('2* need'); // "*2* needs tracked"
  });

  it('lists needs-your-attention with a View button and a state-appropriate quick action', () => {
    const v = view([
      need({ need_id: 'crit', type: 'rescue', severity: 'critical', state: 'OPEN' }),
      need({ need_id: 'tri', type: 'medical', severity: 'high', state: 'TRIAGED' }),
    ]);
    const dump = jsonOf(v);
    expect(dump).toContain('Needs your attention');
    const parsed = actionIds(v).map(parseActionId);
    // View deep-link for both rows.
    expect(parsed).toContainEqual({ action: 'home_view', id: 'crit' });
    expect(parsed).toContainEqual({ action: 'home_view', id: 'tri' });
    // Quick actions: Assign for the OPEN need, Confirm for the TRIAGED need.
    expect(parsed).toContainEqual({ action: 'need_assign', id: 'crit' });
    expect(parsed).toContainEqual({ action: 'need_confirm', id: 'tri' });
  });

  it('ranks an open-critical need above a non-urgent one', () => {
    const v = view([
      need({ need_id: 'calm', type: 'food', severity: 'low', state: 'OPEN' }),
      need({ need_id: 'urgent', type: 'rescue', severity: 'critical', state: 'OPEN' }),
    ]);
    const ids = actionIds(v)
      .map(parseActionId)
      .filter((p) => p.action === 'home_view')
      .map((p) => p.id);
    expect(ids[0]).toBe('urgent');
  });

  it('carries the source permalink on the View button value when present', () => {
    const permalink = 'https://relay.demo/C/p123';
    const v = view([need({ need_id: 'p', source: { permalink } })]);
    const accessory = blocksOf(v)
      .filter((b) => b.type === 'section' && b.accessory)
      .map((b) => b.accessory)
      .find((a) => a?.action_id === 'home_view:p');
    expect(accessory?.value).toBe(permalink);
  });

  it('shows drifting obligations with the assigned volunteer, a warning badge, and the SLA delta', () => {
    const v = view([
      need({
        need_id: 'd',
        state: 'IN_PROGRESS',
        assigned_volunteer_id: 'SEED_U03',
        sla_due_at: '2026-07-06T00:40:00.000Z', // 20m before NOW → overdue
        flags: { is_drifting: true },
      }),
    ]);
    const dump = jsonOf(v);
    expect(dump).toContain('Drifting obligations');
    expect(dump).toContain('SEED_U03');
    expect(dump).toContain('⚠️');
    expect(dump).toContain('past SLA');
  });

  it('renders the reassuring line when nothing is drifting', () => {
    expect(jsonOf(view([need({ state: 'OPEN' })]))).toContain('No obligations drifting');
  });

  it('renders filter buttons for type, severity, locality, and an All reset', () => {
    const v = view([
      need({ need_id: 'a', type: 'medical', severity: 'critical', locality_id: 1, location_text: 'Adyar' }),
      need({ need_id: 'b', type: 'food', severity: 'low', locality_id: 2, location_text: 'Velachery' }),
    ]);
    const filterVals = blocksOf(v)
      .filter((b) => b.type === 'actions' && b.elements)
      .flatMap((b) => b.elements ?? [])
      .filter((el) => (el.action_id ?? '').startsWith('home_filter'))
      .map((el) => parseActionId(el.action_id ?? '').id);
    expect(filterVals).toContain(encodeHomeFilter({ kind: 'type', value: 'medical' }));
    expect(filterVals).toContain(encodeHomeFilter({ kind: 'severity', value: 'critical' }));
    expect(filterVals).toContain(encodeHomeFilter({ kind: 'locality', value: 1 }));
    expect(filterVals).toContain('all');
  });

  it('narrows the board when a filter is active and names it in the context line', () => {
    const needs = [
      need({ need_id: 'a', type: 'medical', severity: 'critical', state: 'OPEN' }),
      need({ need_id: 'b', type: 'food', severity: 'low', state: 'OPEN' }),
    ];
    const v = view(needs, { filter: { kind: 'type', value: 'medical' } });
    const parsed = actionIds(v).map(parseActionId);
    expect(parsed).toContainEqual({ action: 'home_view', id: 'a' });
    expect(parsed).not.toContainEqual({ action: 'home_view', id: 'b' });
    expect(jsonOf(v)).toContain('Type: medical');
  });

  it('renders the config panel: verification policy and the SLA table', () => {
    const dump = jsonOf(view([]));
    expect(dump).toContain('Verification policy');
    expect(dump).toContain('coordinator sign-off');
    expect(dump).toContain('SLA clock');
    expect(dump).toContain('medical'); // an SLA table row
    expect(dump).toContain('45m'); // medical critical budget
  });

  it('notes SLA compression only when the demo multiplier is not 1', () => {
    expect(jsonOf(view([], { slaMultiplier: 0.02 }))).toContain('compressed ×0.02');
    expect(jsonOf(view([], { slaMultiplier: 1 }))).not.toContain('compressed');
  });

  it('keeps the "How Relay decides" transparency note at the bottom', () => {
    expect(jsonOf(view([]))).toContain('How Relay decides');
  });

  it('shows the empty-state line and no filter buttons when there are no needs', () => {
    const v = view([]);
    expect(jsonOf(v)).toContain('No needs yet');
    expect(actionIds(v).some((id) => id.startsWith('home_filter'))).toBe(false);
  });
});
