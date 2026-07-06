import type { ProjectedNeed } from '../ledger/types';
import { actions, button, context, inputBlock, modal, type SlackBlock, type SlackView, section } from './primitives';
import { EVIDENCE_KIND_LABEL, type VerificationStatus } from './verification';

// Evidence-capture UI (BUILD-DOC §F5). Pure Block Kit builders — no Slack client — so the
// view JSON, the button routing, and the state→payload parse are all unit-testable.
//
// F5 design rule (BUILD-DOC §F5): "Do not rely on photo EXIF GPS — Slack strips/re-encodes
// uploads unreliably; locality confirm is an explicit button/select, not metadata magic."
// So the reliable signals here are EXPLICIT controls the coordinator/volunteer operates:
//   • a photo reference (paste a Slack file link / short note) PLUS a "photo attached in
//     this thread" checkbox — the checkbox is the dependable signal when the photo is
//     uploaded straight into the thread rather than linked. We deliberately do NOT use a
//     `file_input` element (upload wiring is out of scope for this self-contained builder,
//     and the explicit control is what F5 asks for).
//   • a static_select where the coordinator explicitly CONFIRMS the delivery locality.
// The evidence packet stores references + kinds + times only — never beneficiary content
// (zero-copy + PII, CLAUDE.md invariant #5).

export const DELIVERY_CALLBACK_ID = 'evidence_deliver';

/** Card/DM button (on a CLAIMED/IN_PROGRESS need) that opens the delivery evidence modal
 *  via views.open(buildDeliveryModal(needId)). Wired in src/ingest/slackApp.ts. */
export const MARK_DELIVERED_ACTION = 'need_mark_delivered';

/** block_id === action_id per field (separate Slack namespaces; keeps parsing 1:1). */
export const DELIVERY_FIELD = {
  photo: 'ev_photo',
  photoAttached: 'ev_photo_attached',
  locality: 'ev_locality',
  note: 'ev_note',
} as const;

/** Sentinel photoRef used when only the "attached in thread" checkbox is ticked (no link). */
export const PHOTO_IN_THREAD = 'thread';

/** Requester-thread confirm button → RecipientConfirmed {confirmed_by:'recipient'}. */
export const RECIPIENT_CONFIRM_ACTION = 'need_recipient_confirm';
/** Coordinator-substitute button → RecipientConfirmed {confirmed_by:'coordinator_substitute'}. */
export const RECIPIENT_SUBSTITUTE_ACTION = 'need_recipient_confirm_sub';
/** Coordinator sign-off & close button → CoordinatorSignedOff (+ Verified + Closed). */
export const SIGNOFF_ACTION = 'need_signoff';

const LOCALITY_OPTIONS: ReadonlyArray<{ text: string; value: string }> = [
  { text: '✅ Delivered at the recorded location', value: 'confirmed' },
  { text: '⚠️ Location differs / could not confirm', value: 'unconfirmed' },
];

/** Wrap an arbitrary element in an input block (checkboxes / select need this — the shared
 *  inputBlock helper only builds plain_text_input). */
function inputWrap(blockId: string, label: string, element: SlackBlock, optional = false): SlackBlock {
  return {
    type: 'input',
    block_id: blockId,
    optional,
    label: { type: 'plain_text', text: label },
    element,
  };
}

function checkbox(actionId: string, optionText: string, value: string): SlackBlock {
  return {
    type: 'checkboxes',
    action_id: actionId,
    options: [{ text: { type: 'plain_text', text: optionText, emoji: true }, value }],
  };
}

function localitySelect(): SlackBlock {
  return {
    type: 'static_select',
    action_id: DELIVERY_FIELD.locality,
    placeholder: { type: 'plain_text', text: 'Confirm the delivery location' },
    options: LOCALITY_OPTIONS.map((o) => ({ text: { type: 'plain_text', text: o.text, emoji: true }, value: o.value })),
  };
}

/**
 * Build the `views.open` payload the "Mark delivered" action opens. Collects the explicit
 * evidence signals for L1 (photo + locality confirm) plus an optional note. The need id
 * round-trips via private_metadata for the view_submission handler.
 */
export function buildDeliveryModal(needId: string): SlackView {
  const blocks: SlackBlock[] = [
    section('Log the delivery evidence. Nothing closes on a report alone — attach what proves it landed.'),
    inputBlock(DELIVERY_FIELD.photo, 'Photo reference (Slack file link or short note)', DELIVERY_FIELD.photo, '', {
      optional: true,
    }),
    inputWrap(
      DELIVERY_FIELD.photoAttached,
      'Photo evidence',
      checkbox(DELIVERY_FIELD.photoAttached, 'Photo is attached in this thread', 'attached'),
      true,
    ),
    inputWrap(DELIVERY_FIELD.locality, 'Delivery location', localitySelect(), false),
    inputBlock(DELIVERY_FIELD.note, 'Note (optional)', DELIVERY_FIELD.note, '', { multiline: true, optional: true }),
  ];
  return modal(DELIVERY_CALLBACK_ID, 'Mark delivered', blocks, 'Submit', needId);
}

/**
 * Blocks for the requester thread asking the recipient to confirm receipt. The primary
 * button routes to RECIPIENT_CONFIRM_ACTION (recipient self-confirm); the secondary lets a
 * coordinator confirm on the recipient's behalf (RECIPIENT_SUBSTITUTE_ACTION). Both carry
 * the need id so a single regex handler knows the target.
 */
export function buildRecipientConfirmPrompt(needId: string): SlackBlock[] {
  return [
    section('*Delivery reported.* Did you receive it? A quick tap closes the loop and proves the delivery.'),
    actions([
      button('✅ Confirm received', RECIPIENT_CONFIRM_ACTION, needId, 'primary'),
      button('Coordinator confirm on their behalf', RECIPIENT_SUBSTITUTE_ACTION, needId),
    ]),
    context('_Relay records who confirmed — recipient or coordinator substitute. No delivery closes unproven._'),
  ];
}

/**
 * The coordinator "Sign off & close" control. The button is ENABLED (primary) only when
 * everything the policy needs EXCEPT the sign-off itself is already present — clicking it
 * then attaches coordinator_signoff and the close becomes valid. Otherwise it renders a
 * disabled-style (locked) button plus a context hint naming the still-missing evidence, so
 * a coordinator can never sign off into an incomplete packet from the UI. Pure.
 */
export function buildSignoffControls(need: ProjectedNeed, vstatus: VerificationStatus): SlackBlock[] {
  const blocking = vstatus.missing.filter((k) => k !== 'coordinator_signoff');
  if (blocking.length === 0) {
    return [actions([button('✅ Sign off & close', SIGNOFF_ACTION, need.need_id, 'primary')])];
  }
  const missingLabels = blocking.map((k) => EVIDENCE_KIND_LABEL[k]).join(', ');
  return [
    actions([button('🔒 Sign off & close', SIGNOFF_ACTION, need.need_id)]),
    context(`Sign-off locked — missing: ${missingLabels}`),
  ];
}

// --- view_submission parsing ------------------------------------------------

export interface DeliverySubmission {
  localityConfirmed: boolean;
  note?: string;
  photoRef?: string;
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

function inputText(el: Record<string, unknown>): string {
  return typeof el.value === 'string' ? el.value : '';
}

function selectedValue(el: Record<string, unknown>): string | null {
  const opt = el.selected_option;
  if (!opt || typeof opt !== 'object') return null;
  const v = (opt as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

function selectedValues(el: Record<string, unknown>): string[] {
  const opts = el.selected_options;
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) => (o && typeof o === 'object' ? (o as { value?: unknown }).value : undefined))
    .filter((v): v is string => typeof v === 'string');
}

/**
 * Read a delivery `view_submission` into the explicit evidence signals. `photoRef` is the
 * pasted reference when given, else the sentinel PHOTO_IN_THREAD when the "attached in
 * thread" checkbox is ticked, else undefined. `localityConfirmed` is true only when the
 * coordinator explicitly picked the confirmed option. Pure.
 */
export function parseDeliverySubmission(view: SlackView): DeliverySubmission {
  const values = stateValues(view);
  const localityConfirmed =
    selectedValue(element(values, DELIVERY_FIELD.locality, DELIVERY_FIELD.locality)) === 'confirmed';
  const photoText = inputText(element(values, DELIVERY_FIELD.photo, DELIVERY_FIELD.photo)).trim();
  const photoAttached = selectedValues(
    element(values, DELIVERY_FIELD.photoAttached, DELIVERY_FIELD.photoAttached),
  ).includes('attached');
  const note = inputText(element(values, DELIVERY_FIELD.note, DELIVERY_FIELD.note)).trim();

  let photoRef: string | undefined;
  if (photoText.length > 0) photoRef = photoText;
  else if (photoAttached) photoRef = PHOTO_IN_THREAD;

  return {
    localityConfirmed,
    ...(photoRef !== undefined ? { photoRef } : {}),
    ...(note.length > 0 ? { note } : {}),
  };
}
