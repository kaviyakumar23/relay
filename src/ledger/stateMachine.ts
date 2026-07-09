import { type EventType, isEvent, type NeedEvent } from './events';
import { ACTIVE_STATES, type NeedState, type ProjectedNeed, type Severity } from './types';

// The lifecycle as an explicit, guarded transition table (BUILD-DOC §6.1/§6.2) —
// NOT free-form LLM steps. Every event type declares the states it may apply
// from, the state it moves to, and whether it is a human gate. The LLM proposes;
// canApply decides. No transition happens without passing here.

export type TransitionTarget = NeedState | 'SAME';
type TargetResolver = (event: NeedEvent, currentState: NeedState) => TransitionTarget;

export interface TransitionSpec {
  /** Legal source states, or a class: CREATE (from nothing), ANY_ACTIVE, ANY (incl. terminal). */
  from: readonly NeedState[] | 'ANY_ACTIVE' | 'ANY' | 'CREATE';
  /** Target state, SAME (no state change), or a resolver for conditional routing. */
  to: TransitionTarget | TargetResolver;
  /** §6.2 consequential transition — decide() rejects unless actor.type === 'human'. */
  humanGate: boolean;
}

const T = (s: TransitionSpec): TransitionSpec => s;

/**
 * The FIRST extraction (from NEW) advances the lifecycle to TRIAGED, or NEEDS_REVIEW when it can't
 * be trusted. A LATER ExtractionCompleted is a human field-correction ("✏️ Edit" on the card) — it
 * refines the derived fields but must NOT rewind the lifecycle, so from any non-NEW state it keeps
 * the current state (SAME). The projection still applies the corrected fields (severity floor only
 * ever raises, invariant #4).
 */
const extractionTarget: TargetResolver = (event, current) => {
  if (current !== 'NEW') return 'SAME';
  return isEvent(event, 'ExtractionCompleted') && event.payload.needs_review === true ? 'NEEDS_REVIEW' : 'TRIAGED';
};

/** States a field-correction (human override) ExtractionCompleted may apply from: the first pass
 * fires from NEW; a coordinator correction is admitted through the in-flight (pre-close) states the
 * card's Edit control is offered from. Terminal / closed / duplicate states never accept one. */
const EXTRACTION_FROM: readonly NeedState[] = [
  'NEW',
  'TRIAGED',
  'OPEN',
  'NEEDS_REVIEW',
  'MATCH_SUGGESTED',
  'REOPENED',
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
];

const PRE_ASSIGN: readonly NeedState[] = ['NEW', 'TRIAGED', 'OPEN', 'NEEDS_REVIEW', 'MATCH_SUGGESTED'];
const ASSIGNABLE: readonly NeedState[] = ['OPEN', 'MATCH_SUGGESTED', 'REOPENED'];
const CLAIMED_WORK: readonly NeedState[] = ['CLAIMED', 'IN_PROGRESS'];

export const TRANSITIONS: Record<EventType, TransitionSpec> = {
  NeedCreated: T({ from: 'CREATE', to: 'NEW', humanGate: false }),
  ExtractionCompleted: T({ from: EXTRACTION_FROM, to: extractionTarget, humanGate: false }),
  DuplicateProposed: T({ from: PRE_ASSIGN, to: 'SAME', humanGate: false }),
  DuplicateConfirmed: T({ from: PRE_ASSIGN, to: 'DUPLICATE', humanGate: true }),
  TriageConfirmed: T({ from: ['TRIAGED', 'NEEDS_REVIEW'], to: 'OPEN', humanGate: true }),
  // An agent's pledge (Moonshot #2) is a PROPOSAL, not a commitment: it applies from an open need
  // and moves it to MATCH_SUGGESTED (still awaiting a human), exactly like a matcher's suggestion.
  // humanGate:false — an agent may propose — but the need does NOT reach CLAIMED here; only the
  // human-gated Assigned below can commit it, so an agent can never self-assign past the gate.
  PledgeProposed: T({ from: ['OPEN', 'MATCH_SUGGESTED'], to: 'MATCH_SUGGESTED', humanGate: false }),
  MatchSuggested: T({ from: ['OPEN', 'MATCH_SUGGESTED'], to: 'MATCH_SUGGESTED', humanGate: false }),
  Claimed: T({ from: ASSIGNABLE, to: 'CLAIMED', humanGate: false }),
  Assigned: T({ from: ASSIGNABLE, to: 'CLAIMED', humanGate: true }),
  Nudged: T({ from: CLAIMED_WORK, to: 'SAME', humanGate: false }),
  ClaimReleased: T({ from: ['CLAIMED', 'IN_PROGRESS', 'REOPENED'], to: 'OPEN', humanGate: false }),
  Reassigned: T({ from: ['CLAIMED', 'IN_PROGRESS', 'REOPENED'], to: 'CLAIMED', humanGate: false }),
  EnRouteReported: T({ from: ['CLAIMED'], to: 'IN_PROGRESS', humanGate: false }),
  EvidenceAttached: T({
    from: ['CLAIMED', 'IN_PROGRESS', 'DELIVERED_UNVERIFIED'],
    to: 'DELIVERED_UNVERIFIED',
    humanGate: false,
  }),
  RecipientConfirmed: T({ from: ['DELIVERED_UNVERIFIED'], to: 'SAME', humanGate: false }),
  CoordinatorSignedOff: T({ from: ['DELIVERED_UNVERIFIED'], to: 'SAME', humanGate: true }),
  Verified: T({ from: ['DELIVERED_UNVERIFIED'], to: 'VERIFIED', humanGate: true }),
  Closed: T({ from: ['VERIFIED'], to: 'CLOSED', humanGate: true }),
  Reopened: T({ from: ['CLOSED', 'VERIFIED', 'DELIVERED_UNVERIFIED', 'EXPIRED'], to: 'REOPENED', humanGate: false }),
  Expired: T({ from: 'ANY_ACTIVE', to: 'EXPIRED', humanGate: false }),
  Cancelled: T({ from: 'ANY_ACTIVE', to: 'CANCELLED', humanGate: true }),
  CommentAdded: T({ from: 'ANY', to: 'SAME', humanGate: false }),
};

/** The consequential-transition gates (§6.2) — decide() enforces these. */
export const HUMAN_GATES: ReadonlySet<EventType> = new Set(
  (Object.keys(TRANSITIONS) as EventType[]).filter((t) => TRANSITIONS[t].humanGate),
);

/** Resolve the target state a transition moves to, given the current state. */
export function resolveTarget(spec: TransitionSpec, event: NeedEvent, currentState: NeedState): NeedState {
  const raw = typeof spec.to === 'function' ? spec.to(event, currentState) : spec.to;
  return raw === 'SAME' ? currentState : raw;
}

function sourceAllows(spec: TransitionSpec, state: NeedState): boolean {
  if (spec.from === 'CREATE') return false; // creation handled separately
  if (spec.from === 'ANY') return true;
  if (spec.from === 'ANY_ACTIVE') return ACTIVE_STATES.has(state);
  return spec.from.includes(state);
}

// --- Verification / evidence policy (§6.2 rule 3) ---------------------------
// L1 = photo + locality_confirm · L2 = recipient_confirm · L3 = coordinator_signoff.
// Policy: critical|high verify at L3 with L1+L2 present; medium|low at L2.

export function meetsVerificationPolicy(need: ProjectedNeed): boolean {
  const kinds = new Set(need.evidence.map((e) => e.kind));
  const l1 = kinds.has('photo') && kinds.has('locality_confirm');
  const l2 = kinds.has('recipient_confirm');
  const l3 = kinds.has('coordinator_signoff');
  return isHighSeverity(need.severity) ? l1 && l2 && l3 : l2;
}

const isHighSeverity = (s: Severity): boolean => s === 'critical' || s === 'high';

export type GuardCode = 'ILLEGAL_TRANSITION' | 'INSUFFICIENT_EVIDENCE';

export type GuardResult = { ok: true; to: NeedState } | { ok: false; code: GuardCode; message: string };

/**
 * The single authority on whether an event may STRUCTURALLY be applied (state
 * legality + evidence sufficiency). Actor/human-gate authority is checked in
 * decide(); idempotency + zero-copy too. Pure: (current, event) → GuardResult.
 */
export function canApply(current: ProjectedNeed | null, event: NeedEvent): GuardResult {
  const spec = TRANSITIONS[event.type];

  if (spec.from === 'CREATE') {
    if (current !== null) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', message: `${event.type} cannot apply to an existing need` };
    }
    return { ok: true, to: 'NEW' };
  }

  if (current === null) {
    return { ok: false, code: 'ILLEGAL_TRANSITION', message: `${event.type} requires an existing need` };
  }

  if (!sourceAllows(spec, current.state)) {
    return { ok: false, code: 'ILLEGAL_TRANSITION', message: `${event.type} not allowed from state ${current.state}` };
  }

  if (event.type === 'Verified' && !meetsVerificationPolicy(current)) {
    return {
      ok: false,
      code: 'INSUFFICIENT_EVIDENCE',
      message:
        current.severity === 'critical' || current.severity === 'high'
          ? 'Verified requires photo + locality + recipient confirmation + coordinator sign-off (L3) for this severity'
          : 'Verified requires recipient confirmation (L2)',
    };
  }

  return { ok: true, to: resolveTarget(spec, event, current.state) };
}
