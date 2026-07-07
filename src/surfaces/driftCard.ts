import type { ProjectedNeed } from '../ledger/types';
import { buildMatchBlocks, type MatchNeed, type RankedCandidate, REASSIGN_PICK_ACTION } from './matchCard';
import { actions, button, context, divider, escapeMrkdwn, header, type SlackBlock, section } from './primitives';

// Drift surfaces (BUILD-DOC §F4). Two Block Kit builders, both pure over the projection:
//  - buildNudgeBlocks     — the DM Relay sends the assigned volunteer when their delivery
//                           crosses at-risk / overdue, with On-my-way / Delayed / Release.
//  - buildReassignBlocks  — the card Relay posts to #relay-dispatch when a delivery drifts
//                           or is released: a drift flare + a FRESH top-3 whose Assign
//                           buttons trigger Reassigned (REASSIGN_PICK_ACTION), so a
//                           coordinator one-click hands the obligation to someone else.
// Neither renders raw message text or beneficiary contact (zero-copy + PII, invariant #5) —
// only derived fields (type, locality, status) and Slack user ids.

/** The nudge-reply action ids (the DM buttons). Each carries the need id as its entity. */
export const ENROUTE_ACTION = 'need_enroute';
export const DELAYED_ACTION = 'need_delayed';
export const RELEASE_ACTION = 'need_release';

/** A short, PII-free label for what the obligation is: "food in Velachery". */
function whatLabel(need: ProjectedNeed): string {
  const where = need.location_text ? ` in ${escapeMrkdwn(need.location_text)}` : '';
  return `*${need.type}*${where}`;
}

/** The volunteer's acknowledgement, once they tap a button — replaces the action row. */
export type NudgeAck = 'en_route' | 'delayed' | 'released';

const ACK_LINE: Record<NudgeAck, string> = {
  en_route: '🚚 *On my way* — marked in progress. Thank you.',
  delayed: '⏱️ *Marked delayed* — a coordinator has been alerted.',
  released: '↩️ *Released* — handed back for reassignment. Thank you.',
};

/**
 * The DM Relay sends the assigned volunteer when their delivery drifts. `kind` picks the
 * tone (approaching vs past SLA); `opts.ack` renders the confirmation the button click
 * produced (and drops the buttons) instead of the live action row.
 */
export function buildNudgeBlocks(
  need: ProjectedNeed,
  publicId: string,
  kind: 'at_risk' | 'overdue',
  opts: { ack?: NudgeAck } = {},
): SlackBlock[] {
  const heading =
    kind === 'overdue'
      ? `⚠️ *${publicId} is now OVERDUE* — ${whatLabel(need)}`
      : `⏳ *${publicId} is approaching its deadline* — ${whatLabel(need)}`;
  const blocks: SlackBlock[] = [section(heading)];
  if (opts.ack !== undefined) {
    blocks.push(context(ACK_LINE[opts.ack]));
    return blocks;
  }
  blocks.push(context('Can you still make this delivery? Let the team know so no one is left waiting.'));
  blocks.push(
    actions([
      button('On my way', ENROUTE_ACTION, need.need_id, 'primary'),
      button('Delayed', DELAYED_ACTION, need.need_id),
      button('Release', RELEASE_ACTION, need.need_id, 'danger'),
    ]),
  );
  return blocks;
}

/**
 * The narration for the reassignment card — the demo's hero moment (BUILD-DOC §F4, hero rule).
 * A silent delivery failure must NOT read as a neutral routing task: the card has to tell the
 * story a judge should retell — Relay noticed a stuck volunteer before the delivery was missed.
 * Calm and factual, never alarmist. Three cases: past SLA (drifting), approaching (at risk),
 * or handed back (released).
 */
function reassignNarration(need: ProjectedNeed, publicId: string): { header: string; line: string } {
  if (need.flags.is_drifting) {
    return {
      header: '⚠️ Delivery drifting — volunteer stuck',
      line: `*${publicId}* is past its SLA and the assigned volunteer hasn't moved. Relay caught it — reassign before it's missed.`,
    };
  }
  if (need.flags.is_at_risk) {
    return {
      header: '⏳ Delivery at risk — SLA approaching',
      line: `*${publicId}* is approaching its SLA with no progress yet. Relay flagged it early — hand it to a fresh volunteer to keep it on time.`,
    };
  }
  return {
    header: '↩️ Released — needs a new volunteer',
    line: `*${publicId}* was handed back and is waiting. Relay kept the obligation alive — reassign it so no one is left waiting.`,
  };
}

/**
 * The reassignment card posted to #relay-dispatch when a delivery drifts or is released.
 * The hero narration (a titled header + a one-line story) states what Relay caught, then a
 * FRESH top-3 slate (already scored + excluding the current volunteer) whose Assign buttons
 * carry REASSIGN_PICK_ACTION for a one-click hand-off.
 */
export function buildReassignBlocks(need: ProjectedNeed, publicId: string, ranked: RankedCandidate[]): SlackBlock[] {
  const narration = reassignNarration(need, publicId);
  const matchNeed: MatchNeed = {
    needId: need.need_id,
    publicId,
    type: need.type,
    localityText: need.location_text,
  };
  return [
    header(narration.header),
    section(narration.line),
    context(`${whatLabel(need)} · one-click hand-off to a fresh volunteer below.`),
    divider,
    ...buildMatchBlocks(matchNeed, ranked, { assignAction: REASSIGN_PICK_ACTION }),
  ];
}
