import type { NeedType } from '../ledger/types';
import type { ScoredCandidate } from '../match/scorer';
import { actions, button, context, escapeMrkdwn, header, type SlackBlock, section } from './primitives';

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

function candidateBlocks(need: MatchNeed, c: RankedCandidate): SlackBlock[] {
  const pct = Math.round(Math.min(1, Math.max(0, c.score)) * 100);
  const name = escapeMrkdwn(c.volunteer.display_name);
  const line = escapeMrkdwn(c.rationale);
  return [
    section(`*${name}*  \`${scoreBar(c.score)}\` ${pct}%\n${line}`),
    actions([
      button('Assign', ASSIGN_PICK_ACTION, encodeAssignTarget(need.needId, c.volunteer.slack_user_id), 'primary'),
    ]),
  ];
}

/**
 * Build the match card blocks for a need and its ranked candidates. Pass the already
 * top-N'd, rationale-attached list (scoreVolunteers → topN → matchRationale). An empty
 * list renders a "no match" note instead of buttons.
 */
export function buildMatchBlocks(need: MatchNeed, ranked: RankedCandidate[]): SlackBlock[] {
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
  for (const c of ranked) blocks.push(...candidateBlocks(need, c));
  blocks.push(context('_Assign is a human decision — clicking it commits the volunteer and starts the SLA clock._'));
  return blocks;
}
