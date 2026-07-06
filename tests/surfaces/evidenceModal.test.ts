import { describe, expect, it } from 'vitest';
import type { EvidenceKind, ProjectedNeed, Severity } from '../../src/ledger/types';
import { emptyFlags } from '../../src/ledger/types';
import {
  buildDeliveryModal,
  buildRecipientConfirmPrompt,
  buildSignoffControls,
  DELIVERY_CALLBACK_ID,
  DELIVERY_FIELD,
  PHOTO_IN_THREAD,
  parseDeliverySubmission,
  RECIPIENT_CONFIRM_ACTION,
  RECIPIENT_SUBSTITUTE_ACTION,
  SIGNOFF_ACTION,
} from '../../src/surfaces/evidenceModal';
import { parseActionId, type SlackBlock, type SlackView } from '../../src/surfaces/primitives';
import { verificationStatus } from '../../src/surfaces/verification';

// Evidence-capture builder shapes + the view_submission round-trip (BUILD-DOC §F5).
// Pure builders — no Slack client — so the view JSON and the parse are unit-testable.

interface InputBlock {
  type: string;
  block_id?: string;
  optional?: boolean;
  element?: Record<string, unknown>;
}

function blocksOf(view: SlackView): InputBlock[] {
  return (view.blocks as InputBlock[]) ?? [];
}

/** Build a synthetic view_submission state the way Slack posts it. */
function stateView(values: Record<string, Record<string, unknown>>): SlackView {
  return { type: 'modal', state: { values } };
}

function actionIds(blocks: SlackBlock[]): Array<{ action: string; id: string }> {
  return blocks
    .filter((b) => (b as { type?: string }).type === 'actions')
    .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
    .map((el) => parseActionId(el.action_id));
}

/** The first button element of the first actions block. */
function firstButton(blocks: SlackBlock[]): { style?: string; action_id: string } {
  const row = blocks.find((b) => (b as { type?: string }).type === 'actions') as
    | { elements: Array<{ style?: string; action_id: string }> }
    | undefined;
  const btn = row?.elements[0];
  if (!btn) throw new Error('no button in blocks');
  return btn;
}

function needWith(severity: Severity, kinds: EvidenceKind[]): ProjectedNeed {
  return {
    need_id: 'need_9',
    state: 'DELIVERED_UNVERIFIED',
    type: 'medical',
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

describe('buildDeliveryModal', () => {
  it('is a modal with the evidence callback_id, the need id in private_metadata, and all fields', () => {
    const view = buildDeliveryModal('need_9');
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(DELIVERY_CALLBACK_ID);
    expect(view.private_metadata).toBe('need_9');
    const ids = blocksOf(view)
      .map((b) => b.block_id)
      .filter((id): id is string => typeof id === 'string');
    expect(ids).toEqual([
      DELIVERY_FIELD.photo,
      DELIVERY_FIELD.photoAttached,
      DELIVERY_FIELD.locality,
      DELIVERY_FIELD.note,
    ]);
  });

  it('confirms locality with an explicit static_select (F5: no EXIF magic)', () => {
    const view = buildDeliveryModal('need_9');
    const localityBlock = blocksOf(view).find((b) => b.block_id === DELIVERY_FIELD.locality);
    expect(localityBlock?.element?.type).toBe('static_select');
    const options = localityBlock?.element?.options as Array<{ value: string }>;
    expect(options.map((o) => o.value)).toEqual(['confirmed', 'unconfirmed']);
  });

  it('offers a "photo attached in thread" checkbox as the explicit photo signal', () => {
    const view = buildDeliveryModal('need_9');
    const photoBlock = blocksOf(view).find((b) => b.block_id === DELIVERY_FIELD.photoAttached);
    expect(photoBlock?.element?.type).toBe('checkboxes');
    expect(photoBlock?.optional).toBe(true);
  });
});

describe('buildRecipientConfirmPrompt', () => {
  it('wires a recipient-confirm and a coordinator-substitute button back to the need id', () => {
    const ids = actionIds(buildRecipientConfirmPrompt('need_9'));
    expect(ids).toContainEqual({ action: RECIPIENT_CONFIRM_ACTION, id: 'need_9' });
    expect(ids).toContainEqual({ action: RECIPIENT_SUBSTITUTE_ACTION, id: 'need_9' });
  });
});

describe('buildSignoffControls', () => {
  it('enables (primary) the sign-off when only the sign-off itself is outstanding', () => {
    const need = needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm']);
    const blocks = buildSignoffControls(need, verificationStatus(need));
    const btn = firstButton(blocks);
    expect(btn.style).toBe('primary');
    expect(parseActionId(btn.action_id)).toEqual({ action: SIGNOFF_ACTION, id: 'need_9' });
    expect(JSON.stringify(blocks)).not.toContain('missing:');
  });

  it('enables the sign-off for a medium need once the recipient confirmation is in', () => {
    const need = needWith('medium', ['recipient_confirm']);
    const btn = firstButton(buildSignoffControls(need, verificationStatus(need)));
    expect(btn.style).toBe('primary');
  });

  it('locks the sign-off with a missing-evidence hint when prerequisites are absent', () => {
    const need = needWith('critical', ['photo']);
    const blocks = buildSignoffControls(need, verificationStatus(need));
    const btn = firstButton(blocks);
    expect(btn.style).toBeUndefined();
    const dump = JSON.stringify(blocks);
    expect(dump).toContain('missing:');
    expect(dump).toContain('location');
    expect(dump).toContain('recipient confirmation');
    // The sign-off itself is never listed as a prerequisite of the sign-off button.
    expect(dump).not.toContain('coordinator sign-off');
  });
});

describe('parseDeliverySubmission', () => {
  it('round-trips a full submission (confirmed locality + photo ref + note)', () => {
    const view = stateView({
      [DELIVERY_FIELD.locality]: {
        [DELIVERY_FIELD.locality]: { type: 'static_select', selected_option: { value: 'confirmed' } },
      },
      [DELIVERY_FIELD.photo]: { [DELIVERY_FIELD.photo]: { type: 'plain_text_input', value: 'F123ABC' } },
      [DELIVERY_FIELD.note]: { [DELIVERY_FIELD.note]: { type: 'plain_text_input', value: 'left at the gate' } },
    });
    expect(parseDeliverySubmission(view)).toEqual({
      localityConfirmed: true,
      photoRef: 'F123ABC',
      note: 'left at the gate',
    });
  });

  it('uses the in-thread sentinel when only the checkbox is ticked, and reads unconfirmed locality', () => {
    const view = stateView({
      [DELIVERY_FIELD.locality]: {
        [DELIVERY_FIELD.locality]: { type: 'static_select', selected_option: { value: 'unconfirmed' } },
      },
      [DELIVERY_FIELD.photoAttached]: {
        [DELIVERY_FIELD.photoAttached]: { type: 'checkboxes', selected_options: [{ value: 'attached' }] },
      },
    });
    expect(parseDeliverySubmission(view)).toEqual({ localityConfirmed: false, photoRef: PHOTO_IN_THREAD });
  });

  it('omits photoRef and note on an empty submission and defaults locality to unconfirmed', () => {
    expect(parseDeliverySubmission(stateView({}))).toEqual({ localityConfirmed: false });
  });
});
