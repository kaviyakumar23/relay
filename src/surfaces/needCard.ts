import type { NeedEvent } from '../ledger/events';
import type { ConfidenceStatus, ProjectedNeed } from '../ledger/types';
import { buildSignoffControls, MARK_DELIVERED_ACTION } from './evidenceModal';
import { buildEvidencePacket } from './evidencePacket';
import {
  ACTIONS,
  actions,
  button,
  context,
  escapeMrkdwn,
  fields,
  header,
  type SlackBlock,
  section,
} from './primitives';
import { verificationStatus } from './verification';

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

/** action_id for the reveal-with-audit button (wired in src/ingest/slackApp.ts). */
const REVEAL_ACTION = 'need_reveal';

/** States in which Confirm/Assign are still offered (pre-commit). Past this, the
 * card shows a status line instead of the action row. */
const PRE_COMMIT_STATES: ReadonlySet<string> = new Set([
  'NEW',
  'TRIAGED',
  'OPEN',
  'NEEDS_REVIEW',
  'MATCH_SUGGESTED',
  'REOPENED',
]);

/** Pack a need id + the proposed original's id into one Merge action entity id.
 * parseActionId splits on the FIRST ':' only, so the two ids are joined with '|':
 *   action_id = `need_merge:<needId>|<otherNeedId>`  (see ACTIONS.merge). */
export function encodeMergeTarget(needId: string, otherNeedId: string): string {
  return `${needId}|${otherNeedId}`;
}

/** Recover { needId, otherNeedId } from a packed Merge entity id / button value. */
export function parseMergeTarget(entityId: string): { needId: string; otherNeedId: string } {
  const i = entityId.indexOf('|');
  return i < 0
    ? { needId: entityId, otherNeedId: '' }
    : { needId: entityId.slice(0, i), otherNeedId: entityId.slice(i + 1) };
}

/** Optional render inputs. `events` powers the duplicate banner (auto-detected
 * DuplicateProposed); `publicIdOf` resolves an internal need id to its N-000x label
 * for the banner / merged-into line (best-effort — falls back to a neutral phrase). */
export interface DispatchCardOptions {
  events?: NeedEvent[];
  publicIdOf?: (needId: string) => string | undefined;
}

/** A friendly received-time label from an ISO timestamp (UTC, second precision). */
function receivedLabel(iso: string): string {
  const cleaned = iso.slice(0, 19).replace('T', ' ');
  return `${cleaned} UTC`;
}

/** A friendly SLA-due label (UTC, minute precision) for the obligation countdown line. */
function slaDueLabel(iso: string): string {
  const cleaned = iso.slice(0, 16).replace('T', ' ');
  return `${cleaned} UTC`;
}

/**
 * Obligation status + SLA line (+ drift flare) for a committed need (§F4). Pure over the
 * projection: is_drifting / is_at_risk are already computed against `now`, so the card
 * flares ⚠️ the moment a delivery drifts without the card needing a clock of its own.
 *
 * The evidence controls (Mark delivered / packet / sign-off) are rendered by
 * evidenceFlowBlocks below, keyed off the delivery state.
 */
function obligationStatusBlocks(need: ProjectedNeed): SlackBlock[] {
  const out: SlackBlock[] = [];
  const who = need.assigned_volunteer_id !== null ? ` <@${need.assigned_volunteer_id}>` : '';
  if (need.state === 'CLAIMED') {
    out.push(context(`🔧 *Claimed*${who ? ` by${who}` : ''}`));
  } else if (need.state === 'IN_PROGRESS') {
    out.push(context(`🚚 *In progress*${who ? ` —${who} en route` : ''}`));
  } else if (need.assigned_volunteer_id !== null) {
    out.push(context(`✅ *Assigned*${who ? ` to${who}` : ''} — a volunteer is committed.`));
  }
  if (need.sla_due_at !== null && (need.state === 'CLAIMED' || need.state === 'IN_PROGRESS')) {
    const due = slaDueLabel(need.sla_due_at);
    if (need.flags.is_drifting) {
      out.push(context(`⚠️ *DRIFTING* — past SLA (was due ${due})`));
    } else if (need.flags.is_at_risk) {
      out.push(context(`⏳ *At risk* — SLA due ${due}`));
    } else {
      out.push(context(`⏱️ SLA due ${due}`));
    }
  }
  return out;
}

/** States in which the delivery has been reported and the evidence/verification trail shows. */
const DELIVERED_STATES: ReadonlySet<string> = new Set(['DELIVERED_UNVERIFIED', 'VERIFIED', 'CLOSED']);

/**
 * The evidence/verification section of a committed card (§F5). Keyed off the delivery state:
 *  • CLAIMED / IN_PROGRESS — the obligation status + SLA line, then a "Mark delivered" button
 *    that opens the evidence-capture modal (nothing closes on a report alone).
 *  • DELIVERED_UNVERIFIED  — the evidence packet + verification badge, plus the policy-gated
 *    sign-off control (locked, with a missing-evidence hint, until the packet is complete).
 *  • VERIFIED / CLOSED     — the closed banner ("✅ Verified · Closed") + the full evidence
 *    packet as the permanent proof. No further action.
 * Pure over the projection — buildEvidencePacket / buildSignoffControls / verificationStatus
 * are the single source of truth so this card can never disagree with the ledger's gate.
 */
function evidenceFlowBlocks(need: ProjectedNeed): SlackBlock[] {
  if (need.state === 'CLAIMED' || need.state === 'IN_PROGRESS') {
    return [
      ...obligationStatusBlocks(need),
      actions([button('📦 Mark delivered', MARK_DELIVERED_ACTION, need.need_id, 'primary')]),
    ];
  }
  if (need.state === 'DELIVERED_UNVERIFIED') {
    return [
      context('📦 *Delivered — pending verification*'),
      ...buildEvidencePacket(need),
      ...buildSignoffControls(need, verificationStatus(need)),
    ];
  }
  // VERIFIED or CLOSED — the permanent proof trail.
  const banner = need.state === 'CLOSED' ? '✅ *Verified · Closed*' : '✅ *Verified*';
  return [section(`${banner} — delivery proven, the loop is closed on evidence.`), ...buildEvidencePacket(need)];
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

/** Banner block(s) for each auto-detected duplicate (DuplicateProposed) that has not
 * yet been human-merged: a warning line naming the likely original + a Merge button. */
function duplicateBanners(need: ProjectedNeed, opts: DispatchCardOptions): SlackBlock[] {
  const events = opts.events ?? [];
  const out: SlackBlock[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== 'DuplicateProposed') continue;
    const otherId = e.payload.other_need_id;
    if (otherId === '' || seen.has(otherId)) continue;
    seen.add(otherId);
    const label = opts.publicIdOf?.(otherId) ?? 'a recent report';
    const why = e.payload.reason === 'exact_contact' ? 'same contact' : 'similar report';
    out.push(section(`⚠️ *Possible duplicate of ${escapeMrkdwn(label)}* — ${why}.`));
    out.push(actions([button('Merge', ACTIONS.merge, encodeMergeTarget(need.need_id, otherId), 'danger')]));
  }
  return out;
}

/** Compact card for a need already confirmed a duplicate (state DUPLICATE): it shows
 * where it was merged, and offers no further action. */
function mergedCard(publicId: string, need: ProjectedNeed, opts: DispatchCardOptions): SlackBlock[] {
  const target = (need.merged_into !== null ? opts.publicIdOf?.(need.merged_into) : undefined) ?? 'another need';
  return [
    header(headerText(publicId, need)),
    context(`Received ${receivedLabel(need.created_at)}  ·  Status: *DUPLICATE*`),
    section(`🔗 *Merged into ${escapeMrkdwn(target)}* — this report is tracked there. No action needed here.`),
    fieldsBlock(need),
  ];
}

/**
 * Build the dispatch card blocks for a need.
 * @param publicId human-facing id (N-0001)
 * @param need the projected need (state, type/severity, derived fields) — no message text
 * @param opts optional events (duplicate banner) + a public-id resolver
 */
export function dispatchCard(publicId: string, need: ProjectedNeed, opts: DispatchCardOptions = {}): SlackBlock[] {
  if (need.merged_into !== null) return mergedCard(publicId, need, opts);

  // A vaulted contact is signalled by the derived `contact` confidence key (never the
  // number). Show the locked reveal control only when there is something to reveal.
  const hasContact = need.confidence.contact === 'stated';
  const committed = !PRE_COMMIT_STATES.has(need.state);

  const blocks: SlackBlock[] = [
    header(headerText(publicId, need)),
    context(`Received ${receivedLabel(need.created_at)}  ·  Status: *${need.state}*`),
    ...duplicateBanners(need, opts),
    fieldsBlock(need),
    confidenceBlock(need),
  ];

  if (committed) {
    // Past triage/assign: no Confirm/Assign row. Render the evidence/verification flow
    // (status + Mark delivered → packet + sign-off → closed proof) for delivery states, or
    // the plain obligation status otherwise. Reveal stays available until the delivery is
    // VERIFIED/CLOSED, then the contact controls hide (the loop is closed).
    if (DELIVERED_STATES.has(need.state) || need.state === 'CLAIMED' || need.state === 'IN_PROGRESS') {
      blocks.push(...evidenceFlowBlocks(need));
    } else {
      blocks.push(...obligationStatusBlocks(need));
    }
    const revealHidden = need.state === 'VERIFIED' || need.state === 'CLOSED';
    if (hasContact && !revealHidden) blocks.push(actions([button('🔒 Reveal contact', REVEAL_ACTION, need.need_id)]));
  } else {
    const actionRow: SlackBlock[] = [
      button('Confirm', ACTIONS.confirm, need.need_id, 'primary'),
      button('Assign', ACTIONS.assign, need.need_id),
    ];
    if (hasContact) actionRow.push(button('🔒 Reveal contact', REVEAL_ACTION, need.need_id));
    blocks.push(actions(actionRow));
  }

  const contactControlsHidden = need.state === 'VERIFIED' || need.state === 'CLOSED';
  if (hasContact && !contactControlsHidden) {
    blocks.push(context('_🔒 Contact is stored encrypted. Reveal writes an audit_log entry._'));
  }
  blocks.push(context('_A human confirms every consequential transition._'));
  return blocks;
}
