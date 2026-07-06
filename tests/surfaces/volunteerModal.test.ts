import { describe, expect, it } from 'vitest';
import type { Volunteer } from '../../src/match/volunteerStore';
import type { SlackView } from '../../src/surfaces/primitives';
import {
  buildVolunteerModal,
  FIELD,
  parseVolunteerSubmission,
  VOLUNTEER_CALLBACK_ID,
} from '../../src/surfaces/volunteerModal';

// Modal builder shape + submission round-trip (BUILD-DOC §F3). Pure builders — no Slack
// client — so the view JSON and the state→payload parse are unit-testable.

interface InputBlock {
  type: string;
  block_id: string;
  optional?: boolean;
  element: Record<string, unknown>;
}

function blocksOf(view: SlackView): InputBlock[] {
  return (view.blocks as InputBlock[]) ?? [];
}

function blockById(view: SlackView, blockId: string): InputBlock | undefined {
  return blocksOf(view).find((b) => b.block_id === blockId);
}

/** Build a synthetic view_submission state the way Slack posts it. */
function stateView(values: Record<string, Record<string, unknown>>): SlackView {
  return { type: 'modal', state: { values } };
}

describe('buildVolunteerModal', () => {
  it('is a modal with the onboarding callback_id and all six fields', () => {
    const view = buildVolunteerModal();
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(VOLUNTEER_CALLBACK_ID);
    const ids = blocksOf(view).map((b) => b.block_id);
    expect(ids).toEqual([
      FIELD.skills,
      FIELD.locality,
      FIELD.radius,
      FIELD.capacity,
      FIELD.languages,
      FIELD.availability,
    ]);
  });

  it('offers the seven canonical skills and both languages', () => {
    const view = buildVolunteerModal();
    const skills = blockById(view, FIELD.skills)?.element.options as Array<{ value: string }>;
    expect(skills.map((o) => o.value)).toEqual([
      'boat',
      'medical',
      'driver',
      'cooking',
      'translation',
      'tech',
      'muscle',
    ]);
    const langs = blockById(view, FIELD.languages)?.element.options as Array<{ value: string }>;
    expect(langs.map((o) => o.value)).toEqual(['ta', 'en']);
  });

  it('prefills the round-trippable fields from an existing volunteer', () => {
    const prefill: Volunteer = {
      slack_user_id: 'U1',
      display_name: 'Anitha',
      skills: ['medical'],
      languages: ['en'],
      home_locality: 3,
      radius_km: 9,
      capacity_per_day: 4,
      availability: { mode: 'evenings' },
      active_load: 0,
      is_demo: false,
    };
    const view = buildVolunteerModal(prefill);
    const skillInit = blockById(view, FIELD.skills)?.element.initial_options as Array<{ value: string }>;
    expect(skillInit.map((o) => o.value)).toEqual(['medical']);
    expect(blockById(view, FIELD.radius)?.element.initial_value).toBe('9');
    expect(blockById(view, FIELD.capacity)?.element.initial_value).toBe('4');
    const availInit = blockById(view, FIELD.availability)?.element.initial_option as { value: string };
    expect(availInit.value).toBe('evenings');
  });
});

describe('parseVolunteerSubmission', () => {
  it('reads a full submission and resolves a known locality to its gazetteer id', () => {
    const view = stateView({
      [FIELD.skills]: {
        [FIELD.skills]: { type: 'multi_static_select', selected_options: [{ value: 'medical' }, { value: 'driver' }] },
      },
      [FIELD.locality]: { [FIELD.locality]: { type: 'plain_text_input', value: 'Velachery' } },
      [FIELD.radius]: { [FIELD.radius]: { type: 'plain_text_input', value: '7' } },
      [FIELD.capacity]: { [FIELD.capacity]: { type: 'plain_text_input', value: '3' } },
      [FIELD.languages]: { [FIELD.languages]: { type: 'multi_static_select', selected_options: [{ value: 'ta' }] } },
      [FIELD.availability]: { [FIELD.availability]: { type: 'static_select', selected_option: { value: 'daytime' } } },
    });
    expect(parseVolunteerSubmission(view)).toEqual({
      skills: ['medical', 'driver'],
      languages: ['ta'],
      home_locality: 1, // Velachery is the first gazetteer entry → id 1
      home_locality_text: null,
      radius_km: 7,
      capacity_per_day: 3,
      availability: { mode: 'daytime' },
    });
  });

  it('keeps an unresolved locality as free text with a null id', () => {
    const view = stateView({
      [FIELD.locality]: { [FIELD.locality]: { type: 'plain_text_input', value: 'Nowhere City' } },
    });
    const parsed = parseVolunteerSubmission(view);
    expect(parsed.home_locality).toBeNull();
    expect(parsed.home_locality_text).toBe('Nowhere City');
  });

  it('falls back to roster defaults on an empty submission', () => {
    expect(parseVolunteerSubmission(stateView({}))).toEqual({
      skills: [],
      languages: [],
      home_locality: null,
      home_locality_text: null,
      radius_km: 5,
      capacity_per_day: 2,
      availability: { mode: 'always' },
    });
  });

  it('ignores non-numeric radius/capacity and keeps defaults', () => {
    const view = stateView({
      [FIELD.radius]: { [FIELD.radius]: { type: 'plain_text_input', value: 'abc' } },
      [FIELD.capacity]: { [FIELD.capacity]: { type: 'plain_text_input', value: '0' } },
    });
    const parsed = parseVolunteerSubmission(view);
    expect(parsed.radius_km).toBe(5);
    expect(parsed.capacity_per_day).toBe(2);
  });
});
