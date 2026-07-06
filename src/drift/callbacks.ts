import type { Notifier } from '../ingest/notifier';
import type { NeedService } from '../ledger/needService';
import type { ProjectedNeed } from '../ledger/types';
import type { LlmProvider } from '../llm/provider';
import { matchRationale } from '../match/rationale';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import type { VolunteerStore } from '../match/volunteerStore';
import { buildNudgeBlocks, buildReassignBlocks } from '../surfaces/driftCard';
import type { RankedCandidate } from '../surfaces/matchCard';
import type { NudgeKind } from './driftEngine';

// The Slack side effects the drift sweep + drift button handlers fire, built ONCE and
// shared by live mode (src/server.ts) and the hermetic demo (src/demo/driver.ts) so both
// exercise the same reassignment scoring + card shape. Everything here is injected behind
// the Notifier / VolunteerStore seams, so it is fully hermetic under RecordingNotifier.

export interface DriftCallbackDeps {
  service: NeedService;
  notifier: Notifier;
  volunteerStore: VolunteerStore;
  localities: LocalityCoord[];
  /** Resolve a need's public_id (N-000x) for card labels; falls back to the raw id. */
  resolvePublicId: (needId: string) => Promise<string>;
  /** Optional LLM for the one-line rationale (falls back to the deterministic template). */
  llm?: LlmProvider;
}

export interface DriftCallbacks {
  /** DM the assigned volunteer that their delivery is drifting (at-risk / overdue). */
  notifyNudge: (need: ProjectedNeed, kind: NudgeKind) => Promise<void>;
  /**
   * Post a reassignment card to #relay-dispatch with a FRESH top-3 (excluding the current
   * volunteer) whose Assign buttons trigger Reassigned. `excludeVolunteerId` overrides the
   * exclusion when the need has already left the volunteer's hands (e.g. post-release the
   * projection's assigned_volunteer_id is null, so the releasing user is passed explicitly).
   */
  proposeReassign: (need: ProjectedNeed, excludeVolunteerId?: string) => Promise<void>;
}

/** Build the drift Slack side effects over the injected seams. */
export function buildDriftCallbacks(deps: DriftCallbackDeps): DriftCallbacks {
  const notifyNudge = async (need: ProjectedNeed, kind: NudgeKind): Promise<void> => {
    if (need.assigned_volunteer_id === null) return; // nobody to nudge
    const publicId = await deps.resolvePublicId(need.need_id);
    await deps.notifier.postDirect(
      need.assigned_volunteer_id,
      `${publicId} needs an update`,
      buildNudgeBlocks(need, publicId, kind),
    );
  };

  const proposeReassign = async (need: ProjectedNeed, excludeVolunteerId?: string): Promise<void> => {
    const publicId = await deps.resolvePublicId(need.need_id);
    const excludeId = excludeVolunteerId ?? need.assigned_volunteer_id ?? undefined;
    const scoreNeed: ScoreNeed = { type: need.type, localityId: need.locality_id, languages: need.languages };
    const volunteers = (await deps.volunteerStore.list()).filter((v) => v.slack_user_id !== excludeId);
    const top = topN(scoreNeed, volunteers, deps.localities, 3);
    const ranked: RankedCandidate[] = [];
    for (const c of top) ranked.push({ ...c, rationale: await matchRationale(c, scoreNeed, deps.llm) });
    await deps.notifier.postToDispatch(`${publicId} needs reassignment`, buildReassignBlocks(need, publicId, ranked));
  };

  return { notifyNudge, proposeReassign };
}
