import type { NeedType } from '../ledger/types';
import { type LocalityCoord, type ScoredCandidate, type ScoreNeed, topN } from '../match/scorer';
import type { Volunteer } from '../match/volunteerStore';

// Pre-warmed backup (Moonshot — a REAL scored candidate, not theater). When an obligation is
// live (claimed / in progress), Relay pre-computes the single best ALTERNATIVE volunteer — the
// one it would surface first if this delivery drifts and has to be reassigned. Surfacing that
// backup on the card the moment work is claimed turns reassignment from a scramble into a
// one-tap hand-off the coordinator already knows the answer to.
//
// This is deliberately the SAME deterministic scorer the live match + drift-reassign paths use
// (topN over match/scorer): the backup is the genuine #1 candidate from the roster with the
// current assignee removed, with its real score + breakdown — never a fabricated stand-in.
//
// PURE: no store, no Slack, no clock, no random. The card renderer + the drift sweep inject the
// roster + gazetteer; the demo/tests prove it hermetically.
//
// INTEGRATOR NOTE: compute this only for a need in a DELIVERING state with an assignee (there is
// something to back up), pass it through the dispatch card's `backup` option so the chip renders,
// and — best effort — send the backup a low-key heads-up DM for high/critical needs. The backup is
// advisory: committing it is still the human-gated need_reassign_pick, never an auto-assign.

/** The minimal need view the backup scorer needs — no raw text, no PII. */
export interface BackupNeed {
  type: NeedType;
  localityId: number | null;
  languages: string[];
  /** The volunteer currently holding the obligation, excluded from the backup pool. */
  assignedVolunteerId: string | null;
}

/** A pre-warmed backup is a genuine scored candidate (score + breakdown + distance). */
export type BackupCandidate = ScoredCandidate;

/**
 * The best backup volunteer for a live obligation: the top-scored roster candidate with the
 * current assignee removed, or null when nobody else is available. Deterministic — identical
 * ordering + numbers to the match slate and the reassignment card.
 */
export function computeBackup(
  need: BackupNeed,
  volunteers: Volunteer[],
  localities: LocalityCoord[],
): BackupCandidate | null {
  const scoreNeed: ScoreNeed = { type: need.type, localityId: need.localityId, languages: need.languages };
  const pool =
    need.assignedVolunteerId !== null
      ? volunteers.filter((v) => v.slack_user_id !== need.assignedVolunteerId)
      : volunteers;
  return topN(scoreNeed, pool, localities, 1)[0] ?? null;
}
