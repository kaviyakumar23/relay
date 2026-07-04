// Core domain vocabulary for the Relay ledger (BUILD-DOC §6.1). Pure types +
// constants only — no runtime deps — so every other ledger module can depend on
// it without cycles. The lifecycle is split into three concerns (kept DNA):
//   • State  — where a need currently is (NeedState)
//   • Flags  — conditions derived from events + time (NeedFlags), never states
//   • Events — what happened (events.ts)
// is_drifting / is_at_risk are NOT states (a need can be IN_PROGRESS *and*
// drifting); they are computed flags.

export type ActorType = 'human' | 'agent' | 'system';

/** Provenance of every event. Human actors are what the consequential-transition
 * gates check for (§6.2). */
export interface Actor {
  type: ActorType;
  id: string;
}

export type NeedType = 'medical' | 'rescue' | 'food' | 'water' | 'shelter' | 'transport' | 'other';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Ordinal rank so severity floors can only ever raise (invariant #4). */
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Per-field extraction provenance shown on cards (InView DNA). */
export type ConfidenceStatus = 'stated' | 'inferred' | 'unknown';

export type EvidenceKind = 'photo' | 'locality_confirm' | 'recipient_confirm' | 'coordinator_signoff';

/** Need lifecycle states (§6.1). Main path + side paths. */
export type NeedState =
  | 'NEW'
  | 'TRIAGED'
  | 'OPEN'
  | 'MATCH_SUGGESTED'
  | 'CLAIMED'
  | 'IN_PROGRESS'
  | 'DELIVERED_UNVERIFIED'
  | 'VERIFIED'
  | 'CLOSED'
  // side paths
  | 'NEEDS_REVIEW'
  | 'DUPLICATE'
  | 'EXPIRED'
  | 'REOPENED'
  | 'CANCELLED';

/** No further transitions (except CommentAdded / Reopened where allowed). */
export const TERMINAL_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'CLOSED',
  'DUPLICATE',
  'EXPIRED',
  'CANCELLED',
]);

/** Every non-terminal state — the window in which ANY_ACTIVE transitions apply. */
export const ACTIVE_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'NEW',
  'TRIAGED',
  'OPEN',
  'NEEDS_REVIEW',
  'MATCH_SUGGESTED',
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
  'VERIFIED',
  'REOPENED',
]);

/** States in which a claimed obligation is being worked / chased (drift applies). */
export const DELIVERING_STATES: ReadonlySet<NeedState> = new Set<NeedState>(['CLAIMED', 'IN_PROGRESS']);

/** Original-thread coordinates — IDs / permalinks only, never message content
 * (zero-copy, §invariant #5). */
export interface NeedSource {
  permalink?: string;
  channel?: string;
  ts?: string;
  team_id?: string;
}

/** One attested piece of the evidence packet (F5). Reference + kind + time only. */
export interface EvidenceRef {
  kind: EvidenceKind;
  at: string;
  evidence_id?: string;
}

/** Conditions derived from the event log + the current time. Never stored as state. */
export interface NeedFlags {
  is_active: boolean;
  is_open: boolean;
  is_drifting: boolean;
  is_at_risk: boolean;
  is_unverified: boolean;
  needs_review: boolean;
  is_duplicate: boolean;
}

export const emptyFlags = (): NeedFlags => ({
  is_active: false,
  is_open: false,
  is_drifting: false,
  is_at_risk: false,
  is_unverified: false,
  needs_review: false,
  is_duplicate: false,
});

/** The projection of a need — derived purely from its ordered event log + `now`. */
export interface ProjectedNeed {
  need_id: string;
  state: NeedState;
  type: NeedType;
  severity: Severity;
  locality_id: number | null;
  location_text: string | null;
  people_count: number | null;
  languages: string[];
  source: NeedSource;
  confidence: Record<string, ConfidenceStatus>;
  merged_into: string | null;
  assigned_volunteer_id: string | null;
  obligation_id: string | null;
  sla_due_at: string | null;
  evidence: EvidenceRef[];
  flags: NeedFlags;
  state_version: number;
  history_count: number;
  created_at: string;
  updated_at: string;
}

/** The projection fields that back the `needs` row cache (needService writes these). */
export interface ProjectionCache {
  status: NeedState;
  type: NeedType;
  severity: Severity;
  locality_id: number | null;
  location_text: string | null;
  people_count: number | null;
  languages: string[];
  confidence: Record<string, ConfidenceStatus>;
}
