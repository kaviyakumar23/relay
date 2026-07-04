// Block Kit primitives — the typed vocabulary every Relay surface is built from
// (ported from kept's blocks.ts). Plain objects only (valid Slack JSON), so the
// builders stay dependency-light and unit-testable without a Slack client.
//
// Action ids encode their target as `action:entityId` (CLAUDE.md convention):
// actionId('need_confirm', needId) → 'need_confirm:<needId>', parsed back by
// parseActionId. This is how a single regex-registered handler knows which need
// a button click refers to.

/** A Block Kit block — valid Slack JSON. */
export type SlackBlock = Record<string, unknown>;
/** A Block Kit view (App Home / modal) — valid Slack JSON. */
export type SlackView = Record<string, unknown>;

// --- action id routing -----------------------------------------------------

/** The interactive targets Relay renders. Confirm/Assign are placeholders until
 * the triage phase (Jul 6) — the ids are wired now so handlers exist from Day-1. */
export const ACTIONS = {
  confirm: 'need_confirm',
  assign: 'need_assign',
  merge: 'need_merge',
  history: 'need_history',
} as const;

export type ActionKind = (typeof ACTIONS)[keyof typeof ACTIONS];

export const actionId = (action: string, id: string): string => `${action}:${id}`;

/** Split an `action:entityId` id back into its parts (the entity id may itself be empty). */
export function parseActionId(id: string): { action: string; id: string } {
  const i = id.indexOf(':');
  return i < 0 ? { action: id, id: '' } : { action: id.slice(0, i), id: id.slice(i + 1) };
}

// --- text safety -----------------------------------------------------------

/** Neutralize Slack mrkdwn control chars so an adapter/LLM-supplied value can't
 * inject a mention, channel link, or `<url|text>` link. */
export const escapeMrkdwn = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- block builders --------------------------------------------------------

export const section = (text: string): SlackBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });

export const context = (text: string): SlackBlock => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

export const header = (text: string): SlackBlock => ({
  type: 'header',
  text: { type: 'plain_text', text, emoji: true },
});

export const divider: SlackBlock = { type: 'divider' };

/** A `fields` section (Slack renders these in a two-column grid). */
export const fields = (values: string[]): SlackBlock => ({
  type: 'section',
  fields: values.map((text) => ({ type: 'mrkdwn', text })),
});

export const button = (text: string, action: string, id: string, style?: 'primary' | 'danger'): SlackBlock => ({
  type: 'button',
  text: { type: 'plain_text', text, emoji: true },
  action_id: actionId(action, id),
  value: id,
  ...(style ? { style } : {}),
});

export const actions = (elements: SlackBlock[]): SlackBlock => ({ type: 'actions', elements });

// --- modals ----------------------------------------------------------------

/** A modal view. private_metadata round-trips the entity id back on view_submission. */
export function modal(
  callbackId: string,
  title: string,
  blocks: SlackBlock[],
  submit: string,
  privateMetadata = '',
): SlackView {
  return {
    type: 'modal',
    callback_id: callbackId,
    private_metadata: privateMetadata,
    title: { type: 'plain_text', text: title },
    submit: { type: 'plain_text', text: submit },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

/** A single-line or multiline text input block. */
export function inputBlock(
  blockId: string,
  label: string,
  action: string,
  initial: string,
  opts: { multiline?: boolean; optional?: boolean } = {},
): SlackBlock {
  const element: Record<string, unknown> = {
    type: 'plain_text_input',
    action_id: action,
    multiline: opts.multiline ?? false,
  };
  if (initial) element.initial_value = initial;
  return {
    type: 'input',
    block_id: blockId,
    optional: opts.optional ?? false,
    label: { type: 'plain_text', text: label },
    element,
  };
}
