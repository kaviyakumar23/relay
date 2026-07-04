import type { ProjectedNeed } from '../ledger/types';
import { ACTIONS, actions, button, context, header, type SlackBlock } from './primitives';

// The dispatch card (BUILD-DOC §F2). Day-1 "walking skeleton" version: a need
// materialises in #relay-dispatch the instant its intake message lands, BEFORE
// any extraction. So it is deliberately dumb — header + provenance context +
// "extraction pending" chips + placeholder action buttons. It shows only Slack
// object references (public id, source permalink, timestamps, state): NEVER the
// raw message text (zero-copy, invariant #5).
//
// Confidence chips, stated/inferred/unknown fields, and live Confirm/Assign
// handlers arrive with triage (Jul 6). The action_ids are wired now so the
// buttons render and route from Day-1 (their handlers post a "coming soon"
// ephemeral until then).

/** A friendly received-time label from an ISO timestamp (UTC, second precision). */
function receivedLabel(iso: string): string {
  const cleaned = iso.slice(0, 19).replace('T', ' ');
  return `${cleaned} UTC`;
}

/** The header classification label. Pre-extraction needs (type=other, still NEW)
 * read as UNCLASSIFIED; once triage runs the real type/severity take over. */
function classification(need: ProjectedNeed): string {
  const classified = need.type !== 'other' || need.state !== 'NEW';
  return classified ? `${need.type.toUpperCase()} · ${need.severity.toUpperCase()}` : 'UNCLASSIFIED';
}

/**
 * Build the Day-1 dispatch card blocks for a freshly-created need.
 * @param publicId human-facing id (N-0001)
 * @param need the projected need (state, source, timestamps) — no message text
 */
export function dispatchCard(publicId: string, need: ProjectedNeed): SlackBlock[] {
  const sourceRef = need.source.permalink
    ? `<${need.source.permalink}|View source message>`
    : '_source permalink unavailable_';

  return [
    header(`${publicId} · ${classification(need)}`),
    context(`${sourceRef}  ·  Received ${receivedLabel(need.created_at)}  ·  Status: *${need.state}*`),
    // Placeholder confidence chips — triage fills these with stated/inferred/unknown.
    context('Confidence: `extraction pending` — Relay will classify type, severity, location & headcount shortly.'),
    actions([
      button('Confirm', ACTIONS.confirm, need.need_id, 'primary'),
      button('Assign', ACTIONS.assign, need.need_id),
    ]),
    context('_Confirm & Assign go live in the triage phase (Jul 6). A human confirms every consequential transition._'),
  ];
}
