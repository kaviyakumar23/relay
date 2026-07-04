import { isEvent, type NeedEvent } from './events';
import { resolveTarget, TRANSITIONS } from './stateMachine';
import {
  DELIVERING_STATES,
  type EvidenceRef,
  emptyFlags,
  type NeedState,
  type ProjectedNeed,
  type ProjectionCache,
  SEVERITY_RANK,
  TERMINAL_STATES,
} from './types';

/** Window before `sla_due_at` in which a live obligation counts as at-risk. */
export const DEFAULT_RISK_WINDOW_MS = 15 * 60 * 1000;

export interface ProjectionOptions {
  /** Reference "now" for time-derived flags. Defaults to Date.now(). */
  now?: number;
  riskWindowMs?: number;
}

/**
 * Derive a need's current state from its ordered event log (BUILD-DOC §6.1).
 * Pure left-fold: same events + same `now` → same projection. The state machine's
 * TRANSITIONS table drives state changes; everything else is payload accumulation.
 * Time-derived conditions (is_drifting, is_at_risk …) are computed FLAGS, not states.
 */
export function project(events: NeedEvent[], opts: ProjectionOptions = {}): ProjectedNeed {
  const head = events[0];
  if (!head) throw new Error('cannot project an empty event log');
  if (head.type !== 'NeedCreated') {
    throw new Error(`event log must begin with NeedCreated, got ${head.type}`);
  }
  const now = opts.now ?? Date.now();
  const riskWindowMs = opts.riskWindowMs ?? DEFAULT_RISK_WINDOW_MS;

  // Pre-extraction defaults for the walking skeleton (floors only ever raise).
  const need: ProjectedNeed = {
    need_id: head.need_id,
    state: 'NEW',
    type: 'other',
    severity: 'low',
    locality_id: null,
    location_text: null,
    people_count: null,
    languages: [],
    source: { ...head.payload.source },
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: null,
    obligation_id: null,
    sla_due_at: null,
    evidence: [],
    flags: emptyFlags(),
    state_version: 0,
    history_count: events.length,
    created_at: head.at,
    updated_at: head.at,
  };

  let state: NeedState | null = null;
  let version = 0;
  const seenEvidence = new Set<string>();

  const attach = (ref: EvidenceRef) => {
    const key = `${ref.kind}:${ref.evidence_id ?? ''}`;
    if (seenEvidence.has(key)) return; // idempotent evidence packet (F5)
    seenEvidence.add(key);
    need.evidence.push(ref);
  };

  for (const event of events) {
    const spec = TRANSITIONS[event.type];
    const target = resolveTarget(spec, event, state ?? 'NEW');
    if (state === null || target !== state) {
      state = target;
      version += 1;
    }
    need.updated_at = event.at;

    if (isEvent(event, 'ExtractionCompleted')) {
      const p = event.payload;
      need.type = p.need_type;
      // Severity floor: only ever raise (invariant #4).
      if (SEVERITY_RANK[p.severity] > SEVERITY_RANK[need.severity]) need.severity = p.severity;
      if (p.locality_id !== undefined) need.locality_id = p.locality_id;
      if (p.location_text !== undefined) need.location_text = p.location_text;
      if (p.people_count !== undefined) need.people_count = p.people_count;
      if (p.languages !== undefined) need.languages = [...p.languages];
      if (p.confidence !== undefined) need.confidence = { ...p.confidence };
    } else if (isEvent(event, 'DuplicateConfirmed')) {
      need.merged_into = event.payload.merged_into;
    } else if (isEvent(event, 'Claimed') || isEvent(event, 'Assigned')) {
      need.assigned_volunteer_id = event.payload.volunteer_id;
      need.obligation_id = event.payload.obligation_id ?? need.obligation_id;
      need.sla_due_at = event.payload.sla_due_at ?? null;
    } else if (isEvent(event, 'Reassigned')) {
      need.assigned_volunteer_id = event.payload.to_volunteer_id;
      need.obligation_id = event.payload.obligation_id ?? need.obligation_id;
      need.sla_due_at = event.payload.sla_due_at ?? null;
    } else if (isEvent(event, 'ClaimReleased')) {
      need.assigned_volunteer_id = null;
      need.obligation_id = null;
      need.sla_due_at = null;
    } else if (isEvent(event, 'EvidenceAttached')) {
      attach({ kind: event.payload.kind, at: event.at, evidence_id: event.payload.evidence_id });
    } else if (isEvent(event, 'RecipientConfirmed')) {
      attach({ kind: 'recipient_confirm', at: event.at });
    } else if (isEvent(event, 'CoordinatorSignedOff')) {
      attach({ kind: 'coordinator_signoff', at: event.at });
    }
  }

  need.state = state ?? 'NEW';
  need.state_version = version;

  const due = need.sla_due_at ? Date.parse(need.sla_due_at) : null;
  const delivering = DELIVERING_STATES.has(need.state);
  need.flags = {
    is_active: !TERMINAL_STATES.has(need.state),
    is_open: need.state === 'OPEN',
    is_drifting: due !== null && delivering && now > due,
    is_at_risk: due !== null && delivering && now <= due && due - now <= riskWindowMs,
    is_unverified: need.state === 'DELIVERED_UNVERIFIED',
    needs_review: need.state === 'NEEDS_REVIEW',
    is_duplicate: need.state === 'DUPLICATE',
  };

  return need;
}

/** Project at most up to (and including) the event with the given id — point-in-time replay. */
export function projectAt(events: NeedEvent[], eventId: string, opts?: ProjectionOptions): ProjectedNeed {
  const idx = events.findIndex((e) => e.event_id === eventId);
  const slice = idx >= 0 ? events.slice(0, idx + 1) : events;
  return project(slice, opts);
}

/** Extract the `needs`-row cache fields from a projection (needService writes these). */
export function toProjectionCache(need: ProjectedNeed): ProjectionCache {
  return {
    status: need.state,
    type: need.type,
    severity: need.severity,
    locality_id: need.locality_id,
    location_text: need.location_text,
    people_count: need.people_count,
    languages: need.languages,
    confidence: need.confidence,
  };
}
