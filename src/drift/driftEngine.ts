import { needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import { DEFAULT_RISK_WINDOW_MS } from '../ledger/projection';
import { type Actor, DELIVERING_STATES, type ProjectedNeed } from '../ledger/types';

// The drift engine (BUILD-DOC §F4). A pure sweep over the ledger + a clock: for
// every live obligation it decides whether the delivery is AT-RISK (approaching
// its SLA) or OVERDUE (past it), appends the corresponding Nudged event, and fires
// an INJECTED side effect (DM nudge / reassignment proposal). Keeping the Slack
// I/O behind callbacks is what makes this module hermetic and replay-safe — the
// tests drive it with a memory store, a virtual clock, and recording callbacks.
//
// AT-MOST-ONCE is the ledger's job, not a DB column: the Nudged idempotency key is
// derived from the obligation's own sla_due_at, so a second sweep at any clock
// re-proposes the SAME key → decide() suppresses it → the callback never re-fires.
// A Reassign stamps a fresh sla_due_at, which mints fresh keys → a new drift cycle
// begins for the new obligation. This is the "delays_count-like" tracking derived
// from events (§F4), with zero extra state.

/** The system actor for autonomous drift events. Nudged is not human-gated. */
export const DRIFT_ACTOR: Actor = { type: 'agent', id: 'drift-engine' };

export type NudgeKind = 'at_risk' | 'overdue';

export interface DriftDecision {
  /** Delivery is within the risk window of its SLA but not yet past it. */
  atRisk: boolean;
  /** Delivery is past its SLA. */
  overdue: boolean;
  /** Not a drift candidate at all — no live obligation to chase (not in a delivering
   * state, or no sla_due_at). The sweep skips these; nudge-once is enforced separately
   * by the ledger keys, so this flag is purely "is there anything to consider". */
  alreadyHandled: boolean;
}

/**
 * Pure drift classification for one need at instant `now`. Mirrors the projection's
 * is_at_risk / is_drifting flag definitions exactly (same risk window), but is
 * self-contained so it can be unit-tested against a fabricated need + arbitrary now.
 * at-risk and overdue are mutually exclusive: at `now === due` the obligation is
 * at-risk; the instant after, overdue.
 */
export function decideDrift(need: ProjectedNeed, now: number, riskWindowMs = DEFAULT_RISK_WINDOW_MS): DriftDecision {
  const due = need.sla_due_at ? Date.parse(need.sla_due_at) : null;
  const delivering = DELIVERING_STATES.has(need.state);
  if (due === null || Number.isNaN(due) || !delivering) {
    return { atRisk: false, overdue: false, alreadyHandled: true };
  }
  const overdue = now > due;
  const atRisk = !overdue && due - now <= riskWindowMs;
  return { atRisk, overdue, alreadyHandled: false };
}

export interface DriftSweepDeps {
  service: NeedService;
  /** All needs projected at `now` (typically NeedService.listNeeds). */
  listNeeds: (now: number) => Promise<ProjectedNeed[]>;
  /** Post the DM nudge (On-my-way / Delayed / Release). Injected — hermetic in tests. */
  notifyNudge: (need: ProjectedNeed, kind: NudgeKind) => Promise<void>;
  /** Post the reassignment card with a fresh top-3. Injected — hermetic in tests. */
  proposeReassign: (need: ProjectedNeed) => Promise<void>;
  now: number;
  /** Override the default 15-min risk window (kept aligned with the projection). */
  riskWindowMs?: number;
  /** Override the drift actor (defaults to DRIFT_ACTOR). */
  actor?: Actor;
}

export interface DriftSweepResult {
  /** need_ids that newly crossed AT-RISK this sweep (a Nudged('at_risk') was appended). */
  nudged: string[];
  /** need_ids that newly crossed OVERDUE this sweep (a Nudged('overdue') + reassign proposal). */
  overdue: string[];
}

/**
 * One drift pass. Lists needs, and for each live obligation appends at most one
 * Nudged('at_risk') and one Nudged('overdue') across its lifetime, firing the
 * matching injected side effect ONLY when the event was genuinely new (dispatch
 * returned 'applied') — so repeated sweeps at any clock never double-notify.
 */
export async function runDriftSweep(deps: DriftSweepDeps): Promise<DriftSweepResult> {
  const { service, listNeeds, notifyNudge, proposeReassign, now } = deps;
  const actor = deps.actor ?? DRIFT_ACTOR;
  const at = new Date(now).toISOString();
  const nudged: string[] = [];
  const overdue: string[] = [];

  const needs = await listNeeds(now);
  for (const need of needs) {
    const decision = decideDrift(need, now, deps.riskWindowMs);
    if (decision.alreadyHandled) continue;
    // sla_due_at is guaranteed present when !alreadyHandled; anchor the key to it so
    // a fresh obligation (post-reassign) gets fresh keys.
    const sla = need.sla_due_at ?? '';
    const obligation = need.obligation_id ? { obligation_id: need.obligation_id } : {};

    if (decision.atRisk) {
      const res = await service.dispatch(
        need.need_id,
        { type: 'Nudged', payload: { kind: 'at_risk', ...obligation } },
        { actor, at, idempotencyKey: needEventKey(need.need_id, 'Nudged', `atrisk:${sla}`), now },
      );
      if (res.status === 'applied') {
        nudged.push(need.need_id);
        await notifyNudge(need, 'at_risk');
      }
    } else if (decision.overdue) {
      const res = await service.dispatch(
        need.need_id,
        { type: 'Nudged', payload: { kind: 'overdue', ...obligation } },
        { actor, at, idempotencyKey: needEventKey(need.need_id, 'Nudged', `overdue:${sla}`), now },
      );
      if (res.status === 'applied') {
        overdue.push(need.need_id);
        await proposeReassign(need);
      }
    }
  }

  return { nudged, overdue };
}
