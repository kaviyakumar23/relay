import type { ConfidenceStatus, ProjectedNeed } from '../ledger/types';
import { ACTIONS, actions, button, context, escapeMrkdwn, fields, header, type SlackBlock } from './primitives';

// The dispatch card (BUILD-DOC §F2). Post-extraction version: a need materialises in
// #relay-dispatch and, once P-1 extraction runs, the card shows the classified
// type/severity, the derived fields (locality/location, headcount, source), a
// per-field confidence row, and a locked reveal-contact control. It renders ONLY
// derived, Slack-object-reference data — NEVER the raw message text and NEVER the
// beneficiary contact (zero-copy + PII, invariants #5). A need still in NEW/other
// (extraction skipped or pending) falls back to the UNCLASSIFIED header.
//
// Live Confirm/Assign handlers ship with triage; the reveal handler writes an
// audit_log row and ships with the vault UI — for now it posts a "coming soon"
// ephemeral (wired in src/ingest/slackApp.ts). Pure function of the projection.

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

/** Confidence glyphs shown on the card (InView DNA): stated ✓ · inferred ~ · unknown ? */
const CONFIDENCE_GLYPH: Record<ConfidenceStatus, string> = {
  stated: '✓',
  inferred: '~',
  unknown: '?',
};

/** action_id for the (later-phase) reveal-with-audit button. */
const REVEAL_ACTION = 'need_reveal';

/** A friendly received-time label from an ISO timestamp (UTC, second precision). */
function receivedLabel(iso: string): string {
  const cleaned = iso.slice(0, 19).replace('T', ' ');
  return `${cleaned} UTC`;
}

/** Header classification. Pre-extraction needs (type=other, still NEW) read as
 * UNCLASSIFIED; once extraction runs, type + severity + a severity emoji take over. */
function headerText(publicId: string, need: ProjectedNeed): string {
  const classified = need.type !== 'other' || need.state !== 'NEW';
  if (!classified) return `${publicId} · UNCLASSIFIED`;
  const emoji = SEVERITY_EMOJI[need.severity] ?? '';
  return `${publicId} · ${need.type.toUpperCase()} · ${need.severity.toUpperCase()} ${emoji}`.trimEnd();
}

/** The derived fields block: location, headcount, source permalink. No raw text. */
function fieldsBlock(need: ProjectedNeed): SlackBlock {
  const sourceRef = need.source.permalink
    ? `<${need.source.permalink}|View source message>`
    : '_source permalink unavailable_';
  const location = need.location_text ? escapeMrkdwn(need.location_text) : '_unknown_';
  const people = need.people_count !== null ? String(need.people_count) : '_unknown_';
  return fields([
    `*Location:*\n${location}`,
    `*People:*\n${people}`,
    `*Source:*\n${sourceRef}`,
    `*Status:*\n${need.state}`,
  ]);
}

/** Per-field confidence chips, or the pre-extraction pending note when empty. */
function confidenceBlock(need: ProjectedNeed): SlackBlock {
  const chip = (label: string, key: string): string | null => {
    const status = need.confidence[key];
    return status === undefined ? null : `${label} ${CONFIDENCE_GLYPH[status]}`;
  };
  const parts = [
    chip('Type', 'type'),
    chip('Severity', 'severity'),
    chip('Locality', 'locality'),
    chip('People', 'people_count'),
  ].filter((c): c is string => c !== null);

  if (parts.length === 0) {
    return context(
      'Confidence: `extraction pending` — Relay will classify type, severity, location & headcount shortly.',
    );
  }
  return context(`Confidence: ${parts.join('  ·  ')}   ( ✓ stated · ~ inferred · ? unknown )`);
}

/**
 * Build the dispatch card blocks for a need.
 * @param publicId human-facing id (N-0001)
 * @param need the projected need (state, type/severity, derived fields) — no message text
 */
export function dispatchCard(publicId: string, need: ProjectedNeed): SlackBlock[] {
  // A vaulted contact is signalled by the derived `contact` confidence key (never the
  // number). Show the locked reveal control only when there is something to reveal.
  const hasContact = need.confidence.contact === 'stated';

  const actionRow: SlackBlock[] = [
    button('Confirm', ACTIONS.confirm, need.need_id, 'primary'),
    button('Assign', ACTIONS.assign, need.need_id),
  ];
  if (hasContact) actionRow.push(button('🔒 Reveal contact', REVEAL_ACTION, need.need_id));

  const blocks: SlackBlock[] = [
    header(headerText(publicId, need)),
    context(`Received ${receivedLabel(need.created_at)}  ·  Status: *${need.state}*`),
    fieldsBlock(need),
    confidenceBlock(need),
    actions(actionRow),
  ];
  if (hasContact) {
    blocks.push(context('_🔒 Contact is stored encrypted. Reveal writes an audit_log entry (vault UI, later phase)._'));
  }
  blocks.push(
    context('_Confirm & Assign go live in the triage phase. A human confirms every consequential transition._'),
  );
  return blocks;
}
