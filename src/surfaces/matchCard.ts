import type { NeedType } from '../ledger/types';
import type { ScoredCandidate } from '../match/scorer';
import { actions, button, context, divider, escapeMrkdwn, header, type SlackBlock, section } from './primitives';

// The match card (BUILD-DOC §F2/§F3). After a human confirms triage, the scorer ranks
// volunteers and this renders the top few as Block Kit — each with a proportional score
// bar, the one-line rationale, and an Assign button. Assign is a HUMAN-gated transition,
// so clicking it is what a coordinator does to commit; the handler emits the Assigned
// event. Pure over its inputs — no Slack client, no store — so it is unit-testable.

/** The Assign-pick action. The entity id packs BOTH ids because parseActionId splits on
 * the FIRST ':' only, so we join needId + volunteerId with '|' instead:
 *   action_id = `need_assign_pick:<needId>|<volunteerId>`
 * The handler does parseActionId(id) → { action, id } then parseAssignTarget(id). */
export const ASSIGN_PICK_ACTION = 'need_assign_pick';

/** The Reassign-pick action (drift/F4). Same packed `<needId>|<volunteerId>` entity id
 * as ASSIGN_PICK_ACTION — encodeAssignTarget / parseAssignTarget round-trip both — but a
 * distinct action id so the drift reassignment card routes to the Reassigned handler
 * instead of the initial-assign one. Rendered by buildMatchBlocks via opts.assignAction. */
export const REASSIGN_PICK_ACTION = 'need_reassign_pick';

/** Pack a need id + volunteer id into one action entity id (split on the first '|'). */
export function encodeAssignTarget(needId: string, volunteerId: string): string {
  return `${needId}|${volunteerId}`;
}

/** Recover { needId, volunteerId } from the packed entity id / button value. */
export function parseAssignTarget(entityId: string): { needId: string; volunteerId: string } {
  const i = entityId.indexOf('|');
  return i < 0
    ? { needId: entityId, volunteerId: '' }
    : { needId: entityId.slice(0, i), volunteerId: entityId.slice(i + 1) };
}

/** The minimal need view the card needs — ids + classification, no raw text, no PII. */
export interface MatchNeed {
  needId: string;
  publicId?: string;
  type: NeedType;
  localityText?: string | null;
}

/** A scored candidate with its (already-built) rationale line. */
export type RankedCandidate = ScoredCandidate & { rationale: string };

const BAR_CELLS = 10;

/** A proportional unicode meter for a score in [0,1]: ▓ filled, ░ empty. */
export function scoreBar(score: number): string {
  const clamped = Math.min(1, Math.max(0, score));
  const filled = Math.round(clamped * BAR_CELLS);
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)}`;
}

/**
 * One candidate: a name + score header line, a readable unicode score bar over the one-line
 * rationale, then a clear Assign button. `index` drives a divider between candidates (not before
 * the first) so the slate reads as distinct rows rather than a stacked wall.
 */
function candidateBlocks(need: MatchNeed, c: RankedCandidate, assignAction: string, index: number): SlackBlock[] {
  const pct = Math.round(Math.min(1, Math.max(0, c.score)) * 100);
  const name = escapeMrkdwn(c.volunteer.display_name);
  const line = escapeMrkdwn(c.rationale);
  const blocks: SlackBlock[] = [];
  if (index > 0) blocks.push(divider);
  blocks.push(
    section(`*${name}* — ${pct}% match\n\`${scoreBar(c.score)}\`  ${line}`),
    actions([button('Assign', assignAction, encodeAssignTarget(need.needId, c.volunteer.slack_user_id), 'primary')]),
  );
  return blocks;
}

/** Render options for buildMatchBlocks. */
export interface MatchBlocksOptions {
  /** The Assign button's action id (default ASSIGN_PICK_ACTION; REASSIGN_PICK_ACTION for drift). */
  assignAction?: string;
}

/**
 * Build the match card blocks for a need and its ranked candidates. Pass the already
 * top-N'd, rationale-attached list (scoreVolunteers → topN → matchRationale). An empty
 * list renders a "no match" note instead of buttons. `opts.assignAction` swaps the
 * Assign button's action id so the same slate drives initial-assign or reassignment.
 */
export function buildMatchBlocks(
  need: MatchNeed,
  ranked: RankedCandidate[],
  opts: MatchBlocksOptions = {},
): SlackBlock[] {
  const assignAction = opts.assignAction ?? ASSIGN_PICK_ACTION;
  const idLabel = need.publicId ? `${need.publicId} · ` : '';
  const where = need.localityText ? ` in ${escapeMrkdwn(need.localityText)}` : '';
  const blocks: SlackBlock[] = [
    header(`${idLabel}Suggested volunteers`),
    context(`Top ${ranked.length} match${ranked.length === 1 ? '' : 'es'} for *${need.type}*${where}`),
  ];
  if (ranked.length === 0) {
    blocks.push(section('_No available volunteers matched this need. Widen radius or check the roster._'));
    return blocks;
  }
  blocks.push(divider);
  for (const [index, c] of ranked.entries()) blocks.push(...candidateBlocks(need, c, assignAction, index));
  blocks.push(context('_Assign is a human decision — clicking it commits the volunteer and starts the SLA clock._'));
  return blocks;
}
