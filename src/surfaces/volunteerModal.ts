import { ALL_SKILLS } from '../match/scorer';
import type { Volunteer } from '../match/volunteerStore';
import { resolveLocality } from '../pipeline/geocode';
import { modal, type SlackBlock, type SlackView } from './primitives';

// Volunteer onboarding modal (BUILD-DOC §F3). `/relay volunteer` opens this; the
// view_submission handler feeds parseVolunteerSubmission → VolunteerStore.upsert. Pure
// builders — no Slack client — so the shape is unit-testable. The modal collects only
// non-PII roster fields (skills, home locality, reach, capacity, languages, availability);
// slack_user_id + display_name come from the submitting user (body.user), not the form.

export const VOLUNTEER_CALLBACK_ID = 'volunteer_onboard';

/** block_id === action_id for each input (different Slack namespaces; keeps parsing 1:1). */
export const FIELD = {
  skills: 'v_skills',
  locality: 'v_locality',
  radius: 'v_radius',
  capacity: 'v_capacity',
  languages: 'v_languages',
  availability: 'v_availability',
} as const;

export const LANGUAGE_OPTIONS = [
  { text: 'Tamil', value: 'ta' },
  { text: 'English', value: 'en' },
] as const;

export const AVAILABILITY_OPTIONS = [
  { text: 'Always', value: 'always' },
  { text: 'Daytime', value: 'daytime' },
  { text: 'Evenings', value: 'evenings' },
] as const;

const AVAILABILITY_MODES = AVAILABILITY_OPTIONS.map((o) => o.value);
export type AvailabilityMode = (typeof AVAILABILITY_OPTIONS)[number]['value'];

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const option = (text: string, value: string): SlackBlock => ({ text: { type: 'plain_text', text }, value });

const SKILL_OPTIONS: SlackBlock[] = ALL_SKILLS.map((s) => option(cap(s), s));
const LANG_OPTION_BLOCKS: SlackBlock[] = LANGUAGE_OPTIONS.map((o) => option(o.text, o.value));
const AVAIL_OPTION_BLOCKS: SlackBlock[] = AVAILABILITY_OPTIONS.map((o) => option(o.text, o.value));

/** An input block wrapping an arbitrary element. */
function inputWrap(blockId: string, label: string, element: SlackBlock, optional = false): SlackBlock {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: { type: 'plain_text', text: label },
    element,
  };
}

function multiSelect(actionId: string, options: SlackBlock[], initial: string[]): SlackBlock {
  const initialOptions = options.filter((o) => initial.includes((o as { value: string }).value));
  return {
    type: 'multi_static_select',
    action_id: actionId,
    placeholder: { type: 'plain_text', text: 'Select…' },
    options,
    ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
  };
}

function staticSelect(actionId: string, options: SlackBlock[], initial?: string): SlackBlock {
  const initialOption = options.find((o) => (o as { value: string }).value === initial);
  return {
    type: 'static_select',
    action_id: actionId,
    placeholder: { type: 'plain_text', text: 'Select…' },
    options,
    ...(initialOption ? { initial_option: initialOption } : {}),
  };
}

function textInput(actionId: string, placeholder: string, initial?: string): SlackBlock {
  return {
    type: 'plain_text_input',
    action_id: actionId,
    placeholder: { type: 'plain_text', text: placeholder },
    ...(initial ? { initial_value: initial } : {}),
  };
}

function prefillMode(prefill?: Volunteer): AvailabilityMode | undefined {
  const raw = prefill?.availability?.mode;
  return typeof raw === 'string' && (AVAILABILITY_MODES as readonly string[]).includes(raw)
    ? (raw as AvailabilityMode)
    : undefined;
}

/**
 * Build the `views.open` payload for volunteer onboarding. `prefill` re-populates the
 * cleanly round-trippable fields (skills, radius, capacity, languages, availability);
 * home locality is entered as free text and resolved to a gazetteer id on submit, so it
 * is not back-filled from a numeric id.
 */
export function buildVolunteerModal(prefill?: Volunteer): SlackView {
  const blocks: SlackBlock[] = [
    inputWrap(FIELD.skills, 'Skills', multiSelect(FIELD.skills, SKILL_OPTIONS, prefill?.skills ?? [])),
    inputWrap(FIELD.locality, 'Home locality', textInput(FIELD.locality, 'e.g. Velachery'), true),
    inputWrap(
      FIELD.radius,
      'Reach (km)',
      textInput(FIELD.radius, '5', prefill ? String(prefill.radius_km) : undefined),
    ),
    inputWrap(
      FIELD.capacity,
      'Capacity per day',
      textInput(FIELD.capacity, '2', prefill ? String(prefill.capacity_per_day) : undefined),
    ),
    inputWrap(FIELD.languages, 'Languages', multiSelect(FIELD.languages, LANG_OPTION_BLOCKS, prefill?.languages ?? [])),
    inputWrap(
      FIELD.availability,
      'Availability',
      staticSelect(FIELD.availability, AVAIL_OPTION_BLOCKS, prefillMode(prefill)),
    ),
  ];
  return modal(VOLUNTEER_CALLBACK_ID, 'Join as volunteer', blocks, 'Save');
}

/** The upsert-ready fields the modal collects. The handler merges slack_user_id +
 * display_name (from body.user) and is_demo before calling VolunteerStore.upsert. */
export interface VolunteerSubmission {
  skills: string[];
  languages: string[];
  /** Resolved gazetteer id, or null when the typed locality didn't match. */
  home_locality: number | null;
  /** The raw locality text when unresolved (for display), else null. */
  home_locality_text: string | null;
  radius_km: number;
  capacity_per_day: number;
  availability: { mode: AvailabilityMode };
}

type StateValues = Record<string, Record<string, unknown>>;

function stateValues(view: SlackView): StateValues {
  const state = (view as { state?: { values?: unknown } }).state;
  const values = state?.values;
  return values && typeof values === 'object' ? (values as StateValues) : {};
}

function element(values: StateValues, blockId: string, actionId: string): Record<string, unknown> {
  const block = values[blockId];
  const el = block ? block[actionId] : undefined;
  return el && typeof el === 'object' ? (el as Record<string, unknown>) : {};
}

function selectedValues(el: Record<string, unknown>): string[] {
  const opts = el.selected_options;
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string');
}

function selectedValue(el: Record<string, unknown>): string | null {
  const opt = el.selected_option;
  if (!opt || typeof opt !== 'object') return null;
  const v = (opt as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

function inputText(el: Record<string, unknown>): string {
  return typeof el.value === 'string' ? el.value : '';
}

function parseIntOr(raw: string, fallback: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read a `view_submission` state into an upsert payload. Locality free-text is resolved
 * to a gazetteer id via geocode (unresolved → null id + kept text). Missing/blank numeric
 * fields fall back to the roster defaults (radius 5, capacity 2). Pure.
 */
export function parseVolunteerSubmission(view: SlackView): VolunteerSubmission {
  const values = stateValues(view);
  const skills = selectedValues(element(values, FIELD.skills, FIELD.skills));
  const languages = selectedValues(element(values, FIELD.languages, FIELD.languages));
  const localityText = inputText(element(values, FIELD.locality, FIELD.locality)).trim();
  const resolved = resolveLocality(localityText.length > 0 ? localityText : null);
  const radius_km = parseIntOr(inputText(element(values, FIELD.radius, FIELD.radius)), 5);
  const capacity_per_day = parseIntOr(inputText(element(values, FIELD.capacity, FIELD.capacity)), 2);
  const mode = selectedValue(element(values, FIELD.availability, FIELD.availability));
  const availabilityMode: AvailabilityMode =
    mode && (AVAILABILITY_MODES as readonly string[]).includes(mode) ? (mode as AvailabilityMode) : 'always';

  return {
    skills,
    languages,
    home_locality: resolved.localityId,
    home_locality_text: resolved.matched ? null : localityText || null,
    radius_km,
    capacity_per_day,
    availability: { mode: availabilityMode },
  };
}
