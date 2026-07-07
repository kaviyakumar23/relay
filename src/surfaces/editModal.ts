import type { NeedType, ProjectedNeed, Severity } from '../ledger/types';
import { resolveLocality } from '../pipeline/geocode';
import { modal, type SlackBlock, type SlackView, section } from './primitives';

// Field-correction modal (BUILD-DOC §F2: the dispatch card's "✏️ Edit" control). A coordinator
// who spots a mis-extraction opens this, corrects the classified fields, and on submit the
// integrator dispatches a HUMAN-actor ExtractionCompleted with the corrected values — a human
// override the projection applies (severity floor still only-raises, invariant #4). Pure Block
// Kit builders — no Slack client — so the view JSON + the state→payload parse unit-test off JSON.
//
// Only the four cleanly-structured extraction fields are editable here (type / severity / location
// / people). Contact, evidence and lifecycle state are never touched by an edit.

export const EDIT_CALLBACK_ID = 'need_edit_submit';

/** block_id === action_id per field (separate Slack namespaces; keeps parsing 1:1). */
export const EDIT_FIELD = {
  type: 'edit_type',
  severity: 'edit_severity',
  locality: 'edit_locality',
  people: 'edit_people',
} as const;

const NEED_TYPES = ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const option = (text: string, value: string): SlackBlock => ({ text: { type: 'plain_text', text }, value });

const TYPE_OPTIONS: SlackBlock[] = NEED_TYPES.map((t) => option(cap(t), t));
const SEVERITY_OPTIONS: SlackBlock[] = SEVERITIES.map((s) => option(cap(s), s));

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

/**
 * Build the `views.open` payload the "Edit" action opens, prefilled from the current projection.
 * The need id round-trips via private_metadata for the view_submission handler. Location is entered
 * as free text and resolved to a gazetteer id on submit (kept as text either way, so the card stays
 * readable). Severity is offered in full, but the floor means a lower pick can never lower it.
 */
export function buildEditModal(need: ProjectedNeed): SlackView {
  const blocks: SlackBlock[] = [
    section(
      'Correct the extracted fields. Your edit is recorded as a *human override* on the ledger. ' +
        'Severity can only be *raised* (safety floor).',
    ),
    inputWrap(EDIT_FIELD.type, 'Type', staticSelect(EDIT_FIELD.type, TYPE_OPTIONS, need.type)),
    inputWrap(EDIT_FIELD.severity, 'Severity', staticSelect(EDIT_FIELD.severity, SEVERITY_OPTIONS, need.severity)),
    inputWrap(
      EDIT_FIELD.locality,
      'Location',
      textInput(EDIT_FIELD.locality, 'e.g. Velachery', need.location_text ?? undefined),
      true,
    ),
    inputWrap(
      EDIT_FIELD.people,
      'People affected',
      textInput(EDIT_FIELD.people, 'e.g. 4', need.people_count !== null ? String(need.people_count) : undefined),
      true,
    ),
  ];
  return modal(EDIT_CALLBACK_ID, 'Edit need', blocks, 'Save', need.need_id);
}

/** The corrected fields an edit submission yields (structured, ready for an ExtractionCompleted). */
export interface EditSubmission {
  need_type: NeedType;
  severity: Severity;
  /** Resolved gazetteer id, or null when the typed location didn't match one. */
  locality_id: number | null;
  /** The typed location kept verbatim (so the card stays readable), or null when left blank. */
  location_text: string | null;
  people_count: number | null;
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

function selectedValue(el: Record<string, unknown>): string | null {
  const opt = el.selected_option;
  if (!opt || typeof opt !== 'object') return null;
  const v = (opt as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

function inputText(el: Record<string, unknown>): string {
  return typeof el.value === 'string' ? el.value : '';
}

/**
 * Read a `view_submission` into the corrected extraction fields. Unknown select values fall back to
 * the safe defaults (type 'other', severity 'low' — the floor will keep any real severity anyway).
 * Location is resolved to a gazetteer id but always kept as free text; people is a non-negative int
 * or null. Pure.
 */
export function parseEditSubmission(view: SlackView): EditSubmission {
  const values = stateValues(view);
  const typeRaw = selectedValue(element(values, EDIT_FIELD.type, EDIT_FIELD.type)) ?? '';
  const sevRaw = selectedValue(element(values, EDIT_FIELD.severity, EDIT_FIELD.severity)) ?? '';
  const need_type: NeedType = (NEED_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as NeedType) : 'other';
  const severity: Severity = (SEVERITIES as readonly string[]).includes(sevRaw) ? (sevRaw as Severity) : 'low';

  const localityText = inputText(element(values, EDIT_FIELD.locality, EDIT_FIELD.locality)).trim();
  const resolved = resolveLocality(localityText.length > 0 ? localityText : null);

  const peopleText = inputText(element(values, EDIT_FIELD.people, EDIT_FIELD.people)).trim();
  const peopleNum = Number.parseInt(peopleText, 10);
  const people_count = Number.isFinite(peopleNum) && peopleNum >= 0 ? peopleNum : null;

  return {
    need_type,
    severity,
    locality_id: resolved.localityId,
    location_text: localityText.length > 0 ? localityText : null,
    people_count,
  };
}
