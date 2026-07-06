import { isEvent, type NeedEvent } from '../ledger/events';
import type { NeedState, NeedType, ProjectedNeed, Severity } from '../ledger/types';
import { TERMINAL_STATES } from '../ledger/types';

// Aggregation over the ledger (BUILD-DOC §F6 sitrep / §F7 report). PURE, deterministic
// functions of the projected needs (+ their events for the report). The caller passes the
// data — this module never touches the store — so `npm test`/`npm run demo` stay hermetic.
//
// PRIVACY (CLAUDE.md invariants 4 & 5): the ledger is PII-free BY CONSTRUCTION — a
// ProjectedNeed and its NeedEvents carry only derived fields + Slack object ids, never
// beneficiary contact (that lives only in contact_vault, never read here). So these
// aggregates are already PII-free at the source; the {{stat:*}} redaction/grep gate in
// statTokens is DEFENSE-IN-DEPTH against a hallucinating narrator, not the primary guard.
//
// The crown-jewel contract (F7): a generated narrative's numbers ALWAYS equal the ledger's.
// This module is the single source of those numbers. Every headline figure is emitted once,
// in an ORDERED StatSet, and only those values are ever allowed into narrated prose.

// --- StatSet: the ordered set of headline numbers a narrative may cite ------

/** One headline figure. `eventRefs` (report only) are the need_ids backing the number,
 * so the integrator can footnote each claim with its ledger link (F7). */
export interface Stat {
  key: string;
  value: number;
  label: string;
  eventRefs?: string[];
}

/** The ordered headline numbers. buildTokenMap turns these into the ONLY digits a
 * narrative is permitted to contain. */
export type StatSet = Stat[];

const NEED_TYPE_LIST: readonly NeedType[] = ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other'];
const SEVERITY_LIST: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const NEED_STATE_LIST: readonly NeedState[] = [
  'NEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
  'VERIFIED',
  'CLOSED',
  'NEEDS_REVIEW',
  'DUPLICATE',
  'EXPIRED',
  'REOPENED',
  'CANCELLED',
];

/** Pre-claim states where a need is still awaiting a volunteer (the "open work queue"). */
const OPEN_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'NEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'REOPENED',
]);
/** States where a volunteer holds a live obligation that has not yet been verified/closed. */
const ACTIVE_OBLIGATION_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
]);

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

const zeroRecord = <K extends string>(keys: readonly K[]): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = 0;
  return out;
};

/** Same UTC calendar day (used to approximate "today" for the live sitrep). */
const sameUtcDay = (aMs: number, bMs: number): boolean => Math.floor(aMs / MS_PER_DAY) === Math.floor(bMs / MS_PER_DAY);

const isActive = (state: NeedState): boolean => !TERMINAL_STATES.has(state);

const stat = (key: string, value: number, label: string, eventRefs?: string[]): Stat =>
  eventRefs !== undefined ? { key, value, label, eventRefs } : { key, value, label };

// --- Sitrep: the LIVE snapshot (F6) -----------------------------------------

export interface SitrepStats {
  now: number;
  totalActive: number;
  open: number;
  openCritical: number;
  claimed: number;
  inProgress: number;
  deliveredUnverified: number;
  verified: number;
  closed: number;
  needsReview: number;
  drifting: number;
  atRisk: number;
  verifiedToday: number;
  activeObligations: number;
  localitiesAffected: number;
  byType: Record<NeedType, number>;
  bySeverity: Record<Severity, number>;
  byStatus: Record<NeedState, number>;
  /** Ordered headline numbers — the ONLY values a narrative may print (statTokens). */
  stats: StatSet;
}

/**
 * Live operational snapshot from the current projection of every need. Counts are exact
 * over the passed set. `open` aggregates the pre-claim states; `openCritical` counts
 * critical needs not in a terminal state; `verifiedToday` approximates the day's closes
 * from `updated_at` on VERIFIED/CLOSED needs (the report path uses exact event times).
 */
export function computeSitrepStats(needs: ProjectedNeed[], now: number): SitrepStats {
  const byType = zeroRecord(NEED_TYPE_LIST);
  const bySeverity = zeroRecord(SEVERITY_LIST);
  const byStatus = zeroRecord(NEED_STATE_LIST);
  const localities = new Set<number>();

  let totalActive = 0;
  let open = 0;
  let openCritical = 0;
  let claimed = 0;
  let inProgress = 0;
  let deliveredUnverified = 0;
  let verified = 0;
  let closed = 0;
  let needsReview = 0;
  let drifting = 0;
  let atRisk = 0;
  let verifiedToday = 0;
  let activeObligations = 0;

  for (const need of needs) {
    byStatus[need.state] += 1;

    if (need.state === 'CLOSED') closed += 1;
    if (need.state === 'CLAIMED') claimed += 1;
    if (need.state === 'IN_PROGRESS') inProgress += 1;
    if (need.state === 'DELIVERED_UNVERIFIED') deliveredUnverified += 1;
    if (need.state === 'VERIFIED') verified += 1;
    if (need.state === 'NEEDS_REVIEW') needsReview += 1;
    if (OPEN_STATES.has(need.state)) open += 1;
    if (need.severity === 'critical' && isActive(need.state)) openCritical += 1;
    if (need.flags.is_drifting) drifting += 1;
    if (need.flags.is_at_risk) atRisk += 1;
    if (ACTIVE_OBLIGATION_STATES.has(need.state) && need.assigned_volunteer_id !== null) activeObligations += 1;

    if ((need.state === 'VERIFIED' || need.state === 'CLOSED') && sameUtcDay(Date.parse(need.updated_at), now)) {
      verifiedToday += 1;
    }

    if (isActive(need.state)) {
      totalActive += 1;
      byType[need.type] += 1;
      bySeverity[need.severity] += 1;
      if (need.locality_id !== null) localities.add(need.locality_id);
    }
  }

  const localitiesAffected = localities.size;

  const stats: StatSet = [
    stat('total_active', totalActive, 'active needs on the board'),
    stat('open', open, 'open, awaiting a volunteer'),
    stat('open_critical', openCritical, 'critical needs still open'),
    stat('claimed', claimed, 'claimed by a volunteer'),
    stat('in_progress', inProgress, 'in progress'),
    stat('delivered_unverified', deliveredUnverified, 'delivered, awaiting verification'),
    stat('verified', verified, 'verified'),
    stat('needs_review', needsReview, 'awaiting human review'),
    stat('drifting', drifting, 'drifting past their deadline'),
    stat('at_risk', atRisk, 'at risk of missing SLA'),
    stat('verified_today', verifiedToday, 'verified today'),
    stat('localities_affected', localitiesAffected, 'localities affected'),
    stat('active_obligations', activeObligations, 'active volunteer obligations'),
  ];
  for (const t of NEED_TYPE_LIST) {
    if (byType[t] > 0) stats.push(stat(`type_${t}`, byType[t], `${t} needs active`));
  }
  for (const s of SEVERITY_LIST) {
    if (bySeverity[s] > 0) stats.push(stat(`sev_${s}`, bySeverity[s], `${s}-severity needs active`));
  }

  return {
    now,
    totalActive,
    open,
    openCritical,
    claimed,
    inProgress,
    deliveredUnverified,
    verified,
    closed,
    needsReview,
    drifting,
    atRisk,
    verifiedToday,
    activeObligations,
    localitiesAffected,
    byType,
    bySeverity,
    byStatus,
    stats,
  };
}

// --- Report: the VERIFIED-ONLY impact record (F7) ---------------------------

export interface ReportWindow {
  sinceMs?: number;
  untilMs?: number;
}

export interface ReportStats {
  sinceMs: number | null;
  untilMs: number | null;
  totalNeeds: number;
  verifiedDeliveries: number;
  peopleHelped: number;
  volunteersEngaged: number;
  medianResponseMinutes: number;
  evidenceCompletePct: number;
  byType: Record<NeedType, number>;
  /** Ordered headline numbers, each carrying the need_ids backing it (F7 footnotes). */
  stats: StatSet;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return Math.round(raw);
};

/** A "complete" evidence packet carries a human attestation (recipient or coordinator),
 * not merely a photo — that is what makes the delivery auditable (F5/F7). */
const hasAttestation = (need: ProjectedNeed): boolean =>
  need.evidence.some((e) => e.kind === 'recipient_confirm' || e.kind === 'coordinator_signoff');

/**
 * Verified-only impact aggregation. A need is in scope iff its event log contains a
 * `Verified` event whose timestamp falls inside [sinceMs, untilMs]. All figures are
 * integers (response times rounded to whole minutes) so a narrative's digits map 1:1 to
 * ledger values. Each headline Stat carries the need_ids backing it; the integrator
 * resolves each to its public_id (N-0421) + source permalink for the per-claim footnote.
 */
export function computeReportStats(
  needs: ProjectedNeed[],
  eventsByNeed: Map<string, NeedEvent[]>,
  opts: ReportWindow = {},
): ReportStats {
  const since = opts.sinceMs ?? Number.NEGATIVE_INFINITY;
  const until = opts.untilMs ?? Number.POSITIVE_INFINITY;
  const inWindow = (ms: number): boolean => ms >= since && ms <= until;

  const byType = zeroRecord(NEED_TYPE_LIST);
  const refsByType: Record<NeedType, string[]> = {
    medical: [],
    rescue: [],
    food: [],
    water: [],
    shelter: [],
    transport: [],
    other: [],
  };
  const scopedNeedIds: string[] = [];
  const volunteers = new Set<string>();
  const responseMinutes: number[] = [];

  let verifiedDeliveries = 0;
  let peopleHelped = 0;
  let evidenceComplete = 0;

  for (const need of needs) {
    const events = eventsByNeed.get(need.need_id) ?? [];
    const verifiedEvents = events.filter((e): e is NeedEvent & { type: 'Verified' } => isEvent(e, 'Verified'));
    const inWindowVerified = verifiedEvents.filter((e) => inWindow(Date.parse(e.at)));
    if (inWindowVerified.length === 0) continue; // not a verified delivery in this window

    scopedNeedIds.push(need.need_id);
    verifiedDeliveries += inWindowVerified.length;
    peopleHelped += need.people_count ?? 0;
    byType[need.type] += 1;
    refsByType[need.type].push(need.need_id);
    if (need.assigned_volunteer_id !== null) volunteers.add(need.assigned_volunteer_id);
    if (hasAttestation(need)) evidenceComplete += 1;

    const createdMs = Date.parse(need.created_at);
    const firstVerifiedMs = Math.min(...inWindowVerified.map((e) => Date.parse(e.at)));
    if (!Number.isNaN(createdMs) && Number.isFinite(firstVerifiedMs)) {
      responseMinutes.push(Math.max(0, (firstVerifiedMs - createdMs) / MS_PER_MINUTE));
    }
  }

  const totalNeeds = scopedNeedIds.length;
  const medianResponseMinutes = median(responseMinutes);
  const evidenceCompletePct = totalNeeds === 0 ? 0 : Math.round((evidenceComplete / totalNeeds) * 100);

  const stats: StatSet = [
    stat('total_needs', totalNeeds, 'needs resolved and verified', [...scopedNeedIds]),
    stat('verified_deliveries', verifiedDeliveries, 'verified deliveries', [...scopedNeedIds]),
    stat('people_helped', peopleHelped, 'people helped', [...scopedNeedIds]),
    stat('volunteers_engaged', volunteers.size, 'volunteers engaged', [...scopedNeedIds]),
    stat('median_response_minutes', medianResponseMinutes, 'minutes median response time', [...scopedNeedIds]),
    stat('evidence_complete_pct', evidenceCompletePct, 'percent of deliveries with a complete evidence packet', [
      ...scopedNeedIds,
    ]),
  ];
  for (const t of NEED_TYPE_LIST) {
    if (byType[t] > 0) stats.push(stat(`type_${t}`, byType[t], `${t} deliveries verified`, [...refsByType[t]]));
  }

  return {
    sinceMs: opts.sinceMs ?? null,
    untilMs: opts.untilMs ?? null,
    totalNeeds,
    verifiedDeliveries,
    peopleHelped,
    volunteersEngaged: volunteers.size,
    medianResponseMinutes,
    evidenceCompletePct,
    byType,
    stats,
  };
}
