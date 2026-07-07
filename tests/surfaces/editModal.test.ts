import { describe, expect, it } from 'vitest';
import type { ProjectedNeed } from '../../src/ledger/types';
import { emptyFlags } from '../../src/ledger/types';
import { buildEditModal, EDIT_CALLBACK_ID, EDIT_FIELD, parseEditSubmission } from '../../src/surfaces/editModal';
import type { SlackView } from '../../src/surfaces/primitives';

// Field-correction modal (BUILD-DOC §F2 "✏️ Edit"). Pure builders — the view JSON + the
// view_submission round-trip are unit-testable off plain JSON, no Slack client.

function needFixture(overrides: Partial<ProjectedNeed> = {}): ProjectedNeed {
  return {
    need_id: 'need_42',
    state: 'CLAIMED',
    type: 'water',
    severity: 'medium',
    locality_id: null,
    location_text: 'somewhere vague',
    people_count: 3,
    languages: [],
    source: {},
    confidence: { type: 'inferred', severity: 'inferred', contact: 'stated' },
    merged_into: null,
    assigned_volunteer_id: 'V1',
    obligation_id: null,
    sla_due_at: null,
    evidence: [],
    flags: emptyFlags(),
    state_version: 1,
    history_count: 3,
    created_at: '2026-07-06T09:00:00.000Z',
    updated_at: '2026-07-06T10:00:00.000Z',
    ...overrides,
  };
}

/** Build a synthetic view_submission state the way Slack posts it. */
function stateView(values: Record<string, Record<string, unknown>>): SlackView {
  return { type: 'modal', state: { values } };
}

const selectState = (blockId: string, actionId: string, value: string) => ({
  [blockId]: { [actionId]: { selected_option: { value } } },
});
const textState = (blockId: string, actionId: string, value: string) => ({
  [blockId]: { [actionId]: { value } },
});

describe('buildEditModal', () => {
  it('is a modal with the edit callback_id, the need id in private_metadata, and the four fields', () => {
    const view = buildEditModal(needFixture());
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(EDIT_CALLBACK_ID);
    expect(view.private_metadata).toBe('need_42');
    const ids = (view.blocks as Array<{ block_id?: string }>)
      .map((b) => b.block_id)
      .filter((id): id is string => typeof id === 'string');
    expect(ids).toEqual([EDIT_FIELD.type, EDIT_FIELD.severity, EDIT_FIELD.locality, EDIT_FIELD.people]);
  });

  it('prefills the current projection (type/severity selects + location/people text)', () => {
    const json = JSON.stringify(buildEditModal(needFixture()));
    // type + severity selects carry an initial_option matching the current values.
    expect(json).toContain('"value":"water"');
    expect(json).toContain('"value":"medium"');
    // location + people text inputs carry the current values as initial_value.
    expect(json).toContain('"initial_value":"somewhere vague"');
    expect(json).toContain('"initial_value":"3"');
  });
});

describe('parseEditSubmission', () => {
  it('reads the corrected type/severity and resolves a known locality to a gazetteer id', () => {
    const view = stateView({
      ...selectState(EDIT_FIELD.type, EDIT_FIELD.type, 'medical'),
      ...selectState(EDIT_FIELD.severity, EDIT_FIELD.severity, 'critical'),
      ...textState(EDIT_FIELD.locality, EDIT_FIELD.locality, 'Velachery'),
      ...textState(EDIT_FIELD.people, EDIT_FIELD.people, '6'),
    });
    const out = parseEditSubmission(view);
    expect(out.need_type).toBe('medical');
    expect(out.severity).toBe('critical');
    expect(out.locality_id).not.toBeNull();
    // location text is always kept verbatim so the card stays readable, even on a gazetteer match.
    expect(out.location_text).toBe('Velachery');
    expect(out.people_count).toBe(6);
  });

  it('keeps an unresolved location as free text (null gazetteer id) and blank people as null', () => {
    const view = stateView({
      ...selectState(EDIT_FIELD.type, EDIT_FIELD.type, 'food'),
      ...selectState(EDIT_FIELD.severity, EDIT_FIELD.severity, 'low'),
      ...textState(EDIT_FIELD.locality, EDIT_FIELD.locality, 'behind the blue temple'),
      ...textState(EDIT_FIELD.people, EDIT_FIELD.people, ''),
    });
    const out = parseEditSubmission(view);
    expect(out.locality_id).toBeNull();
    expect(out.location_text).toBe('behind the blue temple');
    expect(out.people_count).toBeNull();
  });

  it('falls back to safe defaults for an unknown select value (type other / severity low)', () => {
    const view = stateView({
      ...selectState(EDIT_FIELD.type, EDIT_FIELD.type, 'not-a-type'),
      ...selectState(EDIT_FIELD.severity, EDIT_FIELD.severity, 'not-a-severity'),
      ...textState(EDIT_FIELD.locality, EDIT_FIELD.locality, ''),
      ...textState(EDIT_FIELD.people, EDIT_FIELD.people, 'lots'),
    });
    const out = parseEditSubmission(view);
    expect(out.need_type).toBe('other');
    expect(out.severity).toBe('low');
    expect(out.location_text).toBeNull();
    expect(out.people_count).toBeNull();
  });
});
